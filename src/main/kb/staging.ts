/**
 * KB Staging — 知识提案的持久暂存与审阅选择（issue 05，spec §6）。
 *
 * 职责：
 *  1. 把经校验的 FILE 提案持久为变更集（`.kb/staging/<changeSetId>.json`）：
 *     保存 changeSetId、任务身份、read/write baseline、before/proposed、
 *     来源引用与知识待办结构化字段；
 *  2. 把用户逐 hunk/整页的选择持久到 `.kb/reviews/<changeSetId>.json`；
 *  3. 列表/读回 —— 重开仍可审阅。
 *
 * 本模块**不写 wiki/**：正式页、索引在审阅与发布（issue 06）前保持不变。
 * 发布写盘走 issue 06 的 `runAtomicCommit`，绕过 wiki write-guard 是预期的。
 *
 * 完整性门禁（本票范围内的部分）：重复目标、路径沙箱失败、坏
 * frontmatter 类型、来源页归属不符 —— 任一失败不落任何 staging 文件，
 * 不把部分结果报告为成功。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §4、§6
 */

import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFileProposal, readTypeDirs, validateProposalTarget } from './proposal-blocks';
import { parseWikiPage } from './wiki-page';
import { writeFileAtomic } from './atomic-commit';
import { wikiLayout } from './wiki-layout';
import { wikiPageDiffFingerprint } from '@shared/wiki-hunks';
import type {
  WikiChangeSet,
  WikiChangeSetOrigin,
  WikiChangeSetReview,
  WikiChangeSetSummary,
  WikiFinding,
  WikiSourceRef,
  WikiStagedPage,
  WikiStagingErrorCode,
  WikiStagingResult,
  WikiVisionGap,
} from '@shared/kb-types';

// ── 输入契约 ────────────────────────────────────────────────────

export type StageProposalInput = {
  kbId: string;
  /** 任务身份（queue taskId；saveQuery/fix 用合成 id） */
  taskId: string;
  origin: WikiChangeSetOrigin;
  /** 编译时固定的来源修订 */
  sourceRefs: WikiSourceRef[];
  /** 模型产出的 FILE 块文本（公开生产边界投递，无写库后门） */
  proposalText: string;
  /** 读依赖：本变更集参考过的已发布页（pageId + hash） */
  readBaseline?: Array<{ pageId: string; hash: string | null }>;
  /** 知识待办（issue 25 消费同一结构） */
  findings?: WikiFinding[];
  /**
   * 调用方预检警告（如编译管线的坏输出提示），随变更集一并持久化。
   * staging 自身校验产生的警告会追加在其后。
   */
  extraWarnings?: string[];
  /**
   * 源摘要归属由应用固定：若给出，则只接受该 pageId 的 source 页，
   * 其他来源页块被丢弃并记录警告（模型不能为别的 source 伪造来源页）。
   */
  fixedSourcePageId?: string;
  /**
   * 视觉缺口（issue 12）：用户明确选择仅按文字继续时列出未解读的资产。
   * 非空时 changeSet.partial=true（审阅可见「部分产出」徽标）。
   */
  visionGaps?: WikiVisionGap[];
  /** 测试/显式覆盖 schema/purpose hash；生产路径不传，由库内文件计算 */
  schemaHash?: string;
  /** 同上 */
  purposeHash?: string;
  /** 注入时钟（测试用） */
  now?: string;
};

export type StageProposalOutput = { changeSet: WikiChangeSet };

export type RecordDecisionInput = {
  changeSetId: string;
  /** 页 identity：库内相对路径 */
  pageRelPath: string;
  /** 被处置的 hunk 序号（新页/整块用 [0]） */
  hunkIds: number[];
  decision: 'accepted' | 'rejected';
};

// ── 错误工具 ────────────────────────────────────────────────────

function fail(code: WikiStagingErrorCode, message: string): { ok: false; error: { code: WikiStagingErrorCode; message: string } } {
  return { ok: false, error: { code, message } };
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

// ── staging 路径 ────────────────────────────────────────────────

function stagingFile(kbPath: string, changeSetId: string): string {
  return join(wikiLayout(kbPath).stagingDir, `${changeSetId}.json`);
}

function reviewFile(kbPath: string, changeSetId: string): string {
  return join(wikiLayout(kbPath).reviewsDir, `${changeSetId}.json`);
}

// ── staging ─────────────────────────────────────────────────────

/**
 * 接受一个 FILE 提案并持久为变更集。
 *
 * 顺序：解析块 → 逐块路径沙箱 → 读已发布 before/baseline →
 * 校验 frontmatter → 归属固定 → 原子写 staging 文件。
 * 任一步失败返回结构化错误且**不落任何 staging 文件**。
 */
export async function stageProposal(
  kbPath: string,
  input: StageProposalInput,
): Promise<WikiStagingResult<StageProposalOutput>> {
  const parsed = parseFileProposal(input.proposalText);
  if (!parsed.ok) {
    return fail(parsed.error.code, parsed.error.message);
  }

  const typeDirs = await readTypeDirs(kbPath);
  if (typeDirs === null) {
    return fail('schemaUnavailable', 'schema.md 无法解析，拒绝接受提案（不回退无约束）');
  }

  const layout = wikiLayout(kbPath);
  const warnings = [...(input.extraWarnings ?? []), ...parsed.warnings];
  const pages: WikiStagedPage[] = [];

  for (const file of parsed.files) {
    const check = await validateProposalTarget(kbPath, file.path, typeDirs);
    if (!check.ok) {
      return fail('invalidTarget', `提案目标不可写: ${file.path} — ${check.reason}`);
    }
    const relPath = check.relPath;
    const pageId = relPath.slice('wiki/'.length, -3);

    // 源摘要归属：应用固定 source 页路径
    if (input.fixedSourcePageId !== undefined && pageId.startsWith('sources/')) {
      if (pageId !== input.fixedSourcePageId) {
        warnings.push(
          `来源页归属不符：模型提议「${pageId}」，应用固定为「${input.fixedSourcePageId}」，该块被丢弃。`,
        );
        continue;
      }
    }

    // frontmatter 契约校验（坏类型/缺字段失败可见）
    const parse = parseWikiPage(file.content);
    if (!parse.ok) {
      return fail('invalidTarget', `提案页 frontmatter 非法: ${relPath} — ${parse.issues.map((i) => i.message).join('；')}`);
    }

    // 读已发布 before/baseline（拒绝读任意路径：relPath 已经过沙箱）
    const absPath = join(layout.kbPath, relPath);
    let before: string | null = null;
    try {
      before = await readFile(absPath, 'utf-8');
    } catch {
      before = null;
    }
    const baselineHash = before === null ? null : sha256Text(before);

    pages.push({
      relPath,
      pageId,
      type: parse.frontmatter.type,
      before,
      proposed: file.content,
      baselineHash,
      sources: parse.frontmatter.sources,
    });
  }

  if (pages.length === 0) {
    // 没有可发布候选（全被丢弃/全未闭合）：不落 staging，避免空提案
    return fail('invalidTarget', `提案没有任何可发布的页面候选。${warnings.join(' ')}`.trim());
  }

  const now = input.now ?? new Date().toISOString();
  const changeSet: WikiChangeSet = {
    changeSetId: randomUUID(),
    kbId: input.kbId,
    taskId: input.taskId,
    origin: input.origin,
    sources: input.sourceRefs,
    schemaHash: input.schemaHash ?? (await hashFileOrEmpty(layout.schemaMdPath)),
    purposeHash: input.purposeHash ?? (await hashFileOrEmpty(layout.purposeMdPath)),
    readBaseline: input.readBaseline ?? [],
    pages,
    findings: input.findings ?? [],
    warnings,
    // 视觉缺口（issue 12）：非空即部分产出（不冒充完整编译）
    visionGaps: input.visionGaps && input.visionGaps.length > 0 ? input.visionGaps : null,
    partial: (input.visionGaps?.length ?? 0) > 0,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await writeFileAtomic(stagingFile(kbPath, changeSet.changeSetId), JSON.stringify(changeSet, null, 2));
  } catch (err) {
    return fail('ioError', `写入 staging 失败: ${String(err)}`);
  }

  return { ok: true, value: { changeSet } };
}

async function hashFileOrEmpty(filePath: string): Promise<string> {
  try {
    return sha256Text(await readFile(filePath, 'utf-8'));
  } catch {
    return 'ABSENT';
  }
}

// ── 读回 ────────────────────────────────────────────────────────

export async function readChangeSet(
  kbPath: string,
  changeSetId: string,
): Promise<WikiStagingResult<WikiChangeSet>> {
  let raw: string;
  try {
    raw = await readFile(stagingFile(kbPath, changeSetId), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return fail('changeSetNotFound', `变更集不存在: ${changeSetId}`);
    }
    return fail('ioError', `读取 staging 失败: ${String(err)}`);
  }
  return parseChangeSetJson(raw, changeSetId);
}

function parseChangeSetJson(raw: string, changeSetId: string): WikiStagingResult<WikiChangeSet> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return fail('stagingCorrupted', `staging 文件损坏（保留现场，不静默清空）: ${changeSetId}`);
  }
  const cs = data as Partial<WikiChangeSet>;
  if (
    cs === null || typeof cs !== 'object'
    || typeof cs.changeSetId !== 'string'
    || typeof cs.kbId !== 'string'
    || !Array.isArray(cs.pages)
  ) {
    return fail('stagingCorrupted', `staging 结构非法: ${changeSetId}`);
  }
  return { ok: true, value: cs as WikiChangeSet };
}

/**
 * 列出某库的变更集摘要（kbId 不符的不列出，避免跨库泄漏）。
 * 损坏的 staging 文件跳过（保留现场，不阻断其余列表）。
 */
export async function listChangeSets(
  kbPath: string,
  kbId: string,
): Promise<WikiStagingResult<WikiChangeSetSummary[]>> {
  const layout = wikiLayout(kbPath);
  let entries: string[];
  try {
    entries = await readdir(layout.stagingDir);
  } catch {
    return { ok: true, value: [] };
  }
  const out: WikiChangeSetSummary[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    let raw: string;
    try {
      raw = await readFile(join(layout.stagingDir, name), 'utf-8');
    } catch {
      continue;
    }
    const parsed = parseChangeSetJson(raw, name.slice(0, -5));
    if (!parsed.ok) continue;
    const cs = parsed.value;
    if (cs.kbId !== kbId) continue;
    let settled = false;
    const review = await readReview(kbPath, cs.changeSetId);
    if (review.ok) settled = review.value.settled;
    out.push({
      changeSetId: cs.changeSetId,
      kbId: cs.kbId,
      taskId: cs.taskId,
      origin: cs.origin,
      pageCount: cs.pages.length,
      newPageCount: cs.pages.filter((p) => p.before === null).length,
      findingCount: cs.findings.length,
      settled,
      createdAt: cs.createdAt,
      updatedAt: cs.updatedAt,
    });
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { ok: true, value: out };
}

// ── 审阅选择 ────────────────────────────────────────────────────

/** 读取变更集审阅选择；不存在时返回空选择（全部 pending）。 */
export async function readReview(
  kbPath: string,
  changeSetId: string,
): Promise<WikiStagingResult<WikiChangeSetReview>> {
  const cs = await readChangeSet(kbPath, changeSetId);
  if (!cs.ok) return cs;
  let raw: string;
  try {
    raw = await readFile(reviewFile(kbPath, changeSetId), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, value: emptyReview(cs.value) };
    }
    return fail('ioError', `读取 reviews 失败: ${String(err)}`);
  }
  try {
    const parsed = JSON.parse(raw) as WikiChangeSetReview;
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.pages)) {
      return { ok: true, value: emptyReview(cs.value) };
    }
    return { ok: true, value: { ...parsed, settled: isSettled(cs.value, parsed) } };
  } catch {
    return { ok: true, value: emptyReview(cs.value) };
  }
}

function emptyReview(cs: WikiChangeSet): WikiChangeSetReview {
  return {
    changeSetId: cs.changeSetId,
    pages: cs.pages.map((p) => ({ pageId: p.pageId, relPath: p.relPath, hunkStates: {}, pageDecision: 'pending' as const })),
    settled: false,
    updatedAt: cs.createdAt,
  };
}

/**
 * 记录用户对某页若干 hunk 的选择并持久。
 * 未知变更集/未知页 → 结构化错误（不静默成功）。
 */
export async function recordDecision(
  kbPath: string,
  input: RecordDecisionInput,
): Promise<WikiStagingResult<WikiChangeSetReview>> {
  const cs = await readChangeSet(kbPath, input.changeSetId);
  if (!cs.ok) return cs;
  const page = cs.value.pages.find((p) => p.relPath === input.pageRelPath);
  if (!page) return fail('unknownPage', `变更集中不存在页: ${input.pageRelPath}`);

  const current = await readReview(kbPath, input.changeSetId);
  if (!current.ok) return current;
  const review = current.value;
  let pageReview = review.pages.find((p) => p.relPath === input.pageRelPath);
  if (!pageReview) {
    pageReview = { pageId: page.pageId, relPath: page.relPath, hunkStates: {}, pageDecision: 'pending' };
    review.pages.push(pageReview);
  }
  for (const hunkId of input.hunkIds) {
    pageReview.hunkStates[hunkId] = input.decision;
  }
  // 差异指纹随选择持久（issue 07）：发布前重算不一致 = 差异已重新生成，
  // 旧 hunk 决定失效（发布侧转 stale 并重置批准）。
  pageReview.hunksHash = wikiPageDiffFingerprint(page);

  const updated: WikiChangeSetReview = {
    ...review,
    settled: isSettled(cs.value, review),
    updatedAt: new Date().toISOString(),
  };
  try {
    await writeFileAtomic(reviewFile(kbPath, input.changeSetId), JSON.stringify(updated, null, 2));
  } catch (err) {
    return fail('ioError', `写入 reviews 失败: ${String(err)}`);
  }
  return { ok: true, value: updated };
}

/**
 * 是否所有页/块已明确处置。
 *
 * 本票的判定：每页至少有一个决定（新页/整块 = hunkId 0 处置）。
 * 逐 hunk 完整结算在 issue 06/07 的发布候选集计算中细化；
 * 这里只用于「settled」摘要与全拒绝路径不落盘的前提检查。
 */
function isSettled(cs: WikiChangeSet, review: WikiChangeSetReview): boolean {
  return cs.pages.every((p) => {
    const pr = review.pages.find((r) => r.relPath === p.relPath);
    if (!pr) return false;
    if (pr.pageDecision === 'accepted' || pr.pageDecision === 'rejected') return true;
    const states = Object.values(pr.hunkStates);
    return states.length > 0 && states.every((s) => s === 'accepted' || s === 'rejected');
  });
}

/**
 * 失效某变更集的旧批准（issue 06 发布前基线变动时调用）。
 *
 * 把全部 hunk/整页决策重置为 pending 并记录 stale 原因与检测时间：
 * 「变动转 stale 并失效旧批准」—— 失效后的批准不得再用于发布，
 * 必须重新生成差异并重新批准（不在批准之后悄悄做 LLM merge）。
 *
 * 只写 `.kb/reviews/`，不触碰 `wiki/`。
 */
export async function invalidateReview(
  kbPath: string,
  changeSetId: string,
  reasons: string[],
  now?: string,
): Promise<WikiStagingResult<WikiChangeSetReview>> {
  const current = await readReview(kbPath, changeSetId);
  if (!current.ok) return current;

  const at = now ?? new Date().toISOString();
  const invalidated: WikiChangeSetReview = {
    ...current.value,
    pages: current.value.pages.map((p) => ({
      ...p,
      hunkStates: Object.fromEntries(
        Object.keys(p.hunkStates).map((k) => [Number(k), 'pending' as const]),
      ),
      pageDecision: 'pending' as const,
    })),
    settled: false,
    stale: { detectedAt: at, reasons },
    updatedAt: at,
  };

  try {
    await writeFileAtomic(reviewFile(kbPath, changeSetId), JSON.stringify(invalidated, null, 2));
  } catch (err) {
    return fail('ioError', `写入 reviews 失败: ${String(err)}`);
  }
  return { ok: true, value: invalidated };
}
