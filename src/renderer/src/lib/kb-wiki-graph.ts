/**
 * kb-wiki-graph — 知识图谱视图的纯逻辑层（spec §9，issue 26）。
 *
 * 只有纯函数：快照 → 过滤/邻接/配色/布局输入。DOM、WebGL、worker 与
 * tRPC 都不在这里，因此大图预算、过滤和邻接列表可以在 node 环境直接验证，
 * 不需要挂载 sigma（布局仍在 worker 中运行，见 graph-layout-client）。
 *
 * 主进程图快照是唯一输入，renderer 不重新扫盘建图（spec §9）。
 */

import type {
  WikiGraphViewEdge,
  WikiGraphViewNode,
  WikiPageType,
  WikiStructuralFinding,
  WikiCommunitySummary,
} from '@shared/kb-types';

// ── 常量 ────────────────────────────────────────────────────────

/** 首屏节点预算：超过此数量先只画度数最高的一批，其余按需展开（spec §9）。 */
export const GRAPH_INITIAL_NODE_BUDGET = 400;

/** 每次「展开更多」新增的节点数量。 */
export const GRAPH_EXPAND_STEP = 400;

/** 关键词过滤命中的最大展示项（防止超长列表拖慢首屏）。 */
export const GRAPH_ADJACENCY_LIMIT = 300;

/** 节点度数超过此值才在画布上强制显示标签。 */
export const GRAPH_LABEL_DEGREE_THRESHOLD = 3;

/** 类型着色（与 WikiPageType 一一对应）。 */
export const TYPE_COLORS: Record<WikiPageType, string> = {
  source: '#fb923c',
  entity: '#60a5fa',
  concept: '#c084fc',
  comparison: '#2dd4bf',
  synthesis: '#f87171',
  query: '#4ade80',
  pitfall: '#facc15',
  interface: '#38bdf8',
};

/** 类型中文标签（图例与过滤器用）。 */
export const TYPE_LABELS: Record<WikiPageType, string> = {
  source: '来源',
  entity: '实体',
  concept: '概念',
  comparison: '对比',
  synthesis: '综述',
  query: '问答',
  pitfall: '陷阱',
  interface: '接口',
};

/** 社区着色调色板（按 communityId 取模）。 */
export const COMMUNITY_PALETTE: readonly string[] = [
  '#60a5fa',
  '#4ade80',
  '#fb923c',
  '#c084fc',
  '#f87171',
  '#2dd4bf',
  '#facc15',
  '#f472b6',
  '#a78bfa',
  '#38bdf8',
  '#34d399',
  '#fbbf24',
];

/** 社区未分配（社区分析未运行或不含该页）时的中性色。 */
export const UNASSIGNED_COMMUNITY_COLOR = '#64748b';

/** 所有页面类型的规范顺序（图例、过滤器稳定排序）。 */
export const ALL_PAGE_TYPES: readonly WikiPageType[] = [
  'source',
  'entity',
  'concept',
  'comparison',
  'synthesis',
  'query',
  'pitfall',
  'interface',
];

// ── 过滤 ────────────────────────────────────────────────────────

export type GraphColorMode = 'type' | 'community';

export type GraphFilter = {
  /** 允许的页面类型；null = 不按类型过滤 */
  types: WikiPageType[] | null;
  /** 关键词；空串 = 不按关键词过滤 */
  keyword: string;
  /** 社区 ID；null = 不按社区过滤 */
  communityId: number | null;
};

export const EMPTY_GRAPH_FILTER: GraphFilter = { types: null, keyword: '', communityId: null };

/** 过滤器是否处于激活状态（UI 用来显示「已过滤」提示）。 */
export function hasActiveFilter(filter: GraphFilter): boolean {
  return (filter.types !== null && filter.types.length > 0)
    || filter.keyword.trim().length > 0
    || filter.communityId !== null;
}

/**
 * 单个节点是否命中关键词。
 *
 * 匹配标题、pageId 与页面关键词，大小写不敏感；空关键词视为命中。
 * 不做子串模糊以外的推断——过滤只缩小画面，不改变图契约。
 */
export function matchesKeyword(node: WikiGraphViewNode, keyword: string): boolean {
  const needle = keyword.trim().toLowerCase();
  if (needle.length === 0) return true;
  if (node.title.toLowerCase().includes(needle)) return true;
  if (node.pageId.toLowerCase().includes(needle)) return true;
  return node.keywords.some((k) => k.toLowerCase().includes(needle));
}

/** 节点是否通过类型/关键词/社区三个过滤条件。 */
export function nodePassesFilter(
  node: WikiGraphViewNode,
  filter: GraphFilter,
  communityByPage: ReadonlyMap<string, number>,
): boolean {
  if (filter.types !== null && filter.types.length > 0 && !filter.types.includes(node.type)) {
    return false;
  }
  if (filter.communityId !== null && communityByPage.get(node.pageId) !== filter.communityId) {
    return false;
  }
  return matchesKeyword(node, filter.keyword);
}

export type FilteredGraph = {
  /** 通过过滤的节点（保持输入顺序） */
  nodes: WikiGraphViewNode[];
  /** 两端都在 nodes 中的边 */
  edges: WikiGraphViewEdge[];
  /** 原始节点总数 */
  totalNodes: number;
  /** 原始边总数 */
  totalEdges: number;
};

/**
 * 应用类型/关键词/社区过滤。
 *
 * 边只有在 source 与 target 都留下时才保留：悬空边会让度数、邻接列表和
 * 布局都失真。孤立节点（无有效边）保留，因为 `orphan` 本身就是知识待办类型。
 */
export function filterGraph(
  nodes: readonly WikiGraphViewNode[],
  edges: readonly WikiGraphViewEdge[],
  filter: GraphFilter,
  communityByPage: ReadonlyMap<string, number> = new Map<string, number>(),
): FilteredGraph {
  const kept = nodes.filter((n) => nodePassesFilter(n, filter, communityByPage));
  const keptIds = new Set(kept.map((n) => n.pageId));
  const keptEdges = edges.filter((e) => keptIds.has(e.source) && keptIds.has(e.target));
  return {
    nodes: kept,
    edges: keptEdges,
    totalNodes: nodes.length,
    totalEdges: edges.length,
  };
}

// ── 度数 ────────────────────────────────────────────────────────

export type GraphNodeDegree = {
  /** 入链数（在给定边集内） */
  in: number;
  /** 出链数（在给定边集内） */
  out: number;
  /** in + out */
  total: number;
};

/**
 * 按给定边集计算度数。
 *
 * 用已解析的边而不是节点的 inlinks/outlinks 数组：断链/歧义目标不在边集里，
 * 不应把它们算成有效连接（spec §9 结构规则）。
 */
export function computeDegrees(
  nodes: readonly WikiGraphViewNode[],
  edges: readonly WikiGraphViewEdge[],
): Map<string, GraphNodeDegree> {
  const degrees = new Map<string, GraphNodeDegree>();
  for (const node of nodes) degrees.set(node.pageId, { in: 0, out: 0, total: 0 });
  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    const source = degrees.get(edge.source);
    const target = degrees.get(edge.target);
    if (!source || !target) continue;
    source.out += 1;
    source.total += 1;
    target.in += 1;
    target.total += 1;
  }
  return degrees;
}

/** 按总度数降序、pageId 升序排序（度数只由已解析边决定）。 */
export function sortNodesByDegree(
  nodes: readonly WikiGraphViewNode[],
  degrees: ReadonlyMap<string, GraphNodeDegree>,
): WikiGraphViewNode[] {
  return [...nodes].sort((a, b) => {
    const da = degrees.get(a.pageId)?.total ?? 0;
    const db = degrees.get(b.pageId)?.total ?? 0;
    if (da !== db) return db - da;
    return a.pageId < b.pageId ? -1 : a.pageId > b.pageId ? 1 : 0;
  });
}

// ── 大图预算与按需展开 ──────────────────────────────────────────

export type NodeBudget = {
  /** 本次实际可见的 pageId */
  visible: Set<string>;
  /** 因预算被隐藏的节点数 */
  hidden: number;
  /** 展开后的预算上限 */
  budget: number;
};

/**
 * 按度数挑选首屏可见节点（spec §9「大图先过滤和按需展开」）。
 *
 * 预算小于等于 0 或节点数不超过预算时全部可见；否则取度数最高的一批，
 * 同分按 pageId 稳定排序，因此同一快照的多次调用结果一致（可测）。
 */
export function selectNodeBudget(
  nodes: readonly WikiGraphViewNode[],
  edges: readonly WikiGraphViewEdge[],
  budget: number,
): NodeBudget {
  const effectiveBudget = budget <= 0 ? nodes.length : budget;
  if (nodes.length <= effectiveBudget) {
    return { visible: new Set(nodes.map((n) => n.pageId)), hidden: 0, budget: effectiveBudget };
  }
  const degrees = computeDegrees(nodes, edges);
  const ordered = sortNodesByDegree(nodes, degrees);
  const visible = new Set(ordered.slice(0, effectiveBudget).map((n) => n.pageId));
  return { visible, hidden: nodes.length - visible.size, budget: effectiveBudget };
}

/** 保留两端都可见的边（预算裁剪后重新收敛，避免悬空边）。 */
export function restrictEdgesToNodes(
  edges: readonly WikiGraphViewEdge[],
  visible: ReadonlySet<string>,
): WikiGraphViewEdge[] {
  return edges.filter((e) => visible.has(e.source) && visible.has(e.target));
}

// ── 布局输入 ────────────────────────────────────────────────────

export type GraphLayoutNode = { id: string; x: number; y: number };
export type GraphLayoutEdge = { source: string; target: string; weight: number };

/** 大图少迭代、小图多迭代；与 worker 的规模无关，只影响收敛速度。 */
export function layoutIterations(nodeCount: number): number {
  if (nodeCount > 2500) return 28;
  if (nodeCount > 1200) return 40;
  if (nodeCount > 600) return 65;
  if (nodeCount > 250) return 90;
  return 140;
}

/** ForceAtlas2 的 scalingRatio：节点越多越大，避免糊成一团。 */
export function layoutScalingRatio(nodeCount: number, spacing = 1): number {
  return spacing * (nodeCount > 400 ? 3 : 2);
}

/** 度数越高节点越大（视觉权重跟随结构重要性）。 */
export function nodeSize(degree: number, maxDegree: number): number {
  const BASE = 6;
  const MAX = 26;
  if (maxDegree <= 0) return BASE;
  const ratio = Math.max(0, Math.min(1, degree / maxDegree));
  return BASE + Math.sqrt(ratio) * (MAX - BASE);
}

/**
 * 确定性初始坐标（半径随节点数增长的圆周排列）。
 *
 * worker 完成前先画这一帧，首屏就已经是「可交互画面」而不是一堆叠在一起的
 * 随机点；同时避免 Math.random 让测试与冒烟结果不可复现。
 */
export function seedPositions(nodeIds: readonly string[]): Map<string, { x: number; y: number }> {
  const ordered = [...nodeIds].sort();
  const radius = Math.max(10, Math.sqrt(ordered.length) * 12);
  const positions = new Map<string, { x: number; y: number }>();
  ordered.forEach((id, index) => {
    const angle = (2 * Math.PI * index) / Math.max(1, ordered.length);
    positions.set(id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  });
  return positions;
}

/** FNV-1a 32 位哈希（仅用于生成稳定的数据 key，不做安全用途）。 */
export function hashGraphParts(parts: readonly string[]): string {
  let hash = 2166136261;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      hash ^= part.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 0xff;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * 布局数据 key。
 *
 * 包含 kbId 与 revision：切库或重开图会生成不同 key，worker 的迟到结果
 * 因为 key 不匹配被丢弃，不串 revision（spec §9）。
 */
export function graphDataKey(
  kbId: string,
  revision: number,
  nodes: readonly WikiGraphViewNode[],
  edges: readonly WikiGraphViewEdge[],
): string {
  const nodeIds = nodes.map((n) => n.pageId).sort();
  const edgeKeys = edges
    .map((e) => `${e.source}->${e.target}`)
    .sort();
  return `${kbId}:${revision}:${hashGraphParts(nodeIds)}:${hashGraphParts(edgeKeys)}:${nodes.length}:${edges.length}`;
}

export function buildLayoutNodes(
  nodes: readonly WikiGraphViewNode[],
  positions: ReadonlyMap<string, { x: number; y: number }>,
): GraphLayoutNode[] {
  return nodes.map((node) => {
    const position = positions.get(node.pageId) ?? { x: 0, y: 0 };
    return { id: node.pageId, x: position.x, y: position.y };
  });
}

export function buildLayoutEdges(edges: readonly WikiGraphViewEdge[]): GraphLayoutEdge[] {
  return edges.map((edge) => ({ source: edge.source, target: edge.target, weight: 1 }));
}

// ── 社区 ────────────────────────────────────────────────────────

/** 社区统计 → pageId → communityId。缺失的页面视为未分配。 */
export function communityByPage(
  communities: readonly WikiCommunitySummary[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const community of communities) {
    for (const pageId of community.members) {
      if (!map.has(pageId)) map.set(pageId, community.communityId);
    }
  }
  return map;
}

export function communityColor(communityId: number | undefined): string {
  if (communityId === undefined) return UNASSIGNED_COMMUNITY_COLOR;
  const index = ((communityId % COMMUNITY_PALETTE.length) + COMMUNITY_PALETTE.length)
    % COMMUNITY_PALETTE.length;
  return COMMUNITY_PALETTE[index] ?? UNASSIGNED_COMMUNITY_COLOR;
}

/** 按当前着色模式给节点取色。 */
export function nodeColor(
  node: WikiGraphViewNode,
  mode: GraphColorMode,
  communityByPageMap: ReadonlyMap<string, number>,
): string {
  if (mode === 'community') return communityColor(communityByPageMap.get(node.pageId));
  return TYPE_COLORS[node.type] ?? UNASSIGNED_COMMUNITY_COLOR;
}

export type GraphLegendEntry = { key: string; label: string; color: string; count: number };

/** 图例（类型或社区），按数量降序、标签升序稳定排序。 */
export function buildLegend(
  nodes: readonly WikiGraphViewNode[],
  mode: GraphColorMode,
  communityByPageMap: ReadonlyMap<string, number>,
): GraphLegendEntry[] {
  const counts = new Map<string, GraphLegendEntry>();
  for (const node of nodes) {
    if (mode === 'community') {
      const communityId = communityByPageMap.get(node.pageId);
      const key = communityId === undefined ? 'unassigned' : `c${communityId}`;
      const label = communityId === undefined ? '未归属社区' : `社区 ${communityId}`;
      accumulate(counts, key, label, communityColor(communityId));
    } else {
      accumulate(counts, node.type, TYPE_LABELS[node.type] ?? node.type, nodeColor(node, 'type', communityByPageMap));
    }
  }
  return [...counts.values()].sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  });
}

function accumulate(
  counts: Map<string, GraphLegendEntry>,
  key: string,
  label: string,
  color: string,
): void {
  const existing = counts.get(key);
  if (existing) {
    existing.count += 1;
    return;
  }
  counts.set(key, { key, label, color, count: 1 });
}

// ── 邻接列表（WebGL 不可用时的降级视图） ────────────────────────

export type AdjacencyNeighbor = { pageId: string; title: string };

export type AdjacencyEntry = {
  pageId: string;
  title: string;
  type: WikiPageType;
  degree: number;
  /** 该页引用的页面（已解析） */
  out: AdjacencyNeighbor[];
  /** 引用该页的页面（已解析） */
  in: AdjacencyNeighbor[];
};

/**
 * 构建邻接列表。
 *
 * WebGL 不可用时这是唯一的图视图，因此必须包含与画布等价的连接信息：
 * 出入链、度数、标题。排序按度数降序保证「枢纽」排在最前。
 */
export function buildAdjacencyList(
  nodes: readonly WikiGraphViewNode[],
  edges: readonly WikiGraphViewEdge[],
  limit: number = GRAPH_ADJACENCY_LIMIT,
): AdjacencyEntry[] {
  const byId = new Map(nodes.map((n) => [n.pageId, n]));
  const outMap = new Map<string, AdjacencyNeighbor[]>();
  const inMap = new Map<string, AdjacencyNeighbor[]>();
  for (const node of nodes) {
    outMap.set(node.pageId, []);
    inMap.set(node.pageId, []);
  }
  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    outMap.get(edge.source)?.push({ pageId: target.pageId, title: target.title });
    inMap.get(edge.target)?.push({ pageId: source.pageId, title: source.title });
  }

  const degrees = computeDegrees(nodes, edges);
  const ordered = sortNodesByDegree(nodes, degrees).slice(0, limit <= 0 ? nodes.length : limit);

  return ordered.map((node) => ({
    pageId: node.pageId,
    title: node.title,
    type: node.type,
    degree: degrees.get(node.pageId)?.total ?? 0,
    out: sortNeighbors(outMap.get(node.pageId) ?? []),
    in: sortNeighbors(inMap.get(node.pageId) ?? []),
  }));
}

function sortNeighbors(neighbors: AdjacencyNeighbor[]): AdjacencyNeighbor[] {
  return [...neighbors].sort((a, b) => {
    if (a.title !== b.title) return a.title < b.title ? -1 : 1;
    return a.pageId < b.pageId ? -1 : a.pageId > b.pageId ? 1 : 0;
  });
}

// ── 图线索（桥接节点） ──────────────────────────────────────────

/**
 * 从统一 finding 存储中取出桥接节点 pageId。
 *
 * 图洞察的 findings 与结构 lint 共享存储；图视图只做「高亮 + 跳转待办」，
 * 不复制处置状态（忽略/解决仍由知识待办拥有）。
 */
export function bridgeNodePageIds(
  findings: readonly WikiStructuralFinding[],
  options: { includeIgnored?: boolean } = {},
): Set<string> {
  const ids = new Set<string>();
  for (const finding of findings) {
    if (finding.kind !== 'bridge-node') continue;
    if (!options.includeIgnored && finding.status === 'ignored') continue;
    for (const pageId of finding.pageIds) ids.add(pageId);
  }
  return ids;
}

/** 图摘要文案（状态栏）：可见/总数、边数、是否被预算裁剪。 */
export function describeGraphCoverage(
  visibleNodes: number,
  totalNodes: number,
  totalEdges: number,
  hidden: number,
): string {
  if (hidden > 0) {
    return `显示 ${visibleNodes}/${totalNodes} 页（按度数取前 ${visibleNodes}），${totalEdges} 条链接；其余 ${hidden} 页待展开`;
  }
  return `共 ${totalNodes} 页，${totalEdges} 条链接`;
}
