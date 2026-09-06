/**
 * block-diagram-routing 连线几何纯函数测试（issue：连线锚定面 + 绕行）。
 *
 * - anchorSides：锚定面由两端节点相对位置决定（左框右缘出线 → 右框左缘入线；
 *   纵向堆叠走上/下），不再由端口方向决定
 * - nodeSize：body 高度按可视区封顶（与 box max-h-300 渲染一致）
 * - planDetour / detourGeometry：直连线穿过中间节点时绕行（通道 + 桩段折线），
 *   标签落在通道空白区
 */

import { describe, it, expect } from 'vitest';
import {
  anchorSides,
  detourGeometry,
  handleId,
  nodeSize,
  planDetour,
  roundedPath,
  type Rect,
} from '@renderer/components/design/block-diagram-routing';

const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

describe('anchorSides 锚定面选择', () => {
  it('源在左、目标在右：源右缘出线 → 目标左缘入线（水平流）', () => {
    const a = rect(0, 40, 286, 170);
    const b = rect(320, 40, 286, 230);
    expect(anchorSides(a, b)).toEqual({ source: 'r', target: 'l', axis: 'h' });
  });

  it('源在右、目标在左：源左缘出线 → 目标右缘入线', () => {
    const a = rect(320, 40, 286, 230);
    const b = rect(0, 40, 286, 170);
    expect(anchorSides(a, b)).toEqual({ source: 'l', target: 'r', axis: 'h' });
  });

  it('纵向堆叠（|dy| > |dx|）：上框下缘 → 下框上缘', () => {
    const top = rect(0, 0, 286, 170);
    const bottom = rect(40, 400, 286, 170);
    expect(anchorSides(top, bottom)).toEqual({ source: 'b', target: 't', axis: 'v' });
    expect(anchorSides(bottom, top)).toEqual({ source: 't', target: 'b', axis: 'v' });
  });

  it('水平位移远大于纵向偏移时仍走水平流', () => {
    const a = rect(0, 0, 286, 170);
    const b = rect(600, 80, 286, 170);
    expect(anchorSides(a, b).axis).toBe('h');
  });
});

describe('nodeSize box 尺寸', () => {
  it('空端口 box 也保底一行', () => {
    const { width, height } = nodeSize({ bundles: [], leftovers: [] });
    expect(width).toBe(286);
    expect(height).toBe(42 + 30 + 10 + 28);
  });

  it('行数超过可视区时 body 高度封顶 300（与 max-h-300 渲染一致）', () => {
    const { height } = nodeSize({ bundles: Array.from({ length: 20 }, (_, i) => ({ i })), leftovers: [] });
    expect(height).toBe(42 + 300 + 28);
  });
});

describe('planDetour 绕行规划', () => {
  // 三框横向场景：A(0) → B(320) → C(640)，A→C 直连线穿过 B
  const obstacle = rect(320, 40, 286, 230);
  // 障碍集合不含源/目标两端节点（组件侧已过滤）
  const bystander = rect(640, 40, 286, 230);

  it('直连线不穿障碍 → 不绕行（null）', () => {
    // A→B 相邻直连：障碍只有远处的 C（不在 A、B 间的线段上）
    const a = { x: 286, y: 132 };
    const b = { x: 320, y: 132 };
    expect(planDetour(a, b, [bystander], 0, 'h')).toBeNull();
  });

  it('穿过中间节点 → 绕上方通道（锚点中点偏上时）', () => {
    const a = { x: 286, y: 132 };
    const b = { x: 640, y: 132 };
    const detour = planDetour(a, b, [obstacle], 0, 'h');
    expect(detour).toEqual({ axis: 'h', channel: 40 - 46 });
  });

  it('锚点中点偏下时绕下方通道', () => {
    const a = { x: 286, y: 250 };
    const b = { x: 640, y: 250 };
    const detour = planDetour(a, b, [obstacle], 0, 'h');
    expect(detour).toEqual({ axis: 'h', channel: 270 + 46 });
  });

  it('同对多条边按 ordinal 错开通道', () => {
    const a = { x: 286, y: 132 };
    const b = { x: 640, y: 132 };
    const first = planDetour(a, b, [obstacle], 0, 'h');
    const second = planDetour(a, b, [obstacle], 1, 'h');
    expect(second).not.toBeNull();
    expect(first).not.toBeNull();
    expect(Math.abs(second!.channel - first!.channel)).toBe(18);
  });

  it('纵向流穿过障碍 → 绕左侧通道', () => {
    const obstacleV = rect(60, 80, 200, 160);
    const a = { x: 100, y: 280 };
    const b = { x: 100, y: 40 };
    expect(planDetour(a, b, [obstacleV], 0, 'v')).toEqual({ axis: 'v', channel: 60 - 46 });
  });
});

describe('detourGeometry 绕行折线', () => {
  it('水平流：桩段引出后走通道，标签落在通道中点空白区', () => {
    const source = { x: 286, y: 132 };
    const target = { x: 640, y: 132 };
    const detour = { axis: 'h' as const, channel: -6 };
    const { waypoints, label } = detourGeometry(source, target, detour);

    // 端点为实测锚点；先水平引出桩（离开节点边框）再拐通道
    expect(waypoints[0]).toEqual(source);
    expect(waypoints[waypoints.length - 1]).toEqual(target);
    expect(waypoints[1]).toEqual({ x: 306, y: 132 });
    expect(waypoints.some((p) => p.y === -6)).toBe(true);
    // 标签在通道上（不在框内）
    expect(label).toEqual({ x: (306 + 620) / 2, y: -6 });
  });

  it('纵向流：桩段沿纵向引出，通道为 x 坐标', () => {
    const source = { x: 100, y: 280 };
    const target = { x: 100, y: 40 };
    const detour = { axis: 'v' as const, channel: 14 };
    const { waypoints, label } = detourGeometry(source, target, detour);

    expect(waypoints[0]).toEqual(source);
    expect(waypoints[waypoints.length - 1]).toEqual(target);
    expect(waypoints.some((p) => p.x === 14)).toBe(true);
    expect(label.x).toBe(14);
  });
});

describe('roundedPath 折线圆角化', () => {
  it('产出 M/L/Q 路径，首尾为端点', () => {
    const d = roundedPath([
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 50 },
    ]);
    expect(d.startsWith('M 0,0')).toBe(true);
    expect(d).toContain('Q 50,0');
    expect(d.endsWith('L 50,50')).toBe(true);
  });
});

describe('handleId 四向 handle id', () => {
  it('side 前缀 + 端口名', () => {
    expect(handleId('r', 'clk_i')).toBe('r:clk_i');
    expect(handleId('t', 'h_haddr')).toBe('t:h_haddr');
  });
});
