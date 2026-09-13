/**
 * Knowledge Base Registry — 注册表、挂载与旧格式处置管理。
 *
 * KB Registration（应用全局配置）：
 *   - 存储位置：`<userData>/socverify-data/kb-registry.json`
 *   - 空目录 → 初始化 wiki 布局（schema/purpose/raw/wiki/.kb + manifest）并登记
 *   - 已有 wiki 目录（.kb/manifest.json）→ 读取库内持久 kbId 登记登记；
 *     同 kbId 已登记在别的路径 = 复制库冲突，可 asCopy 赋新 kbId 注册为副本
 *   - 同一路径不能重复登记
 *   - 旧格式目录（sources/ + docs/）→ 移出活动使用，写处置记录（不删文件）
 *
 * kbId 与本机根路径分离：kbId 持久于库内 manifest，注册表保存 kbId → 路径
 * 映射。库目录移动后重新注册仍识别为同一身份；副本需要 asCopy 赋新 ID。
 *
 * 离线/权限不误判：目录不可访问（unreadable）保留登记并标记状态，
 * 绝不当作旧格式处置；处置只在目录可访问且探测确认 legacy 后发生。
 *
 * KB Mount（项目配置）：
 *   - 存储位置：`<projectRoot>/.socverify/kb-mounts.json`
 *   - v1 挂载数量上限 1，数据结构用列表预留多库
 *   - 挂载 wiki 库时执行 recoverTransactions（重开恢复）
 *
 * @see ADR 0034 — 知识库重构为 LLM Wiki 双层架构
 * @see ADR 0021 — anydoc 文档知识库（旧布局，已停用）
 */

import { app } from 'electron';
import { join, resolve } from 'node:path';
import { readFile, writeFile, mkdir, stat, realpath } from 'node:fs/promises';
import {
  initWikiLayout,
  detectKbFormat,
  readWikiManifest,
  updateWikiManifest,
  checkWikiHealth,
} from './wiki-layout';
import { recoverTransactions, type RecoveryReport } from './atomic-commit';
import type {
  KbRegistration,
  KbDisposal,
  KbFormat,
  KbMount,
  KbHealthStatus,
  KbWikiHealth,
  KbStatus,
  KbListEntry,
  KbErrorCode,
  KbError,
} from './types';

// ── 常量 ────────────────────────────────────────────────────────

const REGISTRY_FILE = 'kb-registry.json';
const DISPOSALS_FILE = 'kb-disposals.json';
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

/** 处置记录文件路径 */
function getDisposalsPath(): string {
  return join(getGlobalDataDir(), DISPOSALS_FILE);
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

/** 生成不与现有登记冲突的 kbId */
function generateUniqueKbId(name: string, existing: KbRegistration[]): string {
  const base = generateKbId(name);
  if (!existing.some((e) => e.id === base)) return base;
  for (let i = 1; ; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.some((e) => e.id === candidate)) return candidate;
  }
}

/** 路径比较键：Windows 大小写不敏感 */
function samePathKey(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

// ── 注册表读写 ──────────────────────────────────────────────────

/** 读取全局注册表。旧版本条目缺 format 字段 → 补 'legacy'（登记时即为旧布局）。 */
async function loadRegistry(): Promise<KbRegistration[]> {
  try {
    const content = await readFile(getRegistryPath(), 'utf-8');
    const parsed = JSON.parse(content) as Array<KbRegistration & { format?: KbFormat }>;
    return parsed.map((e) => ({ ...e, format: e.format ?? 'legacy' }));
  } catch {
    return [];
  }
}

/** 写入全局注册表 */
async function saveRegistry(entries: KbRegistration[]): Promise<void> {
  await mkdir(getGlobalDataDir(), { recursive: true });
  await writeFile(getRegistryPath(), JSON.stringify(entries, null, 2), 'utf-8');
}

// ── 处置记录读写 ────────────────────────────────────────────────

async function loadDisposals(): Promise<KbDisposal[]> {
  try {
    const content = await readFile(getDisposalsPath(), 'utf-8');
    return JSON.parse(content) as KbDisposal[];
  } catch {
    return [];
  }
}

async function saveDisposals(disposals: KbDisposal[]): Promise<void> {
  await mkdir(getGlobalDataDir(), { recursive: true });
  await writeFile(getDisposalsPath(), JSON.stringify(disposals, null, 2), 'utf-8');
}

/**
 * 追加处置记录（按路径去重），返回是否有新增。
 * 处置不触碰磁盘——只做登记簿记录。
 */
async function addDisposal(record: KbDisposal): Promise<boolean> {
  const disposals = await loadDisposals();
  if (disposals.some((d) => samePathKey(d.path) === samePathKey(record.path))) {
    return false;
  }
  disposals.push(record);
  await saveDisposals(disposals);
  return true;
}

/**
 * 把确认旧格式的登记条目移出活动表：写处置记录 + 从注册表删除 +
 * 清理当前项目的挂载（其他项目打开时惰性处理）。
 */
async function disposeLegacyEntries(
  legacyEntries: KbRegistration[],
  projectRoot: string | null,
): Promise<void> {
  if (legacyEntries.length === 0) return;
  const now = Date.now();
  for (const entry of legacyEntries) {
    await addDisposal({
      id: entry.id,
      path: entry.path,
      name: entry.name,
      kbId: entry.id,
      reason: 'legacyFormat',
      detectedAt: now,
    });
  }
  const legacyIds = new Set(legacyEntries.map((e) => e.id));
  const entries = await loadRegistry();
  await saveRegistry(entries.filter((e) => !legacyIds.has(e.id)));

  if (projectRoot) {
    const mounts = await loadMounts(projectRoot);
    const filtered = mounts.filter((m) => !legacyIds.has(m.kbId));
    if (filtered.length !== mounts.length) {
      await saveMounts(projectRoot, filtered);
    }
  }
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

// ── 条目探测 ────────────────────────────────────────────────────

type EntryProbe =
  | { state: 'ok'; format: KbFormat }
  | { state: 'unreadable'; reason: string }
  | { state: 'structureChanged'; format: KbFormat; detected: string };

/**
 * 探测登记条目对应目录的当前状态。
 * 处置（移出活动表）只在探测确认 legacy 时发生；unreadable 一律保留登记。
 */
async function probeEntry(entry: KbRegistration): Promise<EntryProbe> {
  const detected = await detectKbFormat(entry.path);
  const entryFormat: KbFormat = entry.format ?? 'legacy';
  if (detected.kind === 'unreadable') {
    return { state: 'unreadable', reason: detected.error?.code ?? String(detected.error ?? 'unknown') };
  }
  if (detected.kind === 'wiki' || detected.kind === 'legacy') {
    if (detected.kind === entryFormat) {
      return { state: 'ok', format: detected.kind };
    }
    return { state: 'structureChanged', format: entryFormat, detected: detected.kind };
  }
  return { state: 'structureChanged', format: entryFormat, detected: detected.kind };
}

const EMPTY_HEALTH: KbHealthStatus = { hasSources: false, hasDocs: false, hasIndex: false };

// ── 公开 API ────────────────────────────────────────────────────

type KbResult<T> = { ok: true; data: T } | { ok: false; error: KbError };

function makeError(code: KbErrorCode, message: string): KbError {
  return { code, message };
}

/** 注册选项 */
export type RegisterOptions = {
  /** 复制库冲突（同 kbId 不同路径）时赋新 kbId 注册为副本（写回 manifest） */
  asCopy?: boolean;
};

type RegisterSuccessData = KbRegistration & { disposedLegacy?: boolean };

/**
 * 注册知识库。
 *
 * - 空目录：初始化 wiki 布局并登记（kbId 持久于库内 manifest）
 * - wiki 目录：读取 manifest kbId；同路径拒绝重复登记；
 *   kbId 与已有登记冲突 = 复制库 → 拒绝或 asCopy 赋新 ID
 * - 旧格式目录：不登记，写处置记录并返回 legacyFormat 错误（不删文件）
 * - 不可访问目录：返回 pathUnreadable（离线/权限），绝不按旧格式处置
 */
async function register(
  name: string,
  kbPath: string,
  options: RegisterOptions = {},
): Promise<KbResult<RegisterSuccessData>> {
  // 1. 路径存在且是目录；区分不存在 vs 不可访问
  try {
    const s = await stat(kbPath);
    if (!s.isDirectory()) {
      return { ok: false, error: makeError('pathNotDirectory', '路径不是目录') };
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { ok: false, error: makeError('pathNotFound', '路径不存在') };
    }
    return {
      ok: false,
      error: makeError('pathUnreadable', `库目录不可访问（离线或权限不足）: ${kbPath} (${code ?? String(err)})`),
    };
  }

  // 2. 真实路径归一（junction/symlink 落到真实位置再比较）
  const realPath = await realpath(kbPath).catch(() => resolve(kbPath));

  const existing = await loadRegistry();

  // 3. 同一路径不能重复登记
  const dupPath = existing.find((e) => samePathKey(e.path) === samePathKey(realPath));
  if (dupPath) {
    return {
      ok: false,
      error: makeError('alreadyRegistered', `该路径已注册为知识库「${dupPath.name}」`),
    };
  }

  // 4. 同名拒绝（保持既有行为）
  const dupName = existing.find((e) => e.name === name);
  if (dupName) {
    return { ok: false, error: makeError('alreadyRegistered', `已存在同名知识库：${name}`) };
  }

  // 5. 格式探测与分支处理
  const detected = await detectKbFormat(realPath);

  if (detected.kind === 'unreadable') {
    const code = detected.error?.code;
    return {
      ok: false,
      error: makeError('pathUnreadable', `库目录不可访问（离线或权限不足）: ${realPath} (${code ?? 'unknown'})`),
    };
  }

  if (detected.kind === 'legacy') {
    // 旧格式：移出活动使用，保留处置路径（不删除任何文件）
    await addDisposal({
      id: `legacy-${Date.now()}`,
      path: realPath,
      name,
      kbId: null,
      reason: 'legacyFormat',
      detectedAt: Date.now(),
    });
    return {
      ok: false,
      error: makeError(
        'legacyFormat',
        '该目录是旧格式知识库（sources/ + docs/ 布局），已停用并保留处置记录；原文件未被删除。请在新建库中重新导入所需文档。',
      ),
    };
  }

  if (detected.kind === 'foreign') {
    return {
      ok: false,
      error: makeError('structureIncompatible', '目录不是可识别的知识库（含未知文件且没有库结构标记）'),
    };
  }

  if (detected.kind === 'empty') {
    // 空目录 → 初始化 wiki 布局
    const kbId = generateUniqueKbId(name, existing);
    const manifest = await initWikiLayout(realPath, { kbId, name });
    const entry: KbRegistration = {
      id: manifest.kbId,
      name,
      path: realPath,
      registeredAt: Date.now(),
      format: 'wiki',
    };
    existing.push(entry);
    await saveRegistry(existing);
    return { ok: true, data: entry };
  }

  // detected.kind === 'wiki'：读取库内持久身份
  const read = await readWikiManifest(realPath);
  if (!read.ok) {
    return {
      ok: false,
      error: makeError('manifestCorrupted', '库身份清单（.kb/manifest.json）损坏或结构非法，无法注册'),
    };
  }

  const manifestKbId = read.manifest.kbId;
  const conflict = existing.find((e) => e.id === manifestKbId);
  let finalKbId = manifestKbId;

  if (conflict) {
    if (!options.asCopy) {
      return {
        ok: false,
        error: makeError(
          'kbIdConflict',
          `该目录是已有知识库「${conflict.name}」的副本（库 ID 相同）。可作为副本注册（将获得新的库 ID 并写入该目录的 manifest）。`,
        ),
      };
    }
    // 副本注册：赋新 kbId + 名称写回 manifest
    finalKbId = generateUniqueKbId(name, existing);
    await updateWikiManifest(realPath, { kbId: finalKbId, name });
  }

  const entry: KbRegistration = {
    id: finalKbId,
    name,
    path: realPath,
    registeredAt: Date.now(),
    format: 'wiki',
  };
  existing.push(entry);
  await saveRegistry(existing);
  return { ok: true, data: entry };
}

/** 注销知识库（不删除任何文件） */
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

/**
 * 删除知识库。
 *
 * issue 01 范围外：删除库需要先展示受管资产/历史范围并拒绝在含未知
 * 文件的目录上递归删除。当前一律拒绝，注销（不删文件）仍可用。
 */
async function deleteKb(_kbId: string, _projectRoot: string): Promise<KbResult<void>> {
  return {
    ok: false,
    error: makeError('deleteNotSupported', '删除库功能尚未支持；请使用注销（不删除任何文件）'),
  };
}

/** 列出所有已注册的知识库（含格式与可达性状态） */
async function list(projectRoot: string): Promise<KbListEntry[]> {
  const entries = await loadRegistry();
  const mounts = await loadMounts(projectRoot);
  const mountedIds = new Set(mounts.map((m) => m.kbId));

  // 惰性处置：可访问且确认旧格式的条目移出活动表
  const confirmedLegacy: KbRegistration[] = [];
  const results: Array<KbListEntry & { _formatFixed?: boolean }> = [];

  for (const entry of entries) {
    const probe = await probeEntry(entry);
    if (probe.state === 'ok' && probe.format === 'legacy') {
      confirmedLegacy.push(entry);
      continue;
    }
    results.push({
      id: entry.id,
      name: entry.name,
      path: entry.path,
      registeredAt: entry.registeredAt,
      format: probe.state === 'ok' ? probe.format : entry.format ?? 'legacy',
      state: probe.state,
      ...(probe.state === 'unreadable' ? { stateReason: probe.reason } : {}),
      documentCount: 0,
      categoryCount: 0,
      isMounted: mountedIds.has(entry.id),
    });
  }

  if (confirmedLegacy.length > 0) {
    await disposeLegacyEntries(confirmedLegacy, projectRoot);
  }

  return results;
}

/** 挂载成功数据：挂载记录 + 事务恢复报告（wiki 库） */
export type MountSuccess = { mount: KbMount; recovery: RecoveryReport | null };

/** 挂载知识库到项目 */
async function mount(kbId: string, projectRoot: string): Promise<KbResult<MountSuccess>> {
  // 校验库已注册
  const entries = await loadRegistry();
  const entry = entries.find((e) => e.id === kbId);
  if (!entry) {
    return { ok: false, error: makeError('notRegistered', '知识库未注册') };
  }

  const mounts = await loadMounts(projectRoot);

  // 校验未重复挂载（先于探测与上限检查）
  if (mounts.some((m) => m.kbId === kbId)) {
    return { ok: false, error: makeError('alreadyMounted', '库已挂载到当前项目') };
  }

  // 探测目录状态：旧格式确认 → 处置并拒绝；离线 → 拒绝；结构变化 → 拒绝
  const probe = await probeEntry(entry);
  if (probe.state === 'ok' && probe.format === 'legacy') {
    await disposeLegacyEntries([entry], projectRoot);
    return {
      ok: false,
      error: makeError('legacyFormat', '该库是旧格式布局，已停用并保留处置记录；请新建库并重新导入文档'),
    };
  }
  if (probe.state === 'unreadable') {
    return {
      ok: false,
      error: makeError('pathUnreadable', `库目录不可访问（离线或权限不足）: ${entry.path} (${probe.reason})`),
    };
  }
  if (probe.state === 'structureChanged') {
    return {
      ok: false,
      error: makeError('structureIncompatible', `库目录内容与登记格式不符（当前探测为 ${probe.detected}）: ${entry.path}`),
    };
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

  // wiki 库挂载 = 重开：恢复未完结事务（完整旧版或完整新版）
  let recovery: RecoveryReport | null = null;
  try {
    recovery = await recoverTransactions(entry.path);
  } catch {
    recovery = null; // 恢复失败不阻塞挂载；事务现场保留，下次挂载重试
  }

  return { ok: true, data: { mount: newMount, recovery } };
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

/** 查询当前项目的挂载状态 + 健康检查 */
async function status(projectRoot: string): Promise<KbStatus> {
  const mounts = await loadMounts(projectRoot);
  const entries = await loadRegistry();

  const firstMount = mounts[0];
  if (!firstMount) {
    return { mounted: null, health: EMPTY_HEALTH, wikiHealth: null };
  }

  const entry = entries.find((e) => e.id === firstMount.kbId);
  if (!entry) {
    // 库已注销或已处置但挂载记录残留：处置记录可查 → 清理本项目挂载
    const disposals = await loadDisposals();
    if (disposals.some((d) => d.id === firstMount.kbId)) {
      await saveMounts(projectRoot, mounts.filter((m) => m.kbId !== firstMount.kbId));
    }
    return { mounted: null, health: EMPTY_HEALTH, wikiHealth: null };
  }

  const probe = await probeEntry(entry);

  // 确认旧格式：处置 + 清理本项目挂载（离线/结构变化保留挂载与登记）
  if (probe.state === 'ok' && probe.format === 'legacy') {
    await disposeLegacyEntries([entry], projectRoot);
    return { mounted: null, health: EMPTY_HEALTH, wikiHealth: null };
  }

  const mountedBase = {
    ...firstMount,
    name: entry.name,
    path: entry.path,
    format: probe.state === 'ok' ? probe.format : entry.format ?? 'legacy',
    state: probe.state,
  };

  if (probe.state === 'ok' && probe.format === 'wiki') {
    const wikiHealth: KbWikiHealth = await checkWikiHealth(entry.path);
    return { mounted: mountedBase, health: EMPTY_HEALTH, wikiHealth };
  }

  return { mounted: mountedBase, health: EMPTY_HEALTH, wikiHealth: null };
}

// ── 处置记录 API ────────────────────────────────────────────────

/** 列出旧格式处置记录 */
async function listDisposals(): Promise<KbDisposal[]> {
  return loadDisposals();
}

/** 移除处置记录（仅删除记录本身，不触碰库目录） */
async function dismissDisposal(disposalId: string): Promise<KbResult<void>> {
  const disposals = await loadDisposals();
  const next = disposals.filter((d) => d.id !== disposalId);
  if (next.length === disposals.length) {
    return { ok: false, error: makeError('notRegistered', '处置记录不存在') };
  }
  await saveDisposals(next);
  return { ok: true, data: undefined };
}

// ── 导出 ────────────────────────────────────────────────────────

export const kbRegistry = {
  register,
  unregister,
  deleteKb,
  list,
  listDisposals,
  dismissDisposal,
  mount,
  unmount,
  status,
};

export { MAX_MOUNTS };
