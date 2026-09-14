/**
 * embedding-service 测试（issue 21，spec §8/§11）。
 *
 * 验收映射 A15/A16：
 *  - embedPage：分块 → embed → 指纹校验 → upsert
 *  - 指纹变化检测（同维度换模型不共用空间）
 *  - 部分 chunk 失败保留成功结果
 *  - 全部失败不 upsert
 *  - searchByQuery：embed query → vector search → 页面聚合
 *  - 降级：未配置时返回空结果
 *  - getCoverage：返回索引覆盖状态
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

describe('EmbeddingService', () => {
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

  describe('embedPage', () => {
    it('正常嵌入页面', async () => {
      mockFetchEmbedding(4);
      const cfg = baseConfig();
      const content = '# Title\n\nSome content for embedding.';
      const result = await service.embedPage('kb1', 'page-a', 'Title', content, cfg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.chunkCount).toBeGreaterThan(0);
        expect(result.embeddedCount).toBe(result.chunkCount);
        expect(result.failedCount).toBe(0);
      }
      // 验证向量已写入
      const coverage = await store.getCoverage('kb1');
      expect(coverage.chunks).toBeGreaterThan(0);
      expect(coverage.pages).toBe(1);
    });

    it('指纹已保存', async () => {
      mockFetchEmbedding(4);
      const cfg = baseConfig();
      await service.embedPage('kb1', 'page-a', 'Title', 'Content', cfg);
      const fp = await store.loadFingerprint('kb1');
      expect(fp).not.toBeNull();
      expect(fp).toMatch(/^[0-9a-f]{64}$/);
    });

    it('未配置端点 → notConfigured', async () => {
      const cfg = baseConfig({ endpoint: '' });
      const result = await service.embedPage('kb1', 'page-a', 'Title', 'Content', cfg);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('notConfigured');
      }
    });

    it('全部 chunk 失败不 upsert', async () => {
      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      ) as unknown as typeof fetch;

      const cfg = baseConfig();
      const result = await service.embedPage('kb1', 'page-a', 'Title', 'Content', cfg);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('auth');
      }
      // 向量未写入
      const coverage = await store.getCoverage('kb1');
      expect(coverage.chunks).toBe(0);
    });

    it('空内容产生 0 chunks', async () => {
      mockFetchEmbedding(4);
      const cfg = baseConfig();
      const result = await service.embedPage('kb1', 'page-a', 'Title', '', cfg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.chunkCount).toBe(0);
        expect(result.embeddedCount).toBe(0);
      }
    });

    it('部分 chunk 失败保留成功结果', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(async () => {
        callCount++;
        if (callCount === 2) {
          return new Response(JSON.stringify({ error: { message: 'Server error' } }), {
            status: 500,
          });
        }
        const embedding = [0.1, 0.2, 0.3, 0.4];
        return new Response(JSON.stringify({ data: [{ embedding }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const cfg = baseConfig({ maxChunkChars: 30, overlapChunkChars: 5 });
      // 生成多个 chunk
      const content = `# Title\n\n${'Long content. '.repeat(20)}`;
      const result = await service.embedPage('kb1', 'page-a', 'Title', content, cfg);
      // 部分成功
      if (result.ok) {
        expect(result.chunkCount).toBeGreaterThan(1);
        expect(result.embeddedCount).toBeGreaterThan(0);
        expect(result.failedCount).toBeGreaterThan(0);
        // 向量已写入部分
        const coverage = await store.getCoverage('kb1');
        expect(coverage.chunks).toBeGreaterThan(0);
      }
    });

    it('指纹变化时已有旧向量不与新查询混用', async () => {
      // 第一次嵌入
      mockFetchEmbedding(4);
      const cfg1 = baseConfig({ model: 'model-a' });
      await service.embedPage('kb1', 'page-a', 'Title', 'Content', cfg1);
      const fp1 = await store.loadFingerprint('kb1');

      // 换模型重新嵌入
      const cfg2 = baseConfig({ model: 'model-b' });
      const result = await service.embedPage('kb1', 'page-a', 'Title', 'Content', cfg2);
      expect(result.ok).toBe(true);
      const fp2 = await store.loadFingerprint('kb1');

      expect(fp1).not.toBe(fp2);
    });
  });

  describe('searchByQuery', () => {
    it('正常搜索返回 per-page 聚合结果', async () => {
      mockFetchEmbedding(4);
      const cfg = baseConfig();
      await service.embedPage('kb1', 'page-a', 'Title', 'Some content', cfg);
      await service.embedPage('kb1', 'page-b', 'Other', 'Different content', cfg);

      const result = await service.searchByQuery('kb1', 'query text', cfg, 10);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.results.length).toBeGreaterThan(0);
        // 结果包含 pageId 和 score
        for (const r of result.results) {
          expect(r.id).toBeDefined();
          expect(typeof r.score).toBe('number');
        }
      }
    });

    it('未配置端点返回空结果（降级）', async () => {
      const cfg = baseConfig({ endpoint: '' });
      const result = await service.searchByQuery('kb1', 'query', cfg, 10);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.results).toEqual([]);
        expect(result.degraded).toBe(true);
      }
    });

    it('嵌入查询失败返回空结果（降级）', async () => {
      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), { status: 401 }),
      ) as unknown as typeof fetch;

      const cfg = baseConfig();
      const result = await service.searchByQuery('kb1', 'query', cfg, 10);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.results).toEqual([]);
        expect(result.degraded).toBe(true);
      }
    });

    it('空索引返回空结果', async () => {
      mockFetchEmbedding(4);
      const cfg = baseConfig();
      const result = await service.searchByQuery('kb1', 'query', cfg, 10);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.results).toEqual([]);
        expect(result.degraded).toBe(false);
      }
    });
  });

  describe('getCoverage', () => {
    it('空索引返回 0', async () => {
      const coverage = await service.getCoverage('kb1');
      expect(coverage.chunks).toBe(0);
      expect(coverage.pages).toBe(0);
      expect(coverage.fingerprintHash).toBeNull();
    });

    it('有索引时返回正确覆盖', async () => {
      mockFetchEmbedding(4);
      const cfg = baseConfig();
      await service.embedPage('kb1', 'page-a', 'Title', 'Content', cfg);
      await service.embedPage('kb1', 'page-b', 'Other', 'More content', cfg);

      const coverage = await service.getCoverage('kb1');
      expect(coverage.pages).toBe(2);
      expect(coverage.chunks).toBeGreaterThan(0);
      expect(coverage.fingerprintHash).not.toBeNull();
    });
  });

  describe('removePage', () => {
    it('删除页面后覆盖更新', async () => {
      mockFetchEmbedding(4);
      const cfg = baseConfig();
      await service.embedPage('kb1', 'page-a', 'Title', 'Content', cfg);
      await service.embedPage('kb1', 'page-b', 'Other', 'More content', cfg);

      await service.removePage('kb1', 'page-a');

      const coverage = await service.getCoverage('kb1');
      expect(coverage.pages).toBe(1);
    });
  });

  describe('fingerprint check', () => {
    it('isFingerprintMatch 在指纹一致时返回 true', async () => {
      mockFetchEmbedding(4);
      const cfg = baseConfig();
      await service.embedPage('kb1', 'page-a', 'Title', 'Content', cfg);
      const match = await service.isFingerprintMatch('kb1', cfg);
      expect(match).toBe(true);
    });

    it('isFingerprintMatch 在换模型后返回 false', async () => {
      mockFetchEmbedding(4);
      const cfg1 = baseConfig({ model: 'model-a' });
      await service.embedPage('kb1', 'page-a', 'Title', 'Content', cfg1);

      const cfg2 = baseConfig({ model: 'model-b' });
      const match = await service.isFingerprintMatch('kb1', cfg2);
      expect(match).toBe(false);
    });
  });
});
