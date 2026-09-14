/**
 * Vector Store — 向量存储抽象层（spec §8/§11，issue 21）。
 *
 * 提供 upsert/search/delete/count/clear/fingerprint 操作。
 *
 * 本期使用 MemoryVectorBackend（内存存储）验证嵌入能力链路：
 *  - 分块 → embed → 指纹校验 → upsert
 *  - search → 页面聚合
 *
 * LanceDB Node SDK 后端在打包 spike 验证后接入（issue 21 验收 A22）。
 * 接口设计已与 LanceDB API 对齐，切换后端只需实现 VectorStoreBackend 接口。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §8/§11
 */

import type { VectorCoverage, VectorSearchHit, VectorUpsertChunk } from '@shared/kb-types';

/** 向量存储后端接口（LanceDB / 内存 / SQLite 等） */
export interface VectorStoreBackend {
  upsertChunks(kbId: string, pageId: string, chunks: VectorUpsertChunk[]): Promise<void>;
  searchChunks(kbId: string, queryEmbedding: number[], topK: number): Promise<VectorSearchHit[]>;
  deletePage(kbId: string, pageId: string): Promise<void>;
  countChunks(kbId: string): Promise<number>;
  countPages(kbId: string): Promise<number>;
  clearChunks(kbId: string): Promise<void>;
  saveFingerprint(kbId: string, hash: string): Promise<void>;
  loadFingerprint(kbId: string): Promise<string | null>;
}

/**
 * 内存向量存储后端 — 用于开发与测试。
 *
 * 使用余弦相似度计算 score（1/(1+distance)，与参考实现一致）。
 * 每页 chunks 按 chunkId = `${pageId}#${chunkIndex}` 管理。
 */
export class MemoryVectorBackend implements VectorStoreBackend {
  private readonly stores = new Map<string, {
    chunks: Map<string, VectorUpsertChunk & { pageId: string; chunkId: string }>;
    fingerprint: string | null;
  }>();

  private getStore(kbId: string): NonNullable<ReturnType<typeof this.stores.get>> {
    let store = this.stores.get(kbId);
    if (!store) {
      store = { chunks: new Map(), fingerprint: null };
      this.stores.set(kbId, store);
    }
    return store;
  }

  async upsertChunks(kbId: string, pageId: string, chunks: VectorUpsertChunk[]): Promise<void> {
    const store = this.getStore(kbId);
    // 先删除该页已有的 chunks（替换语义）
    for (const [key, chunk] of store.chunks) {
      if (chunk.pageId === pageId) {
        store.chunks.delete(key);
      }
    }
    // 插入新 chunks
    for (const chunk of chunks) {
      const chunkId = `${pageId}#${chunk.chunkIndex}`;
      store.chunks.set(chunkId, { ...chunk, pageId, chunkId });
    }
  }

  async searchChunks(
    kbId: string,
    queryEmbedding: number[],
    topK: number,
  ): Promise<VectorSearchHit[]> {
    const store = this.getStore(kbId);
    const results: VectorSearchHit[] = [];

    for (const chunk of store.chunks.values()) {
      const distance = cosineDistance(queryEmbedding, chunk.embedding);
      const score = 1 / (1 + distance);
      results.push({
        chunkId: chunk.chunkId,
        pageId: chunk.pageId,
        chunkIndex: chunk.chunkIndex,
        chunkText: chunk.chunkText,
        headingPath: chunk.headingPath,
        score,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  async deletePage(kbId: string, pageId: string): Promise<void> {
    const store = this.getStore(kbId);
    for (const [key, chunk] of store.chunks) {
      if (chunk.pageId === pageId) {
        store.chunks.delete(key);
      }
    }
  }

  async countChunks(kbId: string): Promise<number> {
    const store = this.stores.get(kbId);
    return store ? store.chunks.size : 0;
  }

  async countPages(kbId: string): Promise<number> {
    const store = this.stores.get(kbId);
    if (!store) return 0;
    const pages = new Set<string>();
    for (const chunk of store.chunks.values()) {
      pages.add(chunk.pageId);
    }
    return pages.size;
  }

  async clearChunks(kbId: string): Promise<void> {
    const store = this.getStore(kbId);
    store.chunks.clear();
    store.fingerprint = null;
  }

  async saveFingerprint(kbId: string, hash: string): Promise<void> {
    const store = this.getStore(kbId);
    store.fingerprint = hash;
  }

  async loadFingerprint(kbId: string): Promise<string | null> {
    const store = this.stores.get(kbId);
    return store ? store.fingerprint : null;
  }
}

/**
 * 向量存储服务 — 封装后端选择与调用。
 *
 * 生产环境注入 LanceDB 后端；开发/测试使用 MemoryVectorBackend。
 */
export class VectorStore {
  constructor(private readonly backend: VectorStoreBackend) {}

  /**
   * 按 pageId 替换整页 chunks（spec §8：整页 chunks 准备成功后按 revision 替换）。
   * 空 chunks 是 no-op，不删除已有索引（transient failure 不 nuke index）。
   */
  async upsertChunks(
    kbId: string,
    pageId: string,
    chunks: VectorUpsertChunk[],
  ): Promise<void> {
    if (chunks.length === 0) return;
    await this.backend.upsertChunks(kbId, pageId, chunks);
  }

  /** Top-K chunk 搜索 */
  async searchChunks(
    kbId: string,
    queryEmbedding: number[],
    topK: number,
  ): Promise<VectorSearchHit[]> {
    return this.backend.searchChunks(kbId, queryEmbedding, topK);
  }

  /** 删除指定页的所有 chunks */
  async deletePage(kbId: string, pageId: string): Promise<void> {
    await this.backend.deletePage(kbId, pageId);
  }

  /** 总 chunk 数 */
  async countChunks(kbId: string): Promise<number> {
    return this.backend.countChunks(kbId);
  }

  /** 覆盖状态：去重页数 + chunk 数 + 指纹 */
  async getCoverage(kbId: string): Promise<VectorCoverage> {
    const [pages, chunks, fp] = await Promise.all([
      this.backend.countPages(kbId),
      this.backend.countChunks(kbId),
      this.backend.loadFingerprint(kbId),
    ]);
    return { pages, chunks, fingerprintHash: fp };
  }

  /** 清空所有 chunks */
  async clearChunks(kbId: string): Promise<void> {
    await this.backend.clearChunks(kbId);
  }

  /** 保存嵌入空间指纹 */
  async saveFingerprint(kbId: string, hash: string): Promise<void> {
    await this.backend.saveFingerprint(kbId, hash);
  }

  /** 读取嵌入空间指纹 */
  async loadFingerprint(kbId: string): Promise<string | null> {
    return this.backend.loadFingerprint(kbId);
  }
}

/** 余弦距离 = 1 - 余弦相似度 */
function cosineDistance(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return Infinity;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return Infinity;
  return 1 - dot / denom;
}
