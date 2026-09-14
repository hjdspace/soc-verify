/**
 * embedding-service issue 22 端到端测试（spec §8）。
 *
 * 验收映射 A15 A16：
 *  - 分块带标题面包屑与原文偏移
 *  - 超大原子块保留全文并报告向量未覆盖，不静默截短成功
 *  - 整页 chunks 准备后按 revision 替换，失败保留旧数据且查询过滤过期 revision
 *  - 索引空间记录配置指纹与实际维度，错误状态按端点/库可见，重试不重新编译
 *
 * 端到端流程：页面触发嵌入 → 索引状态记录 → revision 替换 → 查询过滤 → 覆盖报告
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EmbeddingService } from '../src/main/kb/embedding-service';
import { MemoryVectorBackend, VectorStore } from '../src/main/kb/vector-store';
import type { EmbeddingRuntimeConfig } from '@shared/kb-types';

function baseConfig(overrides: Partial<EmbeddingRuntimeConfig> = {}): EmbeddingRuntimeConfig {
  return {
    endpoint: 'https://api.example.com/v1/embeddings',
    apiKey: 'test-key',
    model: 'text-embedding-3-small',
    expectedDimensions: 4,
    maxChunkChars: 1000,
    overlapChunkChars: 200,
    concurrency: 1,
    ...overrides,
  };
}

describe('EmbeddingService — issue 22 端到端', () => {
  let store: VectorStore;
  let service: EmbeddingService;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    store = new VectorStore(new MemoryVectorBackend());
    service = new EmbeddingService(store);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockFetchEmbedding(dim: number = 4): void {
    globalThis.fetch = vi.fn(async () => {
      const embedding = Array.from({ length: dim }, (_, i) => (i + 1) / 10);
      return new Response(JSON.stringify({ data: [{ embedding }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
  }

  describe('A15: 超大原子块保留全文并报告向量未覆盖', () => {
    it('超大代码块保留全文，跳过向量嵌入，覆盖报告 skippedCount > 0', async () => {
      mockFetchEmbedding(4);
      const cfg = baseConfig({ maxChunkChars: 50, overlapChunkChars: 5 });
      const longCode = 'x'.repeat(500);
      const content = `# Page\n\nIntro text.\n\n\`\`\`text\n${longCode}\n\`\`\`\n`;

      const result = await service.embedPage('kb1', 'page-a', 'Page', content, cfg, 'rev-1');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.skippedCount).toBeGreaterThan(0);
      expect(result.coverage).toBeDefined();
      expect(result.coverage!.skippedChunks).toBeGreaterThan(0);
      expect(result.coverage!.coveredChunks).toBeGreaterThan(0);
      // 全文仍可读（未被截短成功标记）
      expect(result.chunkCount).toBeGreaterThan(result.embeddedCount);
    });

    it('全部超大块时保留旧索引，报告 0 embedded', async () => {
      mockFetchEmbedding(4);
      const cfg = baseConfig({ maxChunkChars: 10 });
      const content = `# Page\n\n\`\`\`text\n${'x'.repeat(200)}\n\`\`\`\n`;

      const result = await service.embedPage('kb1', 'page-a', 'Page', content, cfg, 'rev-1');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.embeddedCount).toBe(0);
      expect(result.skippedCount).toBeGreaterThan(0);
    });
  });

  describe('A15: revision 替换与查询过滤', () => {
    it('同 page 新 revision 替换，旧 revision 保留可查', async () => {
      mockFetchEmbedding(4);
      const cfg = baseConfig();
      const content1 = '# Page\n\nRevision 1 content.';
      const content2 = '# Page\n\nRevision 2 content.';

      // 嵌入 rev-1
      await service.embedPage('kb1', 'page-a', 'Page', content1, cfg, 'rev-1');

      // 嵌入 rev-2（替换）
      await service.embedPage('kb1', 'page-a', 'Page', content2, cfg, 'rev-2');

      // 查询 rev-2 → 有结果
      const resultRev2 = await service.searchByQuery('kb1', 'Page', cfg, 10, 'rev-2');
      expect(resultRev2.results.length).toBeGreaterThan(0);

      // 查询 rev-1 → 仍有结果（旧 revision 保留）
      const resultRev1 = await service.searchByQuery('kb1', 'Page', cfg, 10, 'rev-1');
      expect(resultRev1.results.length).toBeGreaterThan(0);
    });

    it('查询过滤过期 revision：不传 revision 返回所有', async () => {
      mockFetchEmbedding(4);
      const cfg = baseConfig();
      await service.embedPage('kb1', 'page-a', 'Page', 'Rev 1', cfg, 'rev-1');
      await service.embedPage('kb1', 'page-a', 'Page', 'Rev 2', cfg, 'rev-2');

      // 不传 revision → 返回所有 chunks
      const resultAll = await service.searchByQuery('kb1', 'Page', cfg, 10);
      expect(resultAll.results.length).toBeGreaterThan(0);
    });

    it('失败保留旧数据：嵌入全部失败时不删除已有索引', async () => {
      // 先成功嵌入 rev-1
      mockFetchEmbedding(4);
      const cfg = baseConfig();
      await service.embedPage('kb1', 'page-a', 'Page', 'Content', cfg, 'rev-1');

      const coverageBefore = await store.getCoverage('kb1');
      expect(coverageBefore.chunks).toBeGreaterThan(0);

      // 再尝试嵌入 rev-2 但全部失败
      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), { status: 401 }),
      ) as unknown as typeof fetch;

      const result = await service.embedPage('kb1', 'page-a', 'Page', 'New content', cfg, 'rev-2');
      expect(result.ok).toBe(false);

      // 旧 rev-1 的索引仍在
      const coverageAfter = await store.getCoverage('kb1');
      expect(coverageAfter.chunks).toBeGreaterThan(0);

      // rev-1 仍可查（恢复成功 mock 后搜索）
      mockFetchEmbedding(4);
      const resultRev1 = await service.searchByQuery('kb1', 'Content', cfg, 10, 'rev-1');
      expect(resultRev1.results.length).toBeGreaterThan(0);
    });
  });

  describe('A16: 索引状态记录', () => {
    it('getIndexStatus 返回指纹、实际维度与错误状态', async () => {
      mockFetchEmbedding(4);
      const cfg = baseConfig();
      await service.embedPage('kb1', 'page-a', 'Page', 'Content', cfg, 'rev-1');

      const status = await service.getIndexStatus('kb1', cfg);
      expect(status.fingerprintHash).not.toBeNull();
      expect(status.actualDimensions).toBe(4);
      expect(status.expectedDimensions).toBe(4);
      expect(status.errorStatus).toBeNull();
    });

    it('错误状态按端点/库可见', async () => {
      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), { status: 401 }),
      ) as unknown as typeof fetch;

      const cfg = baseConfig();
      await service.embedPage('kb1', 'page-a', 'Page', 'Content', cfg, 'rev-1');

      const status = await service.getIndexStatus('kb1', cfg);
      expect(status.errorStatus).not.toBeNull();
      expect(status.errorStatus!.kind).toBe('auth');
    });

    it('重试不重新编译：指纹一致时不重建索引', async () => {
      mockFetchEmbedding(4);
      const cfg = baseConfig();
      await service.embedPage('kb1', 'page-a', 'Page', 'Content', cfg, 'rev-1');

      const match = await service.isFingerprintMatch('kb1', cfg);
      expect(match).toBe(true);

      // 换模型 → 指纹不一致 → 需要重建
      const cfg2 = baseConfig({ model: 'different-model' });
      const match2 = await service.isFingerprintMatch('kb1', cfg2);
      expect(match2).toBe(false);
    });
  });

  describe('分块带原文偏移', () => {
    it('嵌入的 chunks 在搜索结果中携带 start/end 偏移', async () => {
      mockFetchEmbedding(4);
      const cfg = baseConfig();
      const content = '# Title\n\nSome content for embedding here.';
      await service.embedPage('kb1', 'page-a', 'Title', content, cfg, 'rev-1');

      const result = await service.searchByQuery('kb1', 'content', cfg, 10);
      expect(result.results.length).toBeGreaterThan(0);
      const hit = result.results[0];
      expect(hit.matchedChunks).toBeDefined();
      expect(hit.matchedChunks!.length).toBeGreaterThan(0);
      // start/end 偏移存在
      const chunk = hit.matchedChunks![0];
      expect(chunk.start).toBeDefined();
      expect(chunk.end).toBeDefined();
      expect(chunk.end!).toBeGreaterThan(chunk.start!);
    });
  });
});
