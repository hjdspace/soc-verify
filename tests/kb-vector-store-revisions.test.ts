/**
 * vector-store revision 过滤测试（issue 22，spec §8）。
 *
 * 验收映射 A15：
 *  - 整页 chunks 准备后按 revision 替换
 *  - 失败保留旧数据（部分 upsert 不删除旧 revision）
 *  - 查询过滤过期 revision（旧 revision 的向量不得与当前正文拼接使用）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryVectorBackend, VectorStore } from '../src/main/kb/vector-store';
import type { VectorUpsertChunk } from '@shared/kb-types';

function makeChunk(index: number, text: string, embedding: number[]): VectorUpsertChunk {
  return {
    chunkIndex: index,
    chunkText: text,
    headingPath: '',
    start: 0,
    end: text.length,
    embedding,
  };
}

describe('VectorStore — revision 过滤（issue 22）', () => {
  let store: VectorStore;

  beforeEach(() => {
    store = new VectorStore(new MemoryVectorBackend());
  });

  it('upsertChunks 带 revision 存储到 chunk 记录', async () => {
    const chunks = [makeChunk(0, 'content', [0.1, 0.2, 0.3])];
    await store.upsertChunks('kb1', 'page-a', chunks, 'rev-1');

    // 搜索时带 revision 过滤
    const hits = await store.searchChunks('kb1', [0.1, 0.2, 0.3], 10, { revision: 'rev-1' });
    expect(hits.length).toBe(1);
    expect(hits[0].revision).toBe('rev-1');
  });

  it('查询过滤过期 revision：只返回匹配 revision 的 chunks', async () => {
    // 写入 rev-1
    const chunks1 = [makeChunk(0, 'old content', [0.1, 0.2, 0.3])];
    await store.upsertChunks('kb1', 'page-a', chunks1, 'rev-1');

    // 写入 rev-2（替换）
    const chunks2 = [makeChunk(0, 'new content', [0.4, 0.5, 0.6])];
    await store.upsertChunks('kb1', 'page-a', chunks2, 'rev-2');

    // 查询 rev-2 → 只返回 rev-2 的 chunks
    const hitsRev2 = await store.searchChunks('kb1', [0.4, 0.5, 0.6], 10, { revision: 'rev-2' });
    expect(hitsRev2.length).toBe(1);
    expect(hitsRev2[0].revision).toBe('rev-2');
    expect(hitsRev2[0].chunkText).toBe('new content');

    // 查询 rev-1 → 旧数据仍存在（未被 rev-2 upsert 删除）
    const hitsRev1 = await store.searchChunks('kb1', [0.1, 0.2, 0.3], 10, { revision: 'rev-1' });
    expect(hitsRev1.length).toBe(1);
    expect(hitsRev1[0].revision).toBe('rev-1');
    expect(hitsRev1[0].chunkText).toBe('old content');
  });

  it('不传 revision 过滤时返回所有 chunks（向后兼容）', async () => {
    const chunks = [makeChunk(0, 'content', [0.1, 0.2, 0.3])];
    await store.upsertChunks('kb1', 'page-a', chunks, 'rev-1');

    const hits = await store.searchChunks('kb1', [0.1, 0.2, 0.3], 10);
    expect(hits.length).toBe(1);
  });

  it('按 revision 替换：同 page+revision 的旧 chunks 被替换，旧 revision 保留', async () => {
    // rev-1 有 2 chunks
    const chunks1 = [
      makeChunk(0, 'old chunk 0', [0.1, 0.0, 0.0]),
      makeChunk(1, 'old chunk 1', [0.0, 0.1, 0.0]),
    ];
    await store.upsertChunks('kb1', 'page-a', chunks1, 'rev-1');

    // rev-1 替换为 1 chunk（同 revision 替换语义）
    const chunks2 = [makeChunk(0, 'new chunk 0', [0.0, 0.0, 0.1])];
    await store.upsertChunks('kb1', 'page-a', chunks2, 'rev-1');

    // rev-1 现在只有 1 chunk（同 page+revision 替换）
    const hitsRev1 = await store.searchChunks('kb1', [0.0, 0.0, 0.1], 10, { revision: 'rev-1' });
    expect(hitsRev1.length).toBe(1);
    expect(hitsRev1[0].chunkText).toBe('new chunk 0');

    // 旧的 rev-1 chunk 0 和 chunk 1 不再存在（被替换）
    const hitsOld0 = await store.searchChunks('kb1', [0.1, 0.0, 0.0], 10, { revision: 'rev-1' });
    const old0Texts = hitsOld0.map((h) => h.chunkText);
    expect(old0Texts).not.toContain('old chunk 0');
    expect(old0Texts).not.toContain('old chunk 1');
  });

  it('deletePage 带 revision 只删指定 revision 的 chunks', async () => {
    const chunks1 = [makeChunk(0, 'rev1 content', [0.1, 0.2, 0.3])];
    await store.upsertChunks('kb1', 'page-a', chunks1, 'rev-1');

    const chunks2 = [makeChunk(0, 'rev2 content', [0.4, 0.5, 0.6])];
    await store.upsertChunks('kb1', 'page-a', chunks2, 'rev-2');

    // 只删 rev-1
    await store.deletePage('kb1', 'page-a', 'rev-1');

    // rev-2 仍在
    const hitsRev2 = await store.searchChunks('kb1', [0.4, 0.5, 0.6], 10, { revision: 'rev-2' });
    expect(hitsRev2.length).toBe(1);

    // rev-1 被删
    const hitsRev1 = await store.searchChunks('kb1', [0.1, 0.2, 0.3], 10, { revision: 'rev-1' });
    expect(hitsRev1.length).toBe(0);
  });

  it('getCoverage 带 revision 返回指定 revision 的覆盖', async () => {
    const chunks1 = [makeChunk(0, 'rev1', [0.1, 0.2, 0.3])];
    await store.upsertChunks('kb1', 'page-a', chunks1, 'rev-1');
    const chunks2 = [makeChunk(0, 'rev2', [0.4, 0.5, 0.6])];
    await store.upsertChunks('kb1', 'page-b', chunks2, 'rev-2');

    const covAll = await store.getCoverage('kb1');
    expect(covAll.pages).toBe(2);
    expect(covAll.chunks).toBe(2);

    const covRev1 = await store.getCoverage('kb1', 'rev-1');
    expect(covRev1.pages).toBe(1);
    expect(covRev1.chunks).toBe(1);
  });
});
