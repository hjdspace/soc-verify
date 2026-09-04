/**
 * Design Service — Design Source 配置 → elaboration → 提炼入库 的编排器。
 *
 * 职责（issue 02 tracer bullet）：
 *   - Design Source 配置持久化（<projectRoot>/.socverify/design/config.json）
 *   - 手动刷新对齐 Case Scan 模式：DB 有数据秒开、手动触发重跑、mtime 变化提示
 *     过期、无文件监听无自动重跑（ADR 0032 决策 7/19/20）
 *   - per-project DB 连接缓存与 op 串行化（单用户桌面应用，同项目操作排队）
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { resolveYosysPath, yosysMissingDlls } from './binary';
import {
  getChildrenInstances,
  getDef,
  getDefEdges,
  getInstance,
  getLastError,
  getRootInstance,
  getDesignDbPath,
  hasDesignData,
  initDesignDatabase,
  listDefs,
  replaceAll,
  setLastError,
  type DesignDatabase,
} from './design-db';
import { RtlElaborationError, elaborate } from './elaborator';
import { flattenFilelists, renderFlatFilelist } from './filelist';
import { extractDesign, type WriteJsonDoc } from './extractor';
import type {
  DesignDefRow,
  DesignEdgeRow,
  DesignInstRow,
  DesignRefreshResult,
  DesignSourceConfig,
  DesignStatus,
  ElaborationError,
} from './types';

// ─── 配置持久化 ────────────────────────────────────────────

const DESIGN_DIR = '.socverify/design';

export function getDesignConfigPath(projectRoot: string): string {
  return join(projectRoot, DESIGN_DIR, 'config.json');
}

export function getDesignWorkDir(projectRoot: string): string {
  return join(projectRoot, DESIGN_DIR, 'work');
}

export function loadDesignConfig(projectRoot: string): DesignSourceConfig {
  const path = getDesignConfigPath(projectRoot);
  if (!existsSync(path)) return { filelists: [], top: null };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    return {
      filelists: Array.isArray(parsed.filelists) ? parsed.filelists.filter((f): f is string => typeof f === 'string') : [],
      top: typeof parsed.top === 'string' && parsed.top.length > 0 ? parsed.top : null,
    };
  } catch {
    return { filelists: [], top: null };
  }
}

export function saveDesignConfig(projectRoot: string, config: DesignSourceConfig): void {
  const path = getDesignConfigPath(projectRoot);
  mkdirSync(join(projectRoot, DESIGN_DIR), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf-8');
}

export function isConfigured(config: DesignSourceConfig): boolean {
  return config.filelists.length > 0 && config.top !== null;
}

// ─── DB 缓存与操作串行化 ────────────────────────────────────

const dbCache = new Map<string, DesignDatabase>();

function getDesignDb(projectId: string, projectRoot: string): DesignDatabase {
  let db = dbCache.get(projectId);
  if (!db) {
    db = initDesignDatabase(getDesignDbPath(projectRoot));
    dbCache.set(projectId, db);
  }
  return db;
}

export function evictDesignDb(projectId: string): void {
  const db = dbCache.get(projectId);
  if (db) {
    closeDesignDbSafe(db);
    dbCache.delete(projectId);
  }
}

function closeDesignDbSafe(db: DesignDatabase): void {
  try {
    if (db.open) db.close();
  } catch {
    // 关闭失败忽略（进程级单连接，WAL 模式下无一致性问题）
  }
}

const inflight = new Map<string, Promise<unknown>>();

/** 同项目 elaboration 类操作串行化（避免 work 目录/design.json 竞争） */
function serialize<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = inflight.get(projectId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  inflight.set(projectId, next);
  void next.finally(() => {
    if (inflight.get(projectId) === next) inflight.delete(projectId);
  });
  return next;
}

// ─── 状态查询 ──────────────────────────────────────────────

export function getStatus(projectId: string, projectRoot: string): DesignStatus {
  const config = loadDesignConfig(projectRoot);
  const db = getDesignDb(projectId, projectRoot);

  const yosysPath = resolveYosysPath();
  const missingDlls = yosysMissingDlls() ?? [];

  return {
    configured: isConfigured(config),
    hasData: hasDesignData(db),
    top: getTopFromDb(db) ?? config.top,
    lastElaboratedAt: getLastElaboratedAt(db),
    elapsedMs: getElapsedMs(db),
    stale: computeStale(db),
    elaborating: inflight.has(projectId),
    lastError: getLastError(db),
    yosysAvailable: yosysPath !== null && missingDlls.length === 0,
    yosysPath,
    missingDlls,
  };
}

function getTopFromDb(db: DesignDatabase): string | null {
  const raw = getMetaSafe(db, 'top');
  return raw;
}

function getLastElaboratedAt(db: DesignDatabase): string | null {
  return getMetaSafe(db, 'lastElaboratedAt');
}

function getElapsedMs(db: DesignDatabase): number | null {
  const raw = getMetaSafe(db, 'elapsedMs');
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function getMetaSafe(db: DesignDatabase, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/** 源文件 mtime 相对上次 elaboration 是否变化（缺文件视为过期） */
function computeStale(db: DesignDatabase): boolean {
  const raw = getMetaSafe(db, 'sourceFiles');
  if (!raw) return false;
  let files: string[];
  try {
    files = JSON.parse(raw) as string[];
  } catch {
    return false;
  }
  const storedRaw = getMetaSafe(db, 'sourceMaxMtime');
  if (!storedRaw) return false;
  const stored = Number(storedRaw);
  if (!Number.isFinite(stored)) return false;
  return Math.abs(maxMtimeOf(files) - stored) > 1;
}

function maxMtimeOf(files: string[]): number {
  let max = 0;
  for (const f of files) {
    try {
      max = Math.max(max, statSync(f).mtimeMs);
    } catch {
      // 文件消失 → 时间不可判定，返回远大于任何存储值触发过期
      return Number.MAX_SAFE_INTEGER;
    }
  }
  return max;
}

// ─── 数据查询（tRPC 子树查询的底层） ─────────────────────────

export function queryRoot(projectId: string, projectRoot: string): DesignInstRow | null {
  return getRootInstance(getDesignDb(projectId, projectRoot));
}

export function queryChildren(projectId: string, projectRoot: string, path: string): DesignInstRow[] {
  return getChildrenInstances(getDesignDb(projectId, projectRoot), path);
}

export function queryInstance(projectId: string, projectRoot: string, path: string): DesignInstRow | null {
  return getInstance(getDesignDb(projectId, projectRoot), path);
}

export function queryDef(projectId: string, projectRoot: string, name: string): DesignDefRow | null {
  return getDef(getDesignDb(projectId, projectRoot), name);
}

export function queryDefs(projectId: string, projectRoot: string): DesignDefRow[] {
  return listDefs(getDesignDb(projectId, projectRoot));
}

export function queryEdges(projectId: string, projectRoot: string, moduleName: string): DesignEdgeRow[] {
  return getDefEdges(getDesignDb(projectId, projectRoot), moduleName);
}

// ─── 核心管线：elaborate → extract → 入库 ────────────────────

/**
 * 手动刷新（对齐 Case Scan 模式）。
 * 不抛 elaboration 错误：失败持久化 lastError 并返回 ok:false（UI 呈现诊断）。
 */
export function refresh(projectId: string, projectRoot: string): Promise<DesignRefreshResult> {
  return serialize(projectId, async (): Promise<DesignRefreshResult> => {
    const config = loadDesignConfig(projectRoot);
    if (config.filelists.length === 0) {
      return fail('未配置 Design Source：请先在「设计」视图配置 .f 文件列表');
    }
    if (!config.top) {
      return fail('未选择顶层模块：请先检测并选择顶层');
    }

    const yosysPath = resolveYosysPath();
    if (!yosysPath) {
      return fail('yosys 不可用：请运行 npm run download:rtl-tools 安装 RTL 工具链');
    }
    const missingDlls = yosysMissingDlls() ?? [];
    if (missingDlls.length > 0) {
      return fail(`yosys 依赖 DLL 缺失: ${missingDlls.join(', ')}（必须与 exe 同目录，重新运行 npm run download:rtl-tools）`);
    }

    // 展开多 .f → 扁平清单（绝对路径）
    const absFilelists = config.filelists.map((f) => (isAbsolute(f) ? f : join(projectRoot, f)));
    let parsed;
    try {
      parsed = flattenFilelists(absFilelists, projectRoot);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    if (parsed.sources.length === 0) {
      return fail('Design Source 未解析到任何源文件（检查 .f 配置）');
    }

    const started = Date.now();
    const workDir = getDesignWorkDir(projectRoot);
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // work 目录被占用等场景忽略（Windows 文件锁）
    }
    mkdirSync(workDir, { recursive: true });

    const flatPath = join(workDir, 'design_flat.f');
    writeFileSync(flatPath, renderFlatFilelist(parsed), 'utf-8');

    let result;
    try {
      result = await elaborate({ yosysPath, workDir, flatFilelistPath: flatPath, top: config.top });
    } catch (err) {
      const elabErr = err instanceof RtlElaborationError ? err : new RtlElaborationError(String(err), [], '');
      persistError(projectId, projectRoot, elabErr.toElaborationError());
      return { ok: false, error: elabErr.toElaborationError() };
    }

    // 提炼 + 入库（raw write_json 不持久化，提炼后立即删除）
    let design;
    try {
      const doc = JSON.parse(readFileSync(result.jsonPath, 'utf-8')) as WriteJsonDoc;
      design = extractDesign(doc, config.top);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      persistError(projectId, projectRoot, { message: `write_json 提炼失败: ${message}`, diagnostics: [], logTail: '' });
      return {
        ok: false,
        error: { message: `write_json 提炼失败: ${message}`, diagnostics: [], logTail: '' },
      };
    } finally {
      try {
        rmSync(result.jsonPath, { force: true });
      } catch {
        // 忽略临时文件删除失败
      }
    }

    const sourceFiles = [...new Set(parsed.files)];
    const db = getDesignDb(projectId, projectRoot);
    replaceAll(db, design, {
      top: design.top,
      lastElaboratedAt: new Date().toISOString(),
      elapsedMs: String(Date.now() - started),
      sourceFiles: JSON.stringify(sourceFiles),
      sourceMaxMtime: String(maxMtimeOf(sourceFiles)),
    });
    setLastError(db, null);

    return {
      ok: true,
      top: design.top,
      defCount: design.defs.length,
      instCount: design.insts.length,
    };
  });
}

function fail(message: string): DesignRefreshResult {
  return { ok: false, error: { message, diagnostics: [], logTail: '' } };
}

function persistError(projectId: string, projectRoot: string, error: ElaborationError): void {
  try {
    setLastError(getDesignDb(projectId, projectRoot), error);
  } catch {
    // DB 打开失败时错误仅返回给调用方
  }
}

/**
 * 检测顶层模块（story 17：从 elaborated top units 列表选择）。
 * 不写 DB —— read_slang 无 --top 时自动判定顶层，plain 命名模块即 top 单元。
 */
export function detectTops(projectId: string, projectRoot: string): Promise<string[]> {
  return serialize(projectId, async (): Promise<string[]> => {
    const config = loadDesignConfig(projectRoot);
    if (config.filelists.length === 0) {
      throw new RtlElaborationError('未配置 Design Source：请先配置 .f 文件列表', [], '');
    }
    const yosysPath = resolveYosysPath();
    if (!yosysPath) {
      throw new RtlElaborationError('yosys 不可用：请运行 npm run download:rtl-tools 安装 RTL 工具链', [], '');
    }

    const absFilelists = config.filelists.map((f) => (isAbsolute(f) ? f : join(projectRoot, f)));
    const parsed = flattenFilelists(absFilelists, projectRoot);
    if (parsed.sources.length === 0) {
      throw new RtlElaborationError('Design Source 未解析到任何源文件（检查 .f 配置）', [], '');
    }

    const workDir = getDesignWorkDir(projectRoot);
    mkdirSync(workDir, { recursive: true });
    const flatPath = join(workDir, 'design_flat.f');
    writeFileSync(flatPath, renderFlatFilelist(parsed), 'utf-8');

    const result = await elaborate({ yosysPath, workDir, flatFilelistPath: flatPath, top: null });
    try {
      const doc = JSON.parse(readFileSync(result.jsonPath, 'utf-8')) as WriteJsonDoc;
      const tops = Object.keys(doc.modules ?? {}).filter((name) => !name.startsWith('$')).sort();
      return tops;
    } finally {
      try {
        rmSync(result.jsonPath, { force: true });
      } catch {
        // 忽略临时文件删除失败
      }
    }
  });
}
