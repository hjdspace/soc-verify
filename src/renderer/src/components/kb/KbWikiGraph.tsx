/**
 * KbWikiGraph — 知识图谱视图（spec §9/§11，issue 26）。
 *
 * 输入只有 `kb.wikiGraph` 的主进程图快照（renderer 不重新扫盘建图）。
 * 布局在模块 worker 中运行；WebGL 不可用或 sigma 构造失败时降级为
 * 邻接列表，并把原因显示出来（错误状态可观察）。
 *
 * 生命周期：切库/重开图（kbId/revision 变化）与组件卸载都会终止 worker、
 * kill sigma 并显式丢弃 WebGL 上下文，反复切换不累积 GPU 资源。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Info, Loader2, Network, RefreshCw, X } from 'lucide-react';
import type Graph from 'graphology';
import { cn } from '@renderer/lib/utils';
import { useKbWikiGraphStore } from '@renderer/stores/kb-wiki-graph';
import {
  ALL_PAGE_TYPES,
  GRAPH_LABEL_DEGREE_THRESHOLD,
  TYPE_COLORS,
  TYPE_LABELS,
  bridgeNodePageIds,
  buildAdjacencyList,
  buildLegend,
  buildLayoutEdges,
  buildLayoutNodes,
  communityByPage,
  computeDegrees,
  describeGraphCoverage,
  filterGraph,
  graphDataKey,
  hasActiveFilter,
  layoutIterations,
  layoutScalingRatio,
  nodeColor,
  nodeSize,
  restrictEdgesToNodes,
  seedPositions,
  selectNodeBudget,
  type GraphFilter,
} from '@renderer/lib/kb-wiki-graph';
import { createModuleLayoutWorker, GraphLayoutClient } from '@renderer/lib/graph-layout-client';
import { createSigmaRenderer, currentShade, type SigmaRendererHandle } from '@renderer/lib/sigma-graph-renderer';
import { canUseGraphCanvas, detectWebGLSupport, releaseWebGLContexts, type WebGLSupport } from '@renderer/lib/webgl-support';
import type { WikiGraphViewEdge, WikiGraphViewNode, WikiPageType } from '@shared/kb-types';

const LAYOUT_DEBOUNCE_MS = 180;

export type KbWikiGraphProps = {
  /** 节点跳转：打开对应知识页（由父级切换到知识页区） */
  onOpenPage?: (pageId: string) => void;
};

export function KbWikiGraph({ onOpenPage }: KbWikiGraphProps = {}) {
  const load = useKbWikiGraphStore((s) => s.load);
  const runInsights = useKbWikiGraphStore((s) => s.runInsights);
  const reset = useKbWikiGraphStore((s) => s.reset);

  useEffect(() => {
    void load();
    void runInsights();
    return () => reset();
  }, [load, runInsights, reset]);

  const snapshot = useKbWikiGraphStore((s) => s.snapshot);
  const loading = useKbWikiGraphStore((s) => s.loading);
  const error = useKbWikiGraphStore((s) => s.error);

  if (loading && !snapshot) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground" data-testid="kb-graph-loading">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        正在读取知识图谱…
      </div>
    );
  }

  if (error && !snapshot) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center" data-testid="kb-graph-load-error">
        <AlertTriangle className="h-6 w-6 text-destructive" />
        <div className="text-xs text-destructive">{error}</div>
        <button
          onClick={() => void load()}
          className="mt-1 rounded border border-border px-3 py-1 text-xs transition-colors hover:bg-accent"
        >
          重试
        </button>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground" data-testid="kb-graph-empty">
        当前知识库还没有已发布的知识页
      </div>
    );
  }

  return <GraphWorkspace key={`${snapshot.kbId}:${snapshot.revision}`} onOpenPage={onOpenPage} />;
}

// ── 工作区（快照已就绪）──────────────────────────────────────────

function GraphWorkspace({ onOpenPage }: KbWikiGraphProps) {
  const snapshot = useKbWikiGraphStore((s) => s.snapshot);
  const filter = useKbWikiGraphStore((s) => s.filter);
  const colorMode = useKbWikiGraphStore((s) => s.colorMode);
  const nodeBudget = useKbWikiGraphStore((s) => s.nodeBudget);
  const selectedPageId = useKbWikiGraphStore((s) => s.selectedPageId);
  const communities = useKbWikiGraphStore((s) => s.communities);
  const findings = useKbWikiGraphStore((s) => s.findings);
  const insightsRunning = useKbWikiGraphStore((s) => s.insightsRunning);
  const insightsError = useKbWikiGraphStore((s) => s.insightsError);
  const layoutChannel = useKbWikiGraphStore((s) => s.layoutChannel);
  const layoutError = useKbWikiGraphStore((s) => s.layoutError);
  const firstFrameMs = useKbWikiGraphStore((s) => s.firstFrameMs);
  const manualLayoutCount = useKbWikiGraphStore((s) => s.manualLayoutCount);
  const layoutResetToken = useKbWikiGraphStore((s) => s.layoutResetToken);

  const setKeyword = useKbWikiGraphStore((s) => s.setKeyword);
  const toggleType = useKbWikiGraphStore((s) => s.toggleType);
  const clearFilter = useKbWikiGraphStore((s) => s.clearFilter);
  const setTypes = useKbWikiGraphStore((s) => s.setTypes);
  const setCommunityFilter = useKbWikiGraphStore((s) => s.setCommunityFilter);
  const setColorMode = useKbWikiGraphStore((s) => s.setColorMode);
  const selectNode = useKbWikiGraphStore((s) => s.selectNode);
  const expand = useKbWikiGraphStore((s) => s.expand);
  const collapse = useKbWikiGraphStore((s) => s.collapse);
  const setFirstFrameMs = useKbWikiGraphStore((s) => s.setFirstFrameMs);
  const setLayoutChannel = useKbWikiGraphStore((s) => s.setLayoutChannel);
  const noteManualLayout = useKbWikiGraphStore((s) => s.noteManualLayout);
  const resetLayout = useKbWikiGraphStore((s) => s.resetLayout);

  const [webgl, setWebgl] = useState<WebGLSupport | null>(null);
  const [forceList, setForceList] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [shade, setShade] = useState<'light' | 'dark'>(() => currentShade());

  useEffect(() => {
    setWebgl(detectWebGLSupport());
  }, []);

  // 主题明暗切换要重画画笔颜色（画布不用 CSS 变量）
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setShade(currentShade()));
    observer.observe(root, { attributes: true, attributeFilter: ['data-shade'] });
    setShade(currentShade());
    return () => observer.disconnect();
  }, []);

  // 快照存在时组件才会被挂载；useMemo 保住数组引用，避免下游 memo 每次渲染重算
  const nodes = useMemo(() => snapshot?.nodes ?? [], [snapshot]);
  const edges = useMemo(() => snapshot?.edges ?? [], [snapshot]);

  const communityMap = useMemo(() => communityByPage(communities), [communities]);
  const filtered = useMemo(
    () => filterGraph(nodes, edges, filter, communityMap),
    [nodes, edges, filter, communityMap],
  );
  const budget = useMemo(
    () => selectNodeBudget(filtered.nodes, filtered.edges, nodeBudget),
    [filtered, nodeBudget],
  );
  const visibleNodes = useMemo(
    () => filtered.nodes.filter((n) => budget.visible.has(n.pageId)),
    [filtered, budget],
  );
  const visibleEdges = useMemo(
    () => restrictEdgesToNodes(filtered.edges, budget.visible),
    [filtered, budget],
  );
  const hiddenIds = useMemo(() => {
    const hidden = new Set<string>();
    for (const node of nodes) {
      if (!budget.visible.has(node.pageId)) hidden.add(node.pageId);
    }
    return hidden;
  }, [nodes, budget]);
  const degrees = useMemo(() => computeDegrees(visibleNodes, visibleEdges), [visibleNodes, visibleEdges]);
  const bridges = useMemo(() => bridgeNodePageIds(findings), [findings]);
  const legend = useMemo(
    () => buildLegend(visibleNodes, colorMode, communityMap),
    [visibleNodes, colorMode, communityMap],
  );
  const selectedNeighbors = useMemo(() => {
    if (selectedPageId === null) return new Set<string>();
    const neighbors = new Set<string>();
    for (const edge of visibleEdges) {
      if (edge.source === selectedPageId) neighbors.add(edge.target);
      if (edge.target === selectedPageId) neighbors.add(edge.source);
    }
    return neighbors;
  }, [selectedPageId, visibleEdges]);
  const selectedNode = useMemo(
    () => (selectedPageId === null ? null : visibleNodes.find((n) => n.pageId === selectedPageId) ?? null),
    [selectedPageId, visibleNodes],
  );
  const adjacency = useMemo(() => buildAdjacencyList(filtered.nodes, filtered.edges), [filtered]);

  // 画布不可用的三条路径：用户主动切列表、环境无 WebGL、渲染器初始化/渲染失败
  const canvasUsable = webgl !== null && canUseGraphCanvas(webgl);
  const useList = forceList || !canvasUsable || renderError !== null;
  const listReason = forceList
    ? '已手动切换到列表视图'
    : webgl === 'none'
      ? '当前环境不可用 WebGL，已改用邻接列表'
      : renderError !== null
        ? `图渲染器初始化失败（${renderError}），已改用邻接列表`
        : null;

  const handleFirstFrame = useCallback(() => {
    // 从数据请求起算：tRPC + 建图 + 首帧都算进「首个可交互画面」
    const startedAt = useKbWikiGraphStore.getState().loadStartedAt;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    setFirstFrameMs(startedAt === null ? 0 : Math.max(0, now - startedAt));
  }, [setFirstFrameMs]);

  if (webgl === null) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        正在探测 WebGL 能力…
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="kb-wiki-graph">
      <GraphToolbar
        filter={filter}
        colorMode={colorMode}
        communities={communities}
        legendCounts={legend}
        webgl={webgl}
        useList={useList}
        insightsRunning={insightsRunning}
        firstFrameMs={firstFrameMs}
        onKeyword={setKeyword}
        onToggleType={toggleType}
        onClearTypes={() => setTypes(null)}
        onClearFilter={clearFilter}
        onCommunity={setCommunityFilter}
        onColorMode={setColorMode}
        onForceList={(value) => setForceList(value)}
        onRunInsights={() => void useKbWikiGraphStore.getState().runInsights()}
      />

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {useList ? (
            <AdjacencyListPanel
              entries={adjacency}
              reason={listReason}
              selectedPageId={selectedPageId}
              onSelect={selectNode}
            />
          ) : (
            <GraphCanvas
              kbId={snapshot?.kbId ?? ''}
              revision={snapshot?.revision ?? 0}
              nodes={nodes}
              edges={edges}
              visibleNodes={visibleNodes}
              visibleEdges={visibleEdges}
              hiddenIds={hiddenIds}
              neighbors={selectedNeighbors}
              bridges={bridges}
              selectedPageId={selectedPageId}
              colorMode={colorMode}
              communityMap={communityMap}
              shade={shade}
              onFirstFrame={handleFirstFrame}
              onSelect={selectNode}
              onLayoutChannel={setLayoutChannel}
              onRenderError={setRenderError}
              onManualLayout={noteManualLayout}
              resetToken={layoutResetToken}
            />
          )}
        </div>

        <NodeDetailPanel
          node={selectedNode}
          degree={selectedNode ? degrees.get(selectedNode.pageId)?.total ?? 0 : 0}
          isBridge={selectedNode ? bridges.has(selectedNode.pageId) : false}
          neighbors={[...selectedNeighbors]}
          nodesById={nodes}
          colorMode={colorMode}
          communityMap={communityMap}
          communityId={selectedNode ? communityMap.get(selectedNode.pageId) ?? null : null}
          onSelect={selectNode}
          onOpenPage={onOpenPage}
        />
      </div>

      <GraphStatusBar
        visible={visibleNodes.length}
        total={filtered.nodes.length}
        edges={visibleEdges.length}
        hidden={budget.hidden}
        brokenLinks={snapshot?.brokenLinks.length ?? 0}
        rebuilding={snapshot?.rebuilding ?? false}
        layoutChannel={layoutChannel}
        layoutError={layoutError}
        insightsError={insightsError}
        manualLayoutCount={manualLayoutCount}
        onExpand={expand}
        onCollapse={collapse}
        onResetLayout={resetLayout}
      />
    </div>
  );
}

// ── 工具栏 ──────────────────────────────────────────────────────

type GraphToolbarProps = {
  filter: GraphFilter;
  colorMode: 'type' | 'community';
  communities: ReadonlyArray<{ communityId: number; size: number }>;
  legendCounts: ReadonlyArray<{ key: string; count: number }>;
  webgl: WebGLSupport;
  useList: boolean;
  insightsRunning: boolean;
  firstFrameMs: number | null;
  onKeyword: (value: string) => void;
  onToggleType: (type: WikiPageType) => void;
  onClearTypes: () => void;
  onClearFilter: () => void;
  onCommunity: (communityId: number | null) => void;
  onColorMode: (mode: 'type' | 'community') => void;
  onForceList: (value: boolean) => void;
  onRunInsights: () => void;
};

function GraphToolbar(props: GraphToolbarProps) {
  const { filter, legendCounts } = props;
  const countOf = (key: string): number => legendCounts.find((l) => l.key === key)?.count ?? 0;

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5" data-testid="kb-graph-toolbar">
      <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
        关键词
        <input
          value={filter.keyword}
          onChange={(event) => props.onKeyword(event.target.value)}
          placeholder="标题 / pageId / 关键词"
          data-testid="kb-graph-keyword"
          className="w-40 rounded border border-border bg-transparent px-2 py-0.5 text-[11px] text-foreground outline-none focus:border-primary"
        />
      </label>

      <div className="flex items-center gap-1" data-testid="kb-graph-type-filters">
        {ALL_PAGE_TYPES.map((type) => {
          const active = filter.types === null || filter.types.includes(type);
          const count = countOf(type);
          return (
            <button
              key={type}
              onClick={() => props.onToggleType(type)}
              title={`${TYPE_LABELS[type]}（${count}）`}
              data-testid={`kb-graph-type-${type}`}
              data-active={active ? 'true' : 'false'}
              className={cn(
                'rounded border px-1.5 py-0.5 text-[10px] transition-colors',
                active ? 'border-transparent text-foreground' : 'border-border text-muted-foreground/50',
              )}
              style={active ? { backgroundColor: `${TYPE_COLORS[type]}33` } : undefined}
            >
              {TYPE_LABELS[type]}
              <span className="ml-1 opacity-60">{count}</span>
            </button>
          );
        })}
        {filter.types !== null && (
          <button
            onClick={props.onClearTypes}
            className="rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
          >
            全部
          </button>
        )}
      </div>

      <div className="flex items-center gap-1" data-testid="kb-graph-color-mode">
        <button
          onClick={() => props.onColorMode('type')}
          data-active={props.colorMode === 'type' ? 'true' : 'false'}
          className={cn(
            'rounded px-1.5 py-0.5 text-[10px]',
            props.colorMode === 'type' ? 'bg-primary/10 text-primary' : 'text-muted-foreground',
          )}
        >
          按类型
        </button>
        <button
          onClick={() => props.onColorMode('community')}
          data-active={props.colorMode === 'community' ? 'true' : 'false'}
          data-testid="kb-graph-color-community"
          className={cn(
            'rounded px-1.5 py-0.5 text-[10px]',
            props.colorMode === 'community' ? 'bg-primary/10 text-primary' : 'text-muted-foreground',
          )}
        >
          按社区
        </button>
      </div>

      <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
        社区
        <select
          value={filter.communityId === null ? '' : String(filter.communityId)}
          onChange={(event) => props.onCommunity(event.target.value === '' ? null : Number(event.target.value))}
          data-testid="kb-graph-community-filter"
          className="rounded border border-border bg-transparent px-1 py-0.5 text-[11px] text-foreground outline-none"
        >
          <option value="">全部</option>
          {props.communities.map((community) => (
            <option key={community.communityId} value={community.communityId}>
              社区 {community.communityId}（{community.size}）
            </option>
          ))}
        </select>
      </label>

      <div className="flex-1" />

      {hasActiveFilter(filter) && (
        <button
          onClick={props.onClearFilter}
          data-testid="kb-graph-clear-filter"
          className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          清除过滤
        </button>
      )}

      <span className="text-[10px] text-muted-foreground" data-testid="kb-graph-diagnostics">
        {props.useList ? '列表视图' : `WebGL(${props.webgl})`}
        {props.firstFrameMs !== null && ` · 首帧 ${Math.round(props.firstFrameMs)}ms`}
      </span>
      <button
        onClick={props.onRunInsights}
        disabled={props.insightsRunning}
        data-testid="kb-graph-run-insights"
        className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        {props.insightsRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        重跑洞察
      </button>
      <button
        onClick={() => props.onForceList(!props.useList)}
        data-testid="kb-graph-toggle-list"
        className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {props.useList ? '回到画布' : '改用列表'}
      </button>
    </div>
  );
}

// ── 画布（sigma + worker）───────────────────────────────────────

type GraphCanvasProps = {
  kbId: string;
  revision: number;
  nodes: ReadonlyArray<WikiGraphViewNode>;
  edges: ReadonlyArray<WikiGraphViewEdge>;
  visibleNodes: ReadonlyArray<WikiGraphViewNode>;
  visibleEdges: ReadonlyArray<WikiGraphViewEdge>;
  hiddenIds: ReadonlySet<string>;
  neighbors: ReadonlySet<string>;
  bridges: ReadonlySet<string>;
  selectedPageId: string | null;
  colorMode: 'type' | 'community';
  communityMap: ReadonlyMap<string, number>;
  shade: 'light' | 'dark';
  onFirstFrame: () => void;
  onSelect: (pageId: string | null) => void;
  onLayoutChannel: (channel: 'worker' | 'main-thread', error?: string | null) => void;
  onRenderError: (message: string) => void;
  /** 用户拖动节点后通知（状态栏显示手动布局提示） */
  onManualLayout: () => void;
  /** 递增即要求按自动布局重新摆放节点 */
  resetToken: number;
};

function GraphCanvas(props: GraphCanvasProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<SigmaRendererHandle | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const layoutClientRef = useRef<GraphLayoutClient | null>(null);
  const positionsRef = useRef(new Map<string, { x: number; y: number }>());
  const [structureReady, setStructureReady] = useState(false);
  const [structureError, setStructureError] = useState<string | null>(null);

  // 事件回调放进 ref：sigma 只在结构变化时创建一次，避免回调身份变化重建画布
  const handlers = useRef(props);
  useEffect(() => {
    handlers.current = props;
  });

  // ── 结构：每个 (kbId, revision) 只建一次图与渲染器 ──────────────
  useEffect(() => {
    let disposed = false;
    const host = hostRef.current;
    if (!host) return undefined;

    const positions = seedPositions(props.nodes.map((n) => n.pageId));
    positionsRef.current = positions;
    const client = new GraphLayoutClient({
      factory: createModuleLayoutWorker,
      onLayout: (outcome) => {
        if (disposed) return;
        handlers.current.onLayoutChannel(outcome.via, outcome.error ?? null);
        const applied = rendererRef.current?.applyPositions(outcome.positions) ?? 0;
        for (const position of outcome.positions) {
          positionsRef.current.set(position.id, { x: position.x, y: position.y });
        }
        if (applied === 0 && outcome.positions.length > 0) {
          // 结构已经换过（切库/重开图），迟到结果不再写入
          return;
        }
      },
      onError: (message) => {
        if (disposed) return;
        handlers.current.onLayoutChannel('main-thread', message);
      },
    });
    layoutClientRef.current = client;

    void (async () => {
      try {
        const { default: GraphClass } = await import('graphology');
        if (disposed) return;
        const graph = new GraphClass({ multi: false, type: 'directed' });
        const degrees = computeDegrees(props.nodes, props.edges);
        const maxDegree = Math.max(1, ...[...degrees.values()].map((d) => d.total));
        for (const node of props.nodes) {
          const position = positions.get(node.pageId) ?? { x: 0, y: 0 };
          graph.addNode(node.pageId, {
            x: position.x,
            y: position.y,
            size: nodeSize(degrees.get(node.pageId)?.total ?? 0, maxDegree),
            color: nodeColor(node, props.colorMode, props.communityMap),
            label: node.title || node.pageId,
            degree: degrees.get(node.pageId)?.total ?? 0,
            pageId: node.pageId,
            nodeType: node.type,
          });
        }
        for (const edge of props.edges) {
          if (edge.source === edge.target) continue;
          if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue;
          const key = `${edge.source}->${edge.target}`;
          if (graph.hasEdge(key)) continue;
          graph.addEdgeWithKey(key, edge.source, edge.target);
        }
        graphRef.current = graph;

        const renderer = await createSigmaRenderer({
          container: host,
          graph,
          shade: props.shade,
          labelDegreeThreshold: GRAPH_LABEL_DEGREE_THRESHOLD,
          onNodeClick: (pageId) => handlers.current.onSelect(pageId),
          onStageClick: () => handlers.current.onSelect(null),
          onNodeDragEnd: (pageId, position) => {
            positionsRef.current.set(pageId, position);
            // 拖拽是用户显式调整：状态栏暴露「已手动调整」，可一键回到自动布局
            handlers.current.onManualLayout();
          },
          onFirstFrame: () => handlers.current.onFirstFrame(),
          onRuntimeError: (message) => handlers.current.onRenderError(message),
        });
        if (disposed) {
          renderer.kill();
          return;
        }
        rendererRef.current = renderer;
        setStructureReady(true);
      } catch (err) {
        if (disposed) return;
        const message = err instanceof Error ? err.message : String(err);
        setStructureError(message);
        handlers.current.onRenderError(message);
      }
    })();

    return () => {
      disposed = true;
      setStructureReady(false);
      // 卸载/切库：先停 worker，再 kill 画布并丢弃 WebGL 上下文
      client.terminate();
      layoutClientRef.current = null;
      rendererRef.current?.kill();
      rendererRef.current = null;
      graphRef.current = null;
      releaseWebGLContexts(host);
    };
    // 结构只由 kbId/revision 决定；过滤/高亮通过 reducer 生效，不重建画布
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.kbId, props.revision]);

  // ── 高亮与隐藏（不重建画布） ───────────────────────────────────
  useEffect(() => {
    rendererRef.current?.setHighlight({
      selected: props.selectedPageId,
      neighbors: props.neighbors,
      hidden: props.hiddenIds,
      bridges: props.bridges,
    });
  }, [props.selectedPageId, props.neighbors, props.hiddenIds, props.bridges, structureReady]);

  // ── 着色模式变化：改属性后重绘 ─────────────────────────────────
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    for (const node of props.nodes) {
      if (!graph.hasNode(node.pageId)) continue;
      graph.setNodeAttribute(node.pageId, 'color', nodeColor(node, props.colorMode, props.communityMap));
    }
    rendererRef.current?.refresh();
  }, [props.colorMode, props.communityMap, props.nodes, structureReady]);

  // ── 布局请求（按可见集去抖） ───────────────────────────────────
  const layoutKey = graphDataKey(props.kbId, props.revision, props.visibleNodes, props.visibleEdges);
  useEffect(() => {
    if (!structureReady) return undefined;
    const timer = setTimeout(() => {
      const client = layoutClientRef.current;
      if (!client) return;
      client.request({
        key: layoutKey,
        nodes: buildLayoutNodes(props.visibleNodes, positionsRef.current),
        edges: buildLayoutEdges(props.visibleEdges),
        iterations: layoutIterations(props.visibleNodes.length),
        scalingRatio: layoutScalingRatio(props.visibleNodes.length),
      });
    }, LAYOUT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey, structureReady]);

  // ── 尺寸变化 ───────────────────────────────────────────────────
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => rendererRef.current?.resize());
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  /** 节点跳转：相机聚焦该节点（选择与详情由父级负责） */
  const focusSelected = useCallback((pageId: string) => {
    rendererRef.current?.focusNode(pageId);
  }, []);
  useEffect(() => {
    if (!structureReady || props.selectedPageId === null) return;
    focusSelected(props.selectedPageId);
  }, [props.selectedPageId, structureReady, focusSelected]);

  // ── 重置布局：回到确定性初始坐标，再交给 worker 收敛 ────────────
  const resetToken = props.resetToken;
  const nodesForReset = props.nodes;
  useEffect(() => {
    if (!structureReady || resetToken === 0) return;
    const positions = seedPositions(nodesForReset.map((n) => n.pageId));
    positionsRef.current = positions;
    rendererRef.current?.applyPositions(
      [...positions.entries()].map(([id, position]) => ({ id, x: position.x, y: position.y })),
    );
  }, [resetToken, structureReady, nodesForReset]);

  return (
    <>
      <div ref={hostRef} className="absolute inset-0" data-testid="kb-graph-canvas" />
      {structureError !== null && (
        <div className="absolute bottom-2 left-2 rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[10px] text-destructive">
          图渲染失败：{structureError}
        </div>
      )}
    </>
  );
}

// ── 邻接列表（WebGL 不可用 / 手动降级）──────────────────────────

type AdjacencyListPanelProps = {
  entries: ReturnType<typeof buildAdjacencyList>;
  reason: string | null;
  selectedPageId: string | null;
  onSelect: (pageId: string | null) => void;
};

function AdjacencyListPanel({ entries, reason, selectedPageId, onSelect }: AdjacencyListPanelProps) {
  return (
    <div className="flex h-full flex-col" data-testid="kb-graph-adjacency">
      {reason !== null && (
        <div
          className="flex items-center gap-1.5 border-b border-border bg-secondary/50 px-3 py-1 text-[11px] text-muted-foreground"
          data-testid="kb-graph-webgl-notice"
        >
          <Info className="h-3 w-3" />
          {reason}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        <table className="w-full border-collapse text-[11px]">
          <thead className="sticky top-0 bg-background">
            <tr className="text-left text-muted-foreground">
              <th className="py-1 pr-3 font-medium">页面</th>
              <th className="py-1 pr-3 font-medium">度数</th>
              <th className="py-1 pr-3 font-medium">出链（引用）</th>
              <th className="py-1 font-medium">入链（被引用）</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr
                key={entry.pageId}
                data-testid={`kb-graph-adjacency-row-${entry.pageId}`}
                className={cn(
                  'border-t border-border/60 align-top',
                  selectedPageId === entry.pageId && 'bg-primary/10',
                )}
              >
                <td className="py-1 pr-3">
                  <button
                    onClick={() => onSelect(entry.pageId)}
                    className="text-left text-foreground hover:text-primary"
                    title={entry.pageId}
                  >
                    {entry.title || entry.pageId}
                  </button>
                  <div className="text-[10px] text-muted-foreground">{TYPE_LABELS[entry.type] ?? entry.type}</div>
                </td>
                <td className="py-1 pr-3 text-muted-foreground">{entry.degree}</td>
                <td className="py-1 pr-3">
                  <NeighborList neighbors={entry.out} onSelect={onSelect} />
                </td>
                <td className="py-1">
                  <NeighborList neighbors={entry.in} onSelect={onSelect} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {entries.length === 0 && (
          <div className="py-6 text-center text-xs text-muted-foreground">没有匹配的页面</div>
        )}
      </div>
    </div>
  );
}

function NeighborList({
  neighbors,
  onSelect,
}: {
  neighbors: ReadonlyArray<{ pageId: string; title: string }>;
  onSelect: (pageId: string | null) => void;
}) {
  if (neighbors.length === 0) return <span className="text-muted-foreground/60">—</span>;
  return (
    <span className="flex flex-wrap gap-x-2 gap-y-0.5">
      {neighbors.map((neighbor) => (
        <button
          key={neighbor.pageId}
          onClick={() => onSelect(neighbor.pageId)}
          className="text-muted-foreground hover:text-primary"
          title={neighbor.pageId}
        >
          {neighbor.title || neighbor.pageId}
        </button>
      ))}
    </span>
  );
}

// ── 节点详情 ────────────────────────────────────────────────────

type NodeDetailPanelProps = {
  node: WikiGraphViewNode | null;
  degree: number;
  isBridge: boolean;
  neighbors: string[];
  nodesById: ReadonlyArray<WikiGraphViewNode>;
  colorMode: 'type' | 'community';
  communityMap: ReadonlyMap<string, number>;
  communityId: number | null;
  onSelect: (pageId: string | null) => void;
  onOpenPage?: ((pageId: string) => void) | undefined;
};

function NodeDetailPanel(props: NodeDetailPanelProps) {
  if (!props.node) {
    return (
      <aside className="flex w-56 shrink-0 items-center justify-center border-l border-border px-3 text-center text-[11px] text-muted-foreground" data-testid="kb-graph-detail-empty">
        选择节点查看邻接与线索
      </aside>
    );
  }

  const node = props.node;
  const color = nodeColor(node, props.colorMode, props.communityMap);

  return (
    <aside className="flex w-56 shrink-0 flex-col overflow-auto border-l border-border" data-testid="kb-graph-detail">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="flex items-center gap-1 text-[11px] font-medium">
          <Network className="h-3 w-3" />
          节点
        </span>
        <button
          onClick={() => props.onSelect(null)}
          className="rounded p-0.5 text-muted-foreground hover:text-foreground"
          data-testid="kb-graph-detail-close"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="flex-1 space-y-2 px-3 py-2 text-[11px]">
        <div>
          <div className="font-medium text-foreground" data-testid="kb-graph-detail-title">
            {node.title || node.pageId}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
            {TYPE_LABELS[node.type] ?? node.type}
            <span>· 度数 {props.degree}</span>
            {props.communityId !== null && <span>· 社区 {props.communityId}</span>}
          </div>
          <div className="mt-0.5 break-all text-[10px] text-muted-foreground">{node.pageId}</div>
        </div>

        {props.isBridge && (
          <div
            className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-500"
            data-testid="kb-graph-detail-bridge-hint"
          >
            启发式建议：此页面连接多个社区，可能是知识网络的健康枢纽。桥接节点可为健康枢纽，此项为启发式建议，不阻断发布。
          </div>
        )}

        <div>
          <div className="mb-0.5 text-[10px] font-medium text-muted-foreground">一跳邻居（{props.neighbors.length}）</div>
          <div className="flex flex-wrap gap-x-2 gap-y-0.5">
            {props.neighbors.length === 0 && <span className="text-muted-foreground/60">无有效链接</span>}
            {props.neighbors.map((pageId) => {
              const neighbor = props.nodesById.find((n) => n.pageId === pageId);
              return (
                <button
                  key={pageId}
                  onClick={() => props.onSelect(pageId)}
                  className="text-muted-foreground hover:text-primary"
                  title={pageId}
                >
                  {neighbor?.title || pageId}
                </button>
              );
            })}
          </div>
        </div>

        <button
          onClick={() => props.onOpenPage?.(node.pageId)}
          data-testid="kb-graph-detail-open-page"
          className="w-full rounded border border-border px-2 py-1 text-[11px] transition-colors hover:bg-accent"
        >
          打开知识页
        </button>
      </div>
    </aside>
  );
}

// ── 状态栏 ──────────────────────────────────────────────────────

type GraphStatusBarProps = {
  visible: number;
  total: number;
  edges: number;
  hidden: number;
  brokenLinks: number;
  rebuilding: boolean;
  layoutChannel: 'worker' | 'main-thread' | null;
  layoutError: string | null;
  insightsError: string | null;
  manualLayoutCount: number;
  onExpand: () => void;
  onCollapse: () => void;
  onResetLayout: () => void;
};

function GraphStatusBar(props: GraphStatusBarProps) {
  return (
    <div
      className="flex flex-wrap items-center gap-3 border-t border-border px-3 py-1 text-[10px] text-muted-foreground"
      data-testid="kb-graph-status"
    >
      <span data-testid="kb-graph-coverage">
        {describeGraphCoverage(props.visible, props.total, props.edges, props.hidden)}
      </span>
      {props.layoutChannel !== null && (
        <span data-testid="kb-graph-layout-channel">
          布局：{props.layoutChannel === 'worker' ? 'worker' : '主线程回退'}
        </span>
      )}
      {props.brokenLinks > 0 && <span data-testid="kb-graph-broken">断链/歧义 {props.brokenLinks}</span>}
      {props.rebuilding && (
        <span className="text-amber-500" data-testid="kb-graph-rebuilding">
          图落后于当前发布 revision，正在重建
        </span>
      )}
      <div className="flex-1" />
      {props.manualLayoutCount > 0 && (
        <span className="flex items-center gap-1.5" data-testid="kb-graph-manual-layout">
          已手动调整 {props.manualLayoutCount} 个节点
          <button
            onClick={props.onResetLayout}
            data-testid="kb-graph-reset-layout"
            className="rounded border border-border px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
          >
            回到自动布局
          </button>
        </span>
      )}
      {props.hidden > 0 && (
        <button
          onClick={props.onExpand}
          data-testid="kb-graph-expand"
          className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
        >
          <ChevronDown className="h-3 w-3" />
          展开更多（剩余 {props.hidden}）
        </button>
      )}
      {props.hidden === 0 && props.total > 0 && (
        <button
          onClick={props.onCollapse}
          data-testid="kb-graph-collapse"
          className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
        >
          <ChevronUp className="h-3 w-3" />
          收起到大图预算
        </button>
      )}
      {props.layoutError !== null && (
        <span className="text-amber-500" data-testid="kb-graph-layout-error">
          {props.layoutError}
        </span>
      )}
      {props.insightsError !== null && (
        <span className="text-amber-500" data-testid="kb-graph-insights-error">
          社区分析：{props.insightsError}
        </span>
      )}
    </div>
  );
}
