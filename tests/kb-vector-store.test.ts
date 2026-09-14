/**
 * vector-store 测试（issue 21，spec §8/§11）。
 *
 * 验收映射 A15/A22：
 *  - upsert → search → delete → count 基本流程
 *  - 整页 chunks 准备成功后按 pageId 替换
 *  - 不因某批失败先删除旧索引（empty upsert = no-op）
 *  - 不同 page 共存
 *  - clear 清空
 *  - 搜索返回 per-chunk 结果带 score
 *  - 指纹持久化与读取
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryVectorBackend, VectorStore } from '../src/main/kb/vector-store';
import type { VectorUpsertChunk } from '@shared/kb-types';

function makeChunks(pageId: string, n: number, dim: number): VectorUpsertChunk[] {
  return Array.from({ length: n }, (_, i) => ({
    chunkIndex: i,
    chunkText: `${pageId} chunk ${i}`,
    headingPath: `## Heading ${i}`,
    start: i * 100,
    end: (i + 1) * 100,
    embedding: Array.from({ length: dim }, (_, j) => (i * 7 + j * 3) % 11 / 10),
  }));
}

describe('VectorStore with MemoryVectorBackend', () => {
  let store: VectorStore;

  beforeEach(() => {
    store = new VectorStore(new MemoryVectorBackend());
  });

  it('upsert 然后 count 返回正确块数', async () => {
    const chunks = makeChunks('page-a', 3, 4);
    await store.upsertChunks('kb1', 'page-a', chunks);
    expect(await store.countChunks('kb1')).toBe(3);
  });

  it('upsert 替换同页旧 chunks（不累加）', async () => {
    await store.upsertChunks('kb1', 'page-a', makeChunks('page-a', 5, 4));
    expect(await store.countChunks('kb1')).toBe(5);
    await store.upsertChunks('kb1', 'page-a', makeChunks('page-a', 2, 4));
    expect(await store.countChunks('kb1')).toBe(2);
  });

  it('不同 page 共存', async () => {
    await store.upsertChunks('kb1', 'page-a', makeChunks('page-a', 3, 4));
    await store.upsertChunks('kb1', 'page-b', makeChunks('page-b', 4, 4));
    expect(await store.countChunks('kb1')).toBe(7);
  });

  it('delete 只删除指定 page 的 chunks', async () => {
    await store.upsertChunks('kb1', 'page-a', makeChunks('page-a', 3, 4));
    await store.upsertChunks('kb1', 'page-b', makeChunks('page-b', 2, 4));
    await store.deletePage('kb1', 'page-a');
    expect(await store.countChunks('kb1')).toBe(2);
  });

  it('empty upsert 是 no-op（不删除已有索引）', async () => {
    await store.upsertChunks('kb1', 'page-a', makeChunks('page-a', 3, 4));
    await store.upsertChunks('kb1', 'page-a', []);
    expect(await store.countChunks('kb1')).toBe(3);
  });

  it('search 返回 per-chunk 结果带 score', async () => {
    await store.upsertChunks('kb1', 'page-a', makeChunks('page-a', 3, 4));
    const queryEmb = [0.1, 0.2, 0.3, 0.4];
    const results = await store.searchChunks('kb1', queryEmb, 10);
    expect(results.length).toBe(3);
    for (const r of results) {
      expect(r.pageId).toBe('page-a');
      expect(r.chunkId).toContain('page-a#');
      expect(typeof r.score).toBe('number');
      expect(r.chunkText).toContain('chunk');
    }
  });

  it('search 在空表上返回空数组', async () => {
    const results = await store.searchChunks('kb1', [0.1, 0.2], 10);
    expect(results).toEqual([]);
  });

  it('clear 清空所有 chunks', async () => {
    await store.upsertChunks('kb1', 'page-a', makeChunks('page-a', 3, 4));
    await store.upsertChunks('kb1', 'page-b', makeChunks('page-b', 4, 4));
    await store.clearChunks('kb1');
    expect(await store.countChunks('kb1')).toBe(0);
  });

  it('clear 在空表上是幂等的', async () => {
    await store.clearChunks('kb1');
    expect(await store.countChunks('kb1')).toBe(0);
  });

  it('delete 在不存在的 page 上是幂等的', async () => {
    await store.deletePage('kb1', 'never-existed');
    expect(await store.countChunks('kb1')).toBe(0);
  });

  it('不同 kbId 互不干扰', async () => {
    await store.upsertChunks('kb1', 'page-a', makeChunks('page-a', 2, 4));
    await store.upsertChunks('kb2', 'page-a', makeChunks('page-a', 3, 4));
    expect(await store.countChunks('kb1')).toBe(2);
    expect(await store.countChunks('kb2')).toBe(3);
  });

  it('指纹持久化与读取', async () => {
    await store.saveFingerprint('kb1', 'sha256:abc123');
    const fp = await store.loadFingerprint('kb1');
    expect(fp).toBe('sha256:abc123');
  });

  it('未保存的指纹返回 null', async () => {
    const fp = await store.loadFingerprint('kb1');
    expect(fp).toBeNull();
  });

  it('pageCount 返回去重页数', async () => {
    await store.upsertChunks('kb1', 'page-a', makeChunks('page-a', 3, 4));
    await store.upsertChunks('kb1', 'page-b', makeChunks('page-b', 2, 4));
    const coverage = await store.getCoverage('kb1');
    expect(coverage.chunks).toBe(5);
    expect(coverage.pages).toBe(2);
  });

  it('搜索结果按 score 降序', async () => {
    await store.upsertChunks('kb1', 'page-a', makeChunks('page-a', 5, 4));
    const results = await store.searchChunks('kb1', [0.3, 0.1, 0.5, 0.2], 10);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }
  });
});
