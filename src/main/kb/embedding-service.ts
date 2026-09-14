/**
 * Embedding Service — 向量嵌入编排层（spec §8/§11，issue 21）。
 *
 * 职责：
 *  1. embedPage：分块 → embed per-chunk → 指纹校验 → upsert（按 pageId 替换）
 *  2. searchByQuery：embed query → vector search → per-page 聚合
 *  3. 降级：未配置/嵌入失败时返回空结果（关键词/图仍可用）
 *  4. 指纹管理：同维度换模型不共用空间
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §8/§11
 */

import { chunkMarkdown } from './text-chunker';
import { fetchEmbedding } from './embedding-endpoint';
import { computeEmbeddingFingerprint } from './embedding-fingerprint';
import type { VectorStore } from './vector-store';
import type {
  EmbeddingError,
  EmbeddingRuntimeConfig,
  VectorPageResult,
  VectorUpsertChunk,
} from '@shared/kb-types';

export type EmbedPageResult =
  | {
      ok: true;
      chunkCount: number;
      embeddedCount: number;
      failedCount: number;
    }
  | { ok: false; error: EmbeddingError };

export type SearchByQueryResult = {
  ok: true;
  results: VectorPageResult[];
  /** 降级：嵌入不可用时仍返回（空结果） */
  degraded: boolean;
};

/**
 * 构建嵌入文本：page title + heading breadcrumb + chunk text。
 * 参考参考实现的 enrichChunkForEmbedding 设计。
 */
function enrichChunkForEmbedding(
  pageTitle: string,
  chunkText: string,
  headingPath: string,
): string {
  const parts: string[] = [];
  if (pageTitle.trim()) parts.push(pageTitle.trim());
  if (headingPath.trim()) parts.push(headingPath.trim());
  if (chunkText.trim()) parts.push(chunkText.trim());
  return parts.join('\n\n');
}

/** 有限并发 limiter */
function createLimiter(rawLimit: number): <T>(task: () => Promise<T>) => Promise<T> {
  const limit = Math.max(1, Math.min(32, Math.floor(rawLimit)));
  let active = 0;
  const waiters: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    active++;
    try {
      return await task();
    } finally {
      const next = waiters.shift();
      if (next) next();
      else active--;
    }
  };
}

/**
 * 向量嵌入服务 — 编排分块、嵌入、存储与搜索。
 */
export class EmbeddingService {
  constructor(private readonly store: VectorStore) {}

  /**
   * 嵌入一个 wiki 页面：
   *  1. chunkMarkdown → 分块
   *  2. per-chunk fetchEmbedding
   *  3. 成功的 chunks upsert 到向量存储（按 pageId 替换）
   *  4. 保存嵌入空间指纹
   *
   * 全部失败时不 upsert；部分失败保留成功结果。
   */
  async embedPage(
    kbId: string,
    pageId: string,
    pageTitle: string,
    content: string,
    cfg: EmbeddingRuntimeConfig,
  ): Promise<EmbedPageResult> {
    // 未配置检查
    if (!cfg.endpoint || !cfg.apiKey || !cfg.model) {
      return {
        ok: false,
        error: { kind: 'notConfigured', message: 'Embedding endpoint not configured' },
      };
    }

    // 分块
    const chunks = chunkMarkdown(content, cfg.maxChunkChars, cfg.overlapChunkChars);
    if (chunks.length === 0) {
      return { ok: true, chunkCount: 0, embeddedCount: 0, failedCount: 0 };
    }

    // per-chunk embed
    const limiter = createLimiter(cfg.concurrency);
    const results = await Promise.all(
      chunks.map(async (chunk) => {
        const text = enrichChunkForEmbedding(pageTitle, chunk.text, chunk.headingPath);
        return limiter(() => fetchEmbedding(text, cfg));
      }),
    );

    // 收集成功的 chunks
    const upsertChunks: VectorUpsertChunk[] = [];
    let firstError: EmbeddingError | null = null;
    let failedCount = 0;

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.ok) {
        upsertChunks.push({
          chunkIndex: chunks[i].index,
          chunkText: chunks[i].text,
          headingPath: chunks[i].headingPath,
          embedding: result.value,
        });
      } else {
        failedCount++;
        if (!firstError) firstError = result.error;
      }
    }

    // 全部失败
    if (upsertChunks.length === 0) {
      return {
        ok: false,
        error: firstError ?? { kind: 'provider', message: 'All chunks failed to embed' },
      };
    }

    // upsert 成功的 chunks（empty upsert = no-op 不在此触发）
    await this.store.upsertChunks(kbId, pageId, upsertChunks);

    // 保存指纹
    const fingerprint = computeEmbeddingFingerprint(cfg);
    await this.store.saveFingerprint(kbId, fingerprint.hash);

    return {
      ok: true,
      chunkCount: chunks.length,
      embeddedCount: upsertChunks.length,
      failedCount,
    };
  }

  /**
   * 向量搜索：embed query → vector search → per-page 聚合。
   *
   * 降级：未配置或嵌入失败时返回空结果（degraded = true）。
   */
  async searchByQuery(
    kbId: string,
    query: string,
    cfg: EmbeddingRuntimeConfig,
    topK: number = 10,
  ): Promise<SearchByQueryResult> {
    // 未配置 → 降级
    if (!cfg.endpoint || !cfg.apiKey || !cfg.model) {
      return { ok: true, results: [], degraded: true };
    }

    // 嵌入查询
    const embResult = await fetchEmbedding(query, cfg);
    if (!embResult.ok) {
      return { ok: true, results: [], degraded: true };
    }

    // 向量搜索
    const rawChunks = await this.store.searchChunks(kbId, embResult.value, Math.max(topK * 3, 30));
    if (rawChunks.length === 0) {
      return { ok: true, results: [], degraded: false };
    }

    // per-page 聚合：max(chunk_scores) + 0.3 × sum(tail_scores)，cap at 1-max
    const byPage = new Map<string, typeof rawChunks>();
    for (const c of rawChunks) {
      const bucket = byPage.get(c.pageId);
      if (bucket) bucket.push(c);
      else byPage.set(c.pageId, [c]);
    }

    const ranked: VectorPageResult[] = [];
    for (const [pageId, chunkList] of byPage.entries()) {
      chunkList.sort((a, b) => b.score - a.score);
      const top = chunkList[0].score;
      const tail = chunkList.slice(1).reduce((sum, c) => sum + c.score, 0);
      const blended = top + Math.min(tail * 0.3, Math.max(0, 1 - top));
      ranked.push({
        id: pageId,
        score: blended,
        matchedChunks: chunkList.slice(0, 3).map((c) => ({
          text: c.chunkText,
          headingPath: c.headingPath,
          score: c.score,
        })),
      });
    }
    ranked.sort((a, b) => b.score - a.score);

    return {
      ok: true,
      results: ranked.slice(0, topK),
      degraded: false,
    };
  }

  /** 删除指定页的向量 */
  async removePage(kbId: string, pageId: string): Promise<void> {
    await this.store.deletePage(kbId, pageId);
  }

  /** 获取索引覆盖状态 */
  async getCoverage(kbId: string) {
    return this.store.getCoverage(kbId);
  }

  /** 检查当前配置指纹是否与存储的指纹一致 */
  async isFingerprintMatch(kbId: string, cfg: EmbeddingRuntimeConfig): Promise<boolean> {
    const stored = await this.store.loadFingerprint(kbId);
    if (!stored) return false;
    const current = computeEmbeddingFingerprint(cfg);
    return stored === current.hash;
  }
}
