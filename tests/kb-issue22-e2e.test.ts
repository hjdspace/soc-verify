/**
 * Issue 22 端到端测试：页面触发 → 索引状态 → 读取记录。
 *
 * 验收映射 A15 A16：
 *  - 从页面内容触发嵌入 → 索引状态记录 → 向量搜索可查
 *  - revision 替换：新 revision 替换同页同 revision，旧 revision 保留
 *  - 失败保留旧数据：嵌入失败不删除已有索引
 *  - 索引状态：配置指纹、实际维度、错误状态可见
 *  - 重试不重新编译：指纹一致跳过重建
 *  - 超大原子块：保留全文，覆盖报告真实
 *  - 偏移可回溯原文
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EmbeddingService } from '../src/main/kb/embedding-service';
import { MemoryVectorBackend, VectorStore } from '../src/main/kb/vector-store';
import { chunkMarkdown } from '../src/main/kb/text-chunker';
import type { EmbeddingRuntimeConfig } from '@shared/kb-types';

function baseConfig(overrides: Partial<EmbeddingRuntimeConfig> = {}): EmbeddingRuntimeConfig {
  return {
    endpoint: 'https://api.example.com/v1/embeddings',
    apiKey: 'test-key',
    model: 'text-embedding-3-small',
    expectedDimensions: 4,
    maxChunkChars: 1000,
    overlapChunkChars: 200,
    concurrency: 2,
    ...overrides,
  };
}

/**
 * Mock fetch that returns deterministic embeddings based on text content.
 * Different texts get different embeddings so search results are distinguishable.
 */
function mockFetchDeterministic(dim: number = 4): void {
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const bodyStr = init?.body as string ?? '{}';
    const body = JSON.parse(bodyStr);
    const text: string = body.input ?? '';
    // Generate deterministic but varied embedding from text hash
    const embedding = Array.from({ length: dim }, (_, i) => {
      const charCode = text.charCodeAt(i % text.length) || 65;
      return ((charCode % 10) + (i + 1)) / 10;
    });
    return new Response(JSON.stringify({ data: [{ embedding }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

function mockFetchError(status: number, message: string): void {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ error: { message } }), { status }),
  ) as unknown as typeof fetch;
}

describe('Issue 22 — 端到端：页面触发 → 索引状态 → 读取记录', () => {
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

  describe('完整流程：页面发布 → 嵌入 → 索引状态 → 搜索', () => {
    it('单页发布后索引状态正确记录，搜索可查', async () => {
      mockFetchDeterministic(4);
      const cfg = baseConfig();
      const pageContent = [
        '# AXI 协议概述',
        '',
        '## 突发传输',
        '',
        'AXI 协议支持突发传输，AWLEN 控制突发长度。',
        '',
        '## 流控',
        '',
        'AXI 使用 VALID/READY 握手实现流控。',
      ].join('\n');

      // Step 1: 页面触发嵌入
      const embedResult = await service.embedPage(
        'kb-e2e', 'concepts/axi', 'AXI 协议概述', pageContent, cfg, 'rev-1',
      );
      expect(embedResult.ok).toBe(true);
      if (!embedResult.ok) return;
      expect(embedResult.embeddedCount).toBeGreaterThan(0);
      expect(embedResult.failedCount).toBe(0);

      // Step 2: 读取索引状态
      const status = await service.getIndexStatus('kb-e2e', cfg);
      expect(status.fingerprintHash).not.toBeNull();
      expect(status.actualDimensions).toBe(4);
      expect(status.expectedDimensions).toBe(4);
      expect(status.errorStatus).toBeNull();

      // Step 3: 搜索验证
      const searchResult = await service.searchByQuery('kb-e2e', 'AXI 突发传输', cfg, 10, 'rev-1');
      expect(searchResult.degraded).toBe(false);
      expect(searchResult.results.length).toBeGreaterThan(0);
      expect(searchResult.results[0].id).toBe('concepts/axi');
      expect(searchResult.results[0].revision).toBe('rev-1');

      // Step 4: 覆盖状态
      const coverage = await store.getCoverage('kb-e2e');
      expect(coverage.pages).toBe(1);
      expect(coverage.chunks).toBeGreaterThan(0);
      expect(coverage.fingerprintHash).not.toBeNull();
    });

    it('多页发布后索引状态聚合正确', async () => {
      mockFetchDeterministic(4);
      const cfg = baseConfig();

      // 发布三个页面
      await service.embedPage('kb-e2e', 'concepts/axi', 'AXI', 'AXI 协议内容。', cfg, 'rev-1');
      await service.embedPage('kb-e2e', 'concepts/ahb', 'AHB', 'AHB 协议内容。', cfg, 'rev-1');
      await service.embedPage('kb-e2e', 'concepts/apb', 'APB', 'APB 协议内容。', cfg, 'rev-1');

      const coverage = await store.getCoverage('kb-e2e');
      expect(coverage.pages).toBe(3);
      expect(coverage.chunks).toBeGreaterThanOrEqual(3);

      // 搜索可找到所有页面
      const searchResult = await service.searchByQuery('kb-e2e', '协议', cfg, 10, 'rev-1');
      expect(searchResult.results.length).toBe(3);
    });
  });

  describe('revision 替换流程', () => {
    it('页面更新后新 revision 替换，旧 revision 仍可查', async () => {
      mockFetchDeterministic(4);
      const cfg = baseConfig();

      // 初次发布 rev-1
      await service.embedPage(
        'kb-e2e', 'concepts/axi', 'AXI', 'AXI 协议第一版内容。', cfg, 'rev-1',
      );

      // 更新发布 rev-2
      await service.embedPage(
        'kb-e2e', 'concepts/axi', 'AXI', 'AXI 协议第二版内容，增加了流控章节。', cfg, 'rev-2',
      );

      // rev-2 可查
      const searchRev2 = await service.searchByQuery('kb-e2e', 'AXI', cfg, 10, 'rev-2');
      expect(searchRev2.results.length).toBeGreaterThan(0);
      expect(searchRev2.results[0].revision).toBe('rev-2');

      // rev-1 仍可查（旧 revision 保留）
      const searchRev1 = await service.searchByQuery('kb-e2e', 'AXI', cfg, 10, 'rev-1');
      expect(searchRev1.results.length).toBeGreaterThan(0);
      expect(searchRev1.results[0].revision).toBe('rev-1');

      // 不传 revision → 返回所有
      const searchAll = await service.searchByQuery('kb-e2e', 'AXI', cfg, 10);
      expect(searchAll.results.length).toBeGreaterThan(0);
    });

    it('同 revision 重嵌入替换旧 chunks，不累积', async () => {
      mockFetchDeterministic(4);
      const cfg = baseConfig();

      await service.embedPage('kb-e2e', 'p1', 'Page', 'Content v1', cfg, 'rev-1');
      const coverageAfter1 = await store.getCoverage('kb-e2e', 'rev-1');

      await service.embedPage('kb-e2e', 'p1', 'Page', 'Content v2', cfg, 'rev-1');
      const coverageAfter2 = await store.getCoverage('kb-e2e', 'rev-1');

      // 同 revision 同 page → 替换，不累积
      expect(coverageAfter2.chunks).toBe(coverageAfter1.chunks);
    });
  });

  describe('失败恢复流程', () => {
    it('嵌入失败 → 索引记录错误 → 恢复后重试成功', async () => {
      mockFetchDeterministic(4);
      const cfg = baseConfig();

      // 初次成功嵌入
      await service.embedPage('kb-e2e', 'p1', 'Page', 'Content', cfg, 'rev-1');
      const statusOk = await service.getIndexStatus('kb-e2e', cfg);
      expect(statusOk.errorStatus).toBeNull();

      // 模拟嵌入失败（401 auth error）
      mockFetchError(401, 'Unauthorized');
      const failResult = await service.embedPage(
        'kb-e2e', 'p2', 'Page2', 'Content 2', cfg, 'rev-1',
      );
      expect(failResult.ok).toBe(false);

      // 错误状态可见
      const statusErr = await service.getIndexStatus('kb-e2e', cfg);
      expect(statusErr.errorStatus).not.toBeNull();
      expect(statusErr.errorStatus!.kind).toBe('auth');

      // 旧索引仍在
      const coverage = await store.getCoverage('kb-e2e');
      expect(coverage.chunks).toBeGreaterThan(0);

      // 恢复后重试
      mockFetchDeterministic(4);
      const retryResult = await service.embedPage(
        'kb-e2e', 'p2', 'Page2', 'Content 2', cfg, 'rev-1',
      );
      expect(retryResult.ok).toBe(true);

      // 错误状态清除
      const statusRecovered = await service.getIndexStatus('kb-e2e', cfg);
      expect(statusRecovered.errorStatus).toBeNull();
    });

    it('未配置嵌入端点 → 降级返回空结果，关键词搜索不受影响', async () => {
      const cfg = baseConfig({
        endpoint: '',
        apiKey: '',
        model: '',
      });

      // embedPage 返回 notConfigured 错误
      const embedResult = await service.embedPage(
        'kb-e2e', 'p1', 'Page', 'Content', cfg, 'rev-1',
      );
      expect(embedResult.ok).toBe(false);

      // searchByQuery 降级返回空结果
      const searchResult = await service.searchByQuery('kb-e2e', 'test', cfg, 10);
      expect(searchResult.degraded).toBe(true);
      expect(searchResult.results).toEqual([]);
    });
  });

  describe('覆盖报告与偏移回溯', () => {
    it('超大原子块在覆盖报告中真实体现，偏移可回溯原文', async () => {
      mockFetchDeterministic(4);
      const cfg = baseConfig({ maxChunkChars: 50, overlapChunkChars: 5 });
      const longCode = 'x'.repeat(200);
      const pageContent = `# Page\n\nIntro text.\n\n\`\`\`text\n${longCode}\n\`\`\`\n`;

      // 分块检查
      const chunkResult = chunkMarkdown(pageContent, 50, 5, { reportCoverage: true });
      expect(chunkResult.coverage!.skippedChunks).toBeGreaterThan(0);

      // 嵌入后覆盖报告仍可见
      const embedResult = await service.embedPage(
        'kb-e2e', 'p1', 'Page', pageContent, cfg, 'rev-1',
      );
      expect(embedResult.ok).toBe(true);
      if (!embedResult.ok) return;
      expect(embedResult.skippedCount).toBeGreaterThan(0);
      expect(embedResult.coverage!.skippedChunks).toBeGreaterThan(0);
      // 全文仍可读
      expect(embedResult.chunkCount).toBeGreaterThan(embedResult.embeddedCount);

      // 搜索结果中的偏移可回溯原文
      const searchResult = await service.searchByQuery('kb-e2e', 'Page', cfg, 10, 'rev-1');
      expect(searchResult.results.length).toBeGreaterThan(0);
      const hit = searchResult.results[0];
      expect(hit.matchedChunks).toBeDefined();
      expect(hit.matchedChunks!.length).toBeGreaterThan(0);
      const chunk = hit.matchedChunks![0];
      expect(chunk.start).toBeDefined();
      expect(chunk.end).toBeDefined();
      expect(chunk.end!).toBeGreaterThan(chunk.start!);
    });

    it('正常页面分块覆盖报告全覆盖', async () => {
      mockFetchDeterministic(4);
      const cfg = baseConfig();
      const pageContent = '# Title\n\nNormal content.\n\n## Section\n\nMore content.';
      const embedResult = await service.embedPage(
        'kb-e2e', 'p1', 'Title', pageContent, cfg, 'rev-1',
      );
      expect(embedResult.ok).toBe(true);
      if (!embedResult.ok) return;
      expect(embedResult.skippedCount).toBe(0);
      expect(embedResult.coverage!.coveredChunks).toBe(embedResult.coverage!.totalChunks);
    });
  });

  describe('指纹与重试', () => {
    it('指纹一致时重试不需重建，换模型后指纹不一致', async () => {
      mockFetchDeterministic(4);
      const cfg = baseConfig();
      await service.embedPage('kb-e2e', 'p1', 'Page', 'Content', cfg, 'rev-1');

      // 同配置 → 指纹一致
      const match1 = await service.isFingerprintMatch('kb-e2e', cfg);
      expect(match1).toBe(true);

      // 换模型 → 指纹不一致
      const cfg2 = baseConfig({ model: 'different-model' });
      const match2 = await service.isFingerprintMatch('kb-e2e', cfg2);
      expect(match2).toBe(false);

      // 指纹签名在索引状态中可见
      const status = await service.getIndexStatus('kb-e2e', cfg);
      expect(status.fingerprintSignature).toBeDefined();
    });

    it('维度不匹配时状态报告实际维度与预期维度', async () => {
      mockFetchDeterministic(4);
      const cfg = baseConfig({ expectedDimensions: 4 });
      await service.embedPage('kb-e2e', 'p1', 'Page', 'Content', cfg, 'rev-1');

      // 用不同预期维度查询状态
      const cfgWrongDim = baseConfig({ expectedDimensions: 8 });
      const status = await service.getIndexStatus('kb-e2e', cfgWrongDim);
      expect(status.actualDimensions).toBe(4); // 实际存储的
      expect(status.expectedDimensions).toBe(8); // 配置预期的
    });
  });

  describe('删除与清理', () => {
    it('删除单页向量，其他页不受影响', async () => {
      mockFetchDeterministic(4);
      const cfg = baseConfig();

      await service.embedPage('kb-e2e', 'p1', 'Page1', 'Content 1', cfg, 'rev-1');
      await service.embedPage('kb-e2e', 'p2', 'Page2', 'Content 2', cfg, 'rev-1');

      const before = await store.getCoverage('kb-e2e');
      expect(before.pages).toBe(2);

      await service.removePage('kb-e2e', 'p1');

      const after = await store.getCoverage('kb-e2e');
      expect(after.pages).toBe(1);
      expect(after.chunks).toBeLessThan(before.chunks);
    });

    it('按 revision 删除只删除指定 revision 的 chunks', async () => {
      mockFetchDeterministic(4);
      const cfg = baseConfig();

      await service.embedPage('kb-e2e', 'p1', 'Page', 'Content v1', cfg, 'rev-1');
      await service.embedPage('kb-e2e', 'p1', 'Page', 'Content v2', cfg, 'rev-2');

      const before = await store.getCoverage('kb-e2e');
      expect(before.chunks).toBeGreaterThanOrEqual(2);

      // 只删 rev-1
      await service.removePage('kb-e2e', 'p1', 'rev-1');

      // rev-2 仍在
      const searchRev2 = await service.searchByQuery('kb-e2e', 'Content', cfg, 10, 'rev-2');
      expect(searchRev2.results.length).toBeGreaterThan(0);

      // rev-1 已删
      const searchRev1 = await service.searchByQuery('kb-e2e', 'Content', cfg, 10, 'rev-1');
      expect(searchRev1.results.length).toBe(0);
    });
  });
});
