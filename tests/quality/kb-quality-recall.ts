/**
 * issue 29 — 召回与证据匹配的纯逻辑（无 I/O）。
 *
 * 判定口径：
 *  - 证据键 = `${hit.kind}:${hit.id}`（wiki 的 id 即 pageId，parsed 的 id 即 sourceId）。
 *  - Recall@K = |前 K 条 ∩ 预期| / |预期|，宏平均跨查询。
 *  - 图补召回按 `wiki-search` 契约**追加在 topK 之后**，因此不参与 Recall@K，
 *    单独断言「存在 + seed 标注正确 + 不与基础结果重复计票」。
 *  - 被撤回值：页面必须仍可召回（不能说旧知识不存在），但 stale 必须为 true。
 */

import type { WikiSearchHit } from '@shared/kb-types';
import type { EvidenceKey, QualityQuery } from './kb-quality-queries';

export type QueryRun = {
  queryId: string;
  category: string;
  query: string;
  /** 返回条数（含图追加区） */
  returned: number;
  foundAt10: EvidenceKey[];
  missedAt10: EvidenceKey[];
  recallAt10: number;
  /** 前 K 条第一条的证据键（诊断用） */
  top1: string | null;
  /** expectedTop1 是否为第一条（无 expectedTop1 时为 null） */
  top1Correct: boolean | null;
  /** 第一个被命中的预期证据的倒数排名（0 = 完全没召回） */
  reciprocalRank: number;
  /** mustFlagStale 未满足的项：`<pageId>:missing` / `<pageId>:not-stale` */
  staleViolations: string[];
  /** 图补召回契约（无 graphSupplement 时为 null） */
  graphSupplementMet: boolean | null;
  graphSupplementDetail: string | null;
};

/** 证据键 */
export function hitKey(hit: Pick<WikiSearchHit, 'kind' | 'id'>): EvidenceKey {
  return `${hit.kind}:${hit.id}` as EvidenceKey;
}

/** 前 K 条的证据键 */
export function topKeys(hits: WikiSearchHit[], k: number): EvidenceKey[] {
  return hits.slice(0, k).map(hitKey);
}

/**
 * 评估单条查询。
 *
 * @param hits          searchWiki 的返回列表（含图追加区）
 * @param k             Recall@K 的 K
 * @param graphExpanded 图补召回追加条数（追加区 = 列表末尾 graphExpanded 条）——
 *                      基础结果不足 topK 时追加区不会从第 k 位开始，必须按真实边界判定
 */
export function evaluateQuery(
  q: QualityQuery,
  hits: WikiSearchHit[],
  k: number,
  graphExpanded = 0,
): QueryRun {
  const keys = hits.map(hitKey);
  const top = keys.slice(0, k);
  const foundAt10 = q.expected.filter((e) => top.includes(e));
  const missedAt10 = q.expected.filter((e) => !top.includes(e));
  const baseCount = Math.max(0, hits.length - graphExpanded);

  const firstIndex = keys.findIndex((key) => q.expected.includes(key));
  const reciprocalRank = firstIndex >= 0 ? 1 / (firstIndex + 1) : 0;

  const staleViolations: string[] = [];
  for (const pageId of q.mustFlagStale ?? []) {
    const hit = hits.find((h) => h.kind === 'wiki' && h.id === pageId);
    if (!hit) staleViolations.push(`${pageId}:missing`);
    else if (!hit.stale) staleViolations.push(`${pageId}:not-stale`);
  }

  let graphSupplementMet: boolean | null = null;
  let graphSupplementDetail: string | null = null;
  if (q.graphSupplement) {
    const { neighborPageId, seedPageId } = q.graphSupplement;
    const index = hits.findIndex((h) => h.kind === 'wiki' && h.id === neighborPageId);
    const hit = index >= 0 ? hits[index] : undefined;
    const inBase = index >= 0 && index < baseCount;
    const seedOk = hit?.graphRelatedTo?.seedPageId === seedPageId;
    graphSupplementMet = index >= 0 && !inBase && seedOk;
    graphSupplementDetail = index < 0
      ? '邻居页未出现在返回列表'
      : inBase
        ? `邻居页出现在基础结果第 ${index + 1} 位（未走图补召回）`
        : seedOk
          ? `邻居页在第 ${index + 1} 位，seed=${hit?.graphRelatedTo?.seedPageId}`
          : `邻居页在第 ${index + 1} 位但 seed 标注为 ${hit?.graphRelatedTo?.seedPageId ?? 'null'}`;
  }

  return {
    queryId: q.id,
    category: q.category,
    query: q.query,
    returned: hits.length,
    foundAt10,
    missedAt10,
    recallAt10: q.expected.length === 0 ? 1 : foundAt10.length / q.expected.length,
    top1: top[0] ?? null,
    top1Correct: q.expectedTop1 === undefined ? null : top[0] === q.expectedTop1,
    reciprocalRank,
    staleViolations,
    graphSupplementMet,
    graphSupplementDetail,
  };
}

export type RecallSummary = {
  queries: number;
  /** 宏平均 Recall@K */
  macroRecall: number;
  /** 全部预期证据都进入前 K 的查询数 */
  queriesFullyRecalled: number;
  mrr: number;
  /** 有 expectedTop1 的查询里第一位的正确率 */
  top1Accuracy: number | null;
  top1Samples: number;
  /** 未达 1.0 的查询（逐条给出缺口） */
  underRecalled: QueryRun[];
};

export function summarize(runs: QueryRun[]): RecallSummary {
  const queries = runs.length;
  const macroRecall = queries === 0 ? 0 : runs.reduce((s, r) => s + r.recallAt10, 0) / queries;
  const mrr = queries === 0 ? 0 : runs.reduce((s, r) => s + r.reciprocalRank, 0) / queries;
  const top1Runs = runs.filter((r) => r.top1Correct !== null);
  const top1Accuracy = top1Runs.length === 0
    ? null
    : top1Runs.filter((r) => r.top1Correct === true).length / top1Runs.length;

  return {
    queries,
    macroRecall,
    queriesFullyRecalled: runs.filter((r) => r.missedAt10.length === 0).length,
    mrr,
    top1Accuracy,
    top1Samples: top1Runs.length,
    underRecalled: runs.filter((r) => r.missedAt10.length > 0),
  };
}

/** 按证据种类统计「前 K 条里各类证据的条数」（定位召回缺口用） */
export function evidenceMix(hits: WikiSearchHit[], k: number): { wiki: number; parsed: number } {
  const top = hits.slice(0, k);
  return {
    wiki: top.filter((h) => h.kind === 'wiki').length,
    parsed: top.filter((h) => h.kind === 'parsed').length,
  };
}
