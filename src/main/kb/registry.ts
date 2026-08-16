/**
 * Knowledge Base Registry — 注册表与挂载管理。
 *
 * KB Registration（应用全局配置）：
 *   - 存储位置：`<userData>/socverify-data/kb-registry.json`
 *   - 注册空目录时初始化标准结构（sources/ docs/ index.md 骨架）
 *   - 注册已有目录时校验结构兼容（存在 sources/ 与 docs/ 即认可）
 *
 * KB Mount（项目配置）：
 *   - 存储位置：`<projectRoot>/.socverify/kb-mounts.json`
 *   - v1 挂载数量上限 1，数据结构用列表预留多库
 *   - 注销库前校验未被挂载
 *
 * @see ADR 0021 — anydoc 文档知识库
 */

import { app } from 'electron';
import { join } from 'node:path';
import { readFile, writeFile, mkdir, stat, rm } from 'node:fs/promises';
import {
  kbLayout,
  initKbLayout,
  checkKbHealth,
  countKbDocs,
  INDEX_MD_SKELETON,
} from './layout';
import type {
  KbRegistration,
  KbMount,
  KbListEntry,
  KbStatus,
  KbErrorCode,
  KbError,
} from './types';

// ── 常量 ────────────────────────────────────────────────────────

const REGISTRY_FILE = 'kb-registry.json';
const MOUNTS_FILE = 'kb-mounts.json';
const MAX_MOUNTS = 1;

// ── 辅助函数 ────────────────────────────────────────────────────

/** 应用全局数据目录 */
function getGlobalDataDir(): string {
  return join(app.getPath('userData'), 'socverify-data');
}

/** 注册表文件路径 */
function getRegistryPath(): string {
  return join(getGlobalDataDir(), REGISTRY_FILE);
}

/** 项目挂载配置文件路径 */
function getMountsPath(projectRoot: string): string {
  return join(projectRoot, '.socverify', MOUNTS_FILE);
}

/** 从库名生成 ID（slugify + 时间戳后 4 位防冲突） */
function generateKbId(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const suffix = String(Date.now()).slice(-4);
  return `${slug || 'kb'}-${suffix}`;
}

// INDEX_MD_SKELETON 由 layout.ts 单一拥有，此处不再维护副本

// ── 注册表读写 ──────────────────────────────────────────────────

/** 读取全局注册表 */
async function loadRegistry(): Promise<KbRegistration[]> {
  try {
    const content = await readFile(getRegistryPath(), 'utf-8');
    return JSON.parse(content) as KbRegistration[];
  } catch {
    return [];
  }
}

/** 写入全局注册表 */
async function saveRegistry(entries: KbRegistration[]): Promise<void> {
  await mkdir(getGlobalDataDir(), { recursive: true });
  await writeFile(getRegistryPath(), JSON.stringify(entries, null, 2), 'utf-8');
}

// ── 项目挂载读写 ────────────────────────────────────────────────

/** 读取项目的挂载列表 */
async function loadMounts(projectRoot: string): Promise<KbMount[]> {
  try {
    const content = await readFile(getMountsPath(projectRoot), 'utf-8');
    return JSON.parse(content) as KbMount[];
  } catch {
    return [];
  }
}

/** 写入项目的挂载列表 */
async function saveMounts(projectRoot: string, mounts: KbMount[]): Promise<void> {
  await mkdir(join(projectRoot, '.socverify'), { recursive: true });
  await writeFile(getMountsPath(projectRoot), JSON.stringify(mounts, null, 2), 'utf-8');
}

// ── 库结构校验与初始化 ──────────────────────────────────────────

// 库结构校验与初始化由 layout.ts 单一拥有（checkKbHealth / initKbLayout）

// ── 统计 ────────────────────────────────────────────────────────

// 统计逻辑由 layout.ts 的 countKbDocs 单一拥有

// ── 公开 API ────────────────────────────────────────────────────

type KbResult<T> = { ok: true; data: T } | { ok: false; error: KbError };

function makeError(code: KbErrorCode, message: string): KbError {
  return { code, message };
}

/** 注册知识库 */
async function register(name: string, kbPath: string): Promise<KbResult<KbRegistration>> {
  // 校验路径存在且是目录
  try {
    const s = await stat(kbPath);
    if (!s.isDirectory()) {
      return { ok: false, error: makeError('pathNotDirectory', '路径不是目录') };
    }
  } catch {
    return { ok: false, error: makeError('pathNotFound', '路径不存在') };
  }

  // 检查是否已注册（同名或同路径）
  const existing = await loadRegistry();
  const dup = existing.find(
    (e) => e.name === name || e.path === kbPath,
  );
  if (dup) {
    return {
      ok: false,
      error: makeError('alreadyRegistered', `知识库已注册（名称或路径重复）：${dup.name}`),
    };
  }

  // 检查目录结构是否兼容
  const health = checkKbHealth(kbPath);
  if (!health.hasSources || !health.hasDocs) {
    // 空目录 → 初始化标准结构
    await initKbLayout(kbPath);
  }
  // 有 sources/ 和 docs/ 但无 index.md → 补创建
  if (!health.hasIndex && health.hasSources && health.hasDocs) {
    const layout = kbLayout(kbPath);
    await writeFile(layout.indexMdPath, INDEX_MD_SKELETON, 'utf-8');
  }
  // 空目录初始化后 index.md 已创建

  const entry: KbRegistration = {
    id: generateKbId(name),
    name,
    path: kbPath,
    registeredAt: Date.now(),
  };

  existing.push(entry);
  await saveRegistry(existing);

  return { ok: true, data: entry };
}

/** 注销知识库 */
async function unregister(kbId: string, projectRoot: string): Promise<KbResult<void>> {
  const existing = await loadRegistry();
  const entry = existing.find((e) => e.id === kbId);
  if (!entry) {
    return { ok: false, error: makeError('notRegistered', '知识库未注册') };
  }

  // 校验未被当前项目挂载
  const mounts = await loadMounts(projectRoot);
  if (mounts.some((m) => m.kbId === kbId)) {
    return {
      ok: false,
      error: makeError('alreadyMounted', '库已挂载到当前项目，请先卸载'),
    };
  }

  await saveRegistry(existing.filter((e) => e.id !== kbId));
  return { ok: true, data: undefined };
}

/** 删除知识库（注销注册 + 删除库目录全部内容） */
async function deleteKb(kbId: string, projectRoot: string): Promise<KbResult<void>> {
  const existing = await loadRegistry();
  const entry = existing.find((e) => e.id === kbId);
  if (!entry) {
    return { ok: false, error: makeError('notRegistered', '知识库未注册') };
  }

  // 先从所有项目的挂载记录中移除（当前项目）
  const mounts = await loadMounts(projectRoot);
  if (mounts.some((m) => m.kbId === kbId)) {
    await saveMounts(projectRoot, mounts.filter((m) => m.kbId !== kbId));
  }

  // 从注册表中删除
  await saveRegistry(existing.filter((e) => e.id !== kbId));

  // 删除库目录全部内容
  try {
    await rm(entry.path, { recursive: true, force: true });
  } catch {
    // 目录删除失败不阻塞——注册表已清理
  }

  return { ok: true, data: undefined };
}

/** 列出所有已注册的知识库（含统计） */
async function list(projectRoot: string): Promise<KbListEntry[]> {
  const entries = await loadRegistry();
  const mounts = await loadMounts(projectRoot);
  const mountedIds = new Set(mounts.map((m) => m.kbId));

  const result: KbListEntry[] = [];
  for (const entry of entries) {
    const { documentCount, categoryCount } = await countKbDocs(entry.path);
    result.push({
      id: entry.id,
      name: entry.name,
      path: entry.path,
      registeredAt: entry.registeredAt,
      documentCount,
      categoryCount,
      isMounted: mountedIds.has(entry.id),
    });
  }
  return result;
}

/** 挂载知识库到项目 */
async function mount(kbId: string, projectRoot: string): Promise<KbResult<KbMount>> {
  // 校验库已注册
  const entries = await loadRegistry();
  const entry = entries.find((e) => e.id === kbId);
  if (!entry) {
    return { ok: false, error: makeError('notRegistered', '知识库未注册') };
  }

  const mounts = await loadMounts(projectRoot);

  // 校验未重复挂载（先于上限检查，确保重复挂载返回 alreadyMounted 而非 mountLimitExceeded）
  if (mounts.some((m) => m.kbId === kbId)) {
    return { ok: false, error: makeError('alreadyMounted', '库已挂载到当前项目') };
  }

  // 校验挂载数量上限
  if (mounts.length >= MAX_MOUNTS) {
    return {
      ok: false,
      error: makeError('mountLimitExceeded', `挂载上限 ${MAX_MOUNTS}，请先卸载当前库`),
    };
  }

  const newMount: KbMount = {
    kbId,
    mountedAt: Date.now(),
  };

  mounts.push(newMount);
  await saveMounts(projectRoot, mounts);

  return { ok: true, data: newMount };
}

/** 卸载知识库 */
async function unmount(kbId: string, projectRoot: string): Promise<KbResult<void>> {
  const mounts = await loadMounts(projectRoot);
  const exists = mounts.some((m) => m.kbId === kbId);
  if (!exists) {
    return { ok: false, error: makeError('notMounted', '库未挂载到当前项目') };
  }

  await saveMounts(projectRoot, mounts.filter((m) => m.kbId !== kbId));
  return { ok: true, data: undefined };
}

/** 查询当前项目的挂载状态 + 结构健康检查 */
async function status(projectRoot: string): Promise<KbStatus> {
  const mounts = await loadMounts(projectRoot);
  const entries = await loadRegistry();

  const firstMount = mounts[0];
  if (!firstMount) {
    return {
      mounted: null,
      health: { hasSources: false, hasDocs: false, hasIndex: false },
    };
  }

  const entry = entries.find((e) => e.id === firstMount.kbId);
  if (!entry) {
    // 库已注销但挂载记录残留
    return {
      mounted: null,
      health: { hasSources: false, hasDocs: false, hasIndex: false },
    };
  }

  const health = checkKbHealth(entry.path);

  return {
    mounted: {
      ...firstMount,
      name: entry.name,
      path: entry.path,
    },
    health,
  };
}

// ── 导出 ────────────────────────────────────────────────────────

export const kbRegistry = {
  register,
  unregister,
  deleteKb,
  list,
  mount,
  unmount,
  status,
};

export { MAX_MOUNTS };
