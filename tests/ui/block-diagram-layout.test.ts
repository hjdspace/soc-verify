/**
 * block-diagram-layout elkjs 布局测试（issue 05 验收：中等规模子图
 * （几十实例）布局不爆栈、耗时可接受）。
 *
 * elk.bundled.js（无 worker 变体）在渲染进程内同步执行，验证：
 *   - 全部节点产出坐标（无遗漏）
 *   - 坐标为非负有限数（elk 分层布局正常返回）
 *   - 40 实例 / 35 边规模下秒级完成（宽松预算）
 */

import { describe, it, expect } from 'vitest';
import { layoutDiagram } from '@renderer/components/design/block-diagram-layout';

function syntheticGraph(count: number): { nodes: { id: string; width: number; height: number }[]; edges: { id: string; source: string; target: string }[] } {
  const nodes = Array.from({ length: count }, (_, i) => ({
    id: `inst${i}`,
    width: 180,
    height: 120,
  }));
  // 分层结构：每层 5 个实例，层间扇出（模拟 SoC 子系统互连）
  const edges: { id: string; source: string; target: string }[] = [];
  for (let i = 0; i + 5 < count; i++) {
    edges.push({ id: `e${i}`, source: `inst${i}`, target: `inst${i + 5}` });
  }
  return { nodes, edges };
}

describe('layoutDiagram elkjs 分层布局（issue 05）', () => {
  it('小图（3 节点 2 边）：全部节点产出坐标', async () => {
    const positions = await layoutDiagram(
      [
        { id: 'a', width: 180, height: 100 },
        { id: 'b', width: 180, height: 100 },
        { id: 'c', width: 180, height: 100 },
      ],
      [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'b', target: 'c' },
      ],
    );
    expect(positions.size).toBe(3);
    for (const p of positions.values()) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
    }
  });

  it('中等规模（40 实例 / 35 边）不爆栈、秒级完成', async () => {
    const { nodes, edges } = syntheticGraph(40);
    const started = Date.now();
    const positions = await layoutDiagram(nodes, edges);
    const elapsed = Date.now() - started;

    expect(positions.size).toBe(40);
    expect(elapsed).toBeLessThan(10_000);
    // 分层布局应产生离散层坐标（x 维度多于 3 个不同值）
    expect(new Set([...positions.values()].map((p) => Math.round(p.x))).size).toBeGreaterThan(3);
  });
});
