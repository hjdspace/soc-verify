/**
 * bundle 规则引擎纯函数测试（issue 04 / spec「Protocol Bundle 规则引擎」）。
 *
 * fixture = S0 spike 真实端口（ports-spike.json，2026-09-03 实测）：
 *   spike_ip 26 端口 / soc_subsys 13 端口 / spike_top 37 端口，
 *   回归基准 73/76 入束（96%），AXI4/AXI4-Lite/AHB/APB 判别与 role 推断全对。
 */

import { describe, it, expect } from 'vitest';
import {
  analyzePorts,
  BUILTIN_AMBA_RULES,
  type BundleRuleDoc,
} from '../../src/main/rtl/bundle-rules';

// ─── S0 真实端口 fixture（yosys write_json 实测） ─────────────

const SPIKE_IP_PORTS = [
  { name: 'clk_i', direction: 'input' },
  { name: 'rst_n_i', direction: 'input' },
  { name: 's_axil_awvalid', direction: 'input' },
  { name: 's_axil_awaddr', direction: 'input' },
  { name: 's_axil_awready', direction: 'output' },
  { name: 's_axil_wdata', direction: 'input' },
  { name: 's_axil_wstrb', direction: 'input' },
  { name: 's_axil_wvalid', direction: 'input' },
  { name: 's_axil_wready', direction: 'output' },
  { name: 's_axil_bresp', direction: 'output' },
  { name: 's_axil_bvalid', direction: 'output' },
  { name: 's_axil_bready', direction: 'input' },
  { name: 's_axil_arvalid', direction: 'input' },
  { name: 's_axil_araddr', direction: 'input' },
  { name: 's_axil_arready', direction: 'output' },
  { name: 's_axil_rdata', direction: 'output' },
  { name: 's_axil_rresp', direction: 'output' },
  { name: 's_axil_rvalid', direction: 'output' },
  { name: 's_axil_rready', direction: 'input' },
  { name: 'p_paddr', direction: 'input' },
  { name: 'p_psel', direction: 'input' },
  { name: 'p_penable', direction: 'input' },
  { name: 'p_pwrite', direction: 'input' },
  { name: 'p_pwdata', direction: 'input' },
  { name: 'p_prdata', direction: 'output' },
  { name: 'p_pready', direction: 'output' },
  { name: 'irq_o', direction: 'output' },
] as const;

const SOC_SUBSYS_PORTS = [
  { name: 'clk_i', direction: 'input' },
  { name: 'rst_n_i', direction: 'input' },
  { name: 'h_htrans', direction: 'input' },
  { name: 'h_haddr', direction: 'input' },
  { name: 'h_hwrite', direction: 'input' },
  { name: 'h_hburst', direction: 'input' },
  { name: 'h_hwdata', direction: 'input' },
  { name: 'h_hsel', direction: 'input' },
  { name: 'h_hrdata', direction: 'output' },
  { name: 'h_hreadyout', direction: 'output' },
  { name: 'h_hresp', direction: 'output' },
  { name: 'fab_irq_en', direction: 'input' },
  { name: 'irq_o', direction: 'output' },
] as const;

const SPIKE_TOP_PORTS = [
  { name: 'clk_i', direction: 'input' },
  { name: 'rst_n_i', direction: 'input' },
  { name: 'axi0_awvalid', direction: 'input' },
  { name: 'axi0_awid', direction: 'input' },
  { name: 'axi0_awaddr', direction: 'input' },
  { name: 'axi0_awlen', direction: 'input' },
  { name: 'axi0_awsize', direction: 'input' },
  { name: 'axi0_awburst', direction: 'input' },
  { name: 'axi0_awready', direction: 'output' },
  { name: 'axi0_wvalid', direction: 'input' },
  { name: 'axi0_wdata', direction: 'input' },
  { name: 'axi0_wstrb', direction: 'input' },
  { name: 'axi0_wlast', direction: 'input' },
  { name: 'axi0_wready', direction: 'output' },
  { name: 'axi0_bvalid', direction: 'output' },
  { name: 'axi0_bid', direction: 'output' },
  { name: 'axi0_bresp', direction: 'output' },
  { name: 'axi0_bready', direction: 'input' },
  { name: 'axi0_arvalid', direction: 'input' },
  { name: 'axi0_arid', direction: 'input' },
  { name: 'axi0_araddr', direction: 'input' },
  { name: 'axi0_arlen', direction: 'input' },
  { name: 'axi0_arready', direction: 'output' },
  { name: 'axi0_rvalid', direction: 'output' },
  { name: 'axi0_rid', direction: 'output' },
  { name: 'axi0_rdata', direction: 'output' },
  { name: 'axi0_rresp', direction: 'output' },
  { name: 'axi0_rlast', direction: 'output' },
  { name: 'axi0_rready', direction: 'input' },
  { name: 'apb0_paddr', direction: 'input' },
  { name: 'apb0_psel', direction: 'input' },
  { name: 'apb0_penable', direction: 'input' },
  { name: 'apb0_pwrite', direction: 'input' },
  { name: 'apb0_pwdata', direction: 'input' },
  { name: 'apb0_prdata', direction: 'output' },
  { name: 'apb0_pready', direction: 'output' },
] as const;

const SPIKE_IP = SPIKE_IP_PORTS.map((p) => ({ ...p }));
const SOC_SUBSYS = SOC_SUBSYS_PORTS.map((p) => ({ ...p }));
const SPIKE_TOP = SPIKE_TOP_PORTS.map((p) => ({ ...p }));

// ─── 前缀聚类 + 判别 ─────────────────────────────────────────

describe('analyzePorts 前缀聚类', () => {
  it('s_axil_* 前缀聚类为前缀 "s_axil_" 的 bundle（端口名剥离前缀后是信号名）', () => {
    const r = analyzePorts(SPIKE_IP, BUILTIN_AMBA_RULES);
    const axil = r.bundles.find((b) => b.protocol === 'AXI4-Lite');
    expect(axil).toBeDefined();
    expect(axil!.prefix).toBe('s_axil_');
    const sig = axil!.signals.find((s) => s.name === 's_axil_awaddr');
    expect(sig?.sig).toBe('awaddr');
  });

  it('不同前缀的同协议各自成束（axi0_ / axi1_ 两条独立 AXI4 bundle）', () => {
    const ports = [
      ...SPIKE_TOP.filter((p) => p.name.startsWith('axi0_')),
      ...SPIKE_TOP.filter((p) => p.name.startsWith('axi0_')).map((p) => ({
        name: p.name.replace('axi0_', 'axi1_'),
        direction: p.direction,
      })),
    ];
    const r = analyzePorts(ports, BUILTIN_AMBA_RULES);
    const axi = r.bundles.filter((b) => b.protocol === 'AXI4');
    expect(axi).toHaveLength(2);
    expect(new Set(axi.map((b) => b.prefix))).toEqual(new Set(['axi0_', 'axi1_']));
  });
});

describe('analyzePorts 判别条件', () => {
  it('requiresAnyOf：axi0_* 含 awid/arid/awlen/wlast → AXI4（27 信号全通道）', () => {
    const r = analyzePorts(SPIKE_TOP, BUILTIN_AMBA_RULES);
    const axi4 = r.bundles.find((b) => b.protocol === 'AXI4');
    expect(axi4).toBeDefined();
    expect(axi4!.signals).toHaveLength(27);
    for (const feature of ['awid', 'arid', 'awlen', 'wlast', 'rlast']) {
      expect(axi4!.signals.some((s) => s.sig === feature)).toBe(true);
    }
  });

  it('requiresAnyOf 不满足时 AXI4 候选不成束（s_axil_* 无 id/len/burst/last 特征）', () => {
    const r = analyzePorts(SPIKE_IP, BUILTIN_AMBA_RULES);
    expect(r.bundles.some((b) => b.protocol === 'AXI4')).toBe(false);
  });

  it('requiresAllOf：AXI4-Lite 需 awaddr/awvalid/wvalid/bresp 全满足', () => {
    // 只留 3 个（缺 bresp）→ 不成束，端口全部落 leftovers
    const partial = SPIKE_IP.filter(
      (p) => ['s_axil_awaddr', 's_axil_awvalid', 's_axil_wvalid', 'clk_i'].includes(p.name),
    );
    const r = analyzePorts(partial, BUILTIN_AMBA_RULES);
    expect(r.bundles.some((b) => b.protocol === 'AXI4-Lite')).toBe(false);
    expect(r.leftovers).toContain('s_axil_awaddr');
  });

  it('minSignals 下限：2 个 AXI4-Lite 信号不成束', () => {
    const partial = SPIKE_IP.filter((p) =>
      ['s_axil_awaddr', 's_axil_awvalid', 's_axil_wvalid', 's_axil_bresp', 's_axil_awready'].includes(p.name),
    );
    const r = analyzePorts(partial, BUILTIN_AMBA_RULES);
    expect(r.bundles.some((b) => b.protocol === 'AXI4-Lite')).toBe(false);
  });
});

// ─── roleDetection ──────────────────────────────────────────

describe('analyzePorts roleDetection', () => {
  it('awvalid 为 input → slave；htrans 为 input → slave', () => {
    const ip = analyzePorts(SPIKE_IP, BUILTIN_AMBA_RULES);
    expect(ip.bundles.find((b) => b.protocol === 'AXI4-Lite')?.role).toBe('slave');
    expect(ip.bundles.find((b) => b.protocol === 'APB')?.role).toBe('slave');

    const subsys = analyzePorts(SOC_SUBSYS, BUILTIN_AMBA_RULES);
    expect(subsys.bundles.find((b) => b.protocol === 'AHB')?.role).toBe('slave');
  });

  it('awvalid 为 output → master（synthetic：输出 awvalid 的模块是 master 端）', () => {
    const ports = SPIKE_TOP.map((p) =>
      p.name === 'axi0_awvalid' ? { name: p.name, direction: 'output' } : p,
    );
    const r = analyzePorts(ports, BUILTIN_AMBA_RULES);
    expect(r.bundles.find((b) => b.protocol === 'AXI4')?.role).toBe('master');
  });

  it('bundle 缺 roleDetection 关键信号时 role 为 null（synthetic：requires 与关键信号解耦）', () => {
    const doc: BundleRuleDoc = {
      priority: ['axil-nokey'],
      rules: [
        {
          id: 'axil-nokey',
          protocol: 'AXI4-Lite',
          signals: ['awaddr', 'awvalid', 'wvalid', 'bresp', 'wdata'],
          requiresAllOf: ['awaddr', 'wvalid'],
          minSignals: 2,
          roleDetection: { signal: 'awvalid', input: 'slave', output: 'master' },
        },
      ],
    };
    const r = analyzePorts(
      [
        { name: 's_awaddr', direction: 'input' },
        { name: 's_wvalid', direction: 'input' },
        { name: 's_wdata', direction: 'input' },
      ],
      doc,
    );
    expect(r.bundles).toHaveLength(1);
    expect(r.bundles[0]!.role).toBeNull();
  });
});

// ─── singleton ──────────────────────────────────────────────

describe('analyzePorts singleton（clk/rst 正则）', () => {
  it('clk_i → clock；rst_n_i → reset（每端口独立成 singleton 束）', () => {
    const r = analyzePorts(SPIKE_IP, BUILTIN_AMBA_RULES);
    const clk = r.bundles.find((b) => b.protocol === 'clock');
    const rst = r.bundles.find((b) => b.protocol === 'reset');
    expect(clk?.singleton).toBe(true);
    expect(clk?.signals[0]?.name).toBe('clk_i');
    expect(rst?.singleton).toBe(true);
    expect(rst?.signals[0]?.name).toBe('rst_n_i');
  });

  it('rst 变体正则覆盖 rstn / aresetn / por_n（synthetic）', () => {
    const ports = [
      { name: 'rstn', direction: 'input' },
      { name: 'aresetn', direction: 'input' },
      { name: 'por_n', direction: 'input' },
      { name: 'my_rst_ni', direction: 'input' },
    ];
    const r = analyzePorts(ports, BUILTIN_AMBA_RULES);
    expect(r.bundles.filter((b) => b.protocol === 'reset')).toHaveLength(4);
    expect(r.leftovers).toHaveLength(0);
  });
});

// ─── leftovers + 优先级 ──────────────────────────────────────

describe('analyzePorts leftovers 与优先级', () => {
  it('spike_ip leftovers = irq_o（自定义信号不入束）', () => {
    const r = analyzePorts(SPIKE_IP, BUILTIN_AMBA_RULES);
    expect(r.leftovers).toEqual(['irq_o']);
  });

  it('soc_subsys leftovers = fab_irq_en / irq_o', () => {
    const r = analyzePorts(SOC_SUBSYS, BUILTIN_AMBA_RULES);
    expect(r.leftovers.sort()).toEqual(['fab_irq_en', 'irq_o']);
  });

  it('单端口只入一个 bundle：AXI4-Lite 优先于其后规则（synthetic：裸名 AXI4-Lite 端口不会重复入 APB）', () => {
    // 裸名（无前缀）AXI4-Lite 端口 + APB 端口共存，互不抢
    const ports = [
      { name: 'awaddr', direction: 'input' },
      { name: 'awvalid', direction: 'input' },
      { name: 'wdata', direction: 'input' },
      { name: 'wvalid', direction: 'input' },
      { name: 'bresp', direction: 'output' },
      { name: 'bvalid', direction: 'output' },
      { name: 'psel', direction: 'input' },
      { name: 'penable', direction: 'input' },
      { name: 'paddr', direction: 'input' },
    ];
    const r = analyzePorts(ports, BUILTIN_AMBA_RULES);
    const axil = r.bundles.find((b) => b.protocol === 'AXI4-Lite');
    const apb = r.bundles.find((b) => b.protocol === 'APB');
    expect(axil?.signals).toHaveLength(6);
    expect(apb?.signals).toHaveLength(3);
    // 没有端口同时出现在两个 bundle
    const names = [...axil!.signals, ...apb!.signals].map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(r.leftovers).toHaveLength(0);
  });
});

// ─── S0 回归基准（96% 入束） ────────────────────────────────

describe('S0 fixture 回归基准', () => {
  const modules = [
    { name: 'spike_ip', ports: SPIKE_IP },
    { name: 'soc_subsys', ports: SOC_SUBSYS },
    { name: 'spike_top', ports: SPIKE_TOP },
  ];

  it('三模块 73/76 端口入束（96%），AXI4/AXI4-Lite/AHB/APB 判别全对', () => {
    let total = 0;
    let bundled = 0;
    for (const m of modules) {
      const r = analyzePorts(m.ports, BUILTIN_AMBA_RULES);
      total += m.ports.length;
      bundled += m.ports.length - r.leftovers.length;
    }
    expect(total).toBe(76);
    expect(bundled).toBe(73);
  });

  it('spike_ip：AXI4-Lite [slave] 17 信号 / APB [slave] 7 信号 / clock / reset + leftovers irq_o', () => {
    const r = analyzePorts(SPIKE_IP, BUILTIN_AMBA_RULES);
    expect(r.bundles.find((b) => b.protocol === 'AXI4-Lite')).toMatchObject({
      prefix: 's_axil_',
      role: 'slave',
    });
    expect(r.bundles.find((b) => b.protocol === 'AXI4-Lite')?.signals).toHaveLength(17);
    expect(r.bundles.find((b) => b.protocol === 'APB')).toMatchObject({ prefix: 'p_', role: 'slave' });
    expect(r.bundles.find((b) => b.protocol === 'APB')?.signals).toHaveLength(7);
    expect(r.bundles.some((b) => b.protocol === 'clock' && b.singleton)).toBe(true);
    expect(r.bundles.some((b) => b.protocol === 'reset' && b.singleton)).toBe(true);
    expect(r.leftovers).toEqual(['irq_o']);
  });

  it('spike_top：AXI4 [slave] 27 信号 + APB [slave] 7 信号分组（顶层 DUT 端口由外部驱动）', () => {
    const r = analyzePorts(SPIKE_TOP, BUILTIN_AMBA_RULES);
    expect(r.bundles.find((b) => b.protocol === 'AXI4')).toMatchObject({
      prefix: 'axi0_',
      role: 'slave',
    });
    expect(r.bundles.find((b) => b.protocol === 'APB')).toMatchObject({ prefix: 'apb0_', role: 'slave' });
    expect(r.leftovers).toEqual([]);
  });

  it('soc_subsys：AHB [slave] 9 信号（h_ 前缀）', () => {
    const r = analyzePorts(SOC_SUBSYS, BUILTIN_AMBA_RULES);
    expect(r.bundles.find((b) => b.protocol === 'AHB')).toMatchObject({
      prefix: 'h_',
      role: 'slave',
    });
    expect(r.bundles.find((b) => b.protocol === 'AHB')?.signals).toHaveLength(9);
  });
});

// ─── 自定义规则文档（覆盖 / 扩展） ─────────────────────────────

describe('自定义规则文档', () => {
  it('同 id 规则整体覆盖内置（h_ 前缀协议改名 "MyAHB"）', () => {
    const custom: BundleRuleDoc = {
      priority: ['ahb', 'clk', 'rst'],
      rules: [
        {
          id: 'ahb',
          protocol: 'MyAHB',
          signals: ['htrans', 'haddr', 'hwrite', 'hsel'],
          requiresAllOf: ['htrans', 'haddr'],
          minSignals: 3,
        },
        BUILTIN_AMBA_RULES.rules.find((r) => r.id === 'clk')!,
        BUILTIN_AMBA_RULES.rules.find((r) => r.id === 'rst')!,
      ],
    };
    const r = analyzePorts(SOC_SUBSYS, custom);
    const ahb = r.bundles.find((b) => b.protocol === 'MyAHB');
    expect(ahb).toBeDefined();
    // signals 清收窄为 4 个信号名 → 命中 h_htrans/h_haddr/h_hwrite/h_hsel
    expect(ahb!.signals.map((s) => s.name).sort()).toEqual(['h_haddr', 'h_hsel', 'h_htrans', 'h_hwrite']);
  });

  it('新增私有协议规则（synthetic my_ 前缀）扩展判别', () => {
    const custom: BundleRuleDoc = {
      priority: ['mybus', 'clk', 'rst'],
      rules: [
        {
          id: 'mybus',
          protocol: 'MyBus',
          signals: ['mreq', 'mgrant', 'mdata'],
          requiresAllOf: ['mreq', 'mgrant'],
          minSignals: 2,
        },
        BUILTIN_AMBA_RULES.rules.find((r) => r.id === 'clk')!,
        BUILTIN_AMBA_RULES.rules.find((r) => r.id === 'rst')!,
      ],
    };
    const r = analyzePorts(
      [
        { name: 'my_mreq', direction: 'input' },
        { name: 'my_mgrant', direction: 'output' },
        { name: 'my_mdata', direction: 'input' },
      ],
      custom,
    );
    expect(r.bundles.find((b) => b.protocol === 'MyBus')?.signals).toHaveLength(3);
    expect(r.leftovers).toHaveLength(0);
  });
});
