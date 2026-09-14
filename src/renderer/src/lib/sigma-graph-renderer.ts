/**
 * sigma-graph-renderer — sigma 画布的薄封装（spec §9/§11，issue 26）。
 *
 * 只做三件事：把 graphology 图交给 sigma、把交互事件翻译成业务回调、
 * 在卸载时把 WebGL 资源还回去。业务状态（过滤/预算/选中）通过 reducer
 * 读取的可变引用注入，因此高亮与过滤不需要重建画布。
 *
 * 模块用动态 import 加载 sigma 与 graphology：图视图是可选视图，
 * 不应把 ~1MB 的渲染器塞进首屏 chunk（项目关注启动时间）。
 */

import type Graph from 'graphology';
import type Sigma from 'sigma';
import type { NodeHoverDrawingFunction } from 'sigma/rendering';
import { releaseWebGLContexts } from './webgl-support';

export type RenderHighlight = {
  /** 当前选中节点（null = 无选中） */
  selected: string | null;
  /** 选中节点的一跳邻居（画面上保留强调） */
  neighbors: ReadonlySet<string>;
  /** 被预算/过滤排除的节点（reducer 直接隐藏） */
  hidden: ReadonlySet<string>;
  /** 桥接节点（图洞察命中）：用告警色 + highlighted 强调；含义由详情面板文案说明 */
  bridges: ReadonlySet<string>;
};

export type SigmaRendererOptions = {
  container: HTMLElement;
  graph: Graph;
  /** 深色主题下的画布调色板（画布不能用 CSS 变量，需具体色值） */
  shade: 'light' | 'dark';
  /** 标签显示阈值：度数低于该值且未被选中/悬停时不显示标签 */
  labelDegreeThreshold: number;
  onNodeClick: (pageId: string) => void;
  onStageClick: () => void;
  onNodeDragEnd: (pageId: string, position: { x: number; y: number }) => void;
  onFirstFrame?: (elapsedMs: number) => void;
  /**
   * 渲染期运行时错误（sigma 在 rAF 中抛错）。
   *
   * 画布出错不能只把异常抛回 React：那会把整个视图卸载成空白。
   * 组件收到后切到邻接列表，让「渲染失败」成为可观察且有替代路径的状态。
   */
  onRuntimeError?: (message: string) => void;
};

export type SigmaRendererHandle = {
  /** 数据或属性变化后重绘 */
  refresh(): void;
  /** 容器尺寸变化后重算 */
  resize(): void;
  /** 批量写入布局结果（worker 回传） */
  applyPositions(positions: ReadonlyArray<{ id: string; x: number; y: number }>): number;
  /** 高亮状态变更（不重建画布） */
  setHighlight(highlight: RenderHighlight): void;
  /** 把相机移到指定节点（节点跳转） */
  focusNode(pageId: string): boolean;
  /** 释放画布、监听与 WebGL 上下文；幂等 */
  kill(): void;
};

type Palette = {
  label: string;
  edge: string;
  edgeActive: string;
  nodeMuted: string;
  hoverBackground: string;
  hoverBorder: string;
};

const PALETTES: Record<'light' | 'dark', Palette> = {
  dark: {
    label: '#e2e8f0',
    edge: 'rgba(100,116,139,0.28)',
    edgeActive: '#38bdf8',
    nodeMuted: '#334155',
    hoverBackground: 'rgba(15,23,42,0.94)',
    hoverBorder: 'rgba(148,163,184,0.38)',
  },
  light: {
    label: '#1e293b',
    edge: 'rgba(100,116,139,0.35)',
    edgeActive: '#0284c7',
    nodeMuted: '#cbd5e1',
    hoverBackground: 'rgba(255,255,255,0.97)',
    hoverBorder: 'rgba(15,23,42,0.14)',
  },
};

const BRIDGE_RING_COLOR = '#f59e0b';

function createHoverRenderer(palette: Palette): NodeHoverDrawingFunction {
  return (context, data, settings) => {
    const label = typeof data.label === 'string' ? data.label : '';
    if (!label) return;
    const fontSize = settings.labelSize;
    const nodeRadius = Math.max(data.size, fontSize / 2) + 3;

    context.save();
    context.fillStyle = palette.hoverBackground;
    context.strokeStyle = palette.hoverBorder;
    context.lineWidth = 1;
    context.beginPath();
    context.arc(data.x, data.y, nodeRadius, 0, Math.PI * 2);
    context.closePath();
    context.fill();
    context.stroke();

    context.font = `${settings.labelWeight} ${fontSize}px ${settings.labelFont}`;
    const paddingX = 8;
    const paddingY = 4;
    const textWidth = context.measureText(label).width;
    const boxWidth = Math.ceil(textWidth + paddingX * 2);
    const boxHeight = Math.ceil(fontSize + paddingY * 2);
    const boxX = data.x + nodeRadius + 6;
    const boxY = data.y - boxHeight / 2;

    context.beginPath();
    context.rect(boxX, boxY, boxWidth, boxHeight);
    context.fill();
    context.stroke();
    context.fillStyle = palette.label;
    context.fillText(label, boxX + paddingX, data.y + fontSize / 3);
    context.restore();
  };
}

/** 读取当前明暗档位（主题系统写 documentElement.dataset.shade）。 */
export function currentShade(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.dataset.shade === 'light' ? 'light' : 'dark';
}

/**
 * 创建 sigma 渲染器。失败（构造抛错）时抛出，由组件捕获后切到邻接列表。
 */
export async function createSigmaRenderer(
  options: SigmaRendererOptions,
): Promise<SigmaRendererHandle> {
  const [{ default: SigmaClass }, { default: GraphClass }] = await Promise.all([
    import('sigma'),
    import('graphology'),
  ]);

  const palette = PALETTES[options.shade];
  // graph 由调用方创建（布局客户端的降级路径也在用）；这里只做类型确认
  if (!(options.graph instanceof GraphClass)) {
    throw new Error('图实例类型不匹配（graphology 版本不一致）');
  }
  const graph = options.graph;

  const highlight: RenderHighlight = {
    selected: null,
    neighbors: new Set<string>(),
    hidden: new Set<string>(),
    bridges: new Set<string>(),
  };

  let killed = false;
  let firstFrameReported = false;
  let runtimeErrorReported = false;
  const startAt = typeof performance !== 'undefined' ? performance.now() : Date.now();

  /** sigma 的渲染是同步的，任何一步抛错都在这里收敛成可观察状态 */
  const guard = <T>(run: () => T, fallback: T): T => {
    try {
      return run();
    } catch (error) {
      if (!runtimeErrorReported) {
        runtimeErrorReported = true;
        options.onRuntimeError?.(error instanceof Error ? error.message : String(error));
      }
      return fallback;
    }
  };

  const sigma: Sigma = new SigmaClass(graph, options.container, {
    allowInvalidContainer: true,
    renderLabels: true,
    renderEdgeLabels: false,
    hideEdgesOnMove: true,
    hideLabelsOnMove: true,
    labelColor: { color: palette.label },
    labelSize: 12,
    labelWeight: '500',
    labelRenderedSizeThreshold: 0,
    minEdgeThickness: 0.5,
    defaultEdgeColor: palette.edge,
    defaultDrawNodeHover: createHoverRenderer(palette),
    nodeReducer: (node, data) => {
      const result = { ...data };
      const degree = typeof graph.getNodeAttribute(node, 'degree') === 'number'
        ? (graph.getNodeAttribute(node, 'degree') as number)
        : 0;
      const isSelected = highlight.selected === node;
      const isNeighbor = highlight.neighbors.has(node);

      if (highlight.hidden.has(node)) {
        result.hidden = true;
        return result;
      }
      if (highlight.selected !== null && !isSelected && !isNeighbor) {
        result.color = palette.nodeMuted;
      }
      if (highlight.bridges.has(node)) {
        // 只改颜色与高亮标记：sigma 默认只注册 circle/point 节点程序，
        // 换成未注册的 type 会在渲染时抛错（冒烟实测）
        result.color = BRIDGE_RING_COLOR;
        result.highlighted = true;
      }
      if (isSelected) {
        result.highlighted = true;
        result.zIndex = 3;
      } else if (isNeighbor) {
        result.zIndex = 2;
      }
      const showLabel = isSelected || isNeighbor
        || degree >= options.labelDegreeThreshold
        || highlight.bridges.has(node);
      if (!showLabel) result.label = '';
      return result;
    },
    edgeReducer: (_edge, data) => {
      const result = { ...data };
      const source = graph.source(_edge);
      const target = graph.target(_edge);
      if (highlight.hidden.has(source) || highlight.hidden.has(target)) {
        result.hidden = true;
        return result;
      }
      if (highlight.selected !== null
        && (source === highlight.selected || target === highlight.selected)) {
        result.color = palette.edgeActive;
        result.size = 1.6;
      }
      return result;
    },
  });

  // ── 首帧可交互信号（门禁测的是这个，不是组件挂载） ──────────────
  if (options.onFirstFrame) {
    sigma.on('afterRender', () => {
      if (firstFrameReported) return;
      firstFrameReported = true;
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      options.onFirstFrame?.(now - startAt);
    });
  }

  // ── 节点拖拽 ───────────────────────────────────────────────────
  //
  // 监听器挂 capture 阶段：sigma 的鼠标 captor 在拖拽期间会阻止
  // mousemove 继续冒泡（实测 mousemove 到不了 window 的 bubble 监听），
  // 只有 capture 才能稳定拿到拖拽中的移动事件。
  let dragging: string | null = null;
  let dragStart: { x: number; y: number } | null = null;
  let dragMoved = false;
  const LISTENER_OPTIONS: AddEventListenerOptions = { capture: true };
  /** 判定为拖拽而非点选的最小位移（视口像素） */
  const DRAG_THRESHOLD_PX = 3;

  /** 视口坐标 → 相对画布容器的坐标（与 sigma payload.event 同一空间） */
  const toContainerPoint = (event: MouseEvent): { x: number; y: number } => {
    const rect = options.container.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const handleMouseMove = (event: MouseEvent): void => {
    if (!dragging || killed) return;
    const point = toContainerPoint(event);
    if (!dragMoved && dragStart) {
      if (Math.hypot(point.x - dragStart.x, point.y - dragStart.y) < DRAG_THRESHOLD_PX) return;
      dragMoved = true;
    }
    const position = sigma.viewportToGraph(point);
    graph.setNodeAttribute(dragging, 'x', position.x);
    graph.setNodeAttribute(dragging, 'y', position.y);
    sigma.refresh();
  };

  const handleMouseUp = (): void => {
    if (!dragging) return;
    const pageId = dragging;
    const moved = dragMoved;
    dragging = null;
    dragStart = null;
    dragMoved = false;
    window.removeEventListener('mousemove', handleMouseMove, LISTENER_OPTIONS);
    window.removeEventListener('mouseup', handleMouseUp, LISTENER_OPTIONS);
    // 纯点选不应被记成「手动调整布局」：只有真的移动过才上报
    if (!moved) return;
    const position = {
      x: Number(graph.getNodeAttribute(pageId, 'x')) || 0,
      y: Number(graph.getNodeAttribute(pageId, 'y')) || 0,
    };
    options.onNodeDragEnd(pageId, position);
  };

  sigma.on('downNode', (payload) => {
    if (killed) return;
    // 阻止相机跟随：拖拽节点时画面不应整体平移
    payload.preventSigmaDefault();
    // sigma 在拖拽过程中可能重复派发 downNode；重复时保留最初起点，
    // 否则「位移超过阈值」永远不成立，拖拽会被误判成点选
    if (dragging === payload.node && dragStart !== null) return;
    dragging = payload.node;
    dragStart = { x: payload.event.x, y: payload.event.y };
    dragMoved = false;
    window.addEventListener('mousemove', handleMouseMove, LISTENER_OPTIONS);
    window.addEventListener('mouseup', handleMouseUp, LISTENER_OPTIONS);
  });
  sigma.on('clickNode', (payload) => {
    if (killed) return;
    options.onNodeClick(payload.node);
  });
  sigma.on('clickStage', () => {
    if (killed) return;
    options.onStageClick();
  });

  return {
    refresh: () => {
      if (killed) return;
      guard(() => sigma.refresh(), undefined);
    },
    resize: () => {
      if (killed) return;
      guard(() => {
        sigma.resize();
        sigma.refresh();
      }, undefined);
    },
    applyPositions: (positions) => {
      if (killed) return 0;
      return guard(() => {
        let applied = 0;
        for (const position of positions) {
          if (!graph.hasNode(position.id)) continue;
          graph.setNodeAttribute(position.id, 'x', position.x);
          graph.setNodeAttribute(position.id, 'y', position.y);
          applied += 1;
        }
        sigma.refresh();
        return applied;
      }, 0);
    },
    setHighlight: (next) => {
      if (killed) return;
      highlight.selected = next.selected;
      highlight.neighbors = next.neighbors;
      highlight.hidden = next.hidden;
      highlight.bridges = next.bridges;
      guard(() => sigma.refresh(), undefined);
    },
    focusNode: (pageId) => {
      if (killed || !graph.hasNode(pageId)) return false;
      return guard(() => {
        const viewport = sigma.graphToViewport({
          x: Number(graph.getNodeAttribute(pageId, 'x')) || 0,
          y: Number(graph.getNodeAttribute(pageId, 'y')) || 0,
        });
        const framed = sigma.viewportToFramedGraph(viewport);
        sigma.getCamera().animate(
          { x: framed.x, y: framed.y, ratio: Math.min(0.6, sigma.getCamera().ratio) },
          { duration: 300 },
        );
        return true;
      }, false);
    },
    kill: () => {
      if (killed) return;
      killed = true;
      window.removeEventListener('mousemove', handleMouseMove, LISTENER_OPTIONS);
      window.removeEventListener('mouseup', handleMouseUp, LISTENER_OPTIONS);
      dragging = null;
      try {
        sigma.kill();
      } catch {
        // kill 抛错不应阻断卸载
      }
      // sigma.kill() 释放引用，但 GPU 上下文要显式丢弃，否则反复切库会累积
      releaseWebGLContexts(options.container);
    },
  };
}
