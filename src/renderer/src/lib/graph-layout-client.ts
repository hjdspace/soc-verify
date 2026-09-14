/**
 * graph-layout-client — 布局 worker 的生命周期所有者（spec §9/§10，issue 26）。
 *
 * 单一职责：把「请求一次布局」翻译成 worker 消息，并保证任何路径下
 * （成功、worker 报错、取消、组件卸载、切库）都不会泄漏 worker。
 * 迟到的结果按 key 丢弃，因此切库/重开图不会把旧 revision 的坐标画到新图上。
 *
 * worker 工厂是可注入的：单测用假 worker 验证 create/terminate 次数，
 * 冒烟测试在真实 Electron 中验证模块 worker 能起来。
 */

import type { GraphLayoutEdge, GraphLayoutNode } from './kb-wiki-graph';
import type {
  GraphLayoutWorkerRequest,
  GraphLayoutWorkerResponse,
} from '../workers/graph-layout.worker';

export type LayoutPosition = { id: string; x: number; y: number };

/** worker 句柄的最小契约（真实 Worker 与假 worker 都满足）。 */
export type LayoutWorkerHandle = {
  postMessage(message: GraphLayoutWorkerRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<GraphLayoutWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
};

export type LayoutWorkerFactory = () => LayoutWorkerHandle | null;

/** worker 消息契约的再导出：调用方（含测试与冒烟 harness）无需知道文件布局 */
export type { GraphLayoutWorkerRequest, GraphLayoutWorkerResponse } from '../workers/graph-layout.worker';

export type LayoutOutcome = {
  key: string;
  positions: LayoutPosition[];
  /** 布局实际在哪运行：worker 失败时回退主线程，是可见状态 */
  via: 'worker' | 'main-thread';
  /** via === 'main-thread' 且由失败触发时的原因 */
  error?: string;
};

export type LayoutRequest = {
  key: string;
  nodes: GraphLayoutNode[];
  edges: GraphLayoutEdge[];
  iterations: number;
  scalingRatio: number;
};

export type GraphLayoutClientOptions = {
  factory: LayoutWorkerFactory;
  /** 布局完成（或回退完成）时回调；已完成的结果保证 key 仍是最新请求 */
  onLayout: (outcome: LayoutOutcome) => void;
  /** worker 不可用/失败时回调，用于把错误状态显示给用户 */
  onError?: (message: string) => void;
};

/**
 * 主线程布局：worker 不可用或失败时的降级路径，语义与 worker 完全一致。
 *
 * graphology 与 ForceAtlas2 在这里动态加载：正常路径下它们只存在于 worker
 * chunk 中，主 chunk 不应为一个降级路径背上 ~270KB（项目关注启动耗时）。
 */
export async function runMainThreadLayout(request: LayoutRequest): Promise<LayoutPosition[]> {
  const [{ default: Graph }, { default: forceAtlas2 }] = await Promise.all([
    import('graphology'),
    import('graphology-layout-forceatlas2'),
  ]);
  const graph = new Graph({ multi: false, type: 'directed' });
  for (const node of request.nodes) {
    graph.addNode(node.id, { x: node.x, y: node.y });
  }
  for (const edge of request.edges) {
    if (edge.source === edge.target) continue;
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue;
    const edgeKey = `${edge.source}->${edge.target}`;
    if (graph.hasEdge(edgeKey) || graph.hasEdge(`${edge.target}->${edge.source}`)) continue;
    try {
      graph.addEdgeWithKey(edgeKey, edge.source, edge.target, { weight: edge.weight });
    } catch {
      // 重复 key：跳过，不影响其余边
    }
  }
  const settings = forceAtlas2.inferSettings(graph);
  forceAtlas2.assign(graph, {
    iterations: request.iterations,
    settings: {
      ...settings,
      gravity: 1,
      scalingRatio: request.scalingRatio,
      strongGravityMode: true,
      barnesHutOptimize: request.nodes.length > 50,
    },
  });
  const positions: LayoutPosition[] = [];
  graph.forEachNode((id, attrs) => {
    positions.push({ id, x: attrs.x, y: attrs.y });
  });
  return positions;
}

export class GraphLayoutClient {
  private readonly factory: LayoutWorkerFactory;
  private readonly onLayout: (outcome: LayoutOutcome) => void;
  private readonly onError: ((message: string) => void) | undefined;

  private worker: LayoutWorkerHandle | null = null;
  private pendingKey: string | null = null;
  private lastRequest: LayoutRequest | null = null;
  private disposed = false;
  /** 统计真实创建的 worker 数量（测试/诊断用） */
  private workersCreated = 0;

  constructor(options: GraphLayoutClientOptions) {
    this.factory = options.factory;
    this.onLayout = options.onLayout;
    this.onError = options.onError;
  }

  get pending(): string | null {
    return this.pendingKey;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get usesWorker(): boolean {
    return this.worker !== null;
  }

  get createdWorkerCount(): number {
    return this.workersCreated;
  }

  /**
   * 请求一次布局。
   *
   * 同一 key 重复请求直接忽略（避免同一数据反复重排）；
   * 新请求会覆盖 pending key，旧结果到达时被丢弃。
   */
  request(request: LayoutRequest): void {
    if (this.disposed) return;
    if (this.pendingKey === request.key) return;
    this.lastRequest = request;
    this.pendingKey = request.key;

    if (!this.worker) {
      const created = this.factory();
      if (created) {
        this.worker = created;
        this.workersCreated += 1;
        created.onmessage = (event) => this.handleMessage(event.data);
        created.onerror = (event) => this.handleWorkerFailure(
          request.key,
          event.message || '布局 worker 执行失败',
        );
      }
    }

    if (!this.worker) {
      const message = '布局 worker 不可用，已回退主线程布局';
      this.onError?.(message);
      void this.finishWithMainThread(request, message);
      return;
    }

    try {
      this.worker.postMessage(request);
    } catch (error) {
      this.handleWorkerFailure(
        request.key,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /** 使当前 pending 结果失效（数据已变，但不必销毁 worker）。 */
  cancel(): void {
    this.pendingKey = null;
  }

  /**
   * 终止 worker 并释放句柄。组件卸载、切库、切换视图都必须调用。
   * 调用后实例不可复用（重新挂载会新建实例），避免半死状态。
   */
  terminate(): void {
    this.disposed = true;
    this.pendingKey = null;
    this.lastRequest = null;
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {
        // terminate 本身不应让卸载流程失败
      }
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker = null;
    }
  }

  private handleMessage(message: GraphLayoutWorkerResponse): void {
    if (this.disposed) return;
    if (message.key !== this.pendingKey) return; // 迟到结果：丢弃，不串 revision
    const request = this.lastRequest;
    this.pendingKey = null;
    if ('error' in message) {
      if (request) {
        this.handleWorkerFailure(message.key, message.error);
      }
      return;
    }
    this.onLayout({ key: message.key, positions: message.positions, via: 'worker' });
  }

  private handleWorkerFailure(key: string, reason: string): void {
    if (this.disposed) return;
    const request = this.lastRequest;
    this.onError?.(`布局 worker 失败（${reason}），已回退主线程布局`);
    // worker 已经不可信：销毁句柄，让下一次请求重建
    this.destroyWorker();
    if (!request) return;
    void this.finishWithMainThread({ ...request, key }, reason);
  }

  private async finishWithMainThread(request: LayoutRequest, error?: string): Promise<void> {
    const positions = await runMainThreadLayout(request);
    // 等待期间可能已经卸载/切库：此时结果作废，不能写回新图
    if (this.disposed) return;
    if (this.pendingKey === request.key) this.pendingKey = null;
    this.onLayout({
      key: request.key,
      positions,
      via: 'main-thread',
      ...(error === undefined ? {} : { error }),
    });
  }

  private destroyWorker(): void {
    if (!this.worker) return;
    try {
      this.worker.terminate();
    } catch {
      // 忽略
    }
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker = null;
  }
}

/**
 * 创建真实模块 worker。
 *
 * `new URL(..., import.meta.url)` 让打包器产出同源本地 worker chunk——
 * 不加载 CDN、不需要 `unsafe-eval`（CSP `default-src 'self'` 下可用）。
 * 构造失败返回 null，由调用方回退主线程布局。
 */
export function createModuleLayoutWorker(): LayoutWorkerHandle | null {
  try {
    return new Worker(new URL('../workers/graph-layout.worker.ts', import.meta.url), {
      type: 'module',
      name: 'kb-graph-layout',
    });
  } catch (error) {
    console.warn('[kb-graph] 无法创建布局 worker：', error);
    return null;
  }
}
