// @vitest-environment jsdom
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode, ReactElement } from 'react';
import type { DesignSubgraphRow } from '@main/rtl/types';

/**
 * BlockDiagram 组件测试（issue 05：可下钻框图）。
 *
 * - box = 图根 + 直接子实例；粗边（APB→AHB/clock/reset）+ 细边（link_irq）
 * - 粗边收拢/展开切换（展开显示 bundle 内信号明细）
 * - 双击实例下钻（以它为图根）+ 面包屑一键回退
 * - hover 端口显示信号名/方向/位宽
 * - 点击信号高亮同名连线（含粗边展开信号匹配）
 *
 * Mock 策略：tRPC getSubgraph（fixture 对齐 S0 spike 真实子图）+
 * elk 布局（即时位置）+ @xyflow/react 桩（渲染自定义节点/边组件，
 * 转发 onNodeDoubleClick 交互——测试覆盖的是组件的数据装配与交互接线，
 * React Flow 渲染本身是库内部）。
 */

const { trpcMocks } = vi.hoisted(() => ({
  trpcMocks: { getSubgraph: { query: vi.fn() } },
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: { rtl: { getSubgraph: trpcMocks.getSubgraph } },
}));

vi.mock('@renderer/components/design/block-diagram-layout', () => ({
  layoutDiagram: vi.fn(async (nodes: { id: string }[]) =>
    new Map(nodes.map((n, i) => [n.id, { x: i * 320, y: 40 }]))),
}));

vi.mock('@xyflow/react', () => {
  const Position = { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' } as const;
  const Handle = (props: { id?: string; type?: string }) => (
    <span data-handle-id={props.id ?? ''} data-handle-type={props.type ?? ''} />
  );
  const BaseEdge = () => null;
  const EdgeLabelRenderer = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const getBezierPath = () => '';
  // React Flow 桩：按 nodeTypes/edgeTypes 渲染自定义组件；双击转发给 onNodeDoubleClick
  const ReactFlow = ({
    nodes,
    edges,
    nodeTypes,
    edgeTypes,
    onNodeDoubleClick,
    children,
  }: {
    nodes: { id: string; type?: string; data: Record<string, unknown> }[];
    edges: { id: string; type?: string; data?: Record<string, unknown> }[];
    nodeTypes?: Record<string, (props: { id: string; data: Record<string, unknown> }) => ReactElement>;
    edgeTypes?: Record<string, (props: { id: string; data: Record<string, unknown> }) => ReactElement>;
    onNodeDoubleClick?: (event: unknown, node: { id: string }) => void;
    children?: ReactNode;
  }) => (
    <div data-testid="block-diagram-canvas">
      {nodes?.map((n) => {
        const Cmp = n.type ? nodeTypes?.[n.type] : undefined;
        return (
          <div key={n.id} data-testid={`diagram-node-${n.id}`} onDoubleClick={() => onNodeDoubleClick?.(null, n)}>
            {Cmp ? <Cmp id={n.id} data={n.data} /> : null}
          </div>
        );
      })}
      {edges?.map((e) => {
        const Cmp = e.type ? edgeTypes?.[e.type] : undefined;
        return (
          <div key={e.id} data-edge-id={e.id} data-highlighted={String(e.data?.highlighted ?? false)}>
            {Cmp ? <Cmp id={e.id} data={e.data ?? {}} /> : null}
          </div>
        );
      })}
      {children}
    </div>
  );
  return { ReactFlow, Handle, Position, BaseEdge, EdgeLabelRenderer, getBezierPath };
});

import { BlockDiagram } from '@renderer/components/design/BlockDiagram';

// ─── S0 spike 真实子图 fixture ───────────────────────────────

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

const SG_TOP: DesignSubgraphRow = {
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
    { module: 'spike_top', net: 'apb0_paddr', kind: 'top2i', width: 12, cells: [{ inst: 'spike_top.u_subsys0', port: 'h_haddr' }], topPorts: ['apb0_paddr'] },
    { module: 'spike_top', net: 'apb0_psel', kind: 'top2i', width: 1, cells: [{ inst: 'spike_top.u_subsys0', port: 'h_hsel' }], topPorts: ['apb0_psel'] },
    { module: 'spike_top', net: 'apb0_pwrite', kind: 'top2i', width: 1, cells: [{ inst: 'spike_top.u_subsys0', port: 'h_hwrite' }], topPorts: ['apb0_pwrite'] },
    { module: 'spike_top', net: 'apb0_pwdata', kind: 'top2i', width: 32, cells: [{ inst: 'spike_top.u_subsys0', port: 'h_hwdata' }], topPorts: ['apb0_pwdata'] },
    { module: 'spike_top', net: 'apb0_prdata', kind: 'top2i', width: 32, cells: [{ inst: 'spike_top.u_subsys0', port: 'h_hrdata' }], topPorts: ['apb0_prdata'] },
    { module: 'spike_top', net: 'apb0_pready', kind: 'top2i', width: 1, cells: [{ inst: 'spike_top.u_subsys0', port: 'h_hreadyout' }], topPorts: ['apb0_pready'] },
    { module: 'spike_top', net: 'clk_i', kind: 'i2i', width: 1, cells: [{ inst: 'spike_top.u_subsys0', port: 'clk_i' }, { inst: 'spike_top.u_subsys1', port: 'clk_i' }], topPorts: ['clk_i'] },
    { module: 'spike_top', net: 'rst_n_i', kind: 'i2i', width: 1, cells: [{ inst: 'spike_top.u_subsys0', port: 'rst_n_i' }, { inst: 'spike_top.u_subsys1', port: 'rst_n_i' }], topPorts: ['rst_n_i'] },
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

const SPIKE_IP_PORTS = [
  { name: 'clk_i', direction: 'input', width: 1 },
  { name: 'rst_n_i', direction: 'input', width: 1 },
  { name: 'p_paddr', direction: 'input', width: 12 },
  { name: 'p_psel', direction: 'input', width: 1 },
  { name: 'p_pwrite', direction: 'input', width: 1 },
  { name: 'p_pwdata', direction: 'input', width: 32 },
  { name: 'p_prdata', direction: 'output', width: 32 },
  { name: 'p_pready', direction: 'output', width: 1 },
  { name: 'irq_o', direction: 'output', width: 4 },
];

function genIpNode(path: string, name: string): DesignSubgraphRow['nodes'][number] {
  return {
    path,
    name,
    module: 'spike_ip',
    parent: 'spike_top.u_subsys0',
    depth: 2,
    src: null,
    params: {},
    instCount: 1,
    ports: SPIKE_IP_PORTS,
    bundles: {
      bundles: [
        { protocol: 'APB', prefix: 'p_', singleton: false, role: 'slave', signals: ['p_paddr', 'p_psel', 'p_pwrite', 'p_pwdata', 'p_prdata', 'p_pready', 'p_penable'].map((n) => ({ name: n, sig: n.replace('p_', '') })) },
        { protocol: 'clock', prefix: '', singleton: true, role: null, signals: [{ name: 'clk_i', sig: 'clk_i' }] },
        { protocol: 'reset', prefix: '', singleton: true, role: null, signals: [{ name: 'rst_n_i', sig: 'rst_n_i' }] },
      ],
      leftovers: ['irq_o'],
    },
  };
}

const SG_SUB: DesignSubgraphRow = {
  root: {
    path: 'spike_top.u_subsys0',
    name: 'u_subsys0',
    module: 'soc_subsys',
    parent: 'spike_top',
    depth: 1,
    src: null,
    params: {},
    instCount: 3,
    ports: subsysNode('spike_top.u_subsys0', 'u_subsys0').ports,
  },
  nodes: [genIpNode('spike_top.u_subsys0.gen_ip[0].u_ip', 'gen_ip[0].u_ip'), genIpNode('spike_top.u_subsys0.gen_ip[1].u_ip', 'gen_ip[1].u_ip')],
  edges: [
    { module: 'soc_subsys', net: 'h_haddr', kind: 'i2i', width: 12, cells: [{ inst: 'spike_top.u_subsys0.gen_ip[0].u_ip', port: 'p_paddr' }, { inst: 'spike_top.u_subsys0.gen_ip[1].u_ip', port: 'p_paddr' }], topPorts: ['h_haddr'] },
    { module: 'soc_subsys', net: 'clk_i', kind: 'i2i', width: 1, cells: [{ inst: 'spike_top.u_subsys0.gen_ip[0].u_ip', port: 'clk_i' }, { inst: 'spike_top.u_subsys0.gen_ip[1].u_ip', port: 'clk_i' }], topPorts: ['clk_i'] },
    { module: 'soc_subsys', net: 'rst_n_i', kind: 'i2i', width: 1, cells: [{ inst: 'spike_top.u_subsys0.gen_ip[0].u_ip', port: 'rst_n_i' }, { inst: 'spike_top.u_subsys0.gen_ip[1].u_ip', port: 'rst_n_i' }], topPorts: ['rst_n_i'] },
  ],
  bundles: subsysNode('spike_top.u_subsys0', 'u_subsys0').bundles,
};

const SG_LEAF: DesignSubgraphRow = {
  root: {
    path: 'spike_top.u_subsys0.gen_ip[0].u_ip',
    name: 'gen_ip[0].u_ip',
    module: 'spike_ip',
    parent: 'spike_top.u_subsys0',
    depth: 2,
    src: null,
    params: {},
    instCount: 1,
    ports: SPIKE_IP_PORTS,
  },
  nodes: [],
  edges: [],
  bundles: { bundles: [], leftovers: [] },
};

const SG_NULL: DesignSubgraphRow = { root: null, nodes: [], edges: [], bundles: { bundles: [], leftovers: [] } };

beforeEach(() => {
  vi.clearAllMocks();
  trpcMocks.getSubgraph.query.mockImplementation(({ path }: { path: string }) => {
    if (path === 'spike_top') return Promise.resolve(SG_TOP);
    if (path === 'spike_top.u_subsys0') return Promise.resolve(SG_SUB);
    if (path === 'spike_top.u_subsys0.gen_ip[0].u_ip') return Promise.resolve(SG_LEAF);
    return Promise.resolve(SG_NULL);
  });
});

// ─── 渲染：box + 粗边/细边 ──────────────────────────────────

describe('BlockDiagram 渲染（issue 05）', () => {
  it('图根 + 子实例 box；APB→AHB/clock/reset 粗边 + link_irq 细边（RTL 原名）', async () => {
    render(<BlockDiagram projectId="proj-1" path="spike_top" />);

    const canvas = await screen.findByTestId('block-diagram-canvas');
    // 3 个 box：图根 + 两个子系统
    expect(canvas.querySelector('[data-testid="diagram-node-spike_top"]')).toBeTruthy();
    expect(canvas.querySelector('[data-testid="diagram-node-spike_top.u_subsys0"]')).toBeTruthy();
    expect(canvas.querySelector('[data-testid="diagram-node-spike_top.u_subsys1"]')).toBeTruthy();

    // box 头：实例名 + 模块名
    const u0 = canvas.querySelector('[data-testid="diagram-node-spike_top.u_subsys0"]')!;
    expect(u0).toHaveTextContent('u_subsys0');
    expect(u0).toHaveTextContent('soc_subsys');

    // 7 条边：APB 桥 + AHB→APB 读通道 + clock×2 + reset×2 + link_irq 细边
    expect(canvas.querySelectorAll('[data-edge-id]')).toHaveLength(7);
    expect(canvas.textContent).toContain('APB → AHB');
    expect(canvas.textContent).toContain('clock');
    expect(canvas.textContent).toContain('link_irq');
  });
});

// ─── 粗边收拢/展开 ───────────────────────────────────────────

describe('BlockDiagram 粗边收拢/展开（issue 05）', () => {
  it('默认收拢（协议标签 ×计数）；展开显示 bundle 内信号明细；再点收起', async () => {
    render(<BlockDiagram projectId="proj-1" path="spike_top" />);
    const canvas = await screen.findByTestId('block-diagram-canvas');

    const apbLabel = [...canvas.querySelectorAll('[data-testid="diagram-bundle-label"]')].find((n) =>
      n.textContent?.includes('APB → AHB'),
    ) as HTMLElement;
    expect(apbLabel).toBeTruthy();
    // 收拢态：无信号明细
    expect(apbLabel.querySelectorAll('[data-testid="diagram-bundle-signal"]')).toHaveLength(0);
    expect(apbLabel).toHaveTextContent('6');

    // 展开：6 条信号端口对（含位宽标注）
    fireEvent.click(within(apbLabel).getByTestId('diagram-bundle-toggle'));
    const rows = apbLabel.querySelectorAll('[data-testid="diagram-bundle-signal"]');
    expect(rows).toHaveLength(6);
    expect([...rows].some((r) => r.textContent === 'apb0_paddr → h_haddr [11:0]')).toBe(true);

    // 收起
    fireEvent.click(within(apbLabel).getByTestId('diagram-bundle-toggle'));
    expect(apbLabel.querySelectorAll('[data-testid="diagram-bundle-signal"]')).toHaveLength(0);
  });
});

// ─── 下钻 + 面包屑 ──────────────────────────────────────────

describe('BlockDiagram 下钻与面包屑（issue 05）', () => {
  it('双击 u_subsys0 下钻（getSubgraph 以它为图根）；面包屑一键回 spike_top', async () => {
    render(<BlockDiagram projectId="proj-1" path="spike_top" />);
    await screen.findByTestId('block-diagram-canvas');
    expect(trpcMocks.getSubgraph.query).toHaveBeenCalledWith({ projectId: 'proj-1', path: 'spike_top' });

    // 双击下钻
    fireEvent.doubleClick(screen.getByTestId('diagram-node-spike_top.u_subsys0'));
    await screen.findByTestId('diagram-node-spike_top.u_subsys0.gen_ip[0].u_ip');
    expect(trpcMocks.getSubgraph.query).toHaveBeenCalledWith({ projectId: 'proj-1', path: 'spike_top.u_subsys0' });

    // 面包屑：spike_top > u_subsys0
    const breadcrumb = screen.getByTestId('diagram-breadcrumb');
    expect(breadcrumb).toHaveTextContent('spike_top');
    expect(breadcrumb).toHaveTextContent('u_subsys0');

    // 回退到 spike_top
    fireEvent.click(breadcrumb.querySelector('button[data-path="spike_top"]')!);
    await screen.findByTestId('diagram-node-spike_top.u_subsys0');
    expect(trpcMocks.getSubgraph.query).toHaveBeenLastCalledWith({ projectId: 'proj-1', path: 'spike_top' });
  });

  it('leaf 实例双击：图根 box 渲染 + 无子实例空态提示', async () => {
    render(<BlockDiagram projectId="proj-1" path="spike_top.u_subsys0" />);
    await screen.findByTestId('block-diagram-canvas');

    fireEvent.doubleClick(screen.getByTestId('diagram-node-spike_top.u_subsys0.gen_ip[0].u_ip'));
    expect(await screen.findByTestId('diagram-empty')).toHaveTextContent('无子实例');
    expect(screen.getByTestId('diagram-node-spike_top.u_subsys0.gen_ip[0].u_ip')).toBeTruthy();
  });

  it('不存在的 path：root 为 null → 未找到实例提示', async () => {
    render(<BlockDiagram projectId="proj-1" path="no.such.path" />);
    expect(await screen.findByTestId('diagram-empty')).toHaveTextContent('未找到实例');
  });
});

// ─── hover 端口 / 点击信号高亮 ───────────────────────────────

describe('BlockDiagram 端口交互（issue 05）', () => {
  it('hover 端口显示信号名/方向/位宽（h_haddr input [11:0]）', async () => {
    render(<BlockDiagram projectId="proj-1" path="spike_top" />);
    const canvas = await screen.findByTestId('block-diagram-canvas');

    const u0 = canvas.querySelector('[data-testid="diagram-node-spike_top.u_subsys0"]')!;
    const portRow = u0.querySelector('[data-testid="diagram-port"][data-port="h_haddr"]')!;

    fireEvent.mouseOver(portRow);
    const tooltip = screen.getByTestId('diagram-port-tooltip');
    expect(tooltip).toHaveTextContent('h_haddr');
    expect(tooltip).toHaveTextContent('input');
    expect(tooltip).toHaveTextContent('[11:0]');

    fireEvent.mouseOut(portRow);
    expect(screen.queryByTestId('diagram-port-tooltip')).toBeNull();
  });

  it('点击端口信号高亮同名连线（h_haddr → APB↔AHB 桥；clk_i → 两条 clock 边）', async () => {
    render(<BlockDiagram projectId="proj-1" path="spike_top" />);
    const canvas = await screen.findByTestId('block-diagram-canvas');
    const u0 = canvas.querySelector('[data-testid="diagram-node-spike_top.u_subsys0"]')!;

    const highlighted = () => canvas.querySelectorAll('[data-edge-id][data-highlighted="true"]');

    // h_haddr → APB↔AHB 桥边（一条）
    fireEvent.click(u0.querySelector('[data-testid="diagram-port"][data-port="h_haddr"]')!);
    expect(highlighted()).toHaveLength(1);
    const chip = screen.getByTestId('diagram-highlight-chip');
    expect(chip).toHaveTextContent('h_haddr');

    // 清除
    fireEvent.click(within(chip).getByTestId('diagram-highlight-clear'));
    expect(highlighted()).toHaveLength(0);

    // clk_i → 两条 clock 广播边
    fireEvent.click(u0.querySelector('[data-testid="diagram-port"][data-port="clk_i"]')!);
    expect(highlighted()).toHaveLength(2);
  });
});
