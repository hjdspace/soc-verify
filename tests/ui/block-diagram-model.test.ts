/**
 * block-diagram-model 纯函数测试（issue 05：框图数据映射）。
 *
 * fixture 对齐 S0 真实子图（spike_top：u_subsys0/u_subsys1 + 9 条边——
 * apb0_* 6 条 top2i 桥边、clk/rst i2i 广播边、link_irq i2i 细边）。
 *
 * 映射职责（渲染端 view model，数据全部来自 tRPC getSubgraph）：
 *   - 子实例 + 图根 → box 节点（端口按方向分列）
 *   - 边 pairwise 拆分 → 按两端 bundle 归属聚合：同 bundle 组合 → 协议粗边；
 *     两端均未入束 → net 细边
 *   - 方向：output 端为 source；两端同向时图根端作 sink/source 锚
 *   - 高亮：端口名 → 涉及该信号的边集合（含粗边展开信号匹配）
 */

import { describe, it, expect } from 'vitest';
import {
  buildDiagramViewModel,
  edgesForSignal,
  type DesignSubgraphRow,
} from '@renderer/components/design/block-diagram-model';

// ─── S0 spike_top 子图 fixture（真实数据形态） ─────────────────

const AHB_PORT_NAMES = ['h_haddr', 'h_hsel', 'h_hwrite', 'h_hwdata', 'h_hrdata', 'h_hreadyout', 'h_htrans', 'h_hburst', 'h_hresp'];

function subsysNode(path: string, name: string): DesignSubgraphRow['nodes'][number] {
  return {
    path,
    name,
    module: 'soc_subsys',
    parent: 'spike_top',
    depth: 1,
    src: null,
    params: {},
    instCount: 3,
    ports: [
      { name: 'clk_i', direction: 'input', width: 1 },
      { name: 'rst_n_i', direction: 'input', width: 1 },
      { name: 'h_haddr', direction: 'input', width: 12 },
      { name: 'h_hsel', direction: 'input', width: 1 },
      { name: 'h_hwrite', direction: 'input', width: 1 },
      { name: 'h_hwdata', direction: 'input', width: 32 },
      { name: 'h_hrdata', direction: 'output', width: 32 },
      { name: 'h_hreadyout', direction: 'output', width: 1 },
      { name: 'h_htrans', direction: 'input', width: 2 },
      { name: 'h_hburst', direction: 'input', width: 3 },
      { name: 'h_hresp', direction: 'output', width: 2 },
      { name: 'irq_o', direction: 'output', width: 8 },
      { name: 'fab_irq_en', direction: 'input', width: 1 },
    ],
    bundles: {
      bundles: [
        {
          protocol: 'AHB',
          prefix: 'h_',
          singleton: false,
          role: 'slave',
          signals: AHB_PORT_NAMES.map((n) => ({ name: n, sig: n.replace('h_', '') })),
        },
        { protocol: 'clock', prefix: '', singleton: true, role: null, signals: [{ name: 'clk_i', sig: 'clk_i' }] },
        { protocol: 'reset', prefix: '', singleton: true, role: null, signals: [{ name: 'rst_n_i', sig: 'rst_n_i' }] },
      ],
      leftovers: ['irq_o', 'fab_irq_en'],
    },
  };
}

const SG: DesignSubgraphRow = {
  root: {
    path: 'spike_top',
    name: 'spike_top',
    module: 'spike_top',
    parent: null,
    depth: 0,
    src: null,
    params: {},
    instCount: 9,
    ports: [
      { name: 'clk_i', direction: 'input', width: 1 },
      { name: 'rst_n_i', direction: 'input', width: 1 },
      { name: 'apb0_paddr', direction: 'input', width: 12 },
      { name: 'apb0_psel', direction: 'input', width: 1 },
      { name: 'apb0_pwrite', direction: 'input', width: 1 },
      { name: 'apb0_pwdata', direction: 'input', width: 32 },
      { name: 'apb0_prdata', direction: 'input', width: 32 },
      { name: 'apb0_pready', direction: 'input', width: 1 },
    ],
  },
  nodes: [subsysNode('spike_top.u_subsys0', 'u_subsys0'), subsysNode('spike_top.u_subsys1', 'u_subsys1')],
  edges: [
    // apb0_* 6 条 top2i 桥边（图根 APB → u_subsys0 AHB）
    { module: 'spike_top', net: 'apb0_paddr', kind: 'top2i', width: 12, cells: [{ inst: 'spike_top.u_subsys0', port: 'h_haddr' }], topPorts: ['apb0_paddr'] },
    { module: 'spike_top', net: 'apb0_psel', kind: 'top2i', width: 1, cells: [{ inst: 'spike_top.u_subsys0', port: 'h_hsel' }], topPorts: ['apb0_psel'] },
    { module: 'spike_top', net: 'apb0_pwrite', kind: 'top2i', width: 1, cells: [{ inst: 'spike_top.u_subsys0', port: 'h_hwrite' }], topPorts: ['apb0_pwrite'] },
    { module: 'spike_top', net: 'apb0_pwdata', kind: 'top2i', width: 32, cells: [{ inst: 'spike_top.u_subsys0', port: 'h_hwdata' }], topPorts: ['apb0_pwdata'] },
    { module: 'spike_top', net: 'apb0_prdata', kind: 'top2i', width: 32, cells: [{ inst: 'spike_top.u_subsys0', port: 'h_hrdata' }], topPorts: ['apb0_prdata'] },
    { module: 'spike_top', net: 'apb0_pready', kind: 'top2i', width: 1, cells: [{ inst: 'spike_top.u_subsys0', port: 'h_hreadyout' }], topPorts: ['apb0_pready'] },
    // clk/rst 广播边（i2i + top）
    { module: 'spike_top', net: 'clk_i', kind: 'i2i', width: 1, cells: [{ inst: 'spike_top.u_subsys0', port: 'clk_i' }, { inst: 'spike_top.u_subsys1', port: 'clk_i' }], topPorts: ['clk_i'] },
    { module: 'spike_top', net: 'rst_n_i', kind: 'i2i', width: 1, cells: [{ inst: 'spike_top.u_subsys0', port: 'rst_n_i' }, { inst: 'spike_top.u_subsys1', port: 'rst_n_i' }], topPorts: ['rst_n_i'] },
    // link_irq 细边（u_subsys0:irq_o → u_subsys1:fab_irq_en）
    { module: 'spike_top', net: 'link_irq', kind: 'i2i', width: 1, cells: [{ inst: 'spike_top.u_subsys0', port: 'irq_o' }, { inst: 'spike_top.u_subsys1', port: 'fab_irq_en' }], topPorts: [] },
  ],
  bundles: {
    bundles: [
      { protocol: 'APB', prefix: 'apb0_', singleton: false, role: 'slave', signals: ['apb0_paddr', 'apb0_psel', 'apb0_pwrite', 'apb0_pwdata', 'apb0_prdata', 'apb0_pready', 'apb0_penable'].map((n) => ({ name: n, sig: n.replace('apb0_', '') })) },
      { protocol: 'clock', prefix: '', singleton: true, role: null, signals: [{ name: 'clk_i', sig: 'clk_i' }] },
      { protocol: 'reset', prefix: '', singleton: true, role: null, signals: [{ name: 'rst_n_i', sig: 'rst_n_i' }] },
    ],
    leftovers: [],
  },
};

// ─── 节点映射 ──────────────────────────────────────────────

describe('buildDiagramViewModel 节点（issue 05）', () => {
  const vm = buildDiagramViewModel(SG);

  it('图根 + 直接子实例 → box 节点（id = 实例 path）', () => {
    expect(vm.nodes.map((n) => n.id)).toEqual(['spike_top', 'spike_top.u_subsys0', 'spike_top.u_subsys1']);
    const u0 = vm.nodes.find((n) => n.id === 'spike_top.u_subsys0')!;
    expect(u0.name).toBe('u_subsys0');
    expect(u0.module).toBe('soc_subsys');
    expect(u0.isRoot).toBe(false);
    expect(vm.nodes.find((n) => n.id === 'spike_top')!.isRoot).toBe(true);
  });

  it('box 端口按方向分列（input 左列 / output 右列）', () => {
    const u0 = vm.nodes.find((n) => n.id === 'spike_top.u_subsys0')!;
    expect(u0.portsIn.map((p) => p.name)).toContain('h_haddr');
    expect(u0.portsOut.map((p) => p.name)).toContain('h_hrdata');
    expect(u0.portsIn.every((p) => p.direction === 'input')).toBe(true);
    expect(u0.portsOut.every((p) => p.direction === 'output')).toBe(true);
  });
});

// ─── 边映射：粗边聚合 / 细边 ─────────────────────────────────

describe('buildDiagramViewModel 边（issue 05）', () => {
  const vm = buildDiagramViewModel(SG);

  it('apb0_* 6 条 top2i 桥边聚合为一条协议粗边（label APB → AHB，6 信号）', () => {
    const bridge = vm.edges.filter(
      (e) => e.kind === 'bundle' && e.label.includes('AHB') && e.source === 'spike_top' && e.target === 'spike_top.u_subsys0',
    );
    expect(bridge).toHaveLength(1);
    expect(bridge[0]!.label).toContain('APB');
    expect(bridge[0]!.label).toContain('AHB');
    expect(bridge[0]!.signalCount).toBe(6);
    // 展开信号清单（两端端口对）
    expect(bridge[0]!.signals).toHaveLength(6);
    expect(bridge[0]!.signals.some((s) => s.fromPort === 'apb0_paddr' && s.toPort === 'h_haddr')).toBe(true);
    // 粗边锚定首信号端口（React Flow handle id 两端必须存在）
    expect(bridge[0]!.sourcePort).toBe('apb0_paddr');
    expect(bridge[0]!.targetPort).toBe('h_haddr');
  });

  it('clk 广播边聚合为粗边，标签 = net 名 clk_i（图根 → 两个子实例，各一条）', () => {
    const clkEdges = vm.edges.filter((e) => e.label === 'clk_i');
    expect(clkEdges).toHaveLength(2);
    expect(clkEdges.every((e) => e.kind === 'bundle' && e.source === 'spike_top')).toBe(true);
    expect(new Set(clkEdges.map((e) => e.target))).toEqual(
      new Set(['spike_top.u_subsys0', 'spike_top.u_subsys1']),
    );
    expect(clkEdges.every((e) => e.signalCount === 1)).toBe(true);
    // singleton 束不再用协议名做标签（"clock ×1" 曾被误读为模块）
    expect(vm.edges.some((e) => e.label === 'clock')).toBe(false);
  });

  it('rst 广播边聚合为粗边，标签 = net 名 rst_n_i', () => {
    expect(vm.edges.filter((e) => e.label === 'rst_n_i')).toHaveLength(2);
  });

  it('link_irq 细边：两端均未入束 → signal 边（u_subsys0 → u_subsys1）', () => {
    const link = vm.edges.find((e) => e.kind === 'signal' && e.label === 'link_irq');
    expect(link).toBeDefined();
    expect(link!.source).toBe('spike_top.u_subsys0');
    expect(link!.target).toBe('spike_top.u_subsys1');
    expect(link!.sourcePort).toBe('irq_o');
    expect(link!.targetPort).toBe('fab_irq_en');
    expect(link!.width).toBe(1);
  });

  it('方向：output 端为 source（h_hrdata output → 图根 apb0_prdata input）', () => {
    const read = vm.edges.filter((e) => e.kind === 'bundle' && e.source === 'spike_top.u_subsys0');
    expect(read).toHaveLength(1);
    expect(read[0]!.target).toBe('spike_top');
    expect(read[0]!.label).toContain('AHB');
    expect(read[0]!.label).toContain('APB');
    expect(read[0]!.signalCount).toBe(2); // h_hrdata + h_hreadyout 读通道
  });
});

// ─── 高亮 ──────────────────────────────────────────────────

describe('edgesForSignal（issue 05：点击信号高亮同名连线）', () => {
  const vm = buildDiagramViewModel(SG);

  it('点击 apb0_paddr → 高亮 APB↔AHB 粗边', () => {
    const ids = edgesForSignal(vm, 'apb0_paddr');
    const edges = ids.map((id) => vm.edges.find((e) => e.id === id)!);
    expect(edges.some((e) => e.kind === 'bundle' && e.signalCount === 6)).toBe(true);
  });

  it('点击 h_haddr（u_subsys0 侧端口名）→ 同样命中 APB↔AHB 粗边', () => {
    const ids = edgesForSignal(vm, 'h_haddr');
    expect(ids).toHaveLength(1);
    expect(vm.edges.find((e) => e.id === ids[0])!.kind).toBe('bundle');
  });

  it('点击 irq_o → 命中 link_irq 细边', () => {
    expect(edgesForSignal(vm, 'irq_o')).toHaveLength(1);
  });

  it('点击 clk_i → 命中两条 clock 粗边', () => {
    expect(edgesForSignal(vm, 'clk_i')).toHaveLength(2);
  });

  it('点击未知信号 → 空集合', () => {
    expect(edgesForSignal(vm, 'nope')).toEqual([]);
  });
});

// ─── 无 bundle 数据退化 ─────────────────────────────────────

describe('无打标数据（issue 05：旧数据兼容）', () => {
  it('bundles 为空时全部边退化为 signal 细边', () => {
    const sg: DesignSubgraphRow = {
      ...SG,
      bundles: { bundles: [], leftovers: [] },
      nodes: SG.nodes.map((n) => ({ ...n, bundles: { bundles: [], leftovers: [] } })),
    };
    const vm = buildDiagramViewModel(sg);
    expect(vm.edges.every((e) => e.kind === 'signal')).toBe(true);
    // 9 条源边 pairwise 后 > 9（clk 拆 2 对、rst 拆 2 对、link 1 对、6 top2i）
    expect(vm.edges.length).toBeGreaterThanOrEqual(11);
  });
});
