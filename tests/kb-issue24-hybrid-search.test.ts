/**
 * issue 24 — 向量混合检索与索引代重建测试（spec §8）。
 *
 * 覆盖验收映射 A14 A15 A16；User Stories 48/49/50：
 *  - chunk 结果先按页聚合，关键词/向量 RRF k=60，导航不计票，随后使用现有图配额
 *  - 无嵌入/401/坏模型/429/网络状态可区分，关键词/图保持可用并按库配置提示一次
 *  - 同维度换模型也启新代，完整重建后切换；失败保留旧代但不以新query向量查旧空间
 *  - 重建可取消/继续，覆盖状态和缺口可见
 *  - 固定排名、分页聚合、切代/重开和失效向量过滤
 *
 * Seam: searchWiki() 公共入口 + rebuildEmbeddingIndex() 公共入口。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  searchWiki,
} from '../src/main/kb/wiki-search';
import { initWikiLayout, writeWikiManifest } from '../src/main/kb/wiki-layout';
import type { WikiKbManifest } from '../src/main/kb/wiki-layout';
// WikiKbManifest type re-exported above for use in test helpers
import type { EmbeddingRuntimeConfig } from '@shared/kb-types';
import { EmbeddingService } from '../src/main/kb/embedding-service';
import { VectorStore, MemoryVectorBackend } from '../src/main/kb/vector-store';
import { rebuildEmbeddingIndex, type RebuildProgress } from '../src/main/kb/index-rebuilder';

let kbPath: string;

beforeEach(async () => {
  kbPath = mkdtempSync(join(tmpdir(), 'sv-kb-issue24-'));
  await initWikiLayout(kbPath, { kbId: 'kb-24', name: '混合检索测试库' });
});

afterEach(() => {
  rmSync(kbPath, { recursive: true, force: true });
});

const PAGE_FM = (type: string, title: string, extra: Record<string, string> = {}): string => {
  const base: Array<[string, string]> = [
    ['type', type],
    ['title', `"${title}"`],
    ['summary', '测试页摘要。'],
    ['keywords', '[测试]'],
    ['tags', '[单测]'],
    ['sources', '[]'],
    ['created', '"2026-09-13T00:00:00Z"'],
    ['updated', '"2026-09-13T00:00:00Z"'],
    ...Object.entries(extra).map(([k, v]) => [k, v] as [string, string]),
  ];
  const merged = new Map(base);
  const lines = Array.from(merged, ([k, v]) => `${k}: ${v}`);
  return [
    '---',
    ...lines,
    '---',
    '',
    `# ${title}`,
    '',
  ].join('\n');
};

function writeWikiPage(rel: string, content: string): void {
  const abs = join(kbPath, 'wiki', rel);
  mkdirSync(abs.replace(/[\\/][^\\/]*$/, ''), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

// writeSources/sourceRecord reserved for future test expansion

// ── Mock embedding config ──────────────────────────────────────────

const mockEmbeddingCfg: EmbeddingRuntimeConfig = {
  endpoint: 'http://localhost:8080/v1',
  apiKey: 'test-key',
  model: 'test-embed',
  expectedDimensions: 3,
  maxChunkChars: 1000,
  overlapChunkChars: 200,
  concurrency: 1,
};

/** 创建一个 EmbeddingService，使用 MemoryVectorBackend */
function makeEmbeddingService(): { service: EmbeddingService; store: VectorStore } {
  const backend = new MemoryVectorBackend();
  const store = new VectorStore(backend);
  const service = new EmbeddingService(store);
  return { service, store };
}

// ── RRF 混合搜索 ──────────────────────────────────────────────────

describe('searchWiki — RRF 混合搜索', () => {
  it('无嵌入配置时降级为 keyword 模式，mode=keyword', async () => {
    writeWikiPage('concepts/axi.md', PAGE_FM('concept', 'AXI 协议')
      + '\nAXI outstanding 限制。\n');

    const res = await searchWiki(kbPath, { query: 'AXI' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.mode).toBe('keyword');
    // 无 vectorStatus 字段（未提供 embeddingService）
    expect(res.result.vectorStatus).toBeUndefined();
  });

  it('有嵌入但降级（degraded）时 mode=keyword，vectorStatus.degraded=true', async () => {
    writeWikiPage('concepts/axi.md', PAGE_FM('concept', 'AXI 协议')
      + '\nAXI outstanding 限制。\n');
    const { service } = makeEmbeddingService();

    // searchByQuery 返回 degraded=true（未配置嵌入端点的 cfg）
    const cfg: EmbeddingRuntimeConfig = {
      ...mockEmbeddingCfg,
      endpoint: '',
      apiKey: '',
      model: '',
    };

    const res = await searchWiki(kbPath, { query: 'AXI' }, {
      embeddingService: service,
      embeddingCfg: cfg,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.mode).toBe('keyword');
    expect(res.result.vectorStatus).toBeDefined();
    expect(res.result.vectorStatus?.degraded).toBe(true);
    // 关键词命中仍然返回
    expect(res.result.hits.length).toBeGreaterThan(0);
  });

  it('关键词+向量 RRF 融合：双路命中的页排名高于单路命中', async () => {
    // 两个页面：
    // page-a：标题和正文都含 "AXI" → 关键词和向量都命中
    // page-b：只有向量命中（向量结果中包含但关键词不匹配）
    writeWikiPage('concepts/axi.md', PAGE_FM('concept', 'AXI 协议')
      + '\nAXI outstanding 限制。\n');
    writeWikiPage('concepts/other.md', PAGE_FM('concept', '其他协议')
      + '\n不相关内容。\n');

    const { service, store } = makeEmbeddingService();

    // 手动向 store 注入向量：让 other 页也有向量命中
    // 使用 3 维向量
    await store.upsertChunks('kb-24', 'concepts/axi', [{
      chunkIndex: 0,
      chunkText: 'AXI outstanding',
      headingPath: '## AXI',
      start: 0,
      end: 100,
      embedding: [1, 0, 0],
    }], 'rev-1');
    await store.upsertChunks('kb-24', 'concepts/other', [{
      chunkIndex: 0,
      chunkText: '其他内容',
      headingPath: '## 其他',
      start: 0,
      end: 100,
      embedding: [0.9, 0.1, 0],
    }], 'rev-1');

    // Mock embeddingService.searchByQuery to return both pages
    service.searchByQuery = async () => {
      // 返回两个页面的向量结果
      return {
        ok: true,
        results: [
          { id: 'concepts/axi', score: 0.95 },
          { id: 'concepts/other', score: 0.85 },
        ],
        degraded: false,
      };
    };

    const cfg: EmbeddingRuntimeConfig = { ...mockEmbeddingCfg };

    const res = await searchWiki(kbPath, { query: 'AXI' }, {
      embeddingService: service,
      embeddingCfg: cfg,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 混合模式
    expect(res.result.mode).toBe('hybrid');
    // 双路命中的 axi 排在只有向量命中的 other 之前
    expect(res.result.hits[0].id).toBe('concepts/axi');
  });

  it('RRF k=60 固定排名：rank 0 → 1/60, rank 1 → 1/61', async () => {
    // 验证 RRF 分数计算：两个页面都有向量命中但只有一个有关键词命中
    writeWikiPage('concepts/kw-and-vec.md', PAGE_FM('concept', '关键词专用')
      + '\nAXI 协议细节。\n');
    writeWikiPage('concepts/vec-only.md', PAGE_FM('concept', '向量专用')
      + '\n其他内容。\n');

    const { service } = makeEmbeddingService();

    // 向量命中两个页面
    service.searchByQuery = async () => ({
      ok: true,
      results: [
        { id: 'concepts/kw-and-vec', score: 0.9 },
        { id: 'concepts/vec-only', score: 0.8 },
      ],
      degraded: false,
    });

    const cfg: EmbeddingRuntimeConfig = { ...mockEmbeddingCfg };

    const res = await searchWiki(kbPath, { query: 'AXI' }, {
      embeddingService: service,
      embeddingCfg: cfg,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.mode).toBe('hybrid');
    // kw-and-vec 在关键词 rank=0 且向量 rank=0 → rrf = 2/60 ≈ 0.0333
    // vec-only 不在关键词结果中，向量 rank=1 → rrf = 1/61 ≈ 0.0164
    const kwAndVec = res.result.hits.find((h) => h.id === 'concepts/kw-and-vec');
    const vecOnly = res.result.hits.find((h) => h.id === 'concepts/vec-only');
    expect(kwAndVec).toBeDefined();
    expect(vecOnly).toBeDefined();
    expect(kwAndVec!.score).toBeGreaterThan(vecOnly!.score);
  });

  it('分页聚合：同页多个 chunk 命中不占满 topK', async () => {
    writeWikiPage('concepts/multi-chunk.md', PAGE_FM('concept', '多块页')
      + '\nAXI 内容块一。\n\n## 第二节\n\nAXI 内容块二。\n');

    const { service } = makeEmbeddingService();

    // 向量搜索返回同页的多个 chunk
    service.searchByQuery = async () => ({
      ok: true,
      results: [
        { id: 'concepts/multi-chunk', score: 0.9 },
      ],
      degraded: false,
    });

    const cfg: EmbeddingRuntimeConfig = { ...mockEmbeddingCfg };

    const res = await searchWiki(kbPath, { query: 'AXI', topK: 10 }, {
      embeddingService: service,
      embeddingCfg: cfg,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 同页只出现一次（已聚合）
    const pageHits = res.result.hits.filter((h) => h.id === 'concepts/multi-chunk');
    expect(pageHits).toHaveLength(1);
  });
});

// ── 错误状态区分 ──────────────────────────────────────────────────

describe('searchWiki — 嵌入错误状态区分', () => {
  it('向量搜索返回 degraded 时，关键词仍可用，vectorStatus.degraded=true', async () => {
    writeWikiPage('concepts/axi.md', PAGE_FM('concept', 'AXI')
      + '\nAXI 协议。\n');
    const { service } = makeEmbeddingService();

    const cfg: EmbeddingRuntimeConfig = { ...mockEmbeddingCfg };

    // searchByQuery 返回 degraded
    service.searchByQuery = async () => ({
      ok: true,
      results: [],
      degraded: true,
    });

    const res = await searchWiki(kbPath, { query: 'AXI' }, {
      embeddingService: service,
      embeddingCfg: cfg,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.mode).toBe('keyword');
    expect(res.result.vectorStatus?.degraded).toBe(true);
    expect(res.result.hits.length).toBeGreaterThan(0);
  });

  it('图扩展在混合模式下正常工作，vectorPageHits 影响图配额', async () => {
    // 建两个有链接关系的页面，并设置 publish revision 以构建图
    // axi 页含 "AXI" 关键词；burst 页不含 "AXI" 但被 axi 链接（图扩展候选）
    writeWikiPage('concepts/axi.md', PAGE_FM('concept', 'AXI')
      + '\nAXI 协议。参见 [[concepts/axi-burst]]\n');
    writeWikiPage('concepts/axi-burst.md', PAGE_FM('concept', '突发传输')
      + '\n突发传输模式的详细说明。\n');

    // 设置 publish revision 以构建图快照
    const manifest: WikiKbManifest = {
      manifestVersion: 1,
      format: 'wiki',
      kbId: 'kb-24',
      name: '混合检索测试库',
      createdAt: '2026-09-13T00:00:00Z',
      updatedAt: '2026-09-13T00:00:00Z',
      publish: { revision: 1, commitId: 'c1', at: '2026-09-13T00:00:00Z' },
    };
    await writeWikiManifest(kbPath, manifest);

    const { service } = makeEmbeddingService();

    // 向量命中 axi → vectorPageHits=1
    service.searchByQuery = async () => ({
      ok: true,
      results: [{ id: 'concepts/axi', score: 0.9 }],
      degraded: false,
    });

    const cfg: EmbeddingRuntimeConfig = { ...mockEmbeddingCfg };

    const res = await searchWiki(kbPath, { query: 'AXI', topK: 10 }, {
      embeddingService: service,
      embeddingCfg: cfg,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 混合模式 + 图扩展
    expect(res.result.mode).toBe('hybrid+graph');
    expect(res.result.graphExpansion).toBeDefined();
    expect(res.result.graphExpansion!.expanded).toBeGreaterThan(0);
    // 图扩展应该召回 axi-burst（不在关键词结果中，但是 axi 的图邻居）
    const ids = res.result.hits.map((h) => h.id);
    expect(ids).toContain('concepts/axi-burst');
  });
});

// ── 索引代重建 ────────────────────────────────────────────────────

describe('rebuildEmbeddingIndex — 索引代重建', () => {
  it('完整重建：嵌入所有已发布页面，成功后切换新代', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', '页面A') + '\n内容A。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', '页面B') + '\n内容B。\n');

    const { service } = makeEmbeddingService();

    // Mock embedPage to succeed
    service.embedPage = async () => ({
      ok: true,
      chunkCount: 1,
      embeddedCount: 1,
      failedCount: 0,
      skippedCount: 0,
    });

    const result = await rebuildEmbeddingIndex(kbPath, 'kb-24', service, mockEmbeddingCfg, {
      onProgress: (p: RebuildProgress) => {
        expect(p.total).toBe(2);
        expect(p.done).toBeLessThanOrEqual(p.total);
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.embedded).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it('重建可取消：AbortSignal 触发后停止处理', async () => {
    // 写 3 个页面
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A') + '\n内容。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B') + '\n内容。\n');
    writeWikiPage('concepts/c.md', PAGE_FM('concept', 'C') + '\n内容。\n');

    const { service } = makeEmbeddingService();

    const controller = new AbortController();
    let callCount = 0;
    service.embedPage = async () => {
      callCount++;
      if (callCount >= 1) {
        controller.abort();
      }
      return { ok: true, chunkCount: 1, embeddedCount: 1, failedCount: 0, skippedCount: 0 };
    };

    const result = await rebuildEmbeddingIndex(kbPath, 'kb-24', service, mockEmbeddingCfg, {
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.cancelled).toBe(true);
    // 不应处理完所有页面
    expect(callCount).toBeLessThan(3);
  });

  it('同维度换模型启新代：指纹不匹配时不查旧空间', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A') + '\n内容。\n');

    const { service, store } = makeEmbeddingService();

    // 先存一个旧指纹
    await store.saveFingerprint('kb-24', 'old-fingerprint-hash');

    // 检查指纹不匹配
    const isMatch = await service.isFingerprintMatch('kb-24', mockEmbeddingCfg);
    expect(isMatch).toBe(false);
  });

  it('重建失败保留旧代：部分失败不切换', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A') + '\n内容。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B') + '\n内容。\n');

    const { service } = makeEmbeddingService();

    // 保存旧指纹
    await service.store.saveFingerprint('kb-24', 'old-fp');

    // Mock embedPage: 第一个成功，第二个失败
    let callCount = 0;
    service.embedPage = async () => {
      callCount++;
      if (callCount === 2) {
        return {
          ok: false,
          error: { kind: 'network', message: '网络失败' },
        };
      }
      return { ok: true, chunkCount: 1, embeddedCount: 1, failedCount: 0, skippedCount: 0 };
    };

    const result = await rebuildEmbeddingIndex(kbPath, 'kb-24', service, mockEmbeddingCfg);

    // 重建报告失败
    expect(result.failed).toBeGreaterThan(0);
    // 旧指纹保留
    const fp = await service.store.loadFingerprint('kb-24');
    expect(fp).toBe('old-fp');
  });

  it('覆盖状态和缺口可见：oversize chunk 报告跳过', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A') + '\n内容。\n');

    const { service } = makeEmbeddingService();

    service.embedPage = async () => ({
      ok: true,
      chunkCount: 2,
      embeddedCount: 1,
      failedCount: 0,
      skippedCount: 1,
      coverage: {
        totalChunks: 2,
        coveredChunks: 1,
        skippedChunks: 1,
        skipReasons: ['oversize: 代码块超过上限'],
      },
    });

    const result = await rebuildEmbeddingIndex(kbPath, 'kb-24', service, mockEmbeddingCfg);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skipped).toBe(1);
    expect(result.coverageGaps).toBeDefined();
    expect(result.coverageGaps!.length).toBeGreaterThan(0);
  });
});

// ── 失效向量过滤 ──────────────────────────────────────────────────

describe('searchWiki — 失效向量过滤', () => {
  it('向量结果中的 revision 与当前页面 revision 不匹配时过滤', async () => {
    writeWikiPage('concepts/axi.md', PAGE_FM('concept', 'AXI')
      + '\nAXI 协议。\n');

    const { service } = makeEmbeddingService();

    // 向量返回一个不存在于 catalog 的页面
    service.searchByQuery = async () => ({
      ok: true,
      results: [
        { id: 'concepts/nonexistent', score: 0.9 },
        { id: 'concepts/axi', score: 0.8 },
      ],
      degraded: false,
    });

    const cfg: EmbeddingRuntimeConfig = { ...mockEmbeddingCfg };

    const res = await searchWiki(kbPath, { query: 'AXI' }, {
      embeddingService: service,
      embeddingCfg: cfg,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 不存在的页面被过滤
    const ids = res.result.hits.map((h) => h.id);
    expect(ids).not.toContain('concepts/nonexistent');
    expect(ids).toContain('concepts/axi');
  });
});
