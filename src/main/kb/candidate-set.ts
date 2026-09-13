/**
 * KB Candidate Set — 审阅选择 → 最终候选集，以及候选集上的跨页引用校验（issue 07）。
 *
 * spec §6：
 *  - 「选完后计算最终候选页，重新检查元数据、来源与引用；所有未决项必须
 *    明确处置才能发布此次变更集」→ `resolveCandidateSet`；
 *  - 「本次新增链接若目标被拒绝或不存在，则阻止发布并定位对应 hunk；
 *    预先存在的坏链接可作为 finding 保留」→ `validateCandidateLinks`；
 *  - 「所有涉及被删除页的新旧入链都必须纳入校验，旧断链例外不能用于
 *    绕过本次删除影响」→ `removed` 参与 before/after 两侧查找。
 *
 * 本模块是**纯函数**（除内容 hash 外无 IO）：正向用例可直接单测，
 * 真目录上的发布链路复用同一实现（不出现「测试通过、生产走另一套」）。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §2、§6
 */

import { createHash } from 'node:crypto';
import { buildWikiPageDiff, rebuildWikiPage, wikiPageDiffFingerprint } from '@shared/wiki-hunks';
import type { WikiHunkDecisionLike } from '@shared/wiki-hunks';
import { extractWikiLinks, resolveWikiTarget } from './wikilink';
import { parseWikiPage } from './wiki-page';
import type { WikiCatalogLookup } from './wikilink';
import type { WikiChangeSet, WikiChangeSetReview, WikiStagedPage } from '@shared/kb-types';

// ── 候选集 ──────────────────────────────────────────────────────

export type CandidatePage = {
  page: WikiStagedPage;
  /** 重建后的最终候选正文（部分接受时已剔除被拒块） */
  content: string;
  /** 只接受了部分 hunk（发布状态标 published_partial） */
  partial: boolean;
  operation: 'create' | 'update';
  beforeHash: string | null;
  afterHash: string;
};

export type CandidateSetErrorCode = 'nothingAccepted' | 'unsettled' | 'stale';

export type CandidateSetResult =
  | { ok: true; pages: CandidatePage[]; warnings: string[] }
  | { ok: false; error: { code: CandidateSetErrorCode; message: string; detail?: string[] } };

function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * 从审阅选择计算最终候选集。
 *
 * 判定：
 *  - 任一页 hunk 未处置 → `unsettled`（除「没有任何接受页」外，先报 nothingAccepted）；
 *  - 接受但内容与 before 一致（含纯换行差异）→ 该页不产生发布目标；
 *  - `hunksHash` 与当前差异指纹不符 → `stale`（差异已重算，旧 hunk 决定失效）。
 */
export function resolveCandidateSet(
  changeSet: WikiChangeSet,
  review: WikiChangeSetReview,
): CandidateSetResult {
  const warnings: string[] = [];
  const staleDetails: string[] = [];
  const unsettled: string[] = [];
  const candidates: CandidatePage[] = [];
  let disposed = 0;

  for (const page of changeSet.pages) {
    const pageReview = review.pages.find((p) => p.relPath === page.relPath);

    // 差异指纹：选择持久时记录，重算不一致即旧决定失效（spec §6）
    const fingerprint = wikiPageDiffFingerprint(page);
    if (pageReview?.hunksHash != null && pageReview.hunksHash !== fingerprint) {
      staleDetails.push(`差异已重算，旧 hunk 决定失效：${page.relPath}`);
      continue;
    }

    if (!pageReview) {
      // 缺审阅条目 = 未处置（不静默丢弃）：其余已接受页不得绕过「所有
      // 未决项必须明确处置」的发布前提（spec §6）。
      unsettled.push(`${page.relPath}：整页尚未处置`);
      continue;
    }

    const outcome = rebuildWikiPage(
      page,
      pageReview.pageDecision as WikiHunkDecisionLike,
      pageReview.hunkStates as Record<number, WikiHunkDecisionLike>,
    );

    if (outcome.status === 'pending') {
      unsettled.push(
        outcome.undecidedPage
          ? `${page.relPath}：整页尚未处置`
          : `${page.relPath}：hunk ${outcome.pendingHunks.join(', ')} 尚未处置`,
      );
      continue;
    }
    disposed += 1;
    if (outcome.status !== 'accepted') continue;

    candidates.push({
      page,
      content: outcome.content,
      partial: outcome.partial,
      operation: page.before === null ? 'create' : 'update',
      beforeHash: page.before === null ? null : page.baselineHash,
      afterHash: sha256Text(outcome.content),
    });
  }

  if (staleDetails.length > 0) {
    return {
      ok: false,
      error: {
        code: 'stale',
        message: '审阅选择的差异指纹已变（重新生成差异后再批准）：候选集按旧差异做出，不再有效。',
        detail: staleDetails,
      },
    };
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      error: {
        code: 'nothingAccepted',
        message: '变更集没有已接受的候选页：拒绝或未处置不会改动正式资产。',
        ...(disposed > 0 ? { detail: [`已处置页数 ${disposed}，但没有任何页产生改动。`] } : {}),
      },
    };
  }

  if (unsettled.length > 0) {
    return {
      ok: false,
      error: {
        code: 'unsettled',
        message: '变更集仍有未处置的页/块：所有未决项必须明确处置才能发布此次变更集。',
        detail: unsettled,
      },
    };
  }

  return { ok: true, pages: candidates, warnings };
}

// ── 跨页引用校验 ────────────────────────────────────────────────

export type PublishedPageInfo = { pageId: string; relPath: string; title: string | null };

export type CandidateLinkError = {
  /** 出现坏链接的候选页（库内相对路径） */
  relPath: string;
  pageId: string;
  /** 未解析的链接 target 原文 */
  target: string;
  /** 命中的 hunk（null = 无法定位到具体块，如既有 ctx 行上的链接） */
  hunkId: number | null;
  reason: 'targetMissing' | 'targetRemoved' | 'targetAmbiguous';
  message: string;
};

export type LinkValidationResult =
  | { ok: true; warnings: string[] }
  | { ok: false; warnings: string[]; errors: CandidateLinkError[] };

function buildLookup(entries: Array<{ pageId: string; title: string | null }>): WikiCatalogLookup {
  const byId = new Map<string, { pageId: string; title?: string }>();
  const byBasename = new Map<string, string[]>();
  const byTitle = new Map<string, string[]>();
  const push = (map: Map<string, string[]>, key: string, value: string): void => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  for (const e of entries) {
    byId.set(e.pageId, { pageId: e.pageId, ...(e.title !== null ? { title: e.title } : {}) });
    const base = e.pageId.slice(e.pageId.lastIndexOf('/') + 1).toLowerCase();
    push(byBasename, base, e.pageId);
    if (e.title !== null && e.title.length > 0) push(byTitle, e.title, e.pageId);
  }
  return { byId, byBasename, byTitle };
}

function titleOf(content: string): string | null {
  const parsed = parseWikiPage(content);
  return parsed.ok ? parsed.frontmatter.title : null;
}

/** 找出「新增行」中包含该 target 的 hunk（用于把问题定位到块） */
function locateHunk(page: WikiStagedPage, target: string): number | null {
  const diff = buildWikiPageDiff(page);
  if (diff === null) return null;
  const needle = `[[${target}`;
  const hit = diff.lines.find((l) => l.type === 'add' && l.content.includes(needle));
  return hit?.hunkId ?? null;
}

/**
 * 在**最终候选集**上重新校验引用。
 *
 *  - `candidates`：本批被接受的最终候选页；
 *  - `published`：磁盘上现存页面（含被本批改动的页的旧版本）——
 *    用它构 before 侧查找，从而识别「本批让原本可解析的链接变成断链」；
 *  - `removed`：本批显式移除的 pageId（删除提案；当前生产路径为 `[]`）。
 *
 * 判定：before 可解析而 after 不可解析 → 阻断；两侧都不可解析且该 target
 * 在 before 正文中已出现 → 既有断链（只记警告，不阻断整库）。
 */
export function validateCandidateLinks(input: {
  candidates: CandidatePage[];
  published: PublishedPageInfo[];
  removed?: string[];
}): LinkValidationResult {
  const removed = new Set(input.removed ?? []);
  const changedIds = new Set(input.candidates.map((c) => c.page.pageId));

  const beforeEntries = [
    ...input.published.map((p) => ({ pageId: p.pageId, title: p.title })),
  ];
  const afterEntries = [
    ...input.published.filter((p) => !changedIds.has(p.pageId) && !removed.has(p.pageId))
      .map((p) => ({ pageId: p.pageId, title: p.title })),
    ...input.candidates.map((c) => ({ pageId: c.page.pageId, title: titleOf(c.content) })),
  ];

  const lookupBefore = buildLookup(beforeEntries);
  const lookupAfter = buildLookup(afterEntries);

  const errors: CandidateLinkError[] = [];
  const preExisting: string[] = [];

  for (const candidate of input.candidates) {
    const { page, content } = candidate;
    const beforeTargets = new Set(
      page.before === null
        ? []
        : extractWikiLinks(page.before)
          .filter((o) => o.kind === 'link' && o.target.length > 0)
          .map((o) => o.target),
    );

    const seen = new Set<string>();
    for (const occ of extractWikiLinks(content)) {
      if (occ.kind !== 'link' || occ.target.length === 0) continue;
      if (seen.has(occ.target)) continue;
      seen.add(occ.target);

      const after = resolveWikiTarget(occ.target, lookupAfter);
      if (after.status === 'resolved') continue;

      const before = resolveWikiTarget(occ.target, lookupBefore);
      if (before.status === 'resolved') {
        errors.push({
          relPath: page.relPath,
          pageId: page.pageId,
          target: occ.target,
          hunkId: locateHunk(page, occ.target),
          reason: 'targetRemoved',
          message: `链接目标 \`${occ.target}\` 在本次改动后不再可解析（被拒绝、被删除或不再唯一）。`,
        });
        continue;
      }

      if (beforeTargets.has(occ.target)) {
        preExisting.push(`${page.relPath}：\`${occ.target}\`（既有断链，保留为待办）`);
        continue;
      }

      errors.push({
        relPath: page.relPath,
        pageId: page.pageId,
        target: occ.target,
        hunkId: locateHunk(page, occ.target),
        reason: after.status === 'ambiguous' ? 'targetAmbiguous' : 'targetMissing',
        message: after.status === 'ambiguous'
          ? `新增链接 \`${occ.target}\` 命中多个候选页（歧义），需明确 pageId。`
          : `新增链接 \`${occ.target}\` 指向不存在的页面。`,
      });
    }
  }

  const warnings = preExisting.length > 0
    ? [`以下既有断链不由本次改动引入，保留为知识待办（不阻断发布）：${preExisting.join('；')}`]
    : [];

  return errors.length > 0 ? { ok: false, warnings, errors } : { ok: true, warnings };
}
