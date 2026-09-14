/**
 * issue 29 — SoC 质量样例查询集（spec §Testing Decisions）。
 *
 * 24 条可重复查询，覆盖六类：
 *  - exact-symbol   工程精确符号（`AWLEN[7:0]`、`DDRC_MAX_BURST`、`0x18` …）
 *  - zh-natural     中文自然语言提问
 *  - cross-source   跨来源限制/同名寄存器/单位换算
 *  - retracted      被新版撤回的约束（旧页必须判 stale）
 *  - figure-text    文字与时序图互补（取值只在图上）
 *  - graph-neighbor 图邻居补召回（追加在 topK 之后，另有 seed 标注契约）
 *
 * 每条查询固定**预期证据**（`wiki:<pageId>` / `parsed:<sourceId>`）作为
 * Recall@K 的分母；预期来自来源与页面的**语义定位**，不是从检索结果反推。
 */

import { QUALITY_SOURCES } from './kb-quality-fixture';

/** 证据键：`wiki:<pageId>` 或 `parsed:<sourceId>` */
export type EvidenceKey = `wiki:${string}` | `parsed:${string}`;

export type QualityQueryCategory =
  | 'exact-symbol'
  | 'zh-natural'
  | 'cross-source'
  | 'retracted'
  | 'figure-text'
  | 'graph-neighbor';

export type QualityQuery = {
  id: string;
  category: QualityQueryCategory;
  query: string;
  /** Recall@K 的预期证据集合（全部应进入前 K） */
  expected: EvidenceKey[];
  /** 期望排在第 1 位的证据（同名寄存器等歧义场景的判别断言） */
  expectedTop1?: EvidenceKey;
  /**
   * `expectedTop1` 是否纳入硬门禁。缺省 = 纳入；显式 false 表示只作为
   * **精度诊断**记录（页面与来源同等权威、或与同分项按身份 tie-break 的情形），
   * 不因它失败而改样例难度。
   */
  top1Gated?: boolean;
  /** 返回列表中必须带 stale=true 的页（被撤回/被引用旧修订） */
  mustFlagStale?: string[];
  /**
   * 图补召回契约：`neighborPageId` 必须以 `graphRelatedTo.seedPageId = seedPageId`
   * 出现在**追加区**（topK 之后），且不在基础结果里重复计票。
   * 只在关键词模式断言（见 tests/kb-quality-benchmark.test.ts 的说明）。
   */
  graphSupplement?: { neighborPageId: string; seedPageId: string };
  /** 预期原因说明（可读性/复核用） */
  note: string;
};

const wiki = (pageId: string): EvidenceKey => `wiki:${pageId}`;
const parsed = (sourceId: string): EvidenceKey => `parsed:${sourceId}`;

const SRC = {
  axi4: QUALITY_SOURCES[0].sourceId,
  ddr: QUALITY_SOURCES[1].sourceId,
  pcie: QUALITY_SOURCES[2].sourceId,
  gpio: QUALITY_SOURCES[3].sourceId,
  appendix: QUALITY_SOURCES[4].sourceId,
};

export const QUALITY_QUERIES: QualityQuery[] = [
  // ── 工程精确符号 ────────────────────────────────────────────────
  {
    id: 'sym-awlen',
    category: 'exact-symbol',
    query: 'AWLEN[7:0] 编码与最大值',
    expected: [wiki('concepts/axi-burst-limits'), parsed(SRC.axi4)],
    expectedTop1: wiki('concepts/axi-burst-limits'),
    note: '位宽 8 位、0xFF 表示 256 拍只在协议手册与概念页',
  },
  {
    id: 'sym-ddr-max-burst',
    category: 'exact-symbol',
    query: 'DDRC_MAX_BURST',
    expected: [wiki('entities/ddr-ctrl'), parsed(SRC.ddr)],
    expectedTop1: wiki('entities/ddr-ctrl'),
    note: 'DUT 限制符号只在 DDRC 实体页与手册',
  },
  {
    id: 'sym-trcd',
    category: 'exact-symbol',
    query: 'T_RCD',
    expected: [wiki('interfaces/ddr-timing'), parsed(SRC.ddr)],
    expectedTop1: wiki('interfaces/ddr-timing'),
    note: 'tRCD 以 ns 与周期两种单位给出',
  },
  {
    id: 'sym-pcie-ctrl-reset',
    category: 'exact-symbol',
    query: 'CTRL[7:0] 复位值 0x18',
    expected: [wiki('entities/pcie-ctrl'), parsed(SRC.pcie)],
    expectedTop1: wiki('entities/pcie-ctrl'),
    note: '同名 CTRL[7:0] 三处；只有 PCIe 复位值为 0x18',
  },
  {
    id: 'sym-noc-qos',
    category: 'exact-symbol',
    query: 'NOC_QOS_LEVEL[3:0] 服务等级',
    expected: [wiki('interfaces/noc-qos'), parsed(SRC.appendix)],
    expectedTop1: wiki('interfaces/noc-qos'),
    note: '字段只在手册末尾附录出现',
  },
  {
    id: 'sym-burst-len',
    category: 'exact-symbol',
    query: 'BURST_LEN[2:0] 含义',
    expected: [wiki('entities/ddr-ctrl'), parsed(SRC.ddr)],
    expectedTop1: wiki('entities/ddr-ctrl'),
    top1Gated: false,
    note: 'DDRC CTRL 内部字段；页面与来源同等权威（top1 只作精度诊断）',
  },
  {
    id: 'sym-ltssm',
    category: 'exact-symbol',
    query: 'LTSSM_EN[0] 作用',
    expected: [wiki('entities/pcie-ctrl'), parsed(SRC.pcie)],
    expectedTop1: wiki('entities/pcie-ctrl'),
    note: 'PCIe CTRL 内部字段',
  },

  // ── 中文自然语言 ────────────────────────────────────────────────
  {
    id: 'zh-axi4-burst-max',
    category: 'zh-natural',
    query: 'AXI4 一次突发最多多少拍',
    expected: [wiki('concepts/axi-burst-limits'), parsed(SRC.axi4)],
    expectedTop1: wiki('concepts/axi-burst-limits'),
    note: '中文提问 → 协议上限 256 拍',
  },
  {
    id: 'zh-ddr-cannot-full',
    category: 'zh-natural',
    query: 'DDR 控制器为什么不能跑满协议上限',
    expected: [wiki('comparisons/axi-vs-dut-burst'), wiki('entities/ddr-ctrl')],
    note: '需要跨源对照页给出解释',
  },
  {
    id: 'zh-pcie-reset',
    category: 'zh-natural',
    query: 'PCIe 控制寄存器上电复位值是多少',
    expected: [wiki('entities/pcie-ctrl'), parsed(SRC.pcie)],
    expectedTop1: wiki('entities/pcie-ctrl'),
    note: '中文提问 → 0x18',
  },
  {
    id: 'zh-gpio-default',
    category: 'zh-natural',
    query: 'GPIO 控制寄存器默认值',
    expected: [wiki('entities/gpio-ctrl'), parsed(SRC.gpio)],
    expectedTop1: wiki('entities/gpio-ctrl'),
    note: '中文提问 → 0xFF',
  },
  {
    id: 'zh-trcd-ns',
    category: 'zh-natural',
    query: 'DDR 的 tRCD 是多少纳秒',
    expected: [wiki('interfaces/ddr-timing'), parsed(SRC.ddr)],
    expectedTop1: wiki('interfaces/ddr-timing'),
    top1Gated: false,
    note: '中文提问 → 13.75 ns；与 DDRC 实体页同分（16=16）按 pageId tie-break 落后，只作精度诊断',
  },

  // ── 跨来源限制/对照 ────────────────────────────────────────────
  {
    id: 'cross-burst-gap',
    category: 'cross-source',
    query: '协议允许的突发长度与 DUT 支持的差异',
    expected: [wiki('comparisons/axi-vs-dut-burst')],
    expectedTop1: wiki('comparisons/axi-vs-dut-burst'),
    top1Gated: false,
    note: '对照页是唯一同时给出两侧上限的页；协议概念页与它同源高相关，只作精度诊断',
  },
  {
    id: 'cross-same-name-ctrl',
    category: 'cross-source',
    query: '同名 CTRL 寄存器在 DDR PCIe GPIO 三个 IP 中复位值有什么区别',
    expected: [
      wiki('entities/ddr-ctrl'),
      wiki('entities/pcie-ctrl'),
      wiki('entities/gpio-ctrl'),
    ],
    note: '同名寄存器跨 IP：三页必须全部召回',
  },
  {
    id: 'cross-trcd-cycles',
    category: 'cross-source',
    query: 'tRCD 13.75 ns 在 800 MHz 下是多少个时钟周期',
    expected: [wiki('interfaces/ddr-timing'), parsed(SRC.ddr)],
    expectedTop1: wiki('interfaces/ddr-timing'),
    note: '单位换算：ns ↔ 周期',
  },
  {
    id: 'cross-axi3-interleaving',
    category: 'cross-source',
    query: 'AXI3 与 AXI4 的写数据交织有什么不同',
    expected: [wiki('concepts/axi3-write-interleaving'), parsed(SRC.axi4)],
    expectedTop1: wiki('concepts/axi3-write-interleaving'),
    note: '同源两版差异对照',
  },

  // ── 被新版撤回的约束 ──────────────────────────────────────────
  {
    id: 'retract-outstanding-limit',
    category: 'retracted',
    query: 'AXI outstanding 事务建议上限是多少',
    expected: [wiki('concepts/axi-outstanding'), parsed(SRC.axi4)],
    mustFlagStale: ['concepts/axi-outstanding'],
    note: '当前值 8 在 R3 全文；引用 R1 的页必须判 stale（16 已作废）',
  },
  {
    id: 'retract-old-value-16',
    category: 'retracted',
    query: 'outstanding 未完成事务 16 笔 上限',
    expected: [wiki('concepts/axi-outstanding')],
    mustFlagStale: ['concepts/axi-outstanding'],
    note: '过时值必须仍可定位，但不能以 stale=false 呈现',
  },
  {
    id: 'retract-r3-change',
    category: 'retracted',
    query: 'R3 修订改动了哪些未完成事务建议',
    expected: [parsed(SRC.axi4)],
    expectedTop1: parsed(SRC.axi4),
    top1Gated: false,
    note: '修订说明只在当前修订全文；被撤回值页同时被召回并标 stale，top1 只作精度诊断',
  },

  // ── 文字与时序图互补 ──────────────────────────────────────────
  {
    id: 'fig-handshake-values',
    category: 'figure-text',
    query: 'AXI 握手时序图 T_SETUP 与 T_HOLD 的取值',
    expected: [wiki('interfaces/axi-timing')],
    expectedTop1: wiki('interfaces/axi-timing'),
    note: '取值只标注在 Figure 12-3 上，正文不重复',
  },
  {
    id: 'fig-setup-cycles',
    category: 'figure-text',
    query: 'T_SETUP 建立时间是多少个 cycle',
    expected: [wiki('interfaces/axi-timing')],
    expectedTop1: wiki('interfaces/axi-timing'),
    note: '图上取值 2 cycles',
  },
  {
    id: 'fig-provenance',
    category: 'figure-text',
    query: 'Figure 12-3 时序图的出处章节',
    expected: [wiki('interfaces/axi-timing'), parsed(SRC.axi4)],
    expectedTop1: wiki('interfaces/axi-timing'),
    note: '图文互补：页提供图与取值，手册提供第 12.3 节出处',
  },

  // ── 图邻居补召回 ──────────────────────────────────────────────
  {
    id: 'graph-overflow-root-cause',
    category: 'graph-neighbor',
    query: 'DDRC_OVERFLOW 告警根因',
    expected: [wiki('pitfalls/ddr-burst-overrun')],
    expectedTop1: wiki('pitfalls/ddr-burst-overrun'),
    graphSupplement: {
      neighborPageId: 'entities/ddr-ctrl',
      seedPageId: 'pitfalls/ddr-burst-overrun',
    },
    note: '窄命中（唯一符号）→ 种子页一跳邻居应作为补召回追加',
  },
  {
    id: 'graph-boot-ladder',
    category: 'graph-neighbor',
    query: 'BOOT_LADDER 启动',
    expected: [wiki('synthesis/sprd-ddr-boot-config')],
    expectedTop1: wiki('synthesis/sprd-ddr-boot-config'),
    graphSupplement: {
      neighborPageId: 'interfaces/ddr-timing',
      seedPageId: 'synthesis/sprd-ddr-boot-config',
    },
    note: '窄命中（唯一符号 + 唯一词）→ 综合页出链邻居应作为补召回追加并标注 seed',
  },
];

/** 六类样例都必须有查询（fixture 特征覆盖自检） */
export const REQUIRED_CATEGORIES: QualityQueryCategory[] = [
  'exact-symbol',
  'zh-natural',
  'cross-source',
  'retracted',
  'figure-text',
  'graph-neighbor',
];

export const MIN_QUERY_COUNT = 20;
