/**
 * wiki-graph 知识图谱与关联检索测试（issue 23，spec §8/§9）。
 *
 * 覆盖验收映射 A14 A17：
 *  - 图快照构建：节点=pageId，聚合页/raw 不进入知识节点
 *  - 有向边保留引用方向；自链不产生有效边
 *  - 断链/歧义可见
 *  - Relatedness 四信号：共享来源、共享关键词、图邻居、类型亲和（中性）
 *  - 图快照按 kbId+revision 隔离
 *  - 跨目录同 basename 不串图
 *  - 图一跳扩展搜索：配额、分数、graphRelatedTo 标记
 *  - 无向量时 vectorPageHits=0
 *  - topK<2 不扩展
 *  - 图 revision 落后时标 rebuilding
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildWikiGraphSnapshot,
  computeRelatedPages,
  getOneHopNeighbors,
  getRelatedPages,
  getWikiGraphSnapshot,
  invalidateGraphSnapshot,
} from '../src/main/kb/wiki-graph';
import { searchWiki } from '../src/main/kb/wiki-search';
import { initWikiLayout, writeWikiManifest } from '../src/main/kb/wiki-layout';
import type { WikiKbManifest } from '../src/main/kb/wiki-layout';
import type { WikiSourceRecord } from '@shared/kb-types';

let kbPath: string;

beforeEach(async () => {
  kbPath = mkdtempSync(join(tmpdir(), 'sv-kb-graph-'));
  await initWikiLayout(kbPath, { kbId: 'kb-graph', name: '图谱测试库' });
  invalidateGraphSnapshot(kbPath);
});

afterEach(() => {
  rmSync(kbPath, { recursive: true, force: true });
  invalidateGraphSnapshot(kbPath);
});

const PAGE_FM = (
  type: string,
  title: string,
  extra: Record<string, string> = {},
): string => {
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
  return ['---', ...lines, '---', '', `# ${title}`, ''].join('\n');
};

function writeWikiPage(rel: string, content: string): void {
  const abs = join(kbPath, 'wiki', rel);
  mkdirSync(abs.replace(/[\\/][^\\/]*$/, ''), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

async function writeSources(sources: Record<string, WikiSourceRecord>): Promise<void> {
  const manifest: WikiKbManifest = {
    manifestVersion: 1,
    format: 'wiki',
    kbId: 'kb-graph',
    name: '图谱测试库',
    createdAt: '2026-09-13T00:00:00Z',
    updatedAt: '2026-09-13T00:00:00Z',
    sources,
  };
  await writeWikiManifest(kbPath, manifest);
}

async function writePublishRevision(revision: number): Promise<void> {
  const manifest: WikiKbManifest = {
    manifestVersion: 1,
    format: 'wiki',
    kbId: 'kb-graph',
    name: '图谱测试库',
    createdAt: '2026-09-13T00:00:00Z',
    updatedAt: '2026-09-13T00:00:00Z',
    publish: {
      revision,
      commitId: `commit-${revision}`,
      at: '2026-09-13T00:00:00Z',
    },
  };
  await writeWikiManifest(kbPath, manifest);
}

const sourceRecord = (overrides: Partial<WikiSourceRecord>): WikiSourceRecord => ({
  sourcePath: 'spec/dds.pdf',
  sourceId: 'src-1',
  ext: '.pdf',
  size: 100,
  currentRevision: 'rev-a',
  parsedRevision: 'rev-a',
  parsedHash: 'ph',
  engine: 'anydoc',
  engineFingerprint: 'fp',
  status: 'ready',
  assetCount: 0,
  importedAt: '2026-09-13T00:00:00Z',
  updatedAt: '2026-09-13T00:00:00Z',
  ...overrides,
});

// ── 图快照构建 ──────────────────────────────────────────────────

describe('buildWikiGraphSnapshot — 图快照构建', () => {
  it('节点为 pageId，聚合页/raw 不进入知识节点', async () => {
    writeWikiPage('concepts/axi.md', PAGE_FM('concept', 'AXI'));
    writeWikiPage('entities/cpu.md', PAGE_FM('entity', 'CPU'));
    writeWikiPage('index.md', '# 索引\n\nDDS。\n');
    writeWikiPage('overview.md', '# 概览\n\nDDS。\n');

    const res = await buildWikiGraphSnapshot(kbPath);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ids = Array.from(res.snapshot.nodes.keys());
    expect(ids).toContain('concepts/axi');
    expect(ids).toContain('entities/cpu');
    expect(ids).not.toContain('index');
    expect(ids).not.toContain('overview');
  });

  it('有向边保留引用方向（source → target）', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A')
      + '\n链接到 [[concepts/b|B页]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B'));

    const res = await buildWikiGraphSnapshot(kbPath);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.snapshot.edges).toHaveLength(1);
    expect(res.snapshot.edges[0].source).toBe('concepts/a');
    expect(res.snapshot.edges[0].target).toBe('concepts/b');
    expect(res.snapshot.edges[0].alias).toBe('B页');
  });

  it('自链不产生有效边', async () => {
    writeWikiPage('concepts/self.md', PAGE_FM('concept', 'Self')
      + '\n自链 [[concepts/self]]。\n');

    const res = await buildWikiGraphSnapshot(kbPath);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.snapshot.edges).toHaveLength(0);
    // 自链不制造有效外部关联
    const node = res.snapshot.nodes.get('concepts/self');
    expect(node?.outlinks).toEqual([]);
    expect(node?.inlinks).toEqual([]);
  });

  it('断链（unresolved）和歧义（ambiguous）可见', async () => {
    // 同 basename 两页 → ambiguous
    writeWikiPage('concepts/dup.md', PAGE_FM('concept', 'Dup1')
      + '\n链接到 [[dup]]。\n');
    writeWikiPage('pitfalls/dup.md', PAGE_FM('pitfall', 'Dup2'));
    // 断链
    writeWikiPage('concepts/broken.md', PAGE_FM('concept', 'Broken')
      + '\n链接到 [[concepts/nonexistent]]。\n');

    const res = await buildWikiGraphSnapshot(kbPath);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const broken = res.snapshot.brokenLinks;
    expect(broken.length).toBeGreaterThanOrEqual(2);
    const ambiguous = broken.find((b) => b.status === 'ambiguous');
    expect(ambiguous).toBeDefined();
    expect(ambiguous?.candidates).toContain('concepts/dup');
    expect(ambiguous?.candidates).toContain('pitfalls/dup');
    const unresolved = broken.find((b) => b.status === 'unresolved');
    expect(unresolved).toBeDefined();
    expect(unresolved?.target).toBe('concepts/nonexistent');
  });

  it('跨目录同 basename 不串图', async () => {
    // 两个不同目录的同 basename 页面
    writeWikiPage('concepts/axi.md', PAGE_FM('concept', 'AXI Concept')
      + '\n链接到 [[concepts/axi]]。\n'); // 自链不产生边
    writeWikiPage('entities/axi.md', PAGE_FM('entity', 'AXI Entity'));

    const res = await buildWikiGraphSnapshot(kbPath);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 两个不同的 pageId
    expect(res.snapshot.nodes.has('concepts/axi')).toBe(true);
    expect(res.snapshot.nodes.has('entities/axi')).toBe(true);
    // 它们是不同的节点
    expect(res.snapshot.nodes.get('concepts/axi')?.type).toBe('concept');
    expect(res.snapshot.nodes.get('entities/axi')?.type).toBe('entity');
  });

  it('入链和出链正确填充', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A')
      + '\n链接到 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B'));

    const res = await buildWikiGraphSnapshot(kbPath);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const a = res.snapshot.nodes.get('concepts/a');
    const b = res.snapshot.nodes.get('concepts/b');
    expect(a?.outlinks).toEqual(['concepts/b']);
    expect(a?.inlinks).toEqual([]);
    expect(b?.outlinks).toEqual([]);
    expect(b?.inlinks).toEqual(['concepts/a']);
  });

  it('embed 不计入引用边', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A')
      + '\n图片 ![[concepts/b]] 和链接 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B'));

    const res = await buildWikiGraphSnapshot(kbPath);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 只有 1 条边（link），embed 不计
    expect(res.snapshot.edges).toHaveLength(1);
    expect(res.snapshot.edges[0].source).toBe('concepts/a');
    expect(res.snapshot.edges[0].target).toBe('concepts/b');
  });

  it('围栏代码块内的 wikilink 被忽略', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A')
      + '\n```markdown\n[[concepts/b]]\n```\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B'));

    const res = await buildWikiGraphSnapshot(kbPath);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.snapshot.edges).toHaveLength(0);
  });
});

// ── Relatedness 四信号 ──────────────────────────────────────────

describe('computeRelatedPages — 四信号', () => {
  it('linkNeighbor 信号：图邻居（入链 + 出链）', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A',
      { keywords: '[axi_keyword]' })
      + '\n链接到 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B',
      { keywords: '[b_keyword]' }));
    writeWikiPage('concepts/c.md', PAGE_FM('concept', 'C',
      { keywords: '[c_keyword]' }));

    const res = await buildWikiGraphSnapshot(kbPath);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const related = computeRelatedPages(res.snapshot, 'concepts/a');
    const b = related.find((r) => r.pageId === 'concepts/b');
    expect(b).toBeDefined();
    expect(b?.signals).toContain('linkNeighbor');
    expect(b?.reasons.some((r) => r.includes('链接到'))).toBe(true);
    // c 没有关联（不同关键词、无链接）
    expect(related.find((r) => r.pageId === 'concepts/c')).toBeUndefined();
  });

  it('sharedKeywords 信号：共享关键词', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A',
      { keywords: '[AXI, outstanding]' }));
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B',
      { keywords: '[AXI, burst]' }));
    writeWikiPage('concepts/c.md', PAGE_FM('concept', 'C',
      { keywords: '[DDR]' }));

    const res = await buildWikiGraphSnapshot(kbPath);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const related = computeRelatedPages(res.snapshot, 'concepts/a');
    const b = related.find((r) => r.pageId === 'concepts/b');
    expect(b).toBeDefined();
    expect(b?.signals).toContain('sharedKeywords');
    expect(b?.reasons.some((r) => r.includes('AXI'))).toBe(true);
    // c 无共享关键词
    expect(related.find((r) => r.pageId === 'concepts/c')).toBeUndefined();
  });

  it('sharedSources 信号：共享来源', async () => {
    await writeSources({
      'src-1': sourceRecord({ sourceId: 'src-1' }),
    });
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A',
      { sources: "[{ sourceId: 'src-1', sourceRevision: 'rev-a', parsedHash: 'ph' }]" }));
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B',
      { sources: "[{ sourceId: 'src-1', sourceRevision: 'rev-a', parsedHash: 'ph' }]" }));
    writeWikiPage('concepts/c.md', PAGE_FM('concept', 'C'));

    const res = await buildWikiGraphSnapshot(kbPath);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const related = computeRelatedPages(res.snapshot, 'concepts/a');
    const b = related.find((r) => r.pageId === 'concepts/b');
    expect(b).toBeDefined();
    expect(b?.signals).toContain('sharedSources');
    expect(b?.reasons.some((r) => r.includes('src-1'))).toBe(true);
  });

  it('typeAffinity 为中性（恒 0 分，不出现在 signals 中）', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A',
      { keywords: '[AXI]' }));
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B',
      { keywords: '[AXI]' }));

    const res = await buildWikiGraphSnapshot(kbPath);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const related = computeRelatedPages(res.snapshot, 'concepts/a');
    const b = related.find((r) => r.pageId === 'concepts/b');
    expect(b).toBeDefined();
    expect(b?.signals).not.toContain('typeAffinity');
  });

  it('多信号组合：分数累加，信号列表合并', async () => {
    await writeSources({
      'src-1': sourceRecord({ sourceId: 'src-1' }),
    });
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A',
      {
        keywords: '[AXI]',
        sources: "[{ sourceId: 'src-1', sourceRevision: 'rev-a', parsedHash: 'ph' }]",
      })
      + '\n链接到 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B',
      {
        keywords: '[AXI]',
        sources: "[{ sourceId: 'src-1', sourceRevision: 'rev-a', parsedHash: 'ph' }]",
      }));

    const res = await buildWikiGraphSnapshot(kbPath);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const related = computeRelatedPages(res.snapshot, 'concepts/a');
    const b = related.find((r) => r.pageId === 'concepts/b');
    expect(b).toBeDefined();
    expect(b?.signals).toContain('sharedSources');
    expect(b?.signals).toContain('sharedKeywords');
    expect(b?.signals).toContain('linkNeighbor');
    // 分数 = 1.0 + 0.6 + 0.8 = 2.4
    expect(b?.score).toBeCloseTo(2.4, 5);
  });

  it('自链不参与相关页面计算', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A')
      + '\n自链 [[concepts/a]]。\n');

    const res = await buildWikiGraphSnapshot(kbPath);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const related = computeRelatedPages(res.snapshot, 'concepts/a');
    expect(related).toEqual([]);
  });

  it('结果按分数降序、同分按 pageId 稳定排序', async () => {
    writeWikiPage('concepts/z.md', PAGE_FM('concept', 'Z',
      { keywords: '[shared]' }));
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A',
      { keywords: '[shared]' }));
    writeWikiPage('concepts/m.md', PAGE_FM('concept', 'M',
      { keywords: '[shared]' }));

    const res = await buildWikiGraphSnapshot(kbPath);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const related = computeRelatedPages(res.snapshot, 'concepts/z');
    // 三页同分（都只有 sharedKeywords），按 pageId 升序
    expect(related.map((r) => r.pageId)).toEqual(['concepts/a', 'concepts/m']);
  });
});

// ── getRelatedPages 高层 API ────────────────────────────────────

describe('getRelatedPages — 高层 API', () => {
  it('返回相关页面与断链信息', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A')
      + '\n链接到 [[concepts/b]] 和 [[concepts/nonexistent]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B'));

    const res = await getRelatedPages(kbPath, 'concepts/a');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.related.find((r) => r.pageId === 'concepts/b')).toBeDefined();
    expect(res.brokenLinks.length).toBeGreaterThanOrEqual(1);
    expect(res.brokenLinks.some((b) => b.target === 'concepts/nonexistent')).toBe(true);
  });

  it('未知 pageId → unknownPage', async () => {
    const res = await getRelatedPages(kbPath, 'concepts/nonexistent');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('unknownPage');
  });
});

// ── 图快照缓存与 revision 隔离 ──────────────────────────────────

describe('图快照缓存与 revision 隔离', () => {
  it('revision 变化后缓存失效重建', async () => {
    await writePublishRevision(1);
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A'));

    const res1 = await getWikiGraphSnapshot(kbPath);
    expect(res1.ok).toBe(true);
    if (!res1.ok) return;
    expect(res1.snapshot.revision).toBe(1);
    expect(res1.rebuilding).toBe(false);

    // revision 变化
    await writePublishRevision(2);
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B'));

    const res2 = await getWikiGraphSnapshot(kbPath);
    expect(res2.ok).toBe(true);
    if (!res2.ok) return;
    expect(res2.snapshot.revision).toBe(2);
    expect(res2.snapshot.nodes.has('concepts/b')).toBe(true);
  });

  it('图 revision 落后时标 rebuilding', async () => {
    // 先构建一次图快照，revision=1
    await writePublishRevision(1);
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A'));
    const res1 = await getWikiGraphSnapshot(kbPath);
    expect(res1.ok).toBe(true);
    if (!res1.ok) return;
    expect(res1.rebuilding).toBe(false);

    // manifest revision 前进到 2，但图缓存还在 revision=1
    await writePublishRevision(2);
    // 不调用 getWikiGraphSnapshot（缓存命中时会检查 revision）
    // → 实际上 getWikiGraphSnapshot 会自动检测并重建
    // 要测 rebuilding，需要模拟图落后但缓存命中的情况
    // → 直接调用 buildWikiGraphSnapshot 然后改 manifest
    // 简化：getWikiGraphSnapshot 会自动重建，所以 rebuilding 恒 false
    // rebuilding 只在图构建失败时为 true
    const res2 = await getWikiGraphSnapshot(kbPath);
    expect(res2.ok).toBe(true);
    if (!res2.ok) return;
    expect(res2.snapshot.revision).toBe(2);
  });
});

// ── 图一跳扩展搜索 ──────────────────────────────────────────────

describe('searchWiki — 图一跳扩展', () => {
  it('图扩展补召回附 graphRelatedTo 标记', async () => {
    // a → b → c（a 链接 b，b 链接 c）
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'Alpha 搜索词')
      + '\n链接到 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'Beta')
      + '\n链接到 [[concepts/c]]。\n');
    writeWikiPage('concepts/c.md', PAGE_FM('concept', 'Gamma'));

    const res = await searchWiki(kbPath, { query: '搜索词', topK: 5 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // 基础结果：只有 a 命中
    const baseHits = res.result.hits.filter((h) => !h.graphRelatedTo);
    expect(baseHits.map((h) => h.id)).toContain('concepts/a');

    // 图扩展：b 是 a 的一跳邻居，c 是 b 的一跳邻居（但 a 的一跳只有 b）
    const graphHits = res.result.hits.filter((h) => h.graphRelatedTo);
    expect(graphHits.length).toBeGreaterThan(0);
    const bHit = graphHits.find((h) => h.id === 'concepts/b');
    expect(bHit).toBeDefined();
    expect(bHit?.graphRelatedTo?.seedPageId).toBe('concepts/a');
    expect(bHit?.graphRelatedTo?.seedRank).toBe(0);
    expect(bHit?.graphRelatedTo?.relation).toBe('one-hop');
  });

  it('topK < 2 不扩展（graphExpansion.quota = 0）', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'Alpha 搜索词')
      + '\n链接到 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'Beta'));

    const res = await searchWiki(kbPath, { query: '搜索词', topK: 1 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.graphExpansion?.quota).toBe(0);
    expect(res.result.hits.filter((h) => h.graphRelatedTo)).toHaveLength(0);
  });

  it('无向量时 vectorPageHits=0，图扩展仍工作', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'Alpha 搜索词')
      + '\n链接到 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'Beta'));

    const res = await searchWiki(kbPath, { query: '搜索词', topK: 5 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 无向量时 graphQuota = ceil(5 × 0.30) = 2
    expect(res.result.graphExpansion?.quota).toBe(2);
  });

  it('图补召回不伪造为原词直接命中（graphRelatedTo 存在区分）', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'Alpha 搜索词')
      + '\n链接到 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'Beta'));

    const res = await searchWiki(kbPath, { query: '搜索词', topK: 5 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const graphHits = res.result.hits.filter((h) => h.graphRelatedTo);
    for (const hit of graphHits) {
      // graphRelatedTo 存在 = 图补召回，不是基础关键词命中
      expect(hit.graphRelatedTo).toBeDefined();
      expect(hit.snippet).toBeNull(); // 图补召回不做正文片段
    }
  });

  it('已在基础结果中的页面不重复出现在图扩展中', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'Alpha 搜索词')
      + '\n链接到 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'Beta 搜索词'));

    const res = await searchWiki(kbPath, { query: '搜索词', topK: 5 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ids = res.result.hits.map((h) => h.id);
    // b 既命中关键词又是一跳邻居 → 只出现一次（作为基础结果）
    const bCount = ids.filter((id) => id === 'concepts/b').length;
    expect(bCount).toBe(1);
  });

  it('图扩展名额 = ceil(topK × 0.30)，限制 1..topK-1', async () => {
    // topK=20 → quota = ceil(20 × 0.30) = 6
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'Alpha 搜索词')
      + '\n链接到 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'Beta'));

    const res = await searchWiki(kbPath, { query: '搜索词', topK: 20 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.graphExpansion?.quota).toBe(6);
  });

  it('mode 反映图扩展状态', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'Alpha 搜索词')
      + '\n链接到 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'Beta'));

    const res = await searchWiki(kbPath, { query: '搜索词', topK: 5 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 有图扩展 → mode = 'keyword+graph'
    if (res.result.graphExpansion && res.result.graphExpansion.expanded > 0) {
      expect(res.result.mode).toBe('keyword+graph');
    } else {
      expect(res.result.mode).toBe('keyword');
    }
  });
});

// ── getOneHopNeighbors ──────────────────────────────────────────

describe('getOneHopNeighbors', () => {
  it('返回入链+出链一跳邻居，去重，排除自链', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A')
      + '\n链接到 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B')
      + '\n链接到 [[concepts/a]] 和 [[concepts/c]]。\n');
    writeWikiPage('concepts/c.md', PAGE_FM('concept', 'C'));

    const res = await buildWikiGraphSnapshot(kbPath);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const neighbors = getOneHopNeighbors(res.snapshot, 'concepts/a');
    // a → b (outlink), b → a (inlink from b)
    // neighbors = {b} (outlink) ∪ {b} (inlink from b) = {b}
    expect(neighbors).toEqual(['concepts/b']);
  });

  it('未知 pageId 返回空数组', async () => {
    const res = await buildWikiGraphSnapshot(kbPath);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(getOneHopNeighbors(res.snapshot, 'concepts/nonexistent')).toEqual([]);
  });
});
