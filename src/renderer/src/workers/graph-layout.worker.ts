/**
 * graph-layout.worker — ForceAtlas2 布局 worker（spec §9，issue 26）。
 *
 * 布局在 worker 中运行，主线程只负责首帧与交互（spec §10：CPU 密集计算
 * 不阻塞主事件循环）。worker 不读文件、不建图，只接收已裁剪的节点/边坐标
 * 并回传坐标；图快照的唯一来源仍是主进程（spec §9）。
 *
 * 错误不抛出到主线程：以 `{ error }` 回传，由布局客户端回退到主线程布局，
 * 让「worker 失败」是可观察状态而不是白屏。
 */

import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import type { GraphLayoutEdge, GraphLayoutNode } from '../lib/kb-wiki-graph';

export type GraphLayoutWorkerRequest = {
  /** 数据 key（含 kbId + revision），用于丢弃迟到结果 */
  key: string;
  nodes: GraphLayoutNode[];
  edges: GraphLayoutEdge[];
  iterations: number;
  scalingRatio: number;
};

export type GraphLayoutWorkerResponse =
  | { key: string; positions: Array<{ id: string; x: number; y: number }> }
  | { key: string; error: string };

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<GraphLayoutWorkerRequest>) => void) | null;
  postMessage: (message: GraphLayoutWorkerResponse) => void;
};

ctx.onmessage = (event: MessageEvent<GraphLayoutWorkerRequest>) => {
  const { key, nodes, edges, iterations, scalingRatio } = event.data;
  try {
    const graph = new Graph({ multi: false, type: 'directed' });
    for (const node of nodes) {
      graph.addNode(node.id, { x: node.x, y: node.y });
    }
    // 无向投影：同一对节点只保留一条边，避免反向边把两个节点拉得过紧，
    // 与主进程社区分析使用的无向投影保持一致（spec §9）。
    for (const edge of edges) {
      if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue;
      if (edge.source === edge.target) continue;
      const edgeKey = `${edge.source}->${edge.target}`;
      if (graph.hasEdge(edgeKey) || graph.hasEdge(`${edge.target}->${edge.source}`)) continue;
      try {
        graph.addEdgeWithKey(edgeKey, edge.source, edge.target, { weight: edge.weight });
      } catch {
        // 重复 key（并发写入）直接跳过，不中断整批布局
      }
    }

    const settings = forceAtlas2.inferSettings(graph);
    forceAtlas2.assign(graph, {
      iterations,
      settings: {
        ...settings,
        gravity: 1,
        scalingRatio,
        strongGravityMode: true,
        barnesHutOptimize: nodes.length > 50,
      },
    });

    const positions: Array<{ id: string; x: number; y: number }> = [];
    graph.forEachNode((id, attrs) => {
      positions.push({ id, x: attrs.x, y: attrs.y });
    });

    ctx.postMessage({ key, positions });
  } catch (error) {
    ctx.postMessage({ key, error: error instanceof Error ? error.message : String(error) });
  }
};
