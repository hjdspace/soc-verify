/**
 * KB Atomic Commit — 多文件提交原语（issue 01 spike 产物）。
 *
 * 目标：把「写清单 → 写临时文件 → 逐个替换 → 完成标记」做成可恢复的
 * 最小事务，为后继发布切片（spec §6）提供机制，不实现通用事务框架。
 *
 * 布局（库根内）：
 *   .kb/transactions/<txId>/
 *     manifest.json          { txId, state: prepared|committed, writes[], meta? }
 *     before/before-<i>.bin  被替换目标的旧内容（新建目标无此文件）
 *     after/after-<i>.bin    新内容（rename 的数据源）
 *
 * `meta` 是调用方附加的审计字段（如发布的读/写集 hash、目标 revision），
 * 原样持久、原样保留，供恢复与审计读取。
 *
 * 恢复语义（recoverTransactions，应用启动/重开库时调用）：
 *   - manifest 缺失      → 意向未持久化，任何 rename 都未发生 → 清理 tx 目录（完整旧版）
 *   - manifest 损坏      → 保留损坏副本并报告，不静默清理（spec §5）
 *   - state=prepared     → 尽量 roll-forward：逐个 rename 剩余 after 文件；
 *                          after 文件缺失且目标内容与预期 hash 不符 → 整体回滚
 *                          （还原 before 镜像 / 删除新建文件）→ 完整旧版
 *   - state=committed    → 仅清理 tx 目录
 *
 * 失败不会被报告为成功：completeCommit 中的 rename 失败会立即在进程内
 * 回滚（还原已应用的写入）并返回 { ok: false }；只读目录/只读目标/
 * 目标被目录占位等写失败都走此路径。
 *
 * 单次 rename 原子性不能推广为整个目录事务；本原语只保证通过本应用
 * 接口的可见性（恢复到完整旧版或完整新版），无法约束外部进程直接读盘。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §6、§11（路径与事务 spike）
 */

import { join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, readdir, stat, realpath } from 'node:fs/promises';
import { validateManagedRelPath, ensureRealPathWithinRoot } from './path-guard';

// ── 类型 ────────────────────────────────────────────────────────

export type AtomicCommitError = {
  code: 'pathRejected' | 'ioError' | 'txNotFound' | 'manifestCorrupted';
  message: string;
};

export type AtomicCommitResult = { ok: true } | { ok: false; error: AtomicCommitError };

export type AtomicWritePlan = {
  /** 事务 ID；仅允许 [A-Za-z0-9._-]，由调用方生成（如 commitId） */
  txId: string;
  /** 相对库根的写入目标与新内容（UTF-8 文本） */
  writes: Array<{ relPath: string; content: string }>;
  /**
   * 额外的审计字段，原样持久进事务清单（spec §6：清单要记读/写集 hash、
   * 目标 revision 等；发布方在规划时算好，恢复时无需重算）。
   */
  meta?: Record<string, unknown>;
};

export type PreparedCommit = {
  txId: string;
  /** 事务目录绝对路径（库根内 .kb/transactions/<txId>） */
  txDir: string;
};

type TxWriteRecord = {
  relPath: string;
  /** 旧内容镜像文件名；新建目标为 null */
  beforeFile: string | null;
  /** 新内容镜像文件名 */
  afterFile: string;
  /** 新内容 SHA256（hex），roll-forward 时验证已应用目标 */
  afterHash: string;
};

type TxManifest = {
  txId: string;
  state: 'prepared' | 'committed';
  writes: TxWriteRecord[];
  /** 调用方附加的审计字段（读/写集 hash、目标 revision 等），原样保留 */
  meta?: Record<string, unknown>;
};

export type RecoveryReport = {
  /** 清理掉的未持久化/已提交事务数 */
  cleaned: number;
  /** roll-forward 完成的新版事务数 */
  rolledForward: number;
  /** 回滚到旧版的事务数 */
  rolledBack: number;
  /** 无法自动恢复的事务描述（损坏 manifest 等），目录原样保留 */
  failures: string[];
};

// ── 基础设施 ────────────────────────────────────────────────────

const TX_ROOT = join('.kb', 'transactions');
const TX_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * 单文件原子写：先写同目录临时文件，再 rename 到目标。
 * 临时文件残留时由调用方/恢复逻辑清理；rename 失败时删除临时文件。
 */
export async function writeFileAtomic(filePath: string, content: string | Buffer): Promise<void> {
  const tmpPath = `${filePath}.tmp-${randomUUID()}`;
  try {
    await writeFile(tmpPath, content);
    await rename(tmpPath, filePath);
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }
}

function txDirOf(rootDir: string, txId: string): string {
  return join(rootDir, TX_ROOT, txId);
}

// ── 提交 ────────────────────────────────────────────────────────

/**
 * 阶段一：持久化事务意向。
 *
 * 依次：词法校验全部目标 → 创建目标父目录并做 realpath 围栏 →
 * 读取 before 镜像 → 写入 after 镜像 → 原子写 manifest（prepared）。
 * manifest 落盘前发生的崩溃不留下任何目标改动。
 */
export async function prepareCommit(rootDir: string, plan: AtomicWritePlan): Promise<AtomicCommitResult & { prepared?: PreparedCommit }> {
  if (!TX_ID_PATTERN.test(plan.txId)) {
    return { ok: false, error: { code: 'pathRejected', message: `非法事务 ID: ${plan.txId}` } };
  }
  if (plan.writes.length === 0) {
    return { ok: false, error: { code: 'pathRejected', message: '事务没有任何写入目标' } };
  }

  // 1. 词法校验 + 目标去重
  const normalizedTargets = new Set<string>();
  const normalized: Array<{ relPath: string; normalized: string; content: string }> = [];
  for (const w of plan.writes) {
    const check = validateManagedRelPath(w.relPath);
    if (!check.ok) {
      return { ok: false, error: { code: 'pathRejected', message: check.reason } };
    }
    if (normalizedTargets.has(check.normalized)) {
      return { ok: false, error: { code: 'pathRejected', message: `事务内重复目标: ${w.relPath}` } };
    }
    normalizedTargets.add(check.normalized);
    normalized.push({ relPath: w.relPath, normalized: check.normalized, content: w.content });
  }

  // 2. 库根 realpath（后续围栏都相对真实根计算）
  let realRoot: string;
  try {
    realRoot = await realpathOf(rootDir);
  } catch (err) {
    return { ok: false, error: { code: 'ioError', message: `库根不可访问: ${String(err)}` } };
  }

  // 3. 创建目标父目录 + realpath 围栏（junction/symlink 逃逸在此拒绝，
  //    此时还没有任何镜像落盘）
  for (const w of normalized) {
    const parentAbs = dirname(join(realRoot, w.normalized));
    try {
      await mkdir(parentAbs, { recursive: true });
    } catch (err) {
      return { ok: false, error: { code: 'ioError', message: `创建目标父目录失败: ${w.relPath} (${String(err)})` } };
    }
    const fence = await ensureRealPathWithinRoot(realRoot, parentAbs);
    if (!fence.ok) {
      return { ok: false, error: { code: 'pathRejected', message: `${w.relPath}: ${fence.reason}` } };
    }
  }

  // 4. 事务目录与镜像
  const txDir = txDirOf(realRoot, plan.txId);
  const beforeDir = join(txDir, 'before');
  const afterDir = join(txDir, 'after');
  try {
    await mkdir(beforeDir, { recursive: true });
    await mkdir(afterDir, { recursive: true });

    const records: TxWriteRecord[] = [];
    for (let i = 0; i < normalized.length; i++) {
      const w = normalized[i];
      const targetAbs = join(realRoot, w.normalized);
      const content = Buffer.from(w.content, 'utf-8');

      // before 镜像：目标已存在时必须先于任何 rename 持久化
      let beforeFile: string | null = null;
      try {
        const existing = await readFile(targetAbs);
        beforeFile = `before-${i}.bin`;
        await writeFile(join(beforeDir, beforeFile), existing);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }

      const afterFile = `after-${i}.bin`;
      await writeFile(join(afterDir, afterFile), content);
      records.push({ relPath: w.normalized, beforeFile, afterFile, afterHash: sha256(content) });
    }

    // 5. manifest（prepared）是「意向已持久化」的标记，原子写入
    const manifest: TxManifest = {
      txId: plan.txId,
      state: 'prepared',
      writes: records,
      ...(plan.meta !== undefined ? { meta: plan.meta } : {}),
    };
    await writeFileAtomic(join(txDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  } catch (err) {
    // 镜像阶段失败：目标尚未被触碰，清掉半成品事务目录即可
    await rm(txDir, { recursive: true, force: true });
    return { ok: false, error: { code: 'ioError', message: `准备事务失败: ${String(err)}` } };
  }

  return { ok: true, prepared: { txId: plan.txId, txDir } };
}

/**
 * 阶段二：应用写入并落完成标记。
 *
 * rename 逐个进行；任一失败立即进程内回滚（还原已应用写入），
 * 清理事务目录并返回失败——不把部分成功报告为成功。
 */
export async function completeCommit(rootDir: string, txId: string): Promise<AtomicCommitResult> {
  if (!TX_ID_PATTERN.test(txId)) {
    return { ok: false, error: { code: 'pathRejected', message: `非法事务 ID: ${txId}` } };
  }
  const realRoot = await realpathOf(rootDir).catch(() => null);
  if (!realRoot) {
    return { ok: false, error: { code: 'ioError', message: '库根不可访问' } };
  }
  const txDir = txDirOf(realRoot, txId);
  const manifestPath = join(txDir, 'manifest.json');

  let manifest: TxManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as TxManifest;
  } catch {
    return { ok: false, error: { code: 'txNotFound', message: `事务不存在或清单不可读: ${txId}` } };
  }

  if (manifest.state === 'committed') {
    // 上次已完成标记、清理未做：补清理即可
    await rm(txDir, { recursive: true, force: true });
    return { ok: true };
  }

  const applied: Array<{ record: TxWriteRecord; created: boolean }> = [];
  for (const record of manifest.writes) {
    const afterAbs = join(txDir, 'after', record.afterFile);
    const targetAbs = join(realRoot, record.relPath);
    try {
      await rename(afterAbs, targetAbs);
      applied.push({ record, created: record.beforeFile === null });
    } catch (err) {
      // 进程内回滚：还原本次已应用的写入，保持完整旧版
      await rollbackApplied(realRoot, txDir, applied);
      await rm(txDir, { recursive: true, force: true });
      return {
        ok: false,
        error: { code: 'ioError', message: `写入目标失败（已回滚）: ${record.relPath} (${String(err)})` },
      };
    }
  }

  // 完成标记：此后恢复只做清理
  try {
    const committed: TxManifest = { ...manifest, state: 'committed' };
    await writeFileAtomic(manifestPath, JSON.stringify(committed, null, 2));
  } catch (err) {
    // 标记写失败：目标已是完整新版；恢复逻辑会按 prepared roll-forward 补齐
    return { ok: false, error: { code: 'ioError', message: `完成标记写入失败: ${String(err)}` } };
  }

  await rm(txDir, { recursive: true, force: true });
  return { ok: true };
}

/** 一站式提交：prepare + complete。 */
export async function runAtomicCommit(rootDir: string, plan: AtomicWritePlan): Promise<AtomicCommitResult> {
  const prepared = await prepareCommit(rootDir, plan);
  if (!prepared.ok) return prepared;
  return completeCommit(rootDir, plan.txId);
}

// ── 恢复 ────────────────────────────────────────────────────────

/**
 * 恢复库根下所有未完结事务。应用启动/重开挂载库时调用。
 * 恢复完成前，调用方应暂停该库的读取/检索（spec §6 读取门禁由后继票接入）。
 */
export async function recoverTransactions(rootDir: string): Promise<RecoveryReport> {
  const report: RecoveryReport = { cleaned: 0, rolledForward: 0, rolledBack: 0, failures: [] };
  const realRoot = await realpathOf(rootDir).catch(() => null);
  if (!realRoot) return report;

  const txRoot = join(realRoot, TX_ROOT);
  let entries: string[];
  try {
    entries = await readdir(txRoot);
  } catch {
    return report; // 没有事务目录
  }

  for (const txId of entries) {
    const txDir = join(txRoot, txId);
    try {
      if (!(await stat(txDir)).isDirectory()) continue;
    } catch {
      continue;
    }
    const manifestPath = join(txDir, 'manifest.json');

    let manifest: TxManifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as TxManifest;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // 意向未持久化：rename 都发生在 manifest 之后，目标必然未被触碰
        await rm(txDir, { recursive: true, force: true });
        report.cleaned++;
      } else {
        // manifest 损坏：保留损坏副本并报告，禁止静默清空
        report.failures.push(`事务 ${txId} manifest 不可解析，已保留现场: ${String(err)}`);
      }
      continue;
    }

    if (manifest.txId !== txId || !Array.isArray(manifest.writes)) {
      report.failures.push(`事务 ${txId} manifest 内容非法，已保留现场`);
      continue;
    }

    if (manifest.state === 'committed') {
      await rm(txDir, { recursive: true, force: true });
      report.cleaned++;
      continue;
    }

    // state=prepared → 先尝试 roll-forward 到完整新版
    const forward = await tryRollForward(realRoot, txDir, manifest);
    if (forward.ok) {
      await rm(txDir, { recursive: true, force: true });
      report.rolledForward++;
      continue;
    }

    // roll-forward 不可行 → 回滚到完整旧版
    const rollbackOk = await rollbackFromManifest(realRoot, txDir, manifest);
    if (rollbackOk) {
      await rm(txDir, { recursive: true, force: true });
      report.rolledBack++;
    } else {
      report.failures.push(`事务 ${txId} 回滚未完全成功，已保留现场`);
    }
  }

  return report;
}

async function tryRollForward(
  realRoot: string,
  txDir: string,
  manifest: TxManifest,
): Promise<{ ok: true } | { ok: false }> {
  for (const record of manifest.writes) {
    const afterAbs = join(txDir, 'after', record.afterFile);
    const targetAbs = join(realRoot, record.relPath);
    let afterStat;
    try {
      afterStat = await stat(afterAbs);
    } catch {
      afterStat = null;
    }
    if (afterStat?.isFile()) {
      try {
        await rename(afterAbs, targetAbs);
      } catch {
        return { ok: false };
      }
      continue;
    }
    // after 镜像已不在：rename 可能已发生，用 hash 验证目标内容
    try {
      const targetStat = await stat(targetAbs);
      if (!targetStat.isFile()) return { ok: false };
      const bytes = await readFile(targetAbs);
      if (sha256(bytes) !== record.afterHash) return { ok: false };
    } catch {
      return { ok: false };
    }
  }
  return { ok: true };
}

async function rollbackFromManifest(
  realRoot: string,
  txDir: string,
  manifest: TxManifest,
): Promise<boolean> {
  let allOk = true;
  for (const record of manifest.writes) {
    const targetAbs = join(realRoot, record.relPath);
    try {
      if (record.beforeFile) {
        const beforeBytes = await readFile(join(txDir, 'before', record.beforeFile));
        await writeFile(targetAbs, beforeBytes);
      } else {
        // 新建目标：删除（rename 未发生时目标不存在，force 兜底）
        await rm(targetAbs, { force: true });
      }
    } catch {
      allOk = false;
    }
  }
  return allOk;
}

async function rollbackApplied(
  realRoot: string,
  txDir: string,
  applied: Array<{ record: TxWriteRecord; created: boolean }>,
): Promise<void> {
  for (const { record, created } of applied) {
    const targetAbs = join(realRoot, record.relPath);
    try {
      if (created) {
        await rm(targetAbs, { force: true });
      } else if (record.beforeFile) {
        const beforeBytes = await readFile(join(txDir, 'before', record.beforeFile));
        await writeFile(targetAbs, beforeBytes);
      }
    } catch {
      // 进程内回滚尽力而为；持久恢复由 recoverTransactions 兜底
    }
  }
}

// ── 内部工具 ────────────────────────────────────────────────────

function realpathOf(dir: string): Promise<string> {
  return realpath(dir);
}
