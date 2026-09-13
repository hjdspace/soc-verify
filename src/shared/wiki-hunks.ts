/**
 * Wiki Hunks — 知识提案 before/proposed 的**共享 hunk 模型**（issue 07）。
 *
 * 主进程与渲染端必须对「同一个 hunk id」有一致理解：
 *  - 审阅面板按 hunk 展示并记录用户选择；
 *  - 发布服务按同一 id 把选择**重建为最终候选正文**。
 * 因此切分逻辑放在 shared（纯函数，无 node 依赖）。
 *
 * 编号约定：
 *  - `WIKI_PAGE_HUNK_ID (0)` = **整页/元数据块**：新页的整页处置，
 *    以及审阅面板「整页接受/拒绝」的持久化 id；
 *  - 已有页的真实改动块从 **1** 起编号；
 *  - frontmatter 区的多处改动**合并为单块**（spec §6：新页与 frontmatter
 *    整体接受/拒绝，避免拼出无效 YAML）；正文块各自独立（逐 hunk）。
 *
 * 重建语义：未接受的块回退到旧行、新增行丢弃；全接受 == proposed，
 * 全拒绝 == before（逐字节，行尾按 LF 归一后比较）。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §6
 */

import { lcsDiff } from './diff-lcs';
import type { LcsDiffLine } from './diff-lcs';
import type { DiffHunkInfo, DiffLine, FileDiffResult } from './types';

/** 整页/元数据伪 hunk id（新页整页处置、审阅面板整页动作） */
export const WIKI_PAGE_HUNK_ID = 0;

/** 提案页通常几百行；超过则退化为整体替换，避免 DP 卡住 UI */
const MAX_DP_LINES = 2000;

export type WikiHunkKind = 'whole-page' | 'frontmatter' | 'body';

export type WikiReviewHunk = DiffHunkInfo & { kind: WikiHunkKind };

export type WikiReviewDiff = Omit<FileDiffResult, 'hunks'> & { hunks: WikiReviewHunk[] };

/** 审阅模型的输入（WikiStagedPage 的结构子集） */
export type WikiStagedPageLike = { relPath: string; before: string | null; proposed: string };

export type WikiHunkDecisionLike = 'pending' | 'accepted' | 'rejected';

export type WikiRebuildResult =
  | {
      status: 'accepted';
      /** 重建后的最终候选正文 */
      content: string;
      /** 只接受了一部分块（发布状态标 published_partial） */
      partial: boolean;
      acceptedHunks: number[];
      rejectedHunks: number[];
    }
  | { status: 'rejected'; reason: 'pageRejected' | 'allHunksRejected' }
  | { status: 'unchanged' }
  | { status: 'pending'; pendingHunks: number[]; undecidedPage: boolean };

// ── 行切分 ──────────────────────────────────────────────────────

/** 统一按 LF 切分；CRLF 归一（提案在解析时已归一，重建结果也是 LF） */
export function splitWikiLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.replace(/\r\n/g, '\n').split('\n');
}

/** 行尾归一后的比较基准（CRLF/LF 纯换行差异不算内容改动） */
function normalize(text: string): string {
  return splitWikiLines(text).join('\n');
}

/**
 * frontmatter 区在 1-based 行号下的**末行**（含闭合 `---`）。
 * 无 frontmatter / 未闭合返回 0（此时不把任何改动视作元数据块）。
 */
function frontmatterEndLine(lines: string[]): number {
  if (lines.length === 0 || lines[0].trim() !== '---') return 0;
  for (let i = 1; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (t === '---' || t === '...') return i + 1;
  }
  return 0;
}

// ── diff 模型 ───────────────────────────────────────────────────

type DiffModel = {
  ops: LcsDiffLine[];
  hunks: WikiReviewHunk[];
  hunkIdOfOp: Map<number, number>;
  totalAdd: number;
  totalDel: number;
};

/**
 * 求 before/proposed 的改动块并编号。
 *
 * 步骤：LCS 编辑脚本 → 连续改动块 → frontmatter 区内的块合并为一个 →
 * 按出现位置排序后从 1 编号。
 */
function computeDiffModel(page: WikiStagedPageLike): DiffModel {
  const beforeLines = page.before === null ? [] : splitWikiLines(page.before);
  const afterLines = splitWikiLines(page.proposed);
  const ops = lcsDiff(beforeLines, afterLines, MAX_DP_LINES);

  const fmEndBefore = frontmatterEndLine(beforeLines);
  const fmEndAfter = frontmatterEndLine(afterLines);

  type Block = { indices: number[]; frontmatter: boolean; addCount: number; delCount: number };
  const blocks: Block[] = [];
  let current: Block | null = null;

  ops.forEach((op, idx) => {
    if (op.type === 'ctx') {
      current = null;
      return;
    }
    if (current === null) {
      current = { indices: [], frontmatter: true, addCount: 0, delCount: 0 };
      blocks.push(current);
    }
    current.indices.push(idx);
    if (op.type === 'add') {
      current.addCount += 1;
      // 该 add 行是否落在 proposed 的 frontmatter 区内
      if (!(op.newLine !== undefined && op.newLine <= fmEndAfter)) current.frontmatter = false;
    } else {
      current.delCount += 1;
      if (!(op.oldLine !== undefined && op.oldLine <= fmEndBefore)) current.frontmatter = false;
    }
  });

  const fmBlocks = blocks.filter((b) => b.frontmatter);
  const bodyBlocks = blocks.filter((b) => !b.frontmatter);

  type Descriptor = { kind: WikiHunkKind; indices: number[]; addCount: number; delCount: number };
  const descriptors: Descriptor[] = [];
  if (fmBlocks.length > 0) {
    // 合并为一个原子块：frontmatter 不可拆开接受
    descriptors.push({
      kind: 'frontmatter',
      indices: fmBlocks.flatMap((b) => b.indices).sort((a, b) => a - b),
      addCount: fmBlocks.reduce((n, b) => n + b.addCount, 0),
      delCount: fmBlocks.reduce((n, b) => n + b.delCount, 0),
    });
  }
  for (const b of bodyBlocks) {
    descriptors.push({ kind: 'body', indices: b.indices, addCount: b.addCount, delCount: b.delCount });
  }
  descriptors.sort((a, b) => a.indices[0] - b.indices[0]);

  const hunkIdOfOp = new Map<number, number>();
  const hunks: WikiReviewHunk[] = descriptors.map((d, i) => {
    const id = i + 1;
    for (const idx of d.indices) hunkIdOfOp.set(idx, id);
    return {
      id,
      kind: d.kind,
      toolCallId: `kb-staged:${page.relPath}`,
      toolName: 'wiki-proposal',
      overwritten: false,
      startLineIndex: d.indices[0],
      endLineIndex: d.indices[d.indices.length - 1] + 1,
      addCount: d.addCount,
      delCount: d.delCount,
    };
  });

  let totalAdd = 0;
  let totalDel = 0;
  for (const op of ops) {
    if (op.type === 'add') totalAdd += 1;
    else if (op.type === 'del') totalDel += 1;
  }

  return { ops, hunks, hunkIdOfOp, totalAdd, totalDel };
}

/**
 * 由 before/proposed 合成审阅展示用的 diff。
 *
 * 新页（`before === null`）= 整页一个 hunk（id 0，kind whole-page）；
 * 已有页 = 真实改动块（id 从 1 起）。内容一致（含纯换行差异）返回 null。
 */
export function buildWikiPageDiff(page: WikiStagedPageLike): WikiReviewDiff | null {
  if (page.before === null) {
    const afterLines = splitWikiLines(page.proposed);
    const lines: DiffLine[] = afterLines.map((content, i) => ({
      type: 'add' as const,
      content,
      newLine: i + 1,
      hunkId: WIKI_PAGE_HUNK_ID,
    }));
    if (lines.length === 0) return null;
    return {
      filePath: page.relPath,
      isNewFile: true,
      lines,
      hunks: [{
        id: WIKI_PAGE_HUNK_ID,
        kind: 'whole-page',
        toolCallId: `kb-staged:${page.relPath}`,
        toolName: 'wiki-proposal',
        overwritten: false,
        startLineIndex: 0,
        endLineIndex: lines.length,
        addCount: lines.length,
        delCount: 0,
      }],
      totalAdd: lines.length,
      totalDel: 0,
    };
  }

  if (normalize(page.before) === normalize(page.proposed)) return null;

  const model = computeDiffModel(page);
  if (model.hunks.length === 0) return null;

  const lines: DiffLine[] = model.ops.map((op, idx) => {
    if (op.type === 'ctx') {
      return { type: 'ctx' as const, content: op.content, oldLine: op.oldLine, newLine: op.newLine };
    }
    return {
      type: op.type,
      content: op.content,
      ...(op.oldLine !== undefined ? { oldLine: op.oldLine } : {}),
      ...(op.newLine !== undefined ? { newLine: op.newLine } : {}),
      hunkId: model.hunkIdOfOp.get(idx),
    };
  });

  return {
    filePath: page.relPath,
    isNewFile: false,
    lines,
    hunks: model.hunks,
    totalAdd: model.totalAdd,
    totalDel: model.totalDel,
  };
}

/** 需要用户处置的真实 hunk id 列表（不含整页伪 hunk 0） */
export function wikiRealHunkIds(page: WikiStagedPageLike): number[] {
  if (page.before === null) return [WIKI_PAGE_HUNK_ID];
  const diff = buildWikiPageDiff(page);
  return diff === null ? [] : diff.hunks.map((h) => h.id);
}

// ── 重建 ────────────────────────────────────────────────────────

/**
 * 从用户选择重建最终候选正文。
 *
 * `pageDecision` 非 pending 时优先生效（整页处置）；否则逐 hunk 判定，
 * 任一 hunk 未处置即 `pending`（spec §6：所有未决项必须明确处置才能发布）。
 */
export function rebuildWikiPage(
  page: WikiStagedPageLike,
  pageDecision: WikiHunkDecisionLike,
  hunkStates: Record<number, WikiHunkDecisionLike>,
): WikiRebuildResult {
  if (page.before === null) {
    // 新页 = 整页块（hunk 0）
    const decided: WikiHunkDecisionLike = pageDecision !== 'pending'
      ? pageDecision
      : (hunkStates[WIKI_PAGE_HUNK_ID] ?? 'pending');
    if (decided === 'accepted') {
      return {
        status: 'accepted',
        content: page.proposed,
        partial: false,
        acceptedHunks: [WIKI_PAGE_HUNK_ID],
        rejectedHunks: [],
      };
    }
    if (decided === 'rejected') return { status: 'rejected', reason: 'pageRejected' };
    return { status: 'pending', pendingHunks: [WIKI_PAGE_HUNK_ID], undecidedPage: true };
  }

  const beforeNormalized = normalize(page.before);

  if (pageDecision === 'rejected') return { status: 'rejected', reason: 'pageRejected' };
  if (pageDecision === 'accepted') {
    if (normalize(page.proposed) === beforeNormalized) return { status: 'unchanged' };
    return { status: 'accepted', content: page.proposed, partial: false, acceptedHunks: [], rejectedHunks: [] };
  }

  const diff = buildWikiPageDiff(page);
  if (diff === null) return { status: 'unchanged' };

  const ids = diff.hunks.map((h) => h.id);
  const pending = ids.filter((id) => (hunkStates[id] ?? 'pending') === 'pending');
  if (pending.length > 0) return { status: 'pending', pendingHunks: pending, undecidedPage: false };

  const acceptedIds = ids.filter((id) => hunkStates[id] === 'accepted');
  if (acceptedIds.length === 0) return { status: 'rejected', reason: 'allHunksRejected' };

  const acceptedSet = new Set(acceptedIds);
  const model = computeDiffModel(page);
  const out: string[] = [];
  model.ops.forEach((op, idx) => {
    if (op.type === 'ctx') {
      out.push(op.content);
      return;
    }
    const accepted = acceptedSet.has(model.hunkIdOfOp.get(idx) ?? -1);
    if (op.type === 'del') {
      if (!accepted) out.push(op.content);
    } else if (accepted) {
      out.push(op.content);
    }
  });
  const content = out.join('\n');
  if (content === beforeNormalized) return { status: 'unchanged' };
  return {
    status: 'accepted',
    content,
    partial: acceptedIds.length < ids.length,
    acceptedHunks: acceptedIds,
    rejectedHunks: ids.filter((id) => hunkStates[id] === 'rejected'),
  };
}

// ── 差异指纹 ────────────────────────────────────────────────────

/**
 * 差异指纹：只由 before/proposed 决定。
 *
 * 用户选择持久时同时记录指纹；发布前重算不一致 → 旧 hunk 决定失效
 * （spec §6「重新生成候选并清除相关旧批准」）。
 * 用纯 JS FNV-1a（shared 模块不得依赖 node:crypto，渲染端也要能用）。
 */
export function wikiPageDiffFingerprint(page: WikiStagedPageLike): string {
  const payload = `${page.before === null ? '\u0000NEW' : normalize(page.before)}\u0001${normalize(page.proposed)}`;
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < payload.length; i += 1) {
    hash ^= BigInt(payload.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}
