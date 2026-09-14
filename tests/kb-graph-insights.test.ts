/**
 * graph-insights 图洞察测试（issue 26，spec §9）。
 *
 * 覆盖验收映射 A17 A18 A22；User Stories：54, 55, 56, 58, 63, 64。
 *
 * Seam: detectGraphInsights(snapshot, now) — 从图快照推导图洞察 findings。
 *
 * 验收要点：
 *  - 基于既有社区/节点统计生成有限数量线索
 *  - 桥接节点可为健康枢纽，文案明确是启发式建议
 *  - 聚合页排除
 *  - 关联 pageIds/证据图 revision 进入统一 finding 身份与状态
 *  - 重复刷新保留处置
 *  - 点击线索聚焦关联页面/子图（finding 的 pageIds 即关联页面）
 *  - ignore 与后续图变化正确收敛
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectGraphInsights,
  runGraphInsights,
  detectCommunities,
  findBridgeNodes,
  findSparseCommunities,
} from '../src/main/kb/graph-insights';
import { buildWikiGraphSnapshot, invalidateGraphSnapshot } from '../src/main/kb/wiki-graph';
import { initWikiLayout, writeWikiManifest } from '../src/main/kb/wiki-layout';
import type { WikiKbManifest } from '../src/main/kb/wiki-layout';
import type { WikiGraphSnapshot } from '@shared/kb-types';

let kbPath: string;

beforeEach(async () => {
  kbPath = mkdtempSync(join(tmpdir(), 'sv-kb-insights-'));
  await initWikiLayout(kbPath, { kbId: 'kb-insights', name: '图洞察测试库' });
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
    ['created', '"2026-09-14T00:00:00Z"'],
    ['updated', '"2026-09-14T00:00:00Z"'],
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

async function writePublishRevision(revision: number): Promise<void> {
  const manifest: WikiKbManifest = {
    manifestVersion: 1,
    format: 'wiki',
    kbId: 'kb-insights',
    name: '图洞察测试库',
    createdAt: '2026-09-14T00:00:00Z',
    updatedAt: '2026-09-14T00:00:00Z',
    publish: {
      revision,
      commitId: `commit-${revision}`,
      at: '2026-09-14T00:00:00Z',
    },
  };
  await writeWikiManifest(kbPath, manifest);
}

async function getSnapshot(): Promise<WikiGraphSnapshot> {
  const res = await buildWikiGraphSnapshot(kbPath);
  if (!res.ok) throw new Error('构建图快照失败');
  return res.snapshot;
}

// ── detectCommunities ────────────────────────────────────────────

describe('detectCommunities — 社区检测', () => {
  it('两个不连通的子图 → 两个社区', async () => {
    // 社区 1: A ↔ B
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A')
      + '\n链接到 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B')
      + '\n链接到 [[concepts/a]]。\n');
    // 社区 2: C ↔ D
    writeWikiPage('concepts/c.md', PAGE_FM('concept', 'C')
      + '\n链接到 [[concepts/d]]。\n');
    writeWikiPage('concepts/d.md', PAGE_FM('concept', 'D')
      + '\n链接到 [[concepts/c]]。\n');

    const snapshot = await getSnapshot();
    const communities = detectCommunities(snapshot);

    expect(communities.length).toBe(2);
    // 每个社区有 2 个成员
    for (const c of communities) {
      expect(c.size).toBe(2);
      expect(c.members.length).toBe(2);
    }
  });

  it('单一连通图 → 一个社区', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A')
      + '\n链接到 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B')
      + '\n链接到 [[concepts/a]]。\n');

    const snapshot = await getSnapshot();
    const communities = detectCommunities(snapshot);
    expect(communities.length).toBe(1);
    expect(communities[0].size).toBe(2);
  });

  it('空图 → 无社区', async () => {
    const snapshot = await getSnapshot();
    const communities = detectCommunities(snapshot);
    expect(communities.length).toBe(0);
  });

  it('社区内边数正确计算（无向投影）', async () => {
    // A → B, B → A（两条有向边 = 一条无向边）
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A')
      + '\n链接到 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B')
      + '\n链接到 [[concepts/a]]。\n');

    const snapshot = await getSnapshot();
    const communities = detectCommunities(snapshot);
    expect(communities.length).toBe(1);
    // A→B 和 B→A = 1 条无向边
    expect(communities[0].internalEdges).toBe(1);
  });
});

// ── findBridgeNodes ──────────────────────────────────────────────

describe('findBridgeNodes — 桥接节点检测', () => {
  it('连接两个社区的节点被识别为桥接节点', async () => {
    // 社区 1: A ↔ B
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A')
      + '\n链接到 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B')
      + '\n链接到 [[concepts/a]]。\n');
    // 社区 2: C ↔ D
    writeWikiPage('concepts/c.md', PAGE_FM('concept', 'C')
      + '\n链接到 [[concepts/d]]。\n');
    writeWikiPage('concepts/d.md', PAGE_FM('concept', 'D')
      + '\n链接到 [[concepts/c]]。\n');
    // 桥：B 链接到 C
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B')
      + '\n链接到 [[concepts/a]]。\n链接到 [[concepts/c]]。\n');

    const snapshot = await getSnapshot();
    const communities = detectCommunities(snapshot);
    const bridges = findBridgeNodes(snapshot, communities);

    // B 连接社区 1 (A,B) 和社区 2 (C,D)，或通过结构洞被识别
    expect(bridges.length).toBeGreaterThan(0);
    const bridgeB = bridges.find((b) => b.pageId === 'concepts/b');
    expect(bridgeB).toBeDefined();
    // 桥接节点要么连接多个社区，要么通过结构洞检测
    // connectedCommunities 可能为单元素（结构洞模式），但 hint 包含启发式建议
    expect(bridgeB!.hint).toContain('启发式');
  });

  it('仅连接一个社区的节点不视为桥接', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A')
      + '\n链接到 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B')
      + '\n链接到 [[concepts/a]]。\n');

    const snapshot = await getSnapshot();
    const communities = detectCommunities(snapshot);
    const bridges = findBridgeNodes(snapshot, communities);
    expect(bridges).toHaveLength(0);
  });

  it('桥接节点文案标注为启发式建议', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A')
      + '\n链接到 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B')
      + '\n链接到 [[concepts/a]]。\n');
    writeWikiPage('concepts/c.md', PAGE_FM('concept', 'C')
      + '\n链接到 [[concepts/d]]。\n');
    writeWikiPage('concepts/d.md', PAGE_FM('concept', 'D')
      + '\n链接到 [[concepts/c]]。\n');
    // B 桥接到 C
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B')
      + '\n链接到 [[concepts/a]]。\n链接到 [[concepts/c]]。\n');

    const snapshot = await getSnapshot();
    const communities = detectCommunities(snapshot);
    const bridges = findBridgeNodes(snapshot, communities);
    const bridge = bridges[0];
    expect(bridge.hint).toContain('启发式');
    expect(bridge.hint).toContain('健康枢纽');
  });
});

// ── findSparseCommunities ────────────────────────────────────────

describe('findSparseCommunities — 稀疏社区检测', () => {
  it('内聚度低的社区被标为稀疏', async () => {
    // 3 个节点的连通图但只有 1 条边 → 稀疏
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A')
      + '\n链接到 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B'));
    writeWikiPage('concepts/c.md', PAGE_FM('concept', 'C'));
    // C 无连接 → 独立社区
    // A→B 一个社区（2 节点 1 边），C 独立社区（1 节点 0 边）

    const snapshot = await getSnapshot();
    const communities = detectCommunities(snapshot);
    const sparse = findSparseCommunities(communities);

    // C 的单节点社区（0 边）应被视为稀疏
    const sparseC = sparse.find((s) => s.members.includes('concepts/c'));
    expect(sparseC).toBeDefined();
  });

  it('内聚度高的社区不被标为稀疏', async () => {
    // A ↔ B（紧密连接）
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A')
      + '\n链接到 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B')
      + '\n链接到 [[concepts/a]]。\n');

    const snapshot = await getSnapshot();
    const communities = detectCommunities(snapshot);
    const sparse = findSparseCommunities(communities);
    // 2 节点 1 边 → 密度 1.0 → 不稀疏
    expect(sparse).toHaveLength(0);
  });
});

// ── detectGraphInsights ──────────────────────────────────────────

describe('detectGraphInsights — 图洞察综合', () => {
  it('生成桥接节点和稀疏社区 findings', async () => {
    // 社区 1: A ↔ B
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A')
      + '\n链接到 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B')
      + '\n链接到 [[concepts/a]]。\n');
    // 社区 2: C ↔ D
    writeWikiPage('concepts/c.md', PAGE_FM('concept', 'C')
      + '\n链接到 [[concepts/d]]。\n');
    writeWikiPage('concepts/d.md', PAGE_FM('concept', 'D')
      + '\n链接到 [[concepts/c]]。\n');
    // 桥：B 链接到 C
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B')
      + '\n链接到 [[concepts/a]]。\n链接到 [[concepts/c]]。\n');

    const snapshot = await getSnapshot();
    const result = detectGraphInsights(snapshot, '2026-09-14T00:00:00Z');

    expect(result.findings.length).toBeGreaterThan(0);

    // 应包含桥接节点 finding
    const bridgeFindings = result.findings.filter((f) => f.kind === 'bridge-node');
    expect(bridgeFindings.length).toBeGreaterThan(0);

    // finding 有稳定身份
    for (const f of result.findings) {
      expect(f.findingId).toMatch(/^[0-9a-f]{32}$/);
      expect(f.kbId).toBe('kb-insights');
      expect(f.status).toBe('open');
      expect(f.createdAt).toBe('2026-09-14T00:00:00Z');
      expect(f.updatedAt).toBe('2026-09-14T00:00:00Z');
    }
  });

  it('finding 的 pageIds 包含关联页面', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A')
      + '\n链接到 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B')
      + '\n链接到 [[concepts/a]]。\n');
    writeWikiPage('concepts/c.md', PAGE_FM('concept', 'C')
      + '\n链接到 [[concepts/d]]。\n');
    writeWikiPage('concepts/d.md', PAGE_FM('concept', 'D')
      + '\n链接到 [[concepts/c]]。\n');
    // B 桥接到 C
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B')
      + '\n链接到 [[concepts/a]]。\n链接到 [[concepts/c]]。\n');

    const snapshot = await getSnapshot();
    const result = detectGraphInsights(snapshot, '2026-09-14T00:00:00Z');

    const bridge = result.findings.find((f) => f.kind === 'bridge-node');
    expect(bridge).toBeDefined();
    expect(bridge!.pageIds).toContain('concepts/b');
  });

  it('finding 的 evidenceRefs 包含证据位置', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A')
      + '\n链接到 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B')
      + '\n链接到 [[concepts/a]]。\n');
    writeWikiPage('concepts/c.md', PAGE_FM('concept', 'C')
      + '\n链接到 [[concepts/d]]。\n');
    writeWikiPage('concepts/d.md', PAGE_FM('concept', 'D')
      + '\n链接到 [[concepts/c]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B')
      + '\n链接到 [[concepts/a]]。\n链接到 [[concepts/c]]。\n');

    const snapshot = await getSnapshot();
    const result = detectGraphInsights(snapshot, '2026-09-14T00:00:00Z');

    const bridge = result.findings.find((f) => f.kind === 'bridge-node');
    expect(bridge).toBeDefined();
    expect(bridge!.evidenceRefs.some((r) => r.includes('concepts/b'))).toBe(true);
  });

  it('finding 的 evidenceHashes 非空', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A')
      + '\n链接到 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B')
      + '\n链接到 [[concepts/a]]。\n');
    writeWikiPage('concepts/c.md', PAGE_FM('concept', 'C')
      + '\n链接到 [[concepts/d]]。\n');
    writeWikiPage('concepts/d.md', PAGE_FM('concept', 'D')
      + '\n链接到 [[concepts/c]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B')
      + '\n链接到 [[concepts/a]]。\n链接到 [[concepts/c]]。\n');

    const snapshot = await getSnapshot();
    const result = detectGraphInsights(snapshot, '2026-09-14T00:00:00Z');

    for (const f of result.findings) {
      expect(f.evidenceHashes.length).toBeGreaterThan(0);
      for (const h of f.evidenceHashes) {
        expect(h).toMatch(/^[0-9a-f]{16}$/);
      }
    }
  });

  it('图 revision 进入 finding 证据', async () => {
    await writePublishRevision(5);
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A')
      + '\n链接到 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B')
      + '\n链接到 [[concepts/a]]。\n');
    writeWikiPage('concepts/c.md', PAGE_FM('concept', 'C')
      + '\n链接到 [[concepts/d]]。\n');
    writeWikiPage('concepts/d.md', PAGE_FM('concept', 'D')
      + '\n链接到 [[concepts/c]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B')
      + '\n链接到 [[concepts/a]]。\n链接到 [[concepts/c]]。\n');

    const snapshot = await getSnapshot();
    const result = detectGraphInsights(snapshot, '2026-09-14T00:00:00Z');

    expect(result.revision).toBe(5);
    // evidenceRefs 包含 revision 信息
    for (const f of result.findings) {
      expect(f.evidenceRefs.some((r) => r.includes('revision:'))).toBe(true);
    }
  });

  it('重复推导同一快照 → 同一 findingId', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A')
      + '\n链接到 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B')
      + '\n链接到 [[concepts/a]]。\n');
    writeWikiPage('concepts/c.md', PAGE_FM('concept', 'C')
      + '\n链接到 [[concepts/d]]。\n');
    writeWikiPage('concepts/d.md', PAGE_FM('concept', 'D')
      + '\n链接到 [[concepts/c]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B')
      + '\n链接到 [[concepts/a]]。\n链接到 [[concepts/c]]。\n');

    const snapshot = await getSnapshot();
    const r1 = detectGraphInsights(snapshot, '2026-09-14T00:00:00Z');
    const r2 = detectGraphInsights(snapshot, '2026-09-14T01:00:00Z');

    const ids1 = r1.findings.map((f) => f.findingId).sort();
    const ids2 = r2.findings.map((f) => f.findingId).sort();
    expect(ids1).toEqual(ids2);
  });

  it('完全连通图无桥接节点 finding', async () => {
    // A → B → C → A 三角形（完全连通）
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A')
      + '\n链接到 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B')
      + '\n链接到 [[concepts/c]]。\n');
    writeWikiPage('concepts/c.md', PAGE_FM('concept', 'C')
      + '\n链接到 [[concepts/a]]。\n');

    const snapshot = await getSnapshot();
    const result = detectGraphInsights(snapshot, '2026-09-14T00:00:00Z');

    const bridge = result.findings.filter((f) => f.kind === 'bridge-node');
    expect(bridge).toHaveLength(0);
  });

  it('洞察 finding 数量有限（不超过节点数）', async () => {
    // 5 个页面
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A')
      + '\n链接到 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B')
      + '\n链接到 [[concepts/a]]。\n');
    writeWikiPage('concepts/c.md', PAGE_FM('concept', 'C')
      + '\n链接到 [[concepts/d]]。\n');
    writeWikiPage('concepts/d.md', PAGE_FM('concept', 'D')
      + '\n链接到 [[concepts/c]]。\n');
    writeWikiPage('concepts/e.md', PAGE_FM('concept', 'E'));

    const snapshot = await getSnapshot();
    const result = detectGraphInsights(snapshot, '2026-09-14T00:00:00Z');

    // findings 数量不超过节点数
    expect(result.findings.length).toBeLessThanOrEqual(snapshot.nodes.size);
  });

  it('聚合页排除（不产生 finding）', async () => {
    // index 聚合页不参与图
    writeWikiPage('index.md', '# 索引\n\n[concepts/a](concepts/a)');
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A')
      + '\n链接到 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B')
      + '\n链接到 [[concepts/a]]。\n');

    const snapshot = await getSnapshot();
    const result = detectGraphInsights(snapshot, '2026-09-14T00:00:00Z');

    // 不应有聚合页的 finding
    for (const f of result.findings) {
      expect(f.pageIds.some((p) => p === 'index')).toBe(false);
    }
  });
});

// ── runGraphInsights ─────────────────────────────────────────────

describe('runGraphInsights — 运行图洞察', () => {
  it('正常返回洞察结果', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A')
      + '\n链接到 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B')
      + '\n链接到 [[concepts/a]]。\n');
    writeWikiPage('concepts/c.md', PAGE_FM('concept', 'C')
      + '\n链接到 [[concepts/d]]。\n');
    writeWikiPage('concepts/d.md', PAGE_FM('concept', 'D')
      + '\n链接到 [[concepts/c]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B')
      + '\n链接到 [[concepts/a]]。\n链接到 [[concepts/c]]。\n');

    const result = await runGraphInsights(kbPath, { now: '2026-09-14T00:00:00Z' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kbId).toBe('kb-insights');
    expect(result.communities.length).toBeGreaterThan(0);
  });

  it('无 manifest → catalogFailed', async () => {
    const emptyPath = mkdtempSync(join(tmpdir(), 'sv-kb-insights-empty-'));
    try {
      const result = await runGraphInsights(emptyPath);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('catalogFailed');
    } finally {
      rmSync(emptyPath, { recursive: true, force: true });
    }
  });
});
