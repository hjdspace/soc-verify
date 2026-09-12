/**
 * 框图 view model 纯函数层（issue 05：框图数据映射）。
 *
 * buildDiagramViewModel：getSubgraph 数据 → box 节点 + 聚合边。
 *   - 节点：图根 + 直接子实例；端口按方向分列（input 左列 / output 右列）
 *   - 边：单一驱动端连接到各接收端，按两端 bundle 归属聚合：
 *       · 同一（节点对， bundle 对）的全部连接 → 一条协议粗边（主方向 =
 *         连接数多的一侧，收拢该 bundle 对全部信号；如 27 根 AXI4 合一）
 *       · 与主方向相反的连接（如读通道）额外生成反向粗边
 *       · 任一端端口未入束 → net 细边
 *   - 方向：子实例 output / 图根 input 为驱动；方向不明确的网计数提示。
 *   - architecture 模式在展开前忽略普通网络，保留 clock/reset/bus。
 * edgesForSignal：信号名（任一端端口名 / net 名）→ 关联边 id 集合
 * （点击信号高亮同名连线，含粗边展开信号匹配）。
 */

import type { BundleGroup, DesignSubgraphRow, PortAnalysis, SubgraphPortRow } from '@main/rtl/types';

export type { DesignSubgraphRow } from '@main/rtl/types';

// ─── view model 类型 ─────────────────────────────────────────

export type DiagramNode = {
  /** 实例完整路径（React Flow node id） */
  id: string;
  name: string;
  module: string;
  isRoot: boolean;
  /** input 端口列（box 左缘） */
  portsIn: SubgraphPortRow[];
  /** output 端口列（box 右缘） */
  portsOut: SubgraphPortRow[];
  bundles: BundleGroup[];
  leftovers: string[];
};

/** 粗边展开后的信号明细（一对端口连接） */
export type DiagramSignal = {
  net: string | null;
  width: number;
  fromPort: string;
  toPort: string;
};

export type DiagramEdge = {
  id: string;
  kind: 'bundle' | 'signal';
  category: SignalCategory;
  source: string;
  target: string;
  /** bundle 边 = 协议标签（APB → AHB / clock）；signal 边 = net 名 */
  label: string;
  /** 两端锚定端口（bundle 边锚定首信号端口；signal 边 = net 两端端口） */
  sourcePort: string | null;
  targetPort: string | null;
  /** signal 边位宽（bundle 边为 null） */
  width: number | null;
  signalCount: number;
  signals: DiagramSignal[];
};

export type DiagramViewModel = {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  hiddenNetCount: number;
  unresolvedNetCount: number;
};

export type SignalCategory = 'clock' | 'reset' | 'bus' | 'signal';
export type DiagramMode = 'architecture' | 'all';

export function bundleCategory(bundle: BundleGroup): SignalCategory {
  if (bundle.protocol.toLowerCase() === 'clock') return 'clock';
  if (bundle.protocol.toLowerCase() === 'reset') return 'reset';
  return bundle.singleton ? 'signal' : 'bus';
}

// 无打标/一端重命名时保留常见时钟与复位；不以 data/address 等泛化名称猜总线。
function namedCategory(name: string, width: number): SignalCategory {
  if (width !== 1) return 'signal';
  if (/(^|_)(?:[aph]?clk|clock)(?:\d+)?(?:_(?:i|o|in|out))?$/i.test(name)) return 'clock';
  if (/(^|_)(?:[aph]?reset|rst|por)(?:n|_n)?(?:_(?:i|o|in|out|ni|no))?$/i.test(name)) return 'reset';
  return 'signal';
}

// ─── 索引与节点 ──────────────────────────────────────────────

type NodeCtx = {
  node: DiagramNode;
  ports: Map<string, SubgraphPortRow>;
  bundles: Map<string, BundleGroup>;
  isRoot: boolean;
};

type Endpoint = { ctx: NodeCtx; port: SubgraphPortRow };

type Conn = {
  from: Endpoint;
  to: Endpoint;
  net: string | null;
  width: number;
  category: SignalCategory;
};

function toNode(
  row: { path: string; name: string; module: string; ports: SubgraphPortRow[] },
  isRoot: boolean,
  analysis: PortAnalysis,
): DiagramNode {
  return {
    id: row.path,
    name: row.name,
    module: row.module,
    isRoot,
    portsIn: row.ports.filter((p) => p.direction === 'input'),
    portsOut: row.ports.filter((p) => p.direction === 'output'),
    bundles: analysis.bundles,
    leftovers: analysis.leftovers,
  };
}

/** 端口名 → 端口行 */
function portIndex(ports: SubgraphPortRow[]): Map<string, SubgraphPortRow> {
  return new Map(ports.map((p) => [p.name, p]));
}

/** 端口名 → 所在 bundle（未入束的端口不在索引中） */
function bundleIndex(analysis: PortAnalysis): Map<string, BundleGroup> {
  const m = new Map<string, BundleGroup>();
  for (const b of analysis.bundles) {
    for (const s of b.signals) m.set(s.name, b);
  }
  return m;
}

// ─── 主入口 ─────────────────────────────────────────────────

export function buildDiagramViewModel(sg: DesignSubgraphRow, mode: DiagramMode = 'all'): DiagramViewModel {
  if (!sg.root) return { nodes: [], edges: [], hiddenNetCount: 0, unresolvedNetCount: 0 };

  const rootCtx: NodeCtx = {
    node: toNode(sg.root, true, sg.bundles),
    ports: portIndex(sg.root.ports),
    bundles: bundleIndex(sg.bundles),
    isRoot: true,
  };
  const childCtxs: NodeCtx[] = sg.nodes.map((n) => ({
    node: toNode(n, false, n.bundles),
    ports: portIndex(n.ports),
    bundles: bundleIndex(n.bundles),
    isRoot: false,
  }));
  const ctxById = new Map<string, NodeCtx>([
    [rootCtx.node.id, rootCtx],
    ...childCtxs.map((c) => [c.node.id, c] as const),
  ]);

  // 先筛选网络再展开扇出，普通信号不进入聚合、布局和渲染。
  const conns: Conn[] = [];
  let hiddenNetCount = 0;
  let unresolvedNetCount = 0;
  for (const edge of sg.edges) {
    const cellEps: Endpoint[] = [];
    for (const cell of edge.cells) {
      const ctx = ctxById.get(cell.inst);
      const port = ctx?.ports.get(cell.port);
      if (ctx && port) cellEps.push({ ctx, port });
    }
    const topEps: Endpoint[] = [];
    for (const tp of edge.topPorts) {
      const port = rootCtx.ports.get(tp);
      if (port) topEps.push({ ctx: rootCtx, port });
    }
    const endpoints = [...topEps, ...cellEps];
    const categories = endpoints.map(({ ctx, port }) => {
      const bundle = ctx.bundles.get(port.name);
      return bundle ? bundleCategory(bundle) : namedCategory(port.name, port.width);
    });
    categories.push(namedCategory(edge.net ?? '', edge.width));
    const category = (['clock', 'reset', 'bus'] as const).find((c) => categories.includes(c)) ?? 'signal';
    if (mode === 'architecture' && category === 'signal') {
      hiddenNetCount++;
      continue;
    }
    // 图根方向相对于子图反转：root input 驱动内部，root output 接收内部。
    const drivers = endpoints.filter(({ ctx, port }) => port.direction === (ctx.isRoot ? 'input' : 'output'));
    const sinks = endpoints.filter(({ ctx, port }) => port.direction === (ctx.isRoot ? 'output' : 'input'));
    // 多驱动、inout 或缺失驱动的网不猜测方向，更不能把接收端两两相连。
    if (drivers.length !== 1 || sinks.length === 0 || endpoints.some((ep) => ep.port.direction === 'inout')) {
      unresolvedNetCount++;
      continue;
    }
    for (const to of sinks) {
      conns.push({ from: drivers[0]!, to, net: edge.net, width: edge.width, category });
    }
  }

  const nodes = [rootCtx.node, ...childCtxs.map((c) => c.node)];
  const edges = aggregateEdges(conns);
  if (mode === 'architecture') {
    const connected = new Map<string, Set<string>>();
    for (const e of edges) {
      for (const [id, port] of [[e.source, e.sourcePort], [e.target, e.targetPort]]) {
        if (!id || !port) continue;
        if (!connected.has(id)) connected.set(id, new Set());
        connected.get(id)!.add(port);
      }
    }
    for (const node of nodes) {
      node.bundles = node.bundles.filter((b) => bundleCategory(b) !== 'signal');
      const bundled = new Set(node.bundles.flatMap((b) => b.signals.map((s) => s.name)));
      node.leftovers = [...node.portsIn, ...node.portsOut]
        .filter((p) => !bundled.has(p.name) && (connected.get(node.id)?.has(p.name) || namedCategory(p.name, p.width) !== 'signal'))
        .map((p) => p.name);
    }
  }
  return {
    nodes, edges, hiddenNetCount, unresolvedNetCount,
  };
}

// ─── 边聚合 ─────────────────────────────────────────────────

type BundleGroupEntry = { conns: Conn[]; bundles: Map<string, BundleGroup> };

function bundleKey(b: BundleGroup): string {
  return `${b.protocol}@${b.singleton ? b.signals.map((s) => s.name).join(',') : b.prefix}`;
}

/** 束标签：singleton（clk/rst）用 net 名（协议名 "clock ×1" 易被误读为模块）；协议束用协议名 */
function bundleLabel(src: BundleGroup, tgt: BundleGroup, first: Conn | undefined): string {
  if (src.singleton && tgt.singleton && first) {
    return first.net ?? first.from.port.name;
  }
  return src.protocol === tgt.protocol ? src.protocol : `${src.protocol} → ${tgt.protocol}`;
}

function aggregateEdges(conns: Conn[]): DiagramEdge[] {
  const usedIds = new Set<string>();
  const uniqueId = (base: string): string => {
    let id = base;
    let n = 2;
    while (usedIds.has(id)) id = `${base}#${n++}`;
    usedIds.add(id);
    return id;
  };

  // bundle 分组：key = 无序节点对 + 各自 bundle（同 protocol 不同前缀独立成组）
  const groups = new Map<string, BundleGroupEntry>();
  const rest: Conn[] = [];

  for (const c of conns) {
    const bFrom = c.from.ctx.bundles.get(c.from.port.name);
    const bTo = c.to.ctx.bundles.get(c.to.port.name);
    if (!bFrom || !bTo) {
      rest.push(c);
      continue;
    }
    const aFirst = c.from.ctx.node.id < c.to.ctx.node.id;
    const n1 = aFirst ? c.from.ctx.node.id : c.to.ctx.node.id;
    const n2 = aFirst ? c.to.ctx.node.id : c.from.ctx.node.id;
    const k1 = aFirst ? bundleKey(bFrom) : bundleKey(bTo);
    const k2 = aFirst ? bundleKey(bTo) : bundleKey(bFrom);
    const key = `${n1}|${k1}||${n2}|${k2}`;
    let group = groups.get(key);
    if (!group) {
      group = { conns: [], bundles: new Map() };
      groups.set(key, group);
    }
    group.conns.push(c);
    group.bundles.set(c.from.ctx.node.id, bFrom);
    group.bundles.set(c.to.ctx.node.id, bTo);
  }

  const edges: DiagramEdge[] = [];

  for (const group of groups.values()) {
    // 方向分桶（组内连接可能双向：写通道 + 读通道）
    const byDir = new Map<string, { fromId: string; toId: string; conns: Conn[] }>();
    for (const c of group.conns) {
      const key = `${c.from.ctx.node.id}->${c.to.ctx.node.id}`;
      let bucket = byDir.get(key);
      if (!bucket) {
        bucket = { fromId: c.from.ctx.node.id, toId: c.to.ctx.node.id, conns: [] };
        byDir.set(key, bucket);
      }
      bucket.conns.push(c);
    }
    // 主方向 = 连接数多的一侧（并列取先出现）；主粗边收拢全部连接
    let primary: { fromId: string; toId: string; conns: Conn[] } | null = null;
    for (const bucket of byDir.values()) {
      if (!primary || bucket.conns.length > primary.conns.length) primary = bucket;
    }
    edges.push(bundleEdge(primary!, group.conns, group.bundles, uniqueId));
    // 反向通道边（如 AHB→APB 读通道，仅含该方向连接）
    for (const bucket of byDir.values()) {
      if (bucket !== primary) edges.push(bundleEdge(bucket, bucket.conns, group.bundles, uniqueId));
    }
  }

  for (const c of rest) {
    const source = c.from.ctx.node.id;
    const target = c.to.ctx.node.id;
    edges.push({
      id: uniqueId(`sig:${source}.${c.from.port.name}->${target}.${c.to.port.name}`),
      kind: 'signal',
      category: c.category,
      source,
      target,
      label: c.net ?? `${c.from.port.name} → ${c.to.port.name}`,
      sourcePort: c.from.port.name,
      targetPort: c.to.port.name,
      width: c.width,
      signalCount: 1,
      signals: [],
    });
  }

  return edges;
}

function bundleEdge(
  dir: { fromId: string; toId: string },
  conns: Conn[],
  bundles: Map<string, BundleGroup>,
  uniqueId: (base: string) => string,
): DiagramEdge {
  const src = bundles.get(dir.fromId)!;
  const tgt = bundles.get(dir.toId)!;
  const first = conns.find((c) => c.from.ctx.node.id === dir.fromId && c.to.ctx.node.id === dir.toId);
  return {
    id: uniqueId(`bd:${dir.fromId}->${dir.toId}:${bundleKey(src)}|${bundleKey(tgt)}`),
    kind: 'bundle',
    category: first?.category ?? 'bus',
    source: dir.fromId,
    target: dir.toId,
    label: bundleLabel(src, tgt, first),
    // 锚定首信号端口（box 上具体位置）；信号明细见 signals
    sourcePort: first ? first.from.port.name : null,
    targetPort: first ? first.to.port.name : null,
    width: null,
    signalCount: conns.length,
    signals: conns.map((c) => ({
      net: c.net,
      width: c.width,
      fromPort: c.from.port.name,
      toPort: c.to.port.name,
    })),
  };
}

// ─── 信号高亮 ───────────────────────────────────────────────

/** 信号名（任一端端口名 / net 名）→ 关联边 id 集合（点击高亮） */
export function edgesForSignal(vm: DiagramViewModel, signal: string): string[] {
  const ids: string[] = [];
  for (const e of vm.edges) {
    if (e.kind === 'bundle') {
      if (e.signals.some((s) => s.fromPort === signal || s.toPort === signal || s.net === signal)) ids.push(e.id);
    } else if (e.sourcePort === signal || e.targetPort === signal || e.label === signal) {
      ids.push(e.id);
    }
  }
  return ids;
}
