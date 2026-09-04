/**
 * Protocol Bundle 规则引擎（issue 04 / ADR 0032 主题 3 / spec 决策 11-15）。
 *
 * bundle 是平台自研语义层（yosys 只认位向量不认协议）：对 Module Definition
 * 的端口做命名模式匹配，规则形态经 S0 原型验证（96% 入束）——
 *   prefixOf 前缀聚类（axi0_awvalid → 前缀 axi0_）
 *   requiresAnyOf / requiresAllOf + minSignals 判别
 *   roleDetection 按关键信号方向推断 master/slave
 *   singleton 正则（clk / rst 变体）
 * 规则按 priority 顺序匹配，单端口只入一个 bundle；未入束端口进 leftovers。
 *
 * 纯函数模块（不依赖 fs）：自定义规则文件加载见 design-service（refresh 时读取）。
 */

import type {
  BundleGroup,
  BundleRule,
  BundleRuleDoc,
  PortAnalysis,
} from './types';

export type { BundleRuleDoc };

// ─── 内置 AMBA 规则包（S0 bundle-rules.json 原样移植） ──────────

export const BUILTIN_AMBA_RULES: BundleRuleDoc = {
  priority: ['axi4', 'axi4lite', 'ahb', 'apb', 'clk', 'rst'],
  rules: [
    {
      id: 'axi4',
      protocol: 'AXI4',
      description: 'AMBA AXI4 full channel interface (5 channels)',
      signals: [
        'awid', 'awaddr', 'awlen', 'awsize', 'awburst', 'awlock', 'awcache', 'awprot', 'awqos', 'awregion', 'awuser', 'awvalid', 'awready',
        'wdata', 'wstrb', 'wlast', 'wuser', 'wvalid', 'wready',
        'bid', 'bresp', 'buser', 'bvalid', 'bready',
        'arid', 'araddr', 'arlen', 'arsize', 'arburst', 'arlock', 'arcache', 'arprot', 'arqos', 'arregion', 'aruser', 'arvalid', 'arready',
        'rid', 'rdata', 'rresp', 'rlast', 'ruser', 'rvalid', 'rready',
      ],
      requiresAnyOf: ['awid', 'arid', 'awlen', 'arlen', 'awburst', 'arburst', 'wlast'],
      roleDetection: { signal: 'awvalid', input: 'slave', output: 'master' },
      minSignals: 8,
    },
    {
      id: 'axi4lite',
      protocol: 'AXI4-Lite',
      description: 'AMBA AXI4-Lite (no IDs, no burst, 5 channels)',
      signals: [
        'awaddr', 'awprot', 'awvalid', 'awready',
        'wdata', 'wstrb', 'wvalid', 'wready',
        'bresp', 'bvalid', 'bready',
        'araddr', 'arprot', 'arvalid', 'arready',
        'rdata', 'rresp', 'rvalid', 'rready',
      ],
      requiresAllOf: ['awaddr', 'awvalid', 'wvalid', 'bresp'],
      roleDetection: { signal: 'awvalid', input: 'slave', output: 'master' },
      minSignals: 6,
    },
    {
      id: 'ahb',
      protocol: 'AHB',
      description: 'AMBA AHB (single-channel, htrans/haddr/hwrite core)',
      signals: [
        'htrans', 'haddr', 'hwrite', 'hsize', 'hburst', 'hprot', 'hwdata', 'hrdata',
        'hsel', 'hready', 'hreadyout', 'hresp', 'hmaster', 'hmastlock', 'hnonsec', 'hexcl',
      ],
      requiresAllOf: ['htrans', 'haddr', 'hwrite'],
      roleDetection: { signal: 'htrans', input: 'slave', output: 'master' },
      minSignals: 4,
    },
    {
      id: 'apb',
      protocol: 'APB',
      description: 'AMBA APB (penable/psel handshake)',
      signals: [
        'paddr', 'pprot', 'penable', 'psel', 'pwrite', 'pwdata', 'pstrb', 'pready',
        'prdata', 'pslverr', 'pwakeup', 'pauser', 'pwuser', 'pruser', 'pparity',
      ],
      requiresAllOf: ['psel', 'penable', 'paddr'],
      roleDetection: { signal: 'psel', input: 'slave', output: 'master' },
      minSignals: 3,
    },
    {
      id: 'clk',
      protocol: 'clock',
      description: 'Clock signal singleton',
      singleton: true,
      pattern: '^(?:a?clk(?:_i|_in)?|(?:[a-z0-9]+_)*clk(?:_i)?)$',
    },
    {
      id: 'rst',
      protocol: 'reset',
      description: 'Reset signal singleton',
      singleton: true,
      pattern: '^(?:rstn|rst_ni|rst_n_i|rst_n|rst|resetn|reset_ni|reset_n|aresetn|areset|por_n|(?:[a-z0-9]+_)*rst_ni?|(?:[a-z0-9]+_)*reset_n?)$',
    },
  ],
};

// ─── 引擎 ────────────────────────────────────────────────────

type PortDir = { name: string; direction: string };

/** 端口名以 `_<sig>` 结尾（或等于 sig）→ 聚类前缀（含分隔 `_`，端口名 = prefix + sig）；不匹配返回 null */
export function prefixOf(portName: string, sig: string): string | null {
  if (portName === sig) return '';
  if (portName.endsWith(`_${sig}`)) return portName.slice(0, portName.length - sig.length);
  return null;
}

/**
 * 端口打标主入口：对 Module Definition 的端口表执行规则文档，
 * 产出 bundle 分组 + leftovers（S0 bundle-test.mjs 原型的 TS 化）。
 */
export function analyzePorts(ports: PortDir[], doc: BundleRuleDoc): PortAnalysis {
  const byName = new Map(ports.map((p) => [p.name, p]));
  const matched = new Set<string>();
  const bundles: BundleGroup[] = [];

  for (const ruleId of doc.priority) {
    const rule = doc.rules.find((r) => r.id === ruleId);
    if (!rule) continue;

    if (rule.singleton) {
      matchSingleton(rule, ports, matched, bundles);
      continue;
    }
    matchPrefixed(rule, ports, byName, matched, bundles);
  }

  const leftovers = ports.filter((p) => !matched.has(p.name)).map((p) => p.name);
  return { bundles, leftovers };
}

/** singleton 规则：每个未匹配且命中正则的端口独立成束（clk/rst） */
function matchSingleton(rule: BundleRule, ports: PortDir[], matched: Set<string>, bundles: BundleGroup[]): void {
  const re = new RegExp(rule.pattern ?? /^$/);
  for (const p of ports) {
    if (matched.has(p.name) || !re.test(p.name)) continue;
    bundles.push({
      protocol: rule.protocol,
      prefix: '',
      singleton: true,
      role: null,
      signals: [{ name: p.name, sig: p.name }],
    });
    matched.add(p.name);
  }
}

/** 前缀聚类规则：按 prefix 分桶 → requires/minSignals 判别 → roleDetection */
function matchPrefixed(
  rule: BundleRule,
  ports: PortDir[],
  byName: Map<string, PortDir>,
  matched: Set<string>,
  bundles: BundleGroup[],
): void {
  const sigs = rule.signals ?? [];
  // 前缀分桶（一个端口最多匹配该规则的一个信号）
  const byPrefix = new Map<string, { name: string; sig: string }[]>();
  for (const p of ports) {
    if (matched.has(p.name)) continue;
    for (const sig of sigs) {
      const pfx = prefixOf(p.name, sig);
      if (pfx !== null) {
        const bucket = byPrefix.get(pfx) ?? [];
        bucket.push({ name: p.name, sig });
        byPrefix.set(pfx, bucket);
        break;
      }
    }
  }

  for (const [pfx, signals] of byPrefix) {
    const sigNames = new Set(signals.map((s) => s.sig));
    const okAny = !rule.requiresAnyOf || rule.requiresAnyOf.some((r) => sigNames.has(r));
    const okAll = !rule.requiresAllOf || rule.requiresAllOf.every((r) => sigNames.has(r));
    const okMin = signals.length >= (rule.minSignals ?? 1);
    if (!(okAny && okAll && okMin)) continue;

    bundles.push({
      protocol: rule.protocol,
      prefix: pfx,
      singleton: false,
      role: detectRole(rule, signals, byName),
      signals,
    });
    for (const s of signals) matched.add(s.name);
  }
}

/** 按关键信号方向推断 master/slave（awvalid input → slave） */
function detectRole(rule: BundleRule, signals: { name: string; sig: string }[], byName: Map<string, PortDir>): string | null {
  const det = rule.roleDetection;
  if (!det) return null;
  const key = signals.find((s) => s.sig === det.signal);
  if (!key) return null;
  const port = byName.get(key.name);
  return port ? (port.direction === 'input' ? det.input : det.output) : null;
}
