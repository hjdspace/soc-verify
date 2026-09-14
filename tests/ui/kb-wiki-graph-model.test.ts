/**
 * 知识图谱视图纯逻辑（spec §9，issue 26）。
 *
 * 覆盖过滤（类型/关键词/社区）、度数、大图预算与展开、确定性初始坐标、
 * 数据 key（切库/重开图不串 revision）、邻接列表与图例。
 */

import { describe, it, expect } from 'vitest';
import {
  ALL_PAGE_TYPES,
  EMPTY_GRAPH_FILTER,
  GRAPH_INITIAL_NODE_BUDGET,
  bridgeNodePageIds,
  buildAdjacencyList,
  buildLegend,
  communityByPage,
  computeDegrees,
  describeGraphCoverage,
  filterGraph,
  graphDataKey,
  layoutIterations,
  layoutScalingRatio,
  nodeColor,
  nodeSize,
  restrictEdgesToNodes,
  seedPositions,
  selectNodeBudget,
  sortNodesByDegree,
  hasActiveFilter,
  type GraphFilter,
} from '@renderer/lib/kb-wiki-graph';
import type {
  WikiCommunitySummary,
  WikiGraphViewEdge,
  WikiGraphViewNode,
  WikiPageType,
  WikiStructuralFinding,
} from '@shared/kb-types';

function node(
  pageId: string,
  type: WikiPageType = 'concept',
  extra: Partial<WikiGraphViewNode> = {},
): WikiGraphViewNode {
  return {
    pageId,
    title: extra.title ?? pageId.toUpperCase(),
    type,
    outlinks: [],
    inlinks: [],
    keywords: extra.keywords ?? [],
  };
}

const edge = (source: string, target: string): WikiGraphViewEdge => ({ source, target });

const filter = (patch: Partial<GraphFilter> = {}): GraphFilter => ({ ...EMPTY_GRAPH_FILTER, ...patch });

describe('filterGraph', () => {
  const nodes = [
    node('a', 'concept', { title: '时钟复位' }),
    node('b', 'entity', { title: 'Clock Reset', keywords: ['clkmgr'] }),
    node('c', 'source', { title: '手册' }),
  ];
  const edges = [edge('a', 'b'), edge('b', 'c'), edge('a', 'c')];

  it('无过滤条件时原样返回', () => {
    const result = filterGraph(nodes, edges, EMPTY_GRAPH_FILTER);
    expect(result.nodes).toHaveLength(3);
    expect(result.edges).toHaveLength(3);
  });

  it('按类型过滤会同时丢弃悬空边', () => {
    const result = filterGraph(nodes, edges, filter({ types: ['concept'] }));
    expect(result.nodes.map((n) => n.pageId)).toEqual(['a']);
    expect(result.edges).toHaveLength(0);
  });

  it('关键词匹配标题、pageId 与页面关键词，大小写不敏感', () => {
    expect(filterGraph(nodes, edges, filter({ keyword: 'clock' })).nodes.map((n) => n.pageId)).toEqual(['b']);
    expect(filterGraph(nodes, edges, filter({ keyword: 'CLKMGR' })).nodes.map((n) => n.pageId)).toEqual(['b']);
    expect(filterGraph(nodes, edges, filter({ keyword: 'C' })).nodes.map((n) => n.pageId)).toEqual(['b', 'c']);
    expect(filterGraph(nodes, edges, filter({ keyword: '   ' })).nodes).toHaveLength(3);
  });

  it('社区过滤使用 pageId → communityId 映射，未归属的页面被排除', () => {
    const map = communityByPage([
      { communityId: 0, size: 1, internalEdges: 0, sparse: true, members: ['a'] },
      { communityId: 1, size: 1, internalEdges: 0, sparse: true, members: ['c'] },
    ]);
    const result = filterGraph(nodes, edges, filter({ communityId: 1 }), map);
    expect(result.nodes.map((n) => n.pageId)).toEqual(['c']);
  });

  it('报告过滤前后的规模，供状态栏说明覆盖', () => {
    const result = filterGraph(nodes, edges, filter({ types: ['source'] }));
    expect(result.totalNodes).toBe(3);
    expect(result.totalEdges).toBe(3);
  });

  it('hasActiveFilter 只在真正设置了条件时为真', () => {
    expect(hasActiveFilter(EMPTY_GRAPH_FILTER)).toBe(false);
    expect(hasActiveFilter(filter({ keyword: 'a' }))).toBe(true);
    expect(hasActiveFilter(filter({ types: [] }))).toBe(false);
    expect(hasActiveFilter(filter({ communityId: 0 }))).toBe(true);
  });
});

describe('computeDegrees / sortNodesByDegree', () => {
  it('自链与未知端点不计入度数', () => {
    const nodes = [node('a'), node('b')];
    const edges = [edge('a', 'b'), edge('a', 'a'), edge('b', 'ghost')];
    const degrees = computeDegrees(nodes, edges);
    expect(degrees.get('a')).toEqual({ in: 0, out: 1, total: 1 });
    expect(degrees.get('b')).toEqual({ in: 1, out: 0, total: 1 });
  });

  it('按总度数降序、同分按 pageId 升序稳定排序', () => {
    const nodes = [node('c'), node('a'), node('b')];
    const edges = [edge('a', 'b'), edge('b', 'c')];
    const ordered = sortNodesByDegree(nodes, computeDegrees(nodes, edges));
    expect(ordered.map((n) => n.pageId)).toEqual(['b', 'a', 'c']);
  });
});

describe('selectNodeBudget（大图先过滤/按需展开）', () => {
  function chain(count: number): { nodes: WikiGraphViewNode[]; edges: WikiGraphViewEdge[] } {
    const nodes = Array.from({ length: count }, (_, i) => node(`p${String(i).padStart(3, '0')}`));
    const edges = nodes.slice(1).map((n, i) => edge(nodes[i]!.pageId, n.pageId));
    return { nodes, edges };
  }

  it('节点数不超过预算时全部可见', () => {
    const { nodes, edges } = chain(10);
    const budget = selectNodeBudget(nodes, edges, GRAPH_INITIAL_NODE_BUDGET);
    expect(budget.visible.size).toBe(10);
    expect(budget.hidden).toBe(0);
  });

  it('超过预算时按度数取前 N 个，其余计入隐藏', () => {
    const { nodes, edges } = chain(50);
    const budget = selectNodeBudget(nodes, edges, 10);
    expect(budget.visible.size).toBe(10);
    expect(budget.hidden).toBe(40);
    // 链两端度数为 1，中间为 2 → 中间节点优先（同分按 pageId 升序取前 10）
    expect(budget.visible.has('p000')).toBe(false);
    expect(budget.visible.has('p049')).toBe(false);
    expect(budget.visible.has('p010')).toBe(true);
    expect(budget.visible.has('p011')).toBe(false);
  });

  it('同一快照多次调用结果一致（确定性）', () => {
    const { nodes, edges } = chain(40);
    const first = selectNodeBudget(nodes, edges, 12);
    const second = selectNodeBudget([...nodes].reverse(), [...edges].reverse(), 12);
    expect([...first.visible].sort()).toEqual([...second.visible].sort());
  });

  it('展开后可见集合单调增长', () => {
    const { nodes, edges } = chain(40);
    const small = selectNodeBudget(nodes, edges, 5);
    const large = selectNodeBudget(nodes, edges, 15);
    for (const id of small.visible) expect(large.visible.has(id)).toBe(true);
  });

  it('预算裁剪后只保留两端可见的边', () => {
    const { nodes, edges } = chain(20);
    const budget = selectNodeBudget(nodes, edges, 4);
    const kept = restrictEdgesToNodes(edges, budget.visible);
    for (const e of kept) {
      expect(budget.visible.has(e.source)).toBe(true);
      expect(budget.visible.has(e.target)).toBe(true);
    }
  });
});

describe('seedPositions / 布局参数', () => {
  it('初始坐标确定，且与输入顺序无关', () => {
    const a = seedPositions(['b', 'a', 'c']);
    const b = seedPositions(['c', 'b', 'a']);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it('不同节点坐标互不相同（不会叠在一起）', () => {
    const positions = seedPositions(['a', 'b', 'c', 'd']);
    const seen = new Set([...positions.values()].map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`));
    expect(seen.size).toBe(4);
  });

  it('迭代次数与间距随规模单调不增/增大', () => {
    expect(layoutIterations(50)).toBeGreaterThan(layoutIterations(3000));
    expect(layoutScalingRatio(50)).toBeLessThan(layoutScalingRatio(1000));
  });

  it('节点尺寸随度数增长并封顶', () => {
    const small = nodeSize(0, 10);
    const large = nodeSize(10, 10);
    expect(small).toBeLessThan(large);
    expect(nodeSize(10, 0)).toBe(small);
  });
});

describe('graphDataKey（切库/重开图不串 revision）', () => {
  const nodes = [node('a'), node('b')];
  const edges = [edge('a', 'b')];

  it('kbId 或 revision 变化时 key 变化', () => {
    const base = graphDataKey('kb1', 3, nodes, edges);
    expect(graphDataKey('kb2', 3, nodes, edges)).not.toBe(base);
    expect(graphDataKey('kb1', 4, nodes, edges)).not.toBe(base);
  });

  it('结构变化时 key 变化，仅顺序变化时保持稳定', () => {
    const base = graphDataKey('kb1', 3, nodes, edges);
    expect(graphDataKey('kb1', 3, [...nodes].reverse(), [...edges].reverse())).toBe(base);
    expect(graphDataKey('kb1', 3, nodes, [])).not.toBe(base);
  });
});

describe('社区与图例', () => {
  const communities: WikiCommunitySummary[] = [
    { communityId: 0, size: 2, internalEdges: 1, sparse: false, members: ['a', 'b'] },
    { communityId: 1, size: 1, internalEdges: 0, sparse: true, members: ['c'] },
  ];

  it('communityByPage 展开为 pageId → communityId', () => {
    const map = communityByPage(communities);
    expect(map.get('a')).toBe(0);
    expect(map.get('c')).toBe(1);
    expect(map.get('ghost')).toBeUndefined();
  });

  it('按社区着色时未归属节点使用中性色，按类型着色不受社区影响', () => {
    const map = communityByPage(communities);
    const a = node('a', 'concept');
    const ghost = node('ghost', 'concept');
    expect(nodeColor(a, 'community', map)).not.toBe(nodeColor(ghost, 'community', map));
    expect(nodeColor(a, 'type', map)).toBe(nodeColor(ghost, 'type', map));
  });

  it('图例按数量降序聚合，社区模式含未归属项', () => {
    const nodes = [node('a', 'concept'), node('b', 'concept'), node('c', 'entity'), node('ghost', 'entity')];
    const typeLegend = buildLegend(nodes, 'type', new Map());
    expect(typeLegend.find((l) => l.key === 'concept')?.count).toBe(2);
    expect(typeLegend.find((l) => l.key === 'entity')?.count).toBe(2);
    const communityLegend = buildLegend(nodes, 'community', communityByPage(communities));
    // a/b 在社区 0，c 在社区 1，只有 ghost 未归属
    expect(communityLegend.find((l) => l.key === 'c0')?.count).toBe(2);
    expect(communityLegend.find((l) => l.key === 'c1')?.count).toBe(1);
    expect(communityLegend.find((l) => l.key === 'unassigned')?.count).toBe(1);
  });

  it('八种页面类型都有颜色与标签（图例/过滤器可完整渲染）', () => {
    for (const type of ALL_PAGE_TYPES) {
      const entry = buildLegend([node('x', type)], 'type', new Map());
      expect(entry).toHaveLength(1);
      expect(entry[0]!.label.length).toBeGreaterThan(0);
      expect(entry[0]!.color).toMatch(/^#/);
    }
  });
});

describe('buildAdjacencyList（WebGL 不可用时的降级视图）', () => {
  const nodes = [node('a', 'concept', { title: 'A' }), node('b', 'entity', { title: 'B' }), node('c', 'source', { title: 'C' })];
  const edges = [edge('a', 'b'), edge('c', 'b'), edge('a', 'c')];

  it('按度数降序排列，含出入链标题', () => {
    const list = buildAdjacencyList(nodes, edges);
    expect(list[0]!.pageId).toBe('a');
    const a = list.find((e) => e.pageId === 'a')!;
    expect(a.out.map((n) => n.pageId)).toEqual(['b', 'c']);
    expect(a.in).toHaveLength(0);
    expect(a.degree).toBe(2);
  });

  it('保留孤立节点（orphan 本身就是待办类型）', () => {
    const list = buildAdjacencyList([...nodes, node('d', 'pitfall')], edges);
    expect(list.map((e) => e.pageId)).toContain('d');
    expect(list.find((e) => e.pageId === 'd')!.degree).toBe(0);
  });

  it('limit 截断列表但排序稳定', () => {
    const list = buildAdjacencyList(nodes, edges, 1);
    expect(list).toHaveLength(1);
    expect(list[0]!.pageId).toBe('a');
  });
});

describe('bridgeNodePageIds', () => {
  const finding = (kind: WikiStructuralFinding['kind'], status: WikiStructuralFinding['status'], pageIds: string[]): WikiStructuralFinding => ({
    findingId: `${kind}:${pageIds.join(',')}`,
    kbId: 'kb1',
    kind,
    pageIds,
    evidenceRefs: [],
    evidenceHashes: [],
    status,
    createdAt: '2026-09-14T00:00:00Z',
    updatedAt: '2026-09-14T00:00:00Z',
  });

  it('只取 bridge-node 且默认排除已忽略的线索', () => {
    const ids = bridgeNodePageIds([
      finding('bridge-node', 'open', ['hub']),
      finding('bridge-node', 'ignored', ['ignored-hub']),
      finding('orphan', 'open', ['lonely']),
    ]);
    expect([...ids]).toEqual(['hub']);
  });

  it('includeIgnored 时保留被忽略的桥接节点', () => {
    const ids = bridgeNodePageIds(
      [finding('bridge-node', 'ignored', ['ignored-hub'])],
      { includeIgnored: true },
    );
    expect([...ids]).toEqual(['ignored-hub']);
  });
});

describe('describeGraphCoverage', () => {
  it('被预算裁剪时说明剩余待展开数量', () => {
    expect(describeGraphCoverage(400, 1200, 3000, 800)).toContain('其余 800 页待展开');
  });

  it('未裁剪时只报总数', () => {
    expect(describeGraphCoverage(37, 37, 52, 0)).toBe('共 37 页，52 条链接');
  });
});
