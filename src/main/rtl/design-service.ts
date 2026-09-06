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
  EMPTY_ANALYSIS,
  type DesignDatabase,
} from './design-db';
import { RtlElaborationError, elaborate } from './elaborator';
import { flattenFilelists, renderFlatFilelist } from './filelist';
import { extractDesign, extractTopUnits, normalizeSrc, type WriteJsonDoc } from './extractor';
import { analyzePorts, BUILTIN_AMBA_RULES } from './bundle-rules';
import type {
  BundleRule,
  BundleRuleDoc,
  DesignDefRow,
  DesignEdgeRow,
  DesignInstRow,
  DesignRefreshResult,
  DesignSourceConfig,
  DesignStatus,
  DesignSubgraphRow,
  ElaborationError,
  SubgraphNodeRow,
} from './types';

// ─── 配置持久化 ────────────────────────────────────────────

const DESIGN_DIR = '.socverify/design';

export function getDesignConfigPath(projectRoot: string): string {
  return join(projectRoot, DESIGN_DIR, 'config.json');
}

/** 检测到的 elaborated top units 缓存（顶层选择器记忆列表，story 17） */
export function getDesignTopsPath(projectRoot: string): string {
  return join(projectRoot, DESIGN_DIR, 'tops.json');
}

export function loadDetectedTops(projectRoot: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(getDesignTopsPath(projectRoot), 'utf-8')) as unknown;
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function saveDetectedTops(projectRoot: string, tops: string[]): void {
  mkdirSync(join(projectRoot, DESIGN_DIR), { recursive: true });
  writeFileSync(getDesignTopsPath(projectRoot), JSON.stringify(tops, null, 2), 'utf-8');
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

// ─── Protocol Bundle 规则（issue 04：自定义规则文件覆盖/扩展内置） ─────────

/** 自定义规则文件路径（项目级扩展点：覆盖内置规则 + 新增私有协议） */
export function getBundleRulesPath(projectRoot: string): string {
  return join(projectRoot, DESIGN_DIR, 'bundle-rules.json');
}

/**
 * 加载生效规则文档：`.socverify/design/bundle-rules.json` 存在时与内置合并
 * （同 id 覆盖、新 id 扩展；custom priority 在前），文件缺失/损坏回退纯内置。
 */
export function loadBundleRuleDoc(projectRoot: string): BundleRuleDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(getBundleRulesPath(projectRoot), 'utf-8'));
  } catch {
    return BUILTIN_AMBA_RULES;
  }
  const doc = raw as BundleRuleDoc;
  if (!Array.isArray(doc.rules) || !Array.isArray(doc.priority)) return BUILTIN_AMBA_RULES;
  return mergeRuleDocs(doc);
}

function mergeRuleDocs(custom: BundleRuleDoc): BundleRuleDoc {
  const rulesById = new Map<string, BundleRule>(BUILTIN_AMBA_RULES.rules.map((r) => [r.id, r]));
  for (const rule of custom.rules) {
    if (typeof rule?.id === 'string') rulesById.set(rule.id, rule);
  }
  const seen = new Set<string>();
  const priority: string[] = [];
  const push = (id: string): void => {
    if (rulesById.has(id) && !seen.has(id)) {
      priority.push(id);
      seen.add(id);
    }
  };
  for (const id of custom.priority) {
    if (typeof id === 'string') push(id);
  }
  for (const rule of BUILTIN_AMBA_RULES.rules) push(rule.id);
  for (const rule of custom.rules) push(rule.id);
  return { priority, rules: [...rulesById.values()] };
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
  // .finally() 返回的衍生 Promise 会继承 next 的 rejection；
  // 若 next 被拒绝（如 detectTops yosys 失败），该衍生 Promise 无人捕获
  // → 触发 unhandledRejection → 全局错误横幅误弹。
  // .catch(() => undefined) 吞掉衍生 rejection（cleanup 回调本身不抛异常）。
  next
    .finally(() => {
      if (inflight.get(projectId) === next) inflight.delete(projectId);
    })
    .catch(() => undefined);
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

/** 源文件 mtime 快照：path → mtimeMs；文件缺失记为 -1（增删文件同样触发过期） */
type SourceMtimes = Record<string, number>;

function collectMtimes(files: string[]): SourceMtimes {
  const out: SourceMtimes = {};
  for (const f of files) {
    try {
      out[f] = statSync(f).mtimeMs;
    } catch {
      out[f] = -1;
    }
  }
  return out;
}

/**
 * 源文件 mtime 相对上次 elaboration 是否变化（issue 03：提示过期，不自动重跑）。
 * 任一文件 mtime 与快照不一致（含文件出现/消失）即视为过期。
 */
function computeStale(db: DesignDatabase): boolean {
  const raw = getMetaSafe(db, 'sourceFiles');
  const storedRaw = getMetaSafe(db, 'sourceMtimes');
  if (!raw || !storedRaw) return false;
  let files: string[];
  let stored: SourceMtimes;
  try {
    files = JSON.parse(raw) as string[];
    stored = JSON.parse(storedRaw) as SourceMtimes;
  } catch {
    return false;
  }
  const current = collectMtimes(files);
  const keys = new Set([...Object.keys(stored), ...Object.keys(current)]);
  for (const k of keys) {
    if (Math.abs((current[k] ?? -1) - (stored[k] ?? -1)) > 1) return true;
  }
  return false;
}

// ─── 数据查询（tRPC 子树查询的底层） ─────────────────────────

function knownSourceFiles(db: DesignDatabase): string[] {
  const raw = getMetaSafe(db, 'sourceUnits') ?? getMetaSafe(db, 'sourceFiles');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((path): path is string => typeof path === 'string') : [];
  } catch {
    return [];
  }
}

function repairSource(src: string | null, db: DesignDatabase, projectRoot: string): string | null {
  return normalizeSrc(src, getDesignWorkDir(projectRoot), knownSourceFiles(db));
}

function repairInstSource(
  row: DesignInstRow | null,
  db: DesignDatabase,
  projectRoot: string,
): DesignInstRow | null {
  if (!row) return null;
  const src = repairSource(row.src, db, projectRoot);
  return src === row.src ? row : { ...row, src };
}

function repairDefSource(
  row: DesignDefRow | null,
  db: DesignDatabase,
  projectRoot: string,
): DesignDefRow | null {
  if (!row) return null;
  const src = repairSource(row.src, db, projectRoot);
  return src === row.src ? row : { ...row, src };
}

export function queryRoot(projectId: string, projectRoot: string): DesignInstRow | null {
  const db = getDesignDb(projectId, projectRoot);
  return repairInstSource(getRootInstance(db), db, projectRoot);
}

export function queryChildren(projectId: string, projectRoot: string, path: string): DesignInstRow[] {
  const db = getDesignDb(projectId, projectRoot);
  return getChildrenInstances(db, path).map((row) => repairInstSource(row, db, projectRoot)!);
}

export function queryInstance(projectId: string, projectRoot: string, path: string): DesignInstRow | null {
  const db = getDesignDb(projectId, projectRoot);
  return repairInstSource(getInstance(db, path), db, projectRoot);
}

export function queryDef(projectId: string, projectRoot: string, name: string): DesignDefRow | null {
  const db = getDesignDb(projectId, projectRoot);
  return repairDefSource(getDef(db, name), db, projectRoot);
}

export function queryDefs(projectId: string, projectRoot: string): DesignDefRow[] {
  const db = getDesignDb(projectId, projectRoot);
  return listDefs(db).map((row) => repairDefSource(row, db, projectRoot)!);
}

export function queryEdges(projectId: string, projectRoot: string, moduleName: string): DesignEdgeRow[] {
  return getDefEdges(getDesignDb(projectId, projectRoot), moduleName);
}

// ─── 框图子图查询（issue 05：任意模块为图根） ─────────────────

/**
 * 以 path 实例为图根的框图数据：直接子实例（box，带 def 端口表与打标）+
 * 图根 def 连线表（cells.inst 转完整实例路径）+ 图根打标。
 */
export function querySubgraph(projectId: string, projectRoot: string, path: string): DesignSubgraphRow {
  const db = getDesignDb(projectId, projectRoot);
  const inst = getInstance(db, path);
  if (!inst) {
    return { root: null, nodes: [], edges: [], bundles: EMPTY_ANALYSIS };
  }
  const def = getDef(db, inst.module);
  const children = getChildrenInstances(db, path);
  const repairedInst = repairInstSource(inst, db, projectRoot)!;
  const nodes: SubgraphNodeRow[] = children.map((c) => {
    const cdef = getDef(db, c.module);
    return {
      ...repairInstSource(c, db, projectRoot)!,
      ports: cdef?.ports ?? [],
      bundles: cdef?.bundles ?? EMPTY_ANALYSIS,
    };
  });
  // cells.inst 是 def 内 cell 名（如 u_subsys0 / gen_ip[0].u_ip）→ 图根 path + cell
  const edges: DesignEdgeRow[] = getDefEdges(db, inst.module).map((e) => ({
    ...e,
    cells: e.cells.map((c) => ({ inst: `${path}.${c.inst}`, port: c.port })),
  }));
  return {
    root: { ...repairedInst, ports: def?.ports ?? [] },
    nodes,
    edges,
    bundles: def?.bundles ?? EMPTY_ANALYSIS,
  };
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
      return fail(projectId, projectRoot, '未配置 Design Source：请先在「设计」视图配置 .f 文件列表');
    }
    if (!config.top) {
      return fail(projectId, projectRoot, '未选择顶层模块：请先检测并选择顶层');
    }

    const yosysPath = resolveYosysPath();
    if (!yosysPath) {
      return fail(projectId, projectRoot, 'yosys 不可用：请运行 npm run download:rtl-tools 安装 RTL 工具链');
    }
    const missingDlls = yosysMissingDlls() ?? [];
    if (missingDlls.length > 0) {
      return fail(projectId, projectRoot, `yosys 依赖 DLL 缺失: ${missingDlls.join(', ')}（必须与 exe 同目录，重新运行 npm run download:rtl-tools）`);
    }

    // 展开多 .f → 扁平清单（绝对路径）
    const absFilelists = config.filelists.map((f) => (isAbsolute(f) ? f : join(projectRoot, f)));
    let parsed;
    try {
      parsed = flattenFilelists(absFilelists, projectRoot);
    } catch (err) {
      return fail(projectId, projectRoot, err instanceof Error ? err.message : String(err));
    }
    if (parsed.sources.length === 0) {
      return fail(projectId, projectRoot, 'Design Source 未解析到任何源文件（检查 .f 配置）');
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
      design = extractDesign(doc, config.top, workDir, parsed.sources);
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

    // bundle 打标（提炼阶段语义层：自定义规则文件随每次刷新重新读取生效）
    const ruleDoc = loadBundleRuleDoc(projectRoot);
    for (const def of design.defs) {
      def.bundles = analyzePorts(def.ports, ruleDoc);
    }

    const sourceFiles = [...new Set(parsed.files)];
    const db = getDesignDb(projectId, projectRoot);
    replaceAll(db, design, {
      top: design.top,
      lastElaboratedAt: new Date().toISOString(),
      elapsedMs: String(Date.now() - started),
      sourceUnits: JSON.stringify([...new Set(parsed.sources)]),
      sourceFiles: JSON.stringify(sourceFiles),
      sourceMtimes: JSON.stringify(collectMtimes(sourceFiles)),
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

/**
 * 失败即持久化 lastError（含配置缺失/工具不可用/filelist 展开失败等前置失败）。
 * 否则 UI 刷新失败后会静默回退到「尚未 elaboration」空页面，用户无从得知原因。
 */
function fail(projectId: string, projectRoot: string, message: string): DesignRefreshResult {
  const error: ElaborationError = { message, diagnostics: [], logTail: '' };
  persistError(projectId, projectRoot, error);
  return { ok: false, error };
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
 *
 * 与 refresh 不同，检测阶段不写设计数据 DB（top 未定，提炼结果无意义），
 * 但失败时仍持久化 lastError —— 否则 UI 仅拿到 err.message（如「yosys 退出码 1」）
 * 而 logTail（实际 yosys 输出）和 diagnostics 全部丢失，用户无从诊断。
 */
export function detectTops(projectId: string, projectRoot: string): Promise<string[]> {
  return serialize(projectId, async (): Promise<string[]> => {
    const config = loadDesignConfig(projectRoot);
    if (config.filelists.length === 0) {
      const err = new RtlElaborationError('未配置 Design Source：请先配置 .f 文件列表', [], '');
      persistError(projectId, projectRoot, err.toElaborationError());
      throw err;
    }
    const yosysPath = resolveYosysPath();
    if (!yosysPath) {
      const err = new RtlElaborationError('yosys 不可用：请运行 npm run download:rtl-tools 安装 RTL 工具链', [], '');
      persistError(projectId, projectRoot, err.toElaborationError());
      throw err;
    }

    const absFilelists = config.filelists.map((f) => (isAbsolute(f) ? f : join(projectRoot, f)));
    let parsed;
    try {
      parsed = flattenFilelists(absFilelists, projectRoot);
    } catch (err) {
      const elabErr = new RtlElaborationError(err instanceof Error ? err.message : String(err), [], '');
      persistError(projectId, projectRoot, elabErr.toElaborationError());
      throw elabErr;
    }
    if (parsed.sources.length === 0) {
      const err = new RtlElaborationError('Design Source 未解析到任何源文件（检查 .f 配置）', [], '');
      persistError(projectId, projectRoot, err.toElaborationError());
      throw err;
    }

    const workDir = getDesignWorkDir(projectRoot);
    mkdirSync(workDir, { recursive: true });
    const flatPath = join(workDir, 'design_flat.f');
    writeFileSync(flatPath, renderFlatFilelist(parsed), 'utf-8');

    let result;
    try {
      result = await elaborate({ yosysPath, workDir, flatFilelistPath: flatPath, top: null });
    } catch (err) {
      const elabErr = err instanceof RtlElaborationError ? err : new RtlElaborationError(String(err), [], '');
      persistError(projectId, projectRoot, elabErr.toElaborationError());
      throw elabErr;
    }
    try {
      const doc = JSON.parse(readFileSync(result.jsonPath, 'utf-8')) as WriteJsonDoc;
      // extractTopUnits：过滤 uniquified 实例模块（--keep-hierarchy 产物），
      // 只留真实 elaborated top units（未被任何模块实例化的用户模块）
      const tops = extractTopUnits(doc);
      // 持久化检测结果：顶层选择器下次进入直接恢复候选列表（无需重新 elaboration）
      saveDetectedTops(projectRoot, tops);
      // 检测成功后清除上次失败残留的 lastError
      try {
        setLastError(getDesignDb(projectId, projectRoot), null);
      } catch {
        // DB 打开失败时忽略
      }
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
