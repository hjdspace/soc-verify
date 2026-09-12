/**
 * 框图 elkjs 自动分层布局（issue 05）。
 *
 * 浏览器通过 Worker 执行 ELK，避免大型 SoC 布局阻塞交互。
 * Node 测试环境使用内置 worker 实现，保持相同布局算法。
 * 布局输入只含节点尺寸与连接关系（block-diagram-model 的输出），
 * 与 React Flow 解耦，可在 node 环境测试。
 */

import ELK from 'elkjs/lib/elk-api.js';
import ElkWorker from 'elkjs/lib/elk-worker.min.js?worker';

export type LayoutNode = { id: string; width: number; height: number };
export type LayoutEdge = { id: string; source: string; target: string };

/** elkjs layered 布局：节点 id → 左上角坐标 */
export async function layoutDiagram(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  signal?: AbortSignal,
): Promise<Map<string, { x: number; y: number }>> {
  signal?.throwIfAborted();
  const elk = new ELK({ workerFactory: () => new ElkWorker() });
  // 布局只需要模块间邻接关系；平行 clock/reset/总线不重复参与求解。
  const pairs = new Map<string, LayoutEdge>();
  for (const edge of edges) {
    const key = JSON.stringify([edge.source, edge.target].sort());
    if (!pairs.has(key)) pairs.set(key, edge);
  }
  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': '110',
      'elk.spacing.nodeNode': '60',
      // 中等规模图关闭两条昂贵的精化通路（hierarchy 处理/自环打包）
      'elk.layered.crossingMinimization.strategy': 'HEURISTIC',
    },
    children: nodes.map((n) => ({ id: n.id, width: n.width, height: n.height })),
    edges: [...pairs.values()].map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };
  let onAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new DOMException('Layout cancelled', 'AbortError'));
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    const result = await Promise.race([elk.layout(graph), aborted]);
    const positions = new Map<string, { x: number; y: number }>();
    for (const child of result.children ?? []) {
      positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
    }
    return positions;
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    elk.terminateWorker();
  }
}
