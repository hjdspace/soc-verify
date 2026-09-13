/**
 * 长来源分段 checkpoint（issue 10，spec §4）— 中断后从匹配的已完成段继续。
 *
 * spec §4：「checkpoint 键包括 sourceRevision、parsed/vision 指纹、schema/purpose、
 * 模型/提示与分块设置，**只恢复完全匹配的已完成块**」。
 *
 * 设计取舍：
 *  - 一个来源一个文件（`.kb/compile-checkpoints/<sourceId>.json`），文件内含完整指纹；
 *    指纹变化即忽略并重算（覆盖写），不产生无界文件堆积。
 *  - checkpoint 是**未发布模型中间产物**（spec §1）：可显式丢弃重算。编译成功时清除，
 *    因此它不是「成功缓存」（那属 issue 17）。
 *  - 只保存指纹与分析文本/累计摘要，不保存凭证、来源原件或请求头。
 */

import { readFile, rm, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileAtomic } from './atomic-commit';
import { wikiLayout } from './wiki-layout';

/** checkpoint 结构版本（结构变化即视为不兼容） */
export const LONG_SOURCE_CHECKPOINT_VERSION = 1;

/** 分块形状指纹输入（每段的源行范围） */
export type ChunkShape = { startLine: number; endLine: number };

/** checkpoint 键：来源 + parsed/视觉 + 规则 + 模型/提示 + 分块设置 */
export type LongSourceCheckpointKey = {
  version: number;
  sourceId: string;
  sourceRevision: string;
  parsedHash: string;
  /** 视觉/图像解读指纹（本期未接入视觉 → null；字段先占位，口径不变更） */
  visionHash: string | null;
  schemaHash: string;
  purposeHash: string;
  modelFingerprint: string;
  promptVersion: number;
  chunkTargetTokens: number;
  chunkOverlapTokens: number;
  /** 分块形状指纹（段行范围）；分块变化 → 已完成块不再匹配 */
  chunkShapeHash: string;
};

/** 计算 checkpoint 键所需的输入 */
export type LongSourceCheckpointInput = Omit<LongSourceCheckpointKey, 'version' | 'chunkShapeHash'> & {
  chunks: readonly ChunkShape[];
};

export type LongSourceCheckpoint = {
  version: number;
  /** 全部指纹的 sha256（不匹配即不恢复） */
  fingerprint: string;
  key: LongSourceCheckpointKey;
  /** 已完成的段数（`analyses.length === completedThrough`） */
  completedThrough: number;
  /** 累计全局摘要（归并分析与恢复上下文用） */
  digest: string;
  /** 各段分析（按段序） */
  analyses: string[];
  updatedAt: string;
};

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/** 分块形状指纹：段边界变化（长度/行范围）即不同 */
export function chunkShapeHash(chunks: readonly ChunkShape[]): string {
  return sha256(chunks.map((c) => `${c.startLine}-${c.endLine}`).join('|'));
}

/** 由输入推导 checkpoint 键与总体指纹 */
export function longSourceCheckpointKey(input: LongSourceCheckpointInput): {
  key: LongSourceCheckpointKey;
  fingerprint: string;
} {
  const key: LongSourceCheckpointKey = {
    version: LONG_SOURCE_CHECKPOINT_VERSION,
    sourceId: input.sourceId,
    sourceRevision: input.sourceRevision,
    parsedHash: input.parsedHash,
    visionHash: input.visionHash,
    schemaHash: input.schemaHash,
    purposeHash: input.purposeHash,
    modelFingerprint: input.modelFingerprint,
    promptVersion: input.promptVersion,
    chunkTargetTokens: input.chunkTargetTokens,
    chunkOverlapTokens: input.chunkOverlapTokens,
    chunkShapeHash: chunkShapeHash(input.chunks),
  };
  const canonical = [
    key.version,
    key.sourceId,
    key.sourceRevision,
    key.parsedHash,
    key.visionHash ?? '-',
    key.schemaHash,
    key.purposeHash,
    key.modelFingerprint,
    key.promptVersion,
    key.chunkTargetTokens,
    key.chunkOverlapTokens,
    key.chunkShapeHash,
  ].join('\u0000');
  return { key, fingerprint: sha256(canonical) };
}

/** checkpoint 文件路径（.kb/compile-checkpoints/<sourceId>.json） */
export function longSourceCheckpointPath(kbPath: string, sourceId: string): string {
  return join(wikiLayout(kbPath).compileCheckpointsDir, `${sourceId}.json`);
}

function isRecord(u: unknown): u is Record<string, unknown> {
  return typeof u === 'object' && u !== null && !Array.isArray(u);
}

function parseKey(value: unknown): LongSourceCheckpointKey | null {
  if (!isRecord(value)) return null;
  const str = (k: string): string | null => (typeof value[k] === 'string' ? (value[k] as string) : null);
  const num = (k: string): number | null =>
    typeof value[k] === 'number' && Number.isFinite(value[k] as number) ? (value[k] as number) : null;
  const visionHash = value.visionHash === null ? null : str('visionHash');
  const version = num('version');
  const promptVersion = num('promptVersion');
  const chunkTargetTokens = num('chunkTargetTokens');
  const chunkOverlapTokens = num('chunkOverlapTokens');
  if (
    version === null
    || promptVersion === null
    || chunkTargetTokens === null
    || chunkOverlapTokens === null
  ) {
    return null;
  }
  const required = {
    sourceId: str('sourceId'),
    sourceRevision: str('sourceRevision'),
    parsedHash: str('parsedHash'),
    schemaHash: str('schemaHash'),
    purposeHash: str('purposeHash'),
    modelFingerprint: str('modelFingerprint'),
    chunkShapeHash: str('chunkShapeHash'),
  };
  if (Object.values(required).some((v) => v === null)) return null;
  return {
    version,
    sourceId: required.sourceId as string,
    sourceRevision: required.sourceRevision as string,
    parsedHash: required.parsedHash as string,
    visionHash,
    schemaHash: required.schemaHash as string,
    purposeHash: required.purposeHash as string,
    modelFingerprint: required.modelFingerprint as string,
    promptVersion,
    chunkTargetTokens,
    chunkOverlapTokens,
    chunkShapeHash: required.chunkShapeHash as string,
  };
}

/** 结构校验（坏文件一律 null；调用方按「无 checkpoint」重算） */
export function parseLongSourceCheckpoint(raw: unknown): LongSourceCheckpoint | null {
  if (!isRecord(raw)) return null;
  if (raw.version !== LONG_SOURCE_CHECKPOINT_VERSION) return null;
  if (typeof raw.fingerprint !== 'string' || raw.fingerprint.length === 0) return null;
  if (typeof raw.completedThrough !== 'number' || !Number.isInteger(raw.completedThrough)) return null;
  if (typeof raw.digest !== 'string') return null;
  if (!Array.isArray(raw.analyses) || raw.analyses.some((a) => typeof a !== 'string')) return null;
  if (typeof raw.updatedAt !== 'string') return null;
  const key = parseKey(raw.key);
  if (!key) return null;
  return {
    version: raw.version,
    fingerprint: raw.fingerprint,
    key,
    completedThrough: raw.completedThrough,
    digest: raw.digest,
    analyses: raw.analyses as string[],
    updatedAt: raw.updatedAt,
  };
}

/**
 * 读取 checkpoint：仅当**完全匹配**（指纹一致、段数一致、已完成数与分析条数自洽）
 * 时返回，否则 null（不匹配重算，不把旧结论拼到新来源上）。
 */
export async function loadLongSourceCheckpoint(
  kbPath: string,
  sourceId: string,
  expected: { key: LongSourceCheckpointKey; fingerprint: string; chunkTotal: number },
): Promise<LongSourceCheckpoint | null> {
  let parsed: LongSourceCheckpoint | null = null;
  try {
    const raw = await readFile(longSourceCheckpointPath(kbPath, sourceId), 'utf-8');
    parsed = parseLongSourceCheckpoint(JSON.parse(raw));
  } catch {
    return null;
  }
  if (!parsed) return null;
  if (parsed.fingerprint !== expected.fingerprint) return null;
  if (parsed.key.chunkShapeHash !== expected.key.chunkShapeHash) return null;
  if (parsed.completedThrough < 0 || parsed.completedThrough > expected.chunkTotal) return null;
  if (parsed.analyses.length !== parsed.completedThrough) return null;
  return parsed;
}

/** 原子写入 checkpoint（每段完成后调用；下次运行只重做未完成段） */
export async function saveLongSourceCheckpoint(
  kbPath: string,
  sourceId: string,
  checkpoint: LongSourceCheckpoint,
): Promise<void> {
  const path = longSourceCheckpointPath(kbPath, sourceId);
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, JSON.stringify(checkpoint, null, 2));
}

/** 丢弃 checkpoint（编译成功后调用；幂等） */
export async function clearLongSourceCheckpoint(kbPath: string, sourceId: string): Promise<void> {
  try {
    await rm(longSourceCheckpointPath(kbPath, sourceId), { force: true });
  } catch {
    // 丢弃是尽力而为：残留的 checkpoint 在指纹不符时会被忽略
  }
}
