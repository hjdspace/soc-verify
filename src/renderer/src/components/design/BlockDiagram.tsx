/**
 * 可下钻框图（issue 05：React Flow + elkjs）。
 *
 * - box = 图根 + 直接子实例（端口按方向分列 box 两缘，Handle 按
 *   端口名锚定细边）；粗边 = Protocol Bundle（收拢为协议标签 +
 *   ×计数，可展开信号明细）；细边 = 未入束 net（RTL 原名）
 * - elkjs 自动分层布局（block-diagram-layout），节点可在画布中拖拽整理
 * - 双击实例下钻以它为图根 + 面包屑回退；hover 端口看信号名/方向/位宽；
 *   点击信号高亮同名连线（edgesForSignal）
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
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
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ChevronRight, X } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';
import {
  buildDiagramViewModel,
  edgesForSignal,
  type DiagramSignal,
} from './block-diagram-model';
import { layoutDiagram } from './block-diagram-layout';
import type { DesignSubgraphRow, SubgraphPortRow } from '@main/rtl/types';

const NODE_WIDTH = 220;
const PORT_ROW_H = 16;
const HEADER_H = 30;

function nodeSize(n: { portsIn: unknown[]; portsOut: unknown[] }): { width: number; height: number } {
  const rows = Math.max(n.portsIn.length, n.portsOut.length, 1);
  return { width: NODE_WIDTH, height: HEADER_H + rows * PORT_ROW_H + 8 };
}

// ─── 节点视图：box + 端口两列 ────────────────────────────────

type ModuleBoxData = {
  name: string;
  module: string;
  isRoot: boolean;
  portsIn: SubgraphPortRow[];
  portsOut: SubgraphPortRow[];
  /** 当前高亮信号（同名端口行标记） */
  signal: string | null;
  onPortHover: (port: SubgraphPortRow | null) => void;
  onPortClick: (signal: string) => void;
};

function ModuleBoxView({ data, selected }: NodeProps) {
  const d = (data ?? {}) as ModuleBoxData;
  return (
    <div
      className={cn(
        'overflow-hidden rounded-md border bg-card shadow-sm transition-shadow',
        d.isRoot ? 'border-primary/60' : 'border-border',
        selected && 'ring-2 ring-primary/50',
      )}
      style={{ width: NODE_WIDTH }}
    >
      <div className="flex items-baseline justify-between gap-2 border-b border-border px-2 py-1">
        <span className="truncate font-mono text-[11px] font-semibold text-foreground">{d.name}</span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{d.module}</span>
      </div>
      <div className="flex justify-between gap-2 px-1 py-1">
        <div className="min-w-0">
          {d.portsIn.map((p) => (
            <PortRow key={p.name} port={p} d={d} side="left" />
          ))}
        </div>
        <div className="min-w-0 text-right">
          {d.portsOut.map((p) => (
            <PortRow key={p.name} port={p} d={d} side="right" />
          ))}
        </div>
      </div>
    </div>
  );
}

function PortRow({ port, d, side }: { port: SubgraphPortRow; d: ModuleBoxData; side: 'left' | 'right' }) {
  const matched = d.signal === port.name;
  const pos = side === 'left' ? Position.Left : Position.Right;
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
        'nodrag relative flex w-[100px] cursor-pointer items-center rounded px-1 font-mono text-[10px] leading-4 text-foreground/90 hover:bg-accent',
        matched && 'bg-primary/20 text-primary',
      )}
    >
      {/* 同一端口同时挂 source/target handle：同向端口对（如两 input 共网）的
          source 端也能锚定在该端口行，避免 React Flow 找不到 handle 丢边 */}
      <Handle type="target" position={pos} id={port.name} isConnectable={false} />
      <Handle type="source" position={pos} id={port.name} isConnectable={false} />
      <span className="truncate">{port.name}</span>
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
  onToggle: () => void;
};

function BundleEdgeView(props: EdgeProps) {
  const d = (props.data ?? {}) as EdgeViewData;
  const [path, labelX, labelY] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    targetX: props.targetX,
    targetY: props.targetY,
  });
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        style={{
          strokeWidth: d.highlighted ? 6 : 4,
          stroke: d.highlighted ? 'var(--color-primary, #2563eb)' : 'var(--color-border, #94a3b8)',
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
            'nodrag nopan relative z-20 flex flex-col items-start gap-0.5 rounded-md border border-border bg-card/95 px-1.5 py-1 text-[10px] shadow-md',
            d.highlighted && 'border-primary/60',
          )}
        >
          <div className="flex items-center gap-1">
            <button
              type="button"
              data-testid="diagram-bundle-toggle"
              onClick={d.onToggle}
              title={d.expanded ? '收拢协议信号' : '展开协议信号'}
              className="flex size-3.5 items-center justify-center rounded-sm border border-border text-[9px] leading-none text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {d.expanded ? '−' : '+'}
            </button>
            <span className="font-semibold text-foreground">
              {d.label}
              {d.signalCount > 1 ? ` ×${d.signalCount}` : ''}
            </span>
          </div>
          {d.expanded && (
            <div className="max-h-40 overflow-y-auto rounded bg-background/70 p-1 font-mono text-[9px] leading-4 text-muted-foreground">
              {d.signals.map((s, i) => (
                <div key={`${s.net ?? ''}-${i}`} data-testid="diagram-bundle-signal">
                  {s.fromPort} → {s.toPort}
                  {s.width > 1 ? ` [${s.width - 1}:0]` : ''}
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
  const [path, labelX, labelY] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    targetX: props.targetX,
    targetY: props.targetY,
  });
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        style={{
          strokeWidth: d.highlighted ? 3 : 1.5,
          stroke: d.highlighted ? 'var(--color-primary, #2563eb)' : 'var(--color-border, #94a3b8)',
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
            'nodrag nopan relative z-20 rounded px-1 font-mono text-[9px] text-muted-foreground',
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

  useEffect(() => {
    if (!vm) return;
    let alive = true;
    void layoutDiagram(
      vm.nodes.map((n) => ({ id: n.id, ...nodeSize(n) })),
      vm.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    ).then((pos) => {
      if (alive) setPositions(pos);
    });
    return () => {
      alive = false;
    };
  }, [vm]);

  const highlightedIds = useMemo(
    () => (vm && highlightSignal ? new Set(edgesForSignal(vm, highlightSignal)) : new Set<string>()),
    [vm, highlightSignal],
  );

  const onPortClick = useCallback((signal: string) => {
    setHighlightSignal((prev) => (prev === signal ? null : signal));
  }, []);

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
    setPositions((current) => {
      if (!current) return current;
      const next = new Map(current);
      let changed = false;
      for (const change of changes) {
        if (change.type !== 'position' || !change.position) continue;
        next.set(change.id, change.position);
        changed = true;
      }
      return changed ? next : current;
    });
  }, []);

  const resetLayout = useCallback(() => {
    if (!vm) return;
    void layoutDiagram(
      vm.nodes.map((n) => ({ id: n.id, ...nodeSize(n) })),
      vm.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    ).then((next) => {
      setPositions(next);
      requestAnimationFrame(() => flow?.fitView({ padding: 0.18, duration: 180 }));
    });
  }, [flow, vm]);

  const nodeTypes = useMemo(() => ({ moduleBox: ModuleBoxView }), []);
  const edgeTypes = useMemo(() => ({ bundleEdge: BundleEdgeView, signalEdge: SignalEdgeView }), []);

  const rfNodes = useMemo(() => {
    if (!vm || !positions) return [];
    return vm.nodes.map((n) => ({
      id: n.id,
      type: 'moduleBox',
      position: positions.get(n.id) ?? { x: 0, y: 0 },
      draggable: true,
      data: {
        name: n.name,
        module: n.module,
        isRoot: n.isRoot,
        portsIn: n.portsIn,
        portsOut: n.portsOut,
        signal: highlightSignal,
        onPortHover: setHoveredPort,
        onPortClick,
      } satisfies ModuleBoxData,
    }));
  }, [vm, positions, highlightSignal, onPortClick]);

  const rfEdges = useMemo(() => {
    if (!vm) return [];
    return vm.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourcePort,
      targetHandle: e.targetPort,
      type: e.kind === 'bundle' ? 'bundleEdge' : 'signalEdge',
      data: {
        label: e.label,
        signalCount: e.signalCount,
        signals: e.signals,
        width: e.width,
        highlighted: highlightedIds.has(e.id),
        expanded: e.kind === 'bundle' && expandedEdges.has(e.id),
        onToggle: () => toggleExpanded(e.id),
      } satisfies EdgeViewData,
    }));
  }, [vm, highlightedIds, expandedEdges, toggleExpanded]);

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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {/* ─── 工具条：面包屑 + 高亮信号 chip ─────────────── */}
      <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
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
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-background">
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
          elementsSelectable={false}
          edgesFocusable={false}
          edgesReconnectable={false}
          fitView
          minZoom={0.1}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          className="bg-background"
        >
          <Background gap={22} size={1} color="var(--border)" className="opacity-60" />
          <Controls
            showInteractive={false}
            position="bottom-left"
            className="!m-2 !border-border !bg-card !shadow-sm [&>button]:!border-border [&>button]:!bg-card [&>button]:!text-muted-foreground"
          />
          <MiniMap
            nodeColor="var(--primary)"
            maskColor="color-mix(in oklch, var(--background) 72%, transparent)"
            position="bottom-right"
            className="!m-2 !border-border !bg-card/90 !shadow-sm"
          />
          <Panel position="top-right" className="!m-2">
            <div className="flex items-center gap-1 rounded-md border border-border bg-card/95 p-1 shadow-sm">
              <button
                type="button"
                data-testid="diagram-fit-view"
                title="适应视图"
                aria-label="适应视图"
                onClick={() => flow?.fitView({ padding: 0.18, duration: 180 })}
                className="rounded px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                适应视图
              </button>
              <button
                type="button"
                data-testid="diagram-auto-layout"
                title="自动布局"
                aria-label="自动布局"
                onClick={resetLayout}
                className="rounded px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                自动布局
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
