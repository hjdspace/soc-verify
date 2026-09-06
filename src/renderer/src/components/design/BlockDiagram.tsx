/**
 * 可下钻框图（issue 05：React Flow + elkjs）。
 *
 * - box = 图根 + 直接子实例（每个端口渲染四向 handle，连线锚定面由
 *   两端节点相对位置决定（block-diagram-routing.anchorSides）：左框右缘
 *   出线 → 右框左缘入线，不再按端口方向固定左右，消除绕底部/穿框走线）
 * - 直连线穿过中间节点时按 planDetour 绕行（通道 + 圆角折线），
 *   bundle 标签落在通道空白区
 * - 粗边 = Protocol Bundle（收拢为协议标签 + ×计数，可展开信号明细）；
 *   细边 = 未入束 net（RTL 原名）
 * - elkjs 自动分层布局（block-diagram-layout），节点可在画布中拖拽整理
 * - 双击实例下钻以它为图根 + 面包屑回退；hover 端口看信号名/方向/位宽；
 *   点击信号高亮同名连线（edgesForSignal）
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  applyNodeChanges,
  Handle,
  Position,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Background,
  Controls,
  MiniMap,
  Panel,
  type EdgeProps,
  type NodeChange,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Box, ChevronDown, ChevronRight, LayoutGrid, Maximize2, X } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';
import {
  buildDiagramViewModel,
  edgesForSignal,
  type DiagramSignal,
} from './block-diagram-model';
import { layoutDiagram } from './block-diagram-layout';
import {
  NODE_WIDTH,
  anchorSides,
  detourGeometry,
  handleId,
  nodeSize,
  planDetour,
  roundedPath,
  type Rect,
  type Side,
} from './block-diagram-routing';
import type { BundleGroup, DesignSubgraphRow, SubgraphPortRow } from '@main/rtl/types';

// ─── 节点视图：box + 端口两列 ────────────────────────────────

type ModuleBoxData = {
  name: string;
  module: string;
  isRoot: boolean;
  portsIn: SubgraphPortRow[];
  portsOut: SubgraphPortRow[];
  bundles: BundleGroup[];
  leftovers: string[];
  /** 当前高亮信号（同名端口行标记） */
  signal: string | null;
  onPortHover: (port: SubgraphPortRow | null) => void;
  onPortClick: (signal: string) => void;
};

function ModuleBoxView({ data, selected }: NodeProps) {
  const d = (data ?? {}) as ModuleBoxData;
  const ports = [...d.portsIn, ...d.portsOut];
  const portByName = new Map(ports.map((port) => [port.name, port]));
  return (
    <div
      data-testid="diagram-module-box"
      className={cn(
        'rtl-diagram-node overflow-hidden border bg-card',
        d.isRoot ? 'border-primary' : 'border-border',
        selected && 'is-selected',
      )}
      style={{ width: NODE_WIDTH }}
    >
      <div className="rtl-diagram-node-header flex h-[42px] items-center gap-2 border-b border-border px-2.5">
        <span className="rtl-diagram-node-icon grid size-6 shrink-0 place-items-center rounded-[5px] bg-primary/10 text-primary"><Box className="size-3.5" /></span>
        <span className="min-w-0 flex-1"><span className="block truncate font-mono text-[11px] font-semibold leading-tight text-foreground">{d.name}</span><span className="mt-0.5 block truncate font-mono text-[9px] leading-tight text-muted-foreground">{d.module}</span></span>
        {d.isRoot && <span className="rounded bg-warning/20 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-warning-foreground">root</span>}
      </div>
      <div className="rtl-diagram-node-body max-h-[300px] overflow-y-auto p-[5px]">
        {d.bundles.map((bundle) => (
          <BundleRow key={`${bundle.protocol}:${bundle.prefix}`} bundle={bundle} portByName={portByName} d={d} />
        ))}
        {d.leftovers.map((name) => {
          const port = portByName.get(name);
          return port ? <PortRow key={port.name} port={port} d={d} /> : null;
        })}
      </div>
      <div className="flex h-7 items-center border-t border-border bg-muted/35 px-2.5 text-[9px] text-muted-foreground"><span>{ports.length} ports</span><span className="ml-auto font-mono">{d.bundles.length} bundles</span></div>
    </div>
  );
}

/** 端口四向 handle：锚定面由两端节点相对位置决定（anchorSides），
 * 连线可从任一面出/入框；同一端口同面同时挂 source/target，
 * 支持同向端口对（如两 input 共网）的任一端作 source */
const PORT_SIDES: ReadonlyArray<{ side: Side; pos: Position }> = [
  { side: 'l', pos: Position.Left },
  { side: 'r', pos: Position.Right },
  { side: 't', pos: Position.Top },
  { side: 'b', pos: Position.Bottom },
];

function PortHandles({ port }: { port: SubgraphPortRow }) {
  return (
    <>
      {PORT_SIDES.map(({ side, pos }) => (
        <Fragment key={side}>
          <Handle type="source" position={pos} id={handleId(side, port.name)} isConnectable={false} />
          <Handle type="target" position={pos} id={handleId(side, port.name)} isConnectable={false} />
        </Fragment>
      ))}
    </>
  );
}

function BundleRow({ bundle, portByName, d }: { bundle: BundleGroup; portByName: Map<string, SubgraphPortRow>; d: ModuleBoxData }) {
  const ports = bundle.signals.flatMap((signal) => {
    const port = portByName.get(signal.name);
    return port ? [port] : [];
  });
  const highlighted = ports.some((port) => port.name === d.signal);
  const label = bundle.singleton ? (ports[0]?.name ?? bundle.protocol) : `${bundle.prefix || ''}* · ${bundle.protocol}${bundle.role ? ` ${bundle.role}` : ''}`;
  return (
    <div className={cn('nodrag relative flex h-[30px] items-center gap-1.5 rounded px-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground', highlighted && 'bg-primary/15 text-primary')}>
      <span className={cn('size-1.5 shrink-0 rounded-full', bundle.singleton ? 'bg-muted-foreground' : 'bg-status-pass')} />
      <span className="min-w-0 truncate font-mono text-[10px]">{label}</span>
      <span className="ml-auto shrink-0 text-[9px] text-muted-foreground">{bundle.singleton ? ports[0]?.direction : `${ports.length} signals`}</span>
      {ports.map((port) => (
        <Fragment key={port.name}>
          <span
            data-testid="diagram-port"
            data-port={port.name}
            data-direction={port.direction}
            className="sr-only"
            onMouseEnter={() => d.onPortHover(port)}
            onMouseLeave={() => d.onPortHover(null)}
            onClick={() => d.onPortClick(port.name)}
          />
          <PortHandles port={port} />
        </Fragment>
      ))}
    </div>
  );
}

function PortRow({ port, d }: { port: SubgraphPortRow; d: ModuleBoxData }) {
  const matched = d.signal === port.name;
  return (
    <div
      data-testid="diagram-port"
      data-port={port.name}
      data-direction={port.direction}
      title={`${port.name} · ${port.direction} · [${port.width - 1}:0]`}
      onMouseEnter={() => d.onPortHover(port)}
      onMouseLeave={() => d.onPortHover(null)}
      onClick={() => d.onPortClick(port.name)}
      className={cn(
        'nodrag relative flex h-[30px] w-full cursor-pointer items-center rounded px-1.5 font-mono text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
        matched && 'bg-primary/20 text-primary',
      )}
    >
      {/* 同一端口同时挂 source/target handle：同向端口对（如两 input 共网）的
          source 端也能锚定在该端口行，避免 React Flow 找不到 handle 丢边 */}
      <PortHandles port={port} />
      <span className="truncate">{port.name}</span>
      <span className="ml-auto shrink-0 pl-1 font-sans text-[9px] text-muted-foreground">
        {port.width > 1 ? `[${port.width - 1}:0]` : port.direction}
      </span>
    </div>
  );
}

// ─── 边视图：粗边（bundle）/ 细边（signal） ──────────────────

type EdgeViewData = {
  label: string;
  signalCount: number;
  signals: DiagramSignal[];
  width: number | null;
  highlighted: boolean;
  expanded: boolean;
  /** 布局期决定的流轴向（h = 水平 / v = 纵向），绕行通道方向依据 */
  axis: 'h' | 'v';
  /** 同节点对第几条边（绕行通道错开） */
  ordinal: number;
  /** 其余节点矩形（布局期快照）：直连线穿过时绕行 */
  obstacles: Rect[];
  onToggle: () => void;
};

/** 连线路径 + 标签位置：优先绕行折线（圆角），否则按锚定面方向的贝塞尔 */
function edgeGeometry(props: EdgeProps, d: EdgeViewData): { path: string; labelX: number; labelY: number } {
  const source = { x: props.sourceX, y: props.sourceY };
  const target = { x: props.targetX, y: props.targetY };
  const detour = planDetour(source, target, d.obstacles, d.ordinal, d.axis);
  if (detour) {
    const geo = detourGeometry(source, target, detour);
    return { path: roundedPath(geo.waypoints), labelX: geo.label.x, labelY: geo.label.y };
  }
  const [path, labelX, labelY] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  });
  return { path, labelX, labelY };
}

function BundleEdgeView(props: EdgeProps) {
  const d = (props.data ?? {}) as EdgeViewData;
  const { path, labelX, labelY } = edgeGeometry(props, d);
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        style={{
          strokeWidth: d.highlighted ? 5 : 3.5,
          stroke: d.highlighted ? 'var(--primary)' : 'var(--border)',
          strokeLinecap: 'round',
        }}
      />
      <EdgeLabelRenderer>
        <div
          data-testid="diagram-bundle-label"
          data-highlighted={String(d.highlighted)}
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
          }}
          className={cn(
            'diagram-edge-label nodrag nopan relative z-20 flex flex-col items-start rounded-md border border-border bg-card text-[10px] shadow-sm',
            d.highlighted && 'border-primary/60',
          )}
        >
          <button
            type="button"
            data-testid="diagram-bundle-toggle"
            onClick={d.onToggle}
            title={d.expanded ? '收拢协议信号' : '展开协议信号'}
            className="flex h-7 items-center gap-1.5 px-2 font-semibold text-foreground"
          >
            <span className="size-1.5 rounded-full bg-status-pass" />
            <span className="font-mono">{d.label}</span>
            {d.signalCount > 1 && <span className="font-mono text-[9px] font-normal text-muted-foreground">×{d.signalCount}</span>}
            <ChevronDown className={cn('size-3 text-muted-foreground transition-transform', d.expanded && 'rotate-180')} />
          </button>
          {d.expanded && (
            <div className="max-h-52 w-[286px] overflow-y-auto border-t border-border bg-card p-1.5 font-mono text-[9px] text-muted-foreground">
              <div className="flex h-7 items-center px-1.5 font-sans text-[10px]"><strong className="text-foreground">{d.label}</strong><span className="ml-auto">{d.signalCount} signals</span></div>
              {d.signals.map((s, i) => (
                <div key={`${s.net ?? ''}-${i}`} data-testid="diagram-bundle-signal" className="grid min-h-7 grid-cols-[minmax(0,1fr)_14px_minmax(0,1fr)_auto] items-center gap-1 rounded px-1.5 hover:bg-muted">
                  <span className="truncate">{s.fromPort}</span><span aria-hidden="true"> → </span><span className="truncate">{s.toPort}</span>
                  <span>{s.width > 1 ? ` [${s.width - 1}:0]` : ''}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

function SignalEdgeView(props: EdgeProps) {
  const d = (props.data ?? {}) as EdgeViewData;
  const { path, labelX, labelY } = edgeGeometry(props, d);
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        style={{
          strokeWidth: d.highlighted ? 3 : 1.5,
          stroke: d.highlighted ? 'var(--primary)' : 'var(--border)',
        }}
      />
      <EdgeLabelRenderer>
        <div
          data-testid="diagram-signal-label"
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'none',
          }}
          className={cn(
            'diagram-edge-label nodrag nopan relative z-20 rounded-md border border-border/70 bg-card/90 px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground shadow-sm',
            d.highlighted && 'font-semibold text-primary',
          )}
        >
          {d.label}
          {d.width !== null && d.width > 1 ? ` [${d.width - 1}:0]` : ''}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

// ─── 主组件 ─────────────────────────────────────────────────

export function BlockDiagram({ projectId, path }: { projectId: string; path: string }) {
  const [rootPath, setRootPath] = useState(path);
  const [sg, setSg] = useState<DesignSubgraphRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }> | null>(null);
  const [rfNodes, setRfNodes] = useState<Node[]>([]);
  const [flow, setFlow] = useState<ReactFlowInstance | null>(null);
  const [hoveredPort, setHoveredPort] = useState<SubgraphPortRow | null>(null);
  const [highlightSignal, setHighlightSignal] = useState<string | null>(null);
  const [expandedEdges, setExpandedEdges] = useState<ReadonlySet<string>>(new Set());

  // prop 变化重置图根（DesignView 切换选中实例）
  useEffect(() => setRootPath(path), [path]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setPositions(null);
    setRfNodes([]);
    setHighlightSignal(null);
    setExpandedEdges(new Set());
    setHoveredPort(null);
    trpc.rtl.getSubgraph
      .query({ projectId, path: rootPath })
      .then((r) => {
        if (!alive) return;
        setSg(r);
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setSg(null);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [projectId, rootPath]);

  const vm = useMemo(() => (sg ? buildDiagramViewModel(sg) : null), [sg]);

  const onPortClick = useCallback((signal: string) => {
    setHighlightSignal((prev) => (prev === signal ? null : signal));
  }, []);

  useEffect(() => {
    if (!vm) return;
    let alive = true;
    void layoutDiagram(
      vm.nodes.map((n) => ({ id: n.id, ...nodeSize(n) })),
      vm.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    ).then((pos) => {
      if (!alive) return;
      setPositions(pos);
      setRfNodes(vm.nodes.map((n) => ({
        id: n.id,
        type: 'moduleBox',
        position: pos.get(n.id) ?? { x: 0, y: 0 },
        draggable: true,
        dragHandle: '.rtl-diagram-node-header',
        data: {
          name: n.name,
          module: n.module,
          isRoot: n.isRoot,
          portsIn: n.portsIn,
          portsOut: n.portsOut,
          bundles: n.bundles,
          leftovers: n.leftovers,
          signal: null,
          onPortHover: setHoveredPort,
          onPortClick,
        } satisfies ModuleBoxData,
      })));
    });
    return () => {
      alive = false;
    };
  }, [onPortClick, vm]);

  const highlightedIds = useMemo(
    () => (vm && highlightSignal ? new Set(edgesForSignal(vm, highlightSignal)) : new Set<string>()),
    [vm, highlightSignal],
  );

  const toggleExpanded = useCallback((edgeId: string) => {
    setExpandedEdges((prev) => {
      const next = new Set(prev);
      if (next.has(edgeId)) next.delete(edgeId);
      else next.add(edgeId);
      return next;
    });
  }, []);

  const handleNodeDoubleClick = useCallback(
    (_e: unknown, node: { id: string }) => {
      if (node.id !== rootPath) setRootPath(node.id);
    },
    [rootPath],
  );

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    setRfNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const resetLayout = useCallback(() => {
    if (!vm) return;
    void layoutDiagram(
      vm.nodes.map((n) => ({ id: n.id, ...nodeSize(n) })),
      vm.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    ).then((next) => {
      setPositions(next);
      setRfNodes((_current) =>
        vm.nodes.map((n) => ({
          id: n.id,
          type: 'moduleBox',
          position: next.get(n.id) ?? { x: 0, y: 0 },
          draggable: true,
          dragHandle: '.rtl-diagram-node-header',
          data: {
            name: n.name,
            module: n.module,
            isRoot: n.isRoot,
            portsIn: n.portsIn,
            portsOut: n.portsOut,
            bundles: n.bundles,
            leftovers: n.leftovers,
            signal: highlightSignal,
            onPortHover: setHoveredPort,
            onPortClick,
          } satisfies ModuleBoxData,
        })),
      );
      requestAnimationFrame(() => flow?.fitView({ padding: 0.18, duration: 180 }));
    });
  }, [flow, highlightSignal, onPortClick, vm]);

  const nodeTypes = useMemo(() => ({ moduleBox: ModuleBoxView }), []);
  const edgeTypes = useMemo(() => ({ bundleEdge: BundleEdgeView, signalEdge: SignalEdgeView }), []);

  useEffect(() => {
    setRfNodes((current) =>
      current.map((node) => ({ ...node, data: { ...node.data, signal: highlightSignal } })),
    );
  }, [highlightSignal]);

  const rfEdges = useMemo(() => {
    if (!vm || !positions) return [];
    // 节点矩形（布局期快照）：锚定面选择 + 绕行障碍检测
    const rects = new Map<string, Rect>(
      vm.nodes.map((n) => {
        const pos = positions.get(n.id) ?? { x: 0, y: 0 };
        const { width, height } = nodeSize(n);
        return [n.id, { x: pos.x, y: pos.y, width, height }] as const;
      }),
    );
    // 同节点对多条边的序号：绕行通道错开
    const pairOrdinal = new Map<string, number>();
    return vm.edges.map((e) => {
      const srcRect = rects.get(e.source);
      const tgtRect = rects.get(e.target);
      // 锚定面按节点相对位置：左框右缘出线 → 右框左缘入线（水平流优先）
      const sides =
        srcRect && tgtRect ? anchorSides(srcRect, tgtRect) : { source: 'r' as Side, target: 'l' as Side, axis: 'h' as const };
      const pairKey = `${e.source}->${e.target}`;
      const ordinal = pairOrdinal.get(pairKey) ?? 0;
      pairOrdinal.set(pairKey, ordinal + 1);
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourcePort ? handleId(sides.source, e.sourcePort) : undefined,
        targetHandle: e.targetPort ? handleId(sides.target, e.targetPort) : undefined,
        type: e.kind === 'bundle' ? 'bundleEdge' : 'signalEdge',
        data: {
          label: e.label,
          signalCount: e.signalCount,
          signals: e.signals,
          width: e.width,
          highlighted: highlightedIds.has(e.id),
          expanded: e.kind === 'bundle' && expandedEdges.has(e.id),
          axis: sides.axis,
          ordinal,
          obstacles: [...rects.values()].filter((r) => r !== srcRect && r !== tgtRect),
          onToggle: () => toggleExpanded(e.id),
        } satisfies EdgeViewData,
      };
    });
  }, [vm, positions, highlightedIds, expandedEdges, toggleExpanded]);

  // ── 状态呈现 ──
  if (!loading && (!sg || sg.root === null)) {
    return <EmptyHint text={sg ? '未找到实例' : '框图数据加载失败'} />;
  }
  if (loading || !vm || !positions) {
    return <EmptyHint text="框图加载中..." testId="diagram-loading" />;
  }

  const segments = rootPath.split('.');
  const crumbs: { path: string; name: string }[] = segments.map((name, i) => ({
    name,
    path: segments.slice(0, i + 1).join('.'),
  }));

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-background/60">
      {/* ─── 工具条：面包屑 + 高亮信号 chip ─────────────── */}
      <div className="flex items-center gap-2 border-b border-border bg-card/70 px-3 py-2">
        <div data-testid="diagram-breadcrumb" className="flex min-w-0 flex-wrap items-center gap-0.5">
          {crumbs.map((c, i) => (
            <Fragment key={c.path}>
              {i > 0 && <ChevronRight className="size-3 shrink-0 text-muted-foreground" />}
              {c.path === rootPath ? (
                <span className="font-mono text-xs font-semibold text-foreground">{c.name}</span>
              ) : (
                <button
                  type="button"
                  data-path={c.path}
                  onClick={() => setRootPath(c.path)}
                  title={c.path}
                  className="font-mono text-xs text-muted-foreground transition-colors hover:text-primary hover:underline"
                >
                  {c.name}
                </button>
              )}
            </Fragment>
          ))}
        </div>
        {highlightSignal && (
          <div
            data-testid="diagram-highlight-chip"
            className="ml-auto flex items-center gap-1 rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] text-primary"
          >
            <span>{highlightSignal}</span>
            <button
              type="button"
              data-testid="diagram-highlight-clear"
              onClick={() => setHighlightSignal(null)}
              title="清除高亮"
              className="rounded-sm p-0.5 hover:bg-primary/25"
            >
              <X className="size-3" />
            </button>
          </div>
        )}
      </div>

      {/* ─── 无限画布（节点可拖拽，拓扑仍为只读） ───────── */}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-background">
        {vm.nodes.length <= 1 && (
          <div
            data-testid="diagram-empty"
            className="absolute right-2 top-2 z-10 rounded border border-border bg-card/95 px-2 py-1 text-[10px] text-muted-foreground"
          >
            该模块无子实例（leaf）
          </div>
        )}
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onInit={setFlow}
          onNodesChange={handleNodesChange}
          onNodeDoubleClick={handleNodeDoubleClick}
          nodesDraggable
          nodesConnectable={false}
          elementsSelectable
          edgesFocusable={false}
          edgesReconnectable={false}
          fitView
          minZoom={0.1}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          // isolate：wrapper 自成 stacking context，Background 点阵层
          //（z-index -1）垫在节点/边之下、底色之上，不被上层遮挡
          className="rtl-diagram-flow isolate"
        >
          <Background gap={22} size={1.5} color="var(--muted-foreground)" className="opacity-50" />
          <Controls
            showInteractive={false}
            position="bottom-left"
            className="!m-3 !overflow-hidden !rounded-md !border-border !bg-card !shadow-md [&>button]:!border-border [&>button]:!bg-card [&>button]:!text-muted-foreground [&>button:hover]:!bg-accent"
          />
          <MiniMap
            nodeColor="var(--primary)"
            maskColor="color-mix(in oklch, var(--background) 72%, transparent)"
            position="bottom-right"
            className="!m-3 !overflow-hidden !rounded-md !border-border !bg-card/90 !shadow-md"
          />
          <Panel position="bottom-left" className="!m-3 !ml-[118px]">
            <div className="flex items-center gap-0.5 rounded-md border border-border bg-card p-1 shadow-sm">
              <button
                type="button"
                data-testid="diagram-fit-view"
                title="适应视图"
                aria-label="适应视图"
                onClick={() => flow?.fitView({ padding: 0.18, duration: 180 })}
                className="grid size-7 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Maximize2 className="size-3.5" />
              </button>
              <button
                type="button"
                data-testid="diagram-auto-layout"
                title="自动布局"
                aria-label="自动布局"
                onClick={resetLayout}
                className="grid size-7 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <LayoutGrid className="size-3.5" />
              </button>
            </div>
          </Panel>
          {hoveredPort && (
            <div
              data-testid="diagram-port-tooltip"
              className="pointer-events-none absolute left-2 top-2 z-20 rounded border border-border bg-popover/95 px-2 py-1 font-mono text-[10px] text-popover-foreground shadow-md"
            >
              {hoveredPort.name} · {hoveredPort.direction} · [{hoveredPort.width - 1}:0]
            </div>
          )}
        </ReactFlow>
      </div>
    </div>
  );
}

function EmptyHint({ text, testId = 'diagram-empty' }: { text: string; testId?: string }) {
  return (
    <div data-testid={testId} className="flex min-h-0 flex-1 items-center justify-center p-8">
      <p className="text-xs text-muted-foreground">{text}</p>
    </div>
  );
}
