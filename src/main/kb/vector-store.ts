/**
 * Vector Store — 向量存储抽象层（spec §8/§11，issue 21/22）。
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
 * Issue 22 扩展：
 *  - 按 revision 替换：同 page+revision 的旧 chunks 被替换，旧 revision 保留
 *  - 查询过滤：searchChunks 支持按 revision 过滤，不匹配则排除
 *  - 失败保留旧数据：部分 upsert 失败不删除旧 revision 的向量
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §8/§11
 */

import type { VectorCoverage, VectorSearchHit, VectorUpsertChunk } from '@shared/kb-types';

/** search 选项 */
export type SearchOptions = {
  /** 只返回匹配此 revision 的 chunks（issue 22） */
  revision?: string;
};

/** 向量存储后端接口（LanceDB / 内存 / SQLite 等） */
export interface VectorStoreBackend {
  upsertChunks(
    kbId: string,
    pageId: string,
    chunks: VectorUpsertChunk[],
    revision?: string,
  ): Promise<void>;
  searchChunks(
    kbId: string,
    queryEmbedding: number[],
    topK: number,
    options?: SearchOptions,
  ): Promise<VectorSearchHit[]>;
  deletePage(kbId: string, pageId: string, revision?: string): Promise<void>;
  countChunks(kbId: string, revision?: string): Promise<number>;
  countPages(kbId: string, revision?: string): Promise<number>;
  clearChunks(kbId: string): Promise<void>;
  saveFingerprint(kbId: string, hash: string): Promise<void>;
  loadFingerprint(kbId: string): Promise<string | null>;
  /** 保存索引错误状态（issue 22） */
  saveErrorStatus?(kbId: string, status: { kind: string; message: string; at: string }): Promise<void>;
  /** 读取索引错误状态（issue 22） */
  loadErrorStatus?(kbId: string): Promise<{ kind: string; message: string; at: string } | null>;
  /** 推断实际维度（issue 22） */
  getActualDimensions?(kbId: string): Promise<number | null>;
}

/**
 * 内存向量存储后端 — 用于开发与测试。
 *
 * 使用余弦相似度计算 score（1/(1+distance)，与参考实现一致）。
 * 每页 chunks 按 chunkId = `${pageId}#${revision}#${chunkIndex}` 管理。
 *
 * Issue 22：revision 参与 chunk 身份，同 page+revision 替换，
 * 旧 revision 保留；查询按 revision 过滤。
 */
export class MemoryVectorBackend implements VectorStoreBackend {
  private readonly stores = new Map<
    string,
    {
      chunks: Map<
        string,
        VectorUpsertChunk & { pageId: string; chunkId: string; revision?: string }
      >;
      fingerprint: string | null;
      errorStatus: { kind: string; message: string; at: string } | null;
    }
  >();

  private getStore(): NonNullable<ReturnType<typeof this.stores.get>> {
    let store = this.stores.get('_global');
    if (!store) {
      store = { chunks: new Map(), fingerprint: null, errorStatus: null };
      this.stores.set('_global', store);
    }
    return store;
  }

  private getKbStore(kbId: string): NonNullable<ReturnType<typeof this.stores.get>> {
    let store = this.stores.get(kbId);
    if (!store) {
      store = { chunks: new Map(), fingerprint: null, errorStatus: null };
      this.stores.set(kbId, store);
    }
    return store;
  }

  async upsertChunks(
    kbId: string,
    pageId: string,
    chunks: VectorUpsertChunk[],
    revision?: string,
  ): Promise<void> {
    const store = this.getKbStore(kbId);
    // 先删除该页**同 revision** 的已有 chunks（同 revision 替换语义）
    // 旧 revision 的 chunks 保留（issue 22：失败保留旧数据）
    for (const [key, chunk] of store.chunks) {
      if (chunk.pageId === pageId && chunk.revision === revision) {
        store.chunks.delete(key);
      }
    }
    // 插入新 chunks
    for (const chunk of chunks) {
      const rev = revision ?? chunk.revision;
      const chunkId = rev
        ? `${pageId}#${rev}#${chunk.chunkIndex}`
        : `${pageId}#${chunk.chunkIndex}`;
      store.chunks.set(chunkId, { ...chunk, pageId, chunkId, revision: rev });
    }
  }

  async searchChunks(
    kbId: string,
    queryEmbedding: number[],
    topK: number,
    options?: SearchOptions,
  ): Promise<VectorSearchHit[]> {
    const store = this.getKbStore(kbId);
    const results: VectorSearchHit[] = [];

    for (const chunk of store.chunks.values()) {
      // revision 过滤（issue 22）
      if (options?.revision && chunk.revision !== options.revision) continue;

      const distance = cosineDistance(queryEmbedding, chunk.embedding);
      const score = 1 / (1 + distance);
      results.push({
        chunkId: chunk.chunkId,
        pageId: chunk.pageId,
        chunkIndex: chunk.chunkIndex,
        chunkText: chunk.chunkText,
        headingPath: chunk.headingPath,
        score,
        ...(chunk.revision ? { revision: chunk.revision } : {}),
        ...(chunk.start !== undefined ? { start: chunk.start } : {}),
        ...(chunk.end !== undefined ? { end: chunk.end } : {}),
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  async deletePage(kbId: string, pageId: string, revision?: string): Promise<void> {
    const store = this.getKbStore(kbId);
    for (const [key, chunk] of store.chunks) {
      if (chunk.pageId === pageId) {
        // 如果指定 revision，只删该 revision 的 chunks
        // 不指定 revision → 删除该页所有 chunks（向后兼容）
        if (revision === undefined || chunk.revision === revision) {
          store.chunks.delete(key);
        }
      }
    }
  }

  async countChunks(kbId: string, revision?: string): Promise<number> {
    const store = this.stores.get(kbId);
    if (!store) return 0;
    if (!revision) return store.chunks.size;
    let count = 0;
    for (const chunk of store.chunks.values()) {
      if (chunk.revision === revision) count++;
    }
    return count;
  }

  async countPages(kbId: string, revision?: string): Promise<number> {
    const store = this.stores.get(kbId);
    if (!store) return 0;
    const pages = new Set<string>();
    for (const chunk of store.chunks.values()) {
      if (!revision || chunk.revision === revision) {
        pages.add(chunk.pageId);
      }
    }
    return pages.size;
  }

  async clearChunks(kbId: string): Promise<void> {
    const store = this.getKbStore(kbId);
    store.chunks.clear();
    store.fingerprint = null;
    store.errorStatus = null;
  }

  async saveFingerprint(kbId: string, hash: string): Promise<void> {
    const store = this.getKbStore(kbId);
    store.fingerprint = hash;
  }

  async loadFingerprint(kbId: string): Promise<string | null> {
    const store = this.stores.get(kbId);
    return store ? store.fingerprint : null;
  }

  async saveErrorStatus(
    kbId: string,
    status: { kind: string; message: string; at: string },
  ): Promise<void> {
    const store = this.getKbStore(kbId);
    store.errorStatus = status;
  }

  async loadErrorStatus(
    kbId: string,
  ): Promise<{ kind: string; message: string; at: string } | null> {
    const store = this.stores.get(kbId);
    return store ? store.errorStatus : null;
  }

  async getActualDimensions(kbId: string): Promise<number | null> {
    const store = this.stores.get(kbId);
    if (!store || store.chunks.size === 0) return null;
    // 从第一个 chunk 推断维度
    for (const chunk of store.chunks.values()) {
      if (chunk.embedding && chunk.embedding.length > 0) {
        return chunk.embedding.length;
      }
    }
    return null;
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
   * 按 pageId + revision 替换整页 chunks（spec §8：整页 chunks 准备成功后按 revision 替换）。
   * 空 chunks 是 no-op，不删除已有索引（transient failure 不 nuke index）。
   *
   * Issue 22：同 page+revision 的旧 chunks 被替换，旧 revision 保留。
   */
  async upsertChunks(
    kbId: string,
    pageId: string,
    chunks: VectorUpsertChunk[],
    revision?: string,
  ): Promise<void> {
    if (chunks.length === 0) return;
    await this.backend.upsertChunks(kbId, pageId, chunks, revision);
  }

  /** Top-K chunk 搜索（支持 revision 过滤，issue 22） */
  async searchChunks(
    kbId: string,
    queryEmbedding: number[],
    topK: number,
    options?: SearchOptions,
  ): Promise<VectorSearchHit[]> {
    return this.backend.searchChunks(kbId, queryEmbedding, topK, options);
  }

  /** 删除指定页的 chunks（可选按 revision，issue 22） */
  async deletePage(kbId: string, pageId: string, revision?: string): Promise<void> {
    await this.backend.deletePage(kbId, pageId, revision);
  }

  /** 总 chunk 数（可选按 revision 过滤） */
  async countChunks(kbId: string, revision?: string): Promise<number> {
    return this.backend.countChunks(kbId, revision);
  }

  /** 覆盖状态：去重页数 + chunk 数 + 指纹（可选按 revision 过滤） */
  async getCoverage(kbId: string, revision?: string): Promise<VectorCoverage> {
    const [pages, chunks, fp] = await Promise.all([
      this.backend.countPages(kbId, revision),
      this.backend.countChunks(kbId, revision),
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

  /** 保存索引错误状态（issue 22） */
  async saveErrorStatus(
    kbId: string,
    status: { kind: string; message: string; at: string },
  ): Promise<void> {
    if (this.backend.saveErrorStatus) {
      await this.backend.saveErrorStatus(kbId, status);
    }
  }

  /** 读取索引错误状态（issue 22） */
  async loadErrorStatus(
    kbId: string,
  ): Promise<{ kind: string; message: string; at: string } | null> {
    if (this.backend.loadErrorStatus) {
      return this.backend.loadErrorStatus(kbId);
    }
    return null;
  }

  /** 推断实际维度（issue 22） */
  async getActualDimensions(kbId: string): Promise<number | null> {
    if (this.backend.getActualDimensions) {
      return this.backend.getActualDimensions(kbId);
    }
    return null;
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
