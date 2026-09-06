/**
 * 框图 view model 纯函数层（issue 05：框图数据映射）。
 *
 * buildDiagramViewModel：getSubgraph 数据 → box 节点 + 聚合边。
 *   - 节点：图根 + 直接子实例；端口按方向分列（input 左列 / output 右列）
 *   - 边：源边 pairwise 拆分（图根端口参与的网 = 图根↔各实例端口；
 *     纯 i2i 网两两配对），按两端 bundle 归属聚合：
 *       · 同一（节点对， bundle 对）的全部连接 → 一条协议粗边（主方向 =
 *         连接数多的一侧，收拢该 bundle 对全部信号；如 27 根 AXI4 合一）
 *       · 与主方向相反的连接（如读通道）额外生成反向粗边
 *       · 任一端端口未入束 → net 细边
 *   - 方向：output 端为 source；两端同向时图根端作 source 锚
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
};

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
};

function toNode(
  row: { path: string; name: string; module: string; ports: SubgraphPortRow[] },
  isRoot: boolean,
): DiagramNode {
  return {
    id: row.path,
    name: row.name,
    module: row.module,
    isRoot,
    portsIn: row.ports.filter((p) => p.direction === 'input'),
    portsOut: row.ports.filter((p) => p.direction === 'output'),
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

export function buildDiagramViewModel(sg: DesignSubgraphRow): DiagramViewModel {
  if (!sg.root) return { nodes: [], edges: [] };

  const rootCtx: NodeCtx = {
    node: toNode(sg.root, true),
    ports: portIndex(sg.root.ports),
    bundles: bundleIndex(sg.bundles),
    isRoot: true,
  };
  const childCtxs: NodeCtx[] = sg.nodes.map((n) => ({
    node: toNode(n, false),
    ports: portIndex(n.ports),
    bundles: bundleIndex(n.bundles),
    isRoot: false,
  }));
  const ctxById = new Map<string, NodeCtx>([
    [rootCtx.node.id, rootCtx],
    ...childCtxs.map((c) => [c.node.id, c] as const),
  ]);

  // ── 源边 pairwise 拆分（带方向） ──
  const conns: Conn[] = [];
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
    if (topEps.length > 0) {
      // 图根端口参与的网（top2i 桥 / 广播）：图根 ↔ 每个实例端口
      for (const t of topEps) {
        for (const c of cellEps) conns.push(connect(t, c, edge.net, edge.width));
      }
    } else {
      // 纯 i2i 网：实例两两配对
      for (let i = 0; i < cellEps.length; i++) {
        for (let j = i + 1; j < cellEps.length; j++) {
          conns.push(connect(cellEps[i]!, cellEps[j]!, edge.net, edge.width));
        }
      }
    }
  }

  return {
    nodes: [rootCtx.node, ...childCtxs.map((c) => c.node)],
    edges: aggregateEdges(conns),
  };
}

/** 连接方向：output 端为 source；两端同向时图根端作 source 锚 */
function connect(a: Endpoint, b: Endpoint, net: string | null, width: number): Conn {
  const aOut = a.port.direction === 'output';
  const bOut = b.port.direction === 'output';
  let from: Endpoint;
  if (aOut !== bOut) {
    from = aOut ? a : b;
  } else {
    from = b.ctx.isRoot && !a.ctx.isRoot ? b : a;
  }
  const to = from === a ? b : a;
  return { from, to, net, width };
}

// ─── 边聚合 ─────────────────────────────────────────────────

type BundleGroupEntry = { conns: Conn[]; bundles: Map<string, BundleGroup> };

function bundleKey(b: BundleGroup): string {
  return `${b.protocol}@${b.prefix}`;
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
  const first = conns[0];
  return {
    id: uniqueId(`bd:${dir.fromId}->${dir.toId}:${bundleKey(src)}|${bundleKey(tgt)}`),
    kind: 'bundle',
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
      if (e.signals.some((s) => s.fromPort === signal || s.toPort === signal)) ids.push(e.id);
    } else if (e.sourcePort === signal || e.targetPort === signal || e.label === signal) {
      ids.push(e.id);
    }
  }
  return ids;
}
