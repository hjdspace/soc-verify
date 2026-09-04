/**
 * 框图 elkjs 自动分层布局（issue 05）。
 *
 * elk.bundled.js（无 worker 变体）：渲染进程内直接执行，中等规模
 * （几十实例）布局耗时可接受；框图为只读浏览，无需交互式布局引擎。
 * 布局输入只含节点尺寸与连接关系（block-diagram-model 的输出），
 * 与 React Flow 解耦，可在 node 环境测试。
 */

import ELK from 'elkjs/lib/elk.bundled.js';

export type LayoutNode = { id: string; width: number; height: number };
export type LayoutEdge = { id: string; source: string; target: string };

/** elkjs layered 布局：节点 id → 左上角坐标 */
export async function layoutDiagram(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
): Promise<Map<string, { x: number; y: number }>> {
  const elk = new ELK();
  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': '60',
      'elk.spacing.nodeNode': '40',
      // 中等规模图关闭两条昂贵的精化通路（hierarchy 处理/自环打包）
      'elk.layered.crossingMinimization.strategy': 'HEURISTIC',
    },
    children: nodes.map((n) => ({ id: n.id, width: n.width, height: n.height })),
    edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };
  const result = await elk.layout(graph);
  const positions = new Map<string, { x: number; y: number }>();
  for (const child of result.children ?? []) {
    positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
  }
  return positions;
}
