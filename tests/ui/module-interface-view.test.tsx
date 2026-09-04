// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DesignDefRow, DesignInstRow } from '@main/rtl/types';

/**
 * ModuleInterfaceView 组件测试（issue 04：选中层级树节点查看接口全貌）：
 *
 * - 端口表按 Protocol Bundle 分组（AXI4-Lite/APB/clk/rst）+ leftovers 单列
 * - 组内可见信号名/方向/位宽
 * - role 推断徽标（master/slave）
 * - 参数覆盖值展示（实例 params vs 定义 paramDefaults）
 *
 * Mock 策略：trpc getDef（返回打标好的合成 def）。
 */

const { trpcMocks } = vi.hoisted(() => ({
  trpcMocks: {
    getDef: vi.fn(),
  },
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    rtl: {
      getDef: { query: trpcMocks.getDef },
    },
  },
}));

import { ModuleInterfaceView } from '@renderer/components/design/ModuleInterfaceView';

// ─── 合成 fixture（S0 spike_ip 打标结果） ─────────────────────

function port(name: string, direction: string, width: number): { name: string; direction: string; width: number } {
  return { name, direction, width };
}

const AXIL_SIGS = [
  ['s_axil_awvalid', 'input', 1],
  ['s_axil_awaddr', 'input', 12],
  ['s_axil_awready', 'output', 1],
  ['s_axil_wdata', 'input', 32],
  ['s_axil_wvalid', 'input', 1],
  ['s_axil_wready', 'output', 1],
  ['s_axil_bresp', 'output', 2],
  ['s_axil_bvalid', 'output', 1],
  ['s_axil_bready', 'input', 1],
  ['s_axil_arvalid', 'input', 1],
  ['s_axil_araddr', 'input', 12],
  ['s_axil_arready', 'output', 1],
  ['s_axil_rdata', 'output', 32],
  ['s_axil_rresp', 'output', 2],
  ['s_axil_rvalid', 'output', 1],
  ['s_axil_rready', 'input', 1],
  ['s_axil_wstrb', 'input', 4],
] as const;

const APB_SIGS = [
  ['p_paddr', 'input', 12],
  ['p_psel', 'input', 1],
  ['p_penable', 'input', 1],
  ['p_pwrite', 'input', 1],
  ['p_pwdata', 'input', 32],
  ['p_prdata', 'output', 32],
  ['p_pready', 'output', 1],
] as const;

const SPIKE_IP_DEF: DesignDefRow = {
  name: 'spike_ip',
  src: 'rtl/ip/spike_ip.sv',
  paramDefaults: { N_IP: 4, DW: 32 },
  ports: [
    port('clk_i', 'input', 1),
    port('rst_n_i', 'input', 1),
    ...AXIL_SIGS.map(([n, d, w]) => port(n, d, w)),
    ...APB_SIGS.map(([n, d, w]) => port(n, d, w)),
    port('irq_o', 'output', 4),
  ],
  bundles: {
    bundles: [
      { protocol: 'AXI4-Lite', prefix: 's_axil_', singleton: false, role: 'slave', signals: AXIL_SIGS.map(([n]) => ({ name: n, sig: n.replace('s_axil_', '') })) },
      { protocol: 'APB', prefix: 'p_', singleton: false, role: 'slave', signals: APB_SIGS.map(([n]) => ({ name: n, sig: n.replace('p_', '') })) },
      { protocol: 'clock', prefix: '', singleton: true, role: null, signals: [{ name: 'clk_i', sig: 'clk_i' }] },
      { protocol: 'reset', prefix: '', singleton: true, role: null, signals: [{ name: 'rst_n_i', sig: 'rst_n_i' }] },
    ],
    leftovers: ['irq_o'],
  },
};

function inst(path: string, module: string, params: Record<string, unknown> = {}, name = path.split('.').pop()!): DesignInstRow {
  return {
    path,
    name,
    module,
    parent: path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : null,
    depth: path.split('.').length - 1,
    src: 'rtl/ip/spike_ip.sv',
    params,
    instCount: 1,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  trpcMocks.getDef.mockResolvedValue(SPIKE_IP_DEF);
});

// ─── bundle 分组渲染 ────────────────────────────────────────

describe('ModuleInterfaceView bundle 分组（issue 04）', () => {
  it('选中 spike_ip 实例：按 AXI4-Lite / APB / clock / reset 分组渲染，不出现 76 行裸列表', async () => {
    const leaf = inst('spike_top.u_subsys0.gen_ip[0].u_ip', 'spike_ip', {}, 'gen_ip[0].u_ip');
    render(<ModuleInterfaceView projectId="proj-1" inst={leaf} />);

    expect(await screen.findByTestId('interface-group-AXI4-Lite')).toBeTruthy();
    expect(screen.getByTestId('interface-group-APB')).toBeTruthy();
    expect(screen.getByTestId('interface-group-clock')).toBeTruthy();
    expect(screen.getByTestId('interface-group-reset')).toBeTruthy();

    // 组内信号完整（AXI4-Lite 17 行）
    const axil = screen.getByTestId('interface-group-AXI4-Lite');
    expect(axil.querySelectorAll('[data-testid="interface-signal"]')).toHaveLength(17);

    // 组头带实例名与模块名
    expect(screen.getByTestId('interface-title')).toHaveTextContent('gen_ip[0].u_ip');
    expect(screen.getByTestId('interface-title')).toHaveTextContent('spike_ip');
  });

  it('组内信号显示 名称/方向/位宽（s_axil_awaddr input [11:0]）', async () => {
    render(<ModuleInterfaceView projectId="proj-1" inst={inst('spike_top.u_subsys0.gen_ip[0].u_ip', 'spike_ip')} />);

    const axil = await screen.findByTestId('interface-group-AXI4-Lite');
    const row = axil.querySelector('[data-testid="interface-signal"][data-signal="s_axil_awaddr"]')!;
    expect(row).toHaveTextContent('s_axil_awaddr');
    expect(row).toHaveTextContent('input');
    expect(row).toHaveTextContent('[11:0]');
  });

  it('role 推断徽标：AXI4-Lite 组头显示 [slave]', async () => {
    render(<ModuleInterfaceView projectId="proj-1" inst={inst('spike_top.u_subsys0.gen_ip[0].u_ip', 'spike_ip')} />);

    const axil = await screen.findByTestId('interface-group-AXI4-Lite');
    expect(axil.querySelector('[data-testid="interface-role"]')).toHaveTextContent('slave');
  });

  it('leftovers 单列显示未入束自定义信号（irq_o）', async () => {
    render(<ModuleInterfaceView projectId="proj-1" inst={inst('spike_top.u_subsys0.gen_ip[0].u_ip', 'spike_ip')} />);

    const leftovers = await screen.findByTestId('interface-leftovers');
    expect(leftovers).toHaveTextContent('irq_o');
  });

  it('组头显示信号计数（AXI4-Lite ×17）', async () => {
    render(<ModuleInterfaceView projectId="proj-1" inst={inst('spike_top.u_subsys0.gen_ip[0].u_ip', 'spike_ip')} />);

    const axil = await screen.findByTestId('interface-group-AXI4-Lite');
    expect(axil.querySelector('[data-testid="interface-group-header"]')).toHaveTextContent('17');
  });
});

// ─── 参数覆盖值展示 ────────────────────────────────────────

describe('ModuleInterfaceView 参数覆盖值（issue 04）', () => {
  it('实例 params 覆盖显示覆盖值与定义默认值（N_IP=2，默认 4）', async () => {
    render(
      <ModuleInterfaceView
        projectId="proj-1"
        inst={inst('spike_top.u_subsys0.gen_ip[0].u_ip', 'spike_ip', { N_IP: 2 })}
      />,
    );

    const params = await screen.findByTestId('interface-params');
    const row = params.querySelector('[data-testid="interface-param"][data-param="N_IP"]')!;
    expect(row).toHaveTextContent('2');
    expect(row).toHaveTextContent('4');
  });

  it('无参数覆盖时不渲染参数区', async () => {
    trpcMocks.getDef.mockResolvedValue({ ...SPIKE_IP_DEF, paramDefaults: {} });
    render(<ModuleInterfaceView projectId="proj-1" inst={inst('spike_top.u_subsys0.gen_ip[0].u_ip', 'spike_ip')} />);

    await waitFor(() => expect(screen.getByTestId('interface-title')).toBeTruthy());
    expect(screen.queryByTestId('interface-params')).toBeNull();
  });
});
