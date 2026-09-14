/**
 * KB Compile Cache — 按已发布结果执行增量跳过（issue 17，spec §4）。
 *
 * spec §4 成功缓存语义：
 *  - 成功缓存记录 sourceRevision + 转换/视觉/schema/purpose/编译指纹 + 读依赖
 *    + 已发布产出清单。
 *  - 命中还需验证产出存在和来源修订未失效。
 *  - 待审阅不记成功；全拒绝记录本次决定，普通刷新不重新烧 token；用户显式
 *    重编译创建新尝试。
 *  - 部分接受标为 `published_partial`，不冒充完整成功缓存。
 *  - 接受后衍生索引失败只重试索引，不重跑编译。
 *
 * 缓存文件位于 `.kb/compile-cache/<sourceId>.json`，是派生数据（spec §1）：
 * 可重建，损坏不能影响原件或已发布知识。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §4（编译内核与增量）
 * @see D:/AI/llm_wiki/src/lib/ingest-cache.ts R03（参考实现，缺配置指纹与审批语义）
 */

import { readFile, rm, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileAtomic } from './atomic-commit';
import { wikiLayout, readWikiManifest } from './wiki-layout';

// ── 类型 ────────────────────────────────────────────────────────

/** 缓存指纹计算输入：所有参与缓存判定的因子 */
export type CompileCacheFingerprintInput = {
  sourceId: string;
  sourceRevision: string;
  parsedHash: string;
  /** 视觉附录指纹（无附录为 null） */
  visionHash: string | null;
  schemaHash: string;
  purposeHash: string;
  /** 模型配置指纹（model 字符串即可） */
  modelFingerprint: string;
  /** 读依赖哈希（编译时读取的已发布页/索引的聚合 hash） */
  readDependencyHash: string;
  /** 编译时已发布的 pageId 列表（排序后参与指纹） */
  publishedPageIds: string[];
};

/** 持久化的缓存条目 */
export type CompileCacheEntry = {
  /** 指纹（与当前输入计算的指纹比对） */
  fingerprint: string;
  sourceId: string;
  sourceRevision: string;
  /** 发布产出的 pageId 列表（命中时验证文件存在） */
  publishedPageIds: string[];
  /** 发布时间（ISO 8601） */
  publishedAt: string;
  /**
   * 是否部分发布（published_partial）。
   * true → 不冒充完整成功缓存，checkCompileCache 返回 miss。
   */
  partial: boolean;
};

/** 全拒绝记录（避免普通刷新重新烧 token） */
export type RejectionEntry = {
  sourceId: string;
  sourceRevision: string;
  rejectedAt: string;
};

/** checkCompileCache 结果 */
export type CheckCompileCacheResult =
  | { hit: true; entry: CompileCacheEntry }
  | { hit: false; reason: string };

/** checkRejection 结果 */
export type CheckRejectionResult =
  | { rejected: true; entry: RejectionEntry }
  | { rejected: false };

// ── 常量 ────────────────────────────────────────────────────────

/** 缓存结构版本（结构变化即视为不兼容） */
export const COMPILE_CACHE_VERSION = 1;

// ── 指纹计算 ────────────────────────────────────────────────────

/**
 * 计算缓存指纹。
 *
 * 所有因子参与 sha256：来源修订、parsed/视觉指纹、schema/purpose、
 * 模型配置、读依赖与已发布产出清单。任一因子变化 → 指纹不同 → 缓存失效。
 */
export function computeCacheFingerprint(input: CompileCacheFingerprintInput): string {
  const canonical = [
    COMPILE_CACHE_VERSION,
    input.sourceId,
    input.sourceRevision,
    input.parsedHash,
    input.visionHash ?? '-',
    input.schemaHash,
    input.purposeHash,
    input.modelFingerprint,
    input.readDependencyHash,
    [...input.publishedPageIds].sort().join(','),
  ].join('\u0000');
  return createHash('sha256').update(canonical, 'utf-8').digest('hex');
}

// ── 路径 ────────────────────────────────────────────────────────

function cacheFilePath(kbPath: string, sourceId: string): string {
  return join(wikiLayout(kbPath).kbDir, 'compile-cache', `${sourceId}.json`);
}

function rejectionFilePath(kbPath: string, sourceId: string): string {
  return join(wikiLayout(kbPath).kbDir, 'compile-cache', `${sourceId}.rejection.json`);
}

// ── 缓存检查 ────────────────────────────────────────────────────

function isRecord(u: unknown): u is Record<string, unknown> {
  return typeof u === 'object' && u !== null && !Array.isArray(u);
}

function parseCacheEntry(raw: unknown): CompileCacheEntry | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.fingerprint !== 'string' || raw.fingerprint.length === 0) return null;
  if (typeof raw.sourceId !== 'string') return null;
  if (typeof raw.sourceRevision !== 'string') return null;
  if (!Array.isArray(raw.publishedPageIds) || raw.publishedPageIds.some((p) => typeof p !== 'string')) return null;
  if (typeof raw.publishedAt !== 'string') return null;
  if (typeof raw.partial !== 'boolean') return null;
  return {
    fingerprint: raw.fingerprint,
    sourceId: raw.sourceId,
    sourceRevision: raw.sourceRevision,
    publishedPageIds: raw.publishedPageIds as string[],
    publishedAt: raw.publishedAt,
    partial: raw.partial,
  };
}

function parseRejectionEntry(raw: unknown): RejectionEntry | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.sourceId !== 'string') return null;
  if (typeof raw.sourceRevision !== 'string') return null;
  if (typeof raw.rejectedAt !== 'string') return null;
  return {
    sourceId: raw.sourceId,
    sourceRevision: raw.sourceRevision,
    rejectedAt: raw.rejectedAt,
  };
}

/**
 * 检查缓存是否命中。
 *
 * 命中条件（全部满足）：
 *  1. 缓存文件存在且可解析
 *  2. 指纹与当前输入一致（所有因子相同）
 *  3. partial=false（published_partial 不冒充完整成功）
 *  4. 来源修订在 manifest 中仍为 currentRevision（来源未失效）
 *  5. 所有产出页面对应的文件存在
 *
 * 任一不满足 → miss，并返回可读原因。
 */
export async function checkCompileCache(
  kbPath: string,
  input: CompileCacheFingerprintInput,
): Promise<CheckCompileCacheResult> {
  let raw: string;
  try {
    raw = await readFile(cacheFilePath(kbPath, input.sourceId), 'utf-8');
  } catch {
    return { hit: false, reason: '无缓存文件' };
  }

  let parsed: CompileCacheEntry | null;
  try {
    parsed = parseCacheEntry(JSON.parse(raw));
    if (!parsed) return { hit: false, reason: '缓存文件损坏' };
  } catch {
    return { hit: false, reason: '缓存文件损坏' };
  }

  // 指纹比对
  const currentFingerprint = computeCacheFingerprint(input);
  if (parsed.fingerprint !== currentFingerprint) {
    return { hit: false, reason: '指纹不匹配（来源/转换/规则/模型/读依赖等已变化）' };
  }

  // published_partial 不冒充完整成功
  if (parsed.partial) {
    return { hit: false, reason: '缓存为 published_partial，不冒充完整成功' };
  }

  // 来源修订未失效：manifest 中的 currentRevision 必须与缓存记录一致
  const manifestRes = await readWikiManifest(kbPath);
  if (!manifestRes.ok) {
    return { hit: false, reason: '库 manifest 不可读' };
  }
  const sourceRec = manifestRes.manifest.sources?.[input.sourceId];
  if (!sourceRec) {
    return { hit: false, reason: '来源已不存在' };
  }
  if (sourceRec.currentRevision !== input.sourceRevision) {
    return { hit: false, reason: '来源修订已更新' };
  }

  // 验证产出文件存在
  for (const pageId of parsed.publishedPageIds) {
    const pagePath = join(wikiLayout(kbPath).wikiDir, `${pageId}.md`);
    try {
      const s = await stat(pagePath);
      if (!s.isFile()) {
        return { hit: false, reason: `产出文件不存在: wiki/${pageId}.md` };
      }
    } catch {
      return { hit: false, reason: `产出文件不存在: wiki/${pageId}.md` };
    }
  }

  return { hit: true, entry: parsed };
}

// ── 缓存保存 ────────────────────────────────────────────────────

/**
 * 保存编译成功缓存。
 *
 * 仅在完整发布成功后调用（publishChangeSet 成功且 partial=false）。
 * published_partial 时调用方应传 partial=true，checkCompileCache 会跳过它。
 */
export async function saveCompileCache(
  kbPath: string,
  sourceId: string,
  entry: CompileCacheEntry,
): Promise<void> {
  const path = cacheFilePath(kbPath, sourceId);
  await mkdir(join(wikiLayout(kbPath).kbDir, 'compile-cache'), { recursive: true });
  await writeFileAtomic(path, JSON.stringify(entry, null, 2));
}

// ── 缓存清除 ────────────────────────────────────────────────────

/**
 * 清除编译缓存与拒绝记录（幂等）。
 *
 * 场景：
 *  - 用户显式重编译（force）→ 清除旧缓存与拒绝记录，创建新尝试
 *  - 来源被删除 → 清除缓存
 */
export async function clearCompileCache(kbPath: string, sourceId: string): Promise<void> {
  try {
    await rm(cacheFilePath(kbPath, sourceId), { force: true });
  } catch {
    // 尽力而为
  }
  try {
    await rm(rejectionFilePath(kbPath, sourceId), { force: true });
  } catch {
    // 尽力而为
  }
}

// ── 全拒绝记录 ──────────────────────────────────────────────────

/**
 * 记录全拒绝决定。
 *
 * spec §4：「全拒绝记录本次决定，普通刷新不重新烧 token」。
 * 用户显式重编译（force）时调用 clearCompileCache 清除此记录。
 */
export async function recordRejection(
  kbPath: string,
  sourceId: string,
  sourceRevision: string,
  rejectedAt: string,
): Promise<void> {
  const entry: RejectionEntry = { sourceId, sourceRevision, rejectedAt };
  const path = rejectionFilePath(kbPath, sourceId);
  await mkdir(join(wikiLayout(kbPath).kbDir, 'compile-cache'), { recursive: true });
  await writeFileAtomic(path, JSON.stringify(entry, null, 2));
}

/**
 * 检查是否存在全拒绝记录。
 *
 * 返回 rejected=true 时，普通刷新应跳过编译（不烧 token）。
 * 来源修订变化时自动失效（旧拒绝不适用新修订）。
 */
export async function checkRejection(
  kbPath: string,
  sourceId: string,
  sourceRevision: string,
): Promise<CheckRejectionResult> {
  let raw: string;
  try {
    raw = await readFile(rejectionFilePath(kbPath, sourceId), 'utf-8');
  } catch {
    return { rejected: false };
  }

  let parsed: RejectionEntry | null;
  try {
    parsed = parseRejectionEntry(JSON.parse(raw));
    if (!parsed) return { rejected: false };
  } catch {
    return { rejected: false };
  }

  // 来源修订变化 → 旧拒绝不适用
  if (parsed.sourceRevision !== sourceRevision) {
    return { rejected: false };
  }

  return { rejected: true, entry: parsed };
}
