/**
 * Embedding Service — 向量嵌入编排层（spec §8/§11，issue 21/22）。
 *
 * 职责：
 *  1. embedPage：分块 → embed per-chunk → 指纹校验 → upsert（按 pageId+revision 替换）
 *  2. searchByQuery：embed query → vector search → per-page 聚合
 *  3. 降级：未配置/嵌入失败时返回空结果（关键词/图仍可用）
 *  4. 指纹管理：同维度换模型不共用空间
 *  5. 覆盖报告：超大原子块跳过嵌入，不静默截短成功（issue 22）
 *  6. 索引状态：记录配置指纹与实际维度，错误状态按端点/库可见（issue 22）
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §8/§11
 */

import { chunkMarkdown } from './text-chunker';
import { fetchEmbedding } from './embedding-endpoint';
import { computeEmbeddingFingerprint } from './embedding-fingerprint';
import type { VectorStore } from './vector-store';
import type {
  ChunkCoverageReport,
  EmbeddingError,
  EmbeddingErrorKind,
  EmbeddingRuntimeConfig,
  VectorIndexErrorStatus,
  VectorIndexStatus,
  VectorPageResult,
  VectorUpsertChunk,
} from '@shared/kb-types';

export type EmbedPageResult =
  | {
      ok: true;
      chunkCount: number;
      embeddedCount: number;
      failedCount: number;
      /** 跳过的超大块数（issue 22） */
      skippedCount: number;
      /** 覆盖报告（issue 22） */
      coverage?: ChunkCoverageReport;
    }
  | { ok: false; error: EmbeddingError };

export type SearchByQueryResult = {
  ok: true;
  results: VectorPageResult[];
  /** 降级：嵌入不可用时仍返回（空结果） */
  degraded: boolean;
};

/** 构建嵌入文本：page title + heading breadcrumb + chunk text。 */
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
  constructor(public readonly store: VectorStore) {}

  /**
   * 嵌入一个 wiki 页面：
   *  1. chunkMarkdown → 分块（带覆盖报告）
   *  2. 跳过 oversize chunks（不嵌入，保留全文可读）
   *  3. per-chunk fetchEmbedding
   *  4. 成功的 chunks upsert 到向量存储（按 pageId+revision 替换）
   *  5. 保存嵌入空间指纹
   *  6. 失败时保存错误状态（按端点/库可见）
   *
   * 全部失败时不 upsert；部分失败保留成功结果。
   */
  async embedPage(
    kbId: string,
    pageId: string,
    pageTitle: string,
    content: string,
    cfg: EmbeddingRuntimeConfig,
    revision?: string,
  ): Promise<EmbedPageResult> {
    // 未配置检查
    if (!cfg.endpoint || !cfg.apiKey || !cfg.model) {
      const error: EmbeddingError = {
        kind: 'notConfigured',
        message: 'Embedding endpoint not configured',
      };
      await this.store.saveErrorStatus(kbId, {
        kind: error.kind,
        message: error.message,
        at: new Date().toISOString(),
      });
      return { ok: false, error };
    }

    // 分块（带覆盖报告）
    const chunkResult = chunkMarkdown(content, cfg.maxChunkChars, cfg.overlapChunkChars, {
      reportCoverage: true,
    });
    const allChunks = chunkResult.chunks;
    const coverage = chunkResult.coverage!;

    if (allChunks.length === 0) {
      return {
        ok: true,
        chunkCount: 0,
        embeddedCount: 0,
        failedCount: 0,
        skippedCount: 0,
        coverage,
      };
    }

    // 分离可嵌入 chunks 和 oversize chunks
    const embeddableChunks = allChunks.filter((c) => !c.oversize);
    const skippedCount = allChunks.length - embeddableChunks.length;

    if (embeddableChunks.length === 0) {
      // 全部 oversize — 保留旧索引，报告未覆盖
      return {
        ok: true,
        chunkCount: allChunks.length,
        embeddedCount: 0,
        failedCount: 0,
        skippedCount,
        coverage,
      };
    }

    // per-chunk embed
    const limiter = createLimiter(cfg.concurrency);
    const results = await Promise.all(
      embeddableChunks.map(async (chunk) => {
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
        const chunk = embeddableChunks[i];
        upsertChunks.push({
          chunkIndex: chunk.index,
          chunkText: chunk.text,
          headingPath: chunk.headingPath,
          start: chunk.start,
          end: chunk.end,
          embedding: result.value,
          ...(revision ? { revision } : {}),
        });
      } else {
        failedCount++;
        if (!firstError) firstError = result.error;
      }
    }

    // 全部失败
    if (upsertChunks.length === 0) {
      const error = firstError ?? { kind: 'provider' as const, message: 'All chunks failed to embed' };
      await this.store.saveErrorStatus(kbId, {
        kind: error.kind,
        message: error.message,
        at: new Date().toISOString(),
      });
      return { ok: false, error };
    }

    // upsert 成功的 chunks（按 revision 替换，issue 22）
    await this.store.upsertChunks(kbId, pageId, upsertChunks, revision);

    // 保存指纹
    const fingerprint = computeEmbeddingFingerprint(cfg);
    await this.store.saveFingerprint(kbId, fingerprint.hash);

    // 清除错误状态（索引成功）
    await this.store.saveErrorStatus(kbId, {
      kind: '',
      message: '',
      at: new Date().toISOString(),
    });

    return {
      ok: true,
      chunkCount: allChunks.length,
      embeddedCount: upsertChunks.length,
      failedCount,
      skippedCount,
      coverage,
    };
  }

  /**
   * 向量搜索：embed query → vector search → per-page 聚合。
   *
   * 降级：未配置或嵌入失败时返回空结果（degraded = true）。
   *
   * Issue 22：支持按 revision 过滤，旧 revision 的向量不得与当前正文拼接使用。
   */
  async searchByQuery(
    kbId: string,
    query: string,
    cfg: EmbeddingRuntimeConfig,
    topK: number = 10,
    revision?: string,
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

    // 向量搜索（带 revision 过滤）
    const rawChunks = await this.store.searchChunks(
      kbId,
      embResult.value,
      Math.max(topK * 3, 30),
      revision ? { revision } : undefined,
    );
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
          start: c.start,
          end: c.end,
        })),
        ...(revision ? { revision } : {}),
      });
    }
    ranked.sort((a, b) => b.score - a.score);

    return {
      ok: true,
      results: ranked.slice(0, topK),
      degraded: false,
    };
  }

  /** 删除指定页的向量（可选按 revision） */
  async removePage(kbId: string, pageId: string, revision?: string): Promise<void> {
    await this.store.deletePage(kbId, pageId, revision);
  }

  /** 获取索引覆盖状态（可选按 revision 过滤） */
  async getCoverage(kbId: string, revision?: string) {
    return this.store.getCoverage(kbId, revision);
  }

  /** 检查当前配置指纹是否与存储的指纹一致 */
  async isFingerprintMatch(kbId: string, cfg: EmbeddingRuntimeConfig): Promise<boolean> {
    const stored = await this.store.loadFingerprint(kbId);
    if (!stored) return false;
    const current = computeEmbeddingFingerprint(cfg);
    return stored === current.hash;
  }

  /**
   * 获取索引状态（issue 22：配置指纹 + 实际维度 + 错误状态）。
   */
  async getIndexStatus(
    kbId: string,
    cfg?: EmbeddingRuntimeConfig,
  ): Promise<VectorIndexStatus> {
    const fingerprintHash = await this.store.loadFingerprint(kbId);
    const errorStatus = await this.store.loadErrorStatus(kbId);
    const actualDimensions = await this.store.getActualDimensions(kbId);

    let fingerprintSignature: VectorIndexStatus['fingerprintSignature'] | undefined;
    if (cfg) {
      const fp = computeEmbeddingFingerprint(cfg);
      fingerprintSignature = fp.signature;
    }

    return {
      fingerprintHash,
      ...(fingerprintSignature ? { fingerprintSignature } : {}),
      actualDimensions,
      expectedDimensions: cfg?.expectedDimensions,
      errorStatus: errorStatus && errorStatus.kind
        ? ({
            kind: errorStatus.kind as EmbeddingErrorKind,
            message: errorStatus.message,
            at: errorStatus.at,
          } as VectorIndexErrorStatus)
        : null,
    };
  }
}
