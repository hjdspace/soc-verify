/**
 * issue 29 — 合成 SoC 知识库 fixture（spec §Testing Decisions「检索与模型质量样例」）。
 *
 * 目的：给「验收 SoC 知识与检索证据质量」提供**可重复、无需模型端点**的小库，
 * 覆盖 spec 点名的六类样例特征：
 *
 *  1. 协议上限与 DUT 限制不同（AXI4 `AWLEN[7:0]` 256 拍 vs DDRC 8 拍）
 *  2. 同名寄存器跨 IP（`CTRL[7:0]` 在 DDRC / PCIe / GPIO 三处复位值不同）
 *  3. 不同单位（`T_RCD = 13.75 ns` 与「800 MHz 下 11 个时钟周期」）
 *  4. 被新版撤回的约束（outstanding 建议上限 16 → 8；旧页引用已失效修订）
 *  5. 文字与时序图互补（手册正文只给图形出处，取值只在 Figure 12-3 上）
 *  6. 只在手册末尾出现的字段（附录寄存器索引的 `NOC_QOS_LEVEL[3:0]`）
 *
 * fixture 是**编译产物的形状**（已发布页 + 当前 parsed 全文 + manifest），
 * 不是模型质量结论；真实模型编译见 issue 29 交接的「未覆盖」节。
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { initWikiLayout, writeWikiManifest, wikiLayout } from '../../src/main/kb/wiki-layout';
import type { WikiKbManifest } from '../../src/main/kb/wiki-layout';
import { sourceIdFor } from '../../src/main/kb/source-identity';
import type { WikiPageType, WikiSourceRef } from '@shared/kb-types';

export const QUALITY_KB_ID = 'kb-quality-29';
export const QUALITY_KB_NAME = 'SoC 验证知识质量样例库';
export const FIXTURE_CREATED_AT = '2026-09-14T00:00:00Z';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf-8').digest('hex');

/** 1×1 PNG：时序图资产占位（内容是 fixture 内部约定，检索只关心引用完整性） */
const FIGURE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ── 来源 ────────────────────────────────────────────────────────

export type QualitySourceRevision = {
  /** 修订 id（= 该修订原件字节的 SHA256；fixture 直接用可读 id） */
  revision: string;
  text: string;
};

export type QualitySource = {
  sourceId: string;
  /** raw/sources/ 下的规范相对路径（含扩展名） */
  sourcePath: string;
  ext: string;
  /** 当前修订（manifest.currentRevision） */
  currentRevision: string;
  /** 被引用的历史修订（保留在 raw/revisions/，spec §1 要求旧原件可读） */
  revisions: QualitySourceRevision[];
  /** raw/parsed/<sourcePath>.md 的当前全文 */
  parsedText: string;
  assetCount: number;
};

/** AXI4 协议手册：协议上限 / AXI3 差异 / 被撤回的 outstanding 建议 / 图 12-3 出处 */
const SRC_AXI4: QualitySource = {
  sourceId: sourceIdFor('protocol/amba_axi4_spec.pdf'),
  sourcePath: 'protocol/amba_axi4_spec.pdf',
  ext: '.pdf',
  currentRevision: 'rev3-a41f',
  revisions: [
    {
      revision: 'rev1-7a11',
      text: [
        '# AMBA AXI 协议规范（R1）',
        '',
        '## 4.7 未完成事务建议',
        '',
        '每 ID 不超过 16 笔未完成事务为建议上限。',
        '',
        '## 3.5 写数据交织',
        '',
        'AXI3 允许 WDATA 按 WID 交织。',
        '',
      ].join('\n'),
    },
  ],
  parsedText: [
    '# AMBA AXI4 协议规范（R3 摘录）',
    '',
    '## 3.2 突发长度',
    '',
    'AWLEN[7:0] 与 ARLEN[7:0] 为 8 位字段。INCR 突发的长度范围为 1–256 拍；',
    '当 AxLEN = 0xFF 时表示 256 拍，此时突发不得跨越 4KB 边界。',
    '',
    '## 3.5 写数据交织',
    '',
    'AXI4 不支持 write data interleaving；AXI3 允许 WDATA 按 WID 交织。',
    '',
    '## 4.7 未完成事务建议',
    '',
    '本修订（R3）将第 4.7 节的 outstanding 建议上限由 16 笔修订为 8 笔。',
    '自本修订起，每 ID 不超过 8 笔未完成事务为建议上限；旧值 16 笔作废。',
    '',
    '## 12.3 握手时序',
    '',
    'AXI 通道的建立时间与保持时间要求见图 12-3（时序图）。',
    '图中标注的 T_SETUP 与 T_HOLD 为本节唯一权威取值，正文不重复给出数值。',
    '',
  ].join('\n'),
  assetCount: 1,
};

/** DDR 控制器用户手册：DUT 限制 / ns 与周期两种单位 / CTRL[7:0] 复位值 0x00 */
const SRC_DDR: QualitySource = {
  sourceId: sourceIdFor('ip/ddr_ctrl_ug.pdf'),
  sourcePath: 'ip/ddr_ctrl_ug.pdf',
  ext: '.pdf',
  currentRevision: 'rev2-b7c0',
  revisions: [],
  parsedText: [
    '# DDR 控制器用户手册（Rev 2）',
    '',
    '## 2.1 总线接口限制',
    '',
    'DDRC 的总线接口只支持长度不超过 8 拍的 INCR 突发：',
    '`DDRC_MAX_BURST = 8` beats。超过 8 拍的突发会被接口拒绝并回 error 响应。',
    '',
    '## 2.2 时序参数',
    '',
    'tRCD（T_RCD）= 13.75 ns（在 800 MHz 时钟下等价于 11 个时钟周期）。',
    '',
    '## 3.4 控制寄存器 CTRL',
    '',
    '偏移 0x00 的控制寄存器 CTRL[7:0]，复位值 0x00。',
    '其中 BURST_LEN[2:0] 选择接口突发长度，取值 1–8。',
    '',
  ].join('\n'),
  assetCount: 0,
};

/** PCIe 控制器用户手册：同名寄存器 CTRL[7:0]，复位值 0x18 */
const SRC_PCIE: QualitySource = {
  sourceId: sourceIdFor('ip/pcie_ctrl_ug.pdf'),
  sourcePath: 'ip/pcie_ctrl_ug.pdf',
  ext: '.pdf',
  currentRevision: 'rev1-91de',
  revisions: [],
  parsedText: [
    '# PCIe 控制器用户手册（Rev 1）',
    '',
    '## 4.1 控制寄存器 CTRL',
    '',
    '偏移 0x00 的控制寄存器 CTRL[7:0]，复位值 0x18。',
    '其中 LTSSM_EN[0] 为链路训练使能位。',
    '',
  ].join('\n'),
  assetCount: 0,
};

/** GPIO 控制器用户手册：第三个同名寄存器 CTRL[7:0]，复位值 0xFF */
const SRC_GPIO: QualitySource = {
  sourceId: sourceIdFor('ip/gpio_ctrl_ug.pdf'),
  sourcePath: 'ip/gpio_ctrl_ug.pdf',
  ext: '.pdf',
  currentRevision: 'rev1-33aa',
  revisions: [],
  parsedText: [
    '# GPIO 控制器用户手册（Rev 1）',
    '',
    '## 5.1 控制寄存器 CTRL',
    '',
    '偏移 0x00 的控制寄存器 CTRL[7:0]，复位值 0xFF（上电后全部引脚为输入态）。',
    '',
  ].join('\n'),
  assetCount: 0,
};

/** 附录寄存器索引：只在手册末尾出现的字段 */
const SRC_APPENDIX: QualitySource = {
  sourceId: sourceIdFor('appendix/register_index.md'),
  sourcePath: 'appendix/register_index.md',
  ext: '.md',
  currentRevision: 'rev1-5c02',
  revisions: [],
  parsedText: [
    '# 寄存器索引（附录 A）',
    '',
    '## A.1 全局寄存器',
    '',
    'GLOBAL_ID[15:0]、GLOBAL_VER[7:0]。',
    '',
    '## A.2 NoC 寄存器',
    '',
    'NOC_QOS_LEVEL[3:0] 决定 NoC 请求的服务等级，复位值 0x0。',
    '该字段只在本附录列出，正文未展开。',
    '',
  ].join('\n'),
  assetCount: 0,
};

export const QUALITY_SOURCES: QualitySource[] = [
  SRC_AXI4,
  SRC_DDR,
  SRC_PCIE,
  SRC_GPIO,
  SRC_APPENDIX,
];

export const SOURCE_BY_ID = new Map(QUALITY_SOURCES.map((s) => [s.sourceId, s]));

/** 构造来源引用（缺省引用当前修订） */
export function sourceRef(source: QualitySource, revision?: string): WikiSourceRef {
  const rev = revision ?? source.currentRevision;
  const text = rev === source.currentRevision
    ? source.parsedText
    : source.revisions.find((r) => r.revision === rev)?.text ?? source.parsedText;
  return { sourceId: source.sourceId, sourceRevision: rev, parsedHash: sha256(text) };
}

/** 撤回前的修订 id（被 `concepts/axi-outstanding` 引用 → 该页必须判 stale） */
export const RETRACTED_REVISION = 'rev1-7a11';

// ── 时序图资产（图文互补）─────────────────────────────────────────

export const TIMING_FIGURE = {
  fileName: 'fig-12-3-timing.png',
  /** 正文不重复、只在图上标注的取值（vision 解读产出） */
  facts: [
    { literal: 'T_SETUP = 2 cycles', note: '图 12-3 标注的建立时间' },
    { literal: 'T_HOLD = 1 cycle', note: '图 12-3 标注的保持时间' },
  ],
} as const;

// ── 页面 ────────────────────────────────────────────────────────

export type QualityPage = {
  pageId: string;
  type: WikiPageType;
  title: string;
  summary: string;
  keywords: string[];
  tags: string[];
  sources: WikiSourceRef[];
  body: string;
};

export const QUALITY_PAGES: QualityPage[] = [
  {
    pageId: 'concepts/axi-burst-limits',
    type: 'concept',
    title: 'AXI4 突发长度上限',
    summary: 'AXI4 INCR 突发的长度范围、AxLEN 编码与 4KB 边界约束。',
    keywords: ['AXI4', 'AWLEN[7:0]', '突发', '长度', '上限'],
    tags: ['协议'],
    sources: [sourceRef(SRC_AXI4)],
    body: [
      '## 长度范围',
      '',
      'INCR 突发的长度范围为 1–256 拍；AWLEN[7:0] 为 8 位字段，',
      '当 AxLEN = 0xFF 时表示 256 拍。突发不得跨越 4KB 边界。',
      '',
      '跨源差异见 [[comparisons/axi-vs-dut-burst]]。',
      '',
    ].join('\n'),
  },
  {
    pageId: 'concepts/axi-outstanding',
    type: 'concept',
    title: 'AXI outstanding 事务建议上限',
    summary: '每 ID 未完成事务的建议上限（本页引用的是已被撤回的旧修订）。',
    keywords: ['outstanding', '未完成事务', '上限'],
    tags: ['协议'],
    // 引用 rev1：manifest 当前修订已是 rev3 → 本页必须被判 stale
    sources: [sourceRef(SRC_AXI4, RETRACTED_REVISION)],
    body: [
      '## 建议上限',
      '',
      '每 ID 不超过 16 笔未完成事务为建议上限。',
      '',
    ].join('\n'),
  },
  {
    pageId: 'concepts/axi3-write-interleaving',
    type: 'concept',
    title: 'AXI3 写数据交织差异',
    summary: 'AXI3 允许 WDATA 按 WID 交织，AXI4 取消了该能力。',
    keywords: ['AXI3', 'AXI4', 'write data interleaving', '交织'],
    tags: ['协议'],
    sources: [sourceRef(SRC_AXI4)],
    body: [
      '## 差异',
      '',
      'AXI3 允许 WDATA 按 WID 交织；AXI4 不支持 write data interleaving。',
      '',
    ].join('\n'),
  },
  {
    pageId: 'entities/ddr-ctrl',
    type: 'entity',
    title: 'DDR 控制器（DDRC）',
    summary: 'DDRC 总线接口限制、时序参数与控制寄存器。',
    keywords: ['DDRC', 'DDR 控制器', 'DDRC_MAX_BURST', 'CTRL[7:0]'],
    tags: ['IP', 'DDR'],
    sources: [sourceRef(SRC_DDR)],
    body: [
      '## 接口限制',
      '',
      'DDRC 只支持长度不超过 8 拍的 INCR 突发：DDRC_MAX_BURST = 8 beats。',
      '',
      '## 寄存器',
      '',
      'CTRL[7:0]（偏移 0x00）复位值 0x00，其中 BURST_LEN[2:0] 选择突发长度。',
      '',
      '时序参数见 [[interfaces/ddr-timing]]，跨源差异见 [[comparisons/axi-vs-dut-burst]]。',
      '',
    ].join('\n'),
  },
  {
    pageId: 'entities/pcie-ctrl',
    type: 'entity',
    title: 'PCIe 控制器（PCIeC）',
    summary: 'PCIe 控制器的同名控制寄存器与复位值。',
    keywords: ['PCIe', 'PCIeC', 'CTRL[7:0]', 'LTSSM_EN[0]'],
    tags: ['IP', 'PCIe'],
    sources: [sourceRef(SRC_PCIE)],
    body: [
      '## 寄存器',
      '',
      'CTRL[7:0]（偏移 0x00）复位值 0x18；LTSSM_EN[0] 为链路训练使能位。',
      '',
    ].join('\n'),
  },
  {
    pageId: 'entities/gpio-ctrl',
    type: 'entity',
    title: 'GPIO 控制器（GPIOC）',
    summary: 'GPIO 控制器的同名控制寄存器与上电默认态。',
    keywords: ['GPIO', 'GPIOC', 'CTRL[7:0]'],
    tags: ['IP', 'GPIO'],
    sources: [sourceRef(SRC_GPIO)],
    body: [
      '## 寄存器',
      '',
      'CTRL[7:0]（偏移 0x00）复位值 0xFF，上电后全部引脚为输入态。',
      '',
    ].join('\n'),
  },
  {
    pageId: 'comparisons/axi-vs-dut-burst',
    type: 'comparison',
    title: 'AXI4 协议上限与 DDRC 限制对照',
    summary: '协议允许 256 拍，DDRC 接口只接受 8 拍。',
    keywords: ['协议', 'DUT', '限制', '差异', '突发'],
    tags: ['对照'],
    sources: [sourceRef(SRC_AXI4), sourceRef(SRC_DDR)],
    body: [
      '## 对照',
      '',
      '| 项 | 协议（AXI4） | DUT（DDRC） |',
      '| --- | --- | --- |',
      '| 单次突发上限 | 256 拍 | 8 拍 |',
      '',
      '协议上限见 [[concepts/axi-burst-limits]]，DUT 限制见 [[entities/ddr-ctrl]]。',
      '结论：DDRC 配置必须显式限制 BURST_LEN，不能照搬协议上限。',
      '',
    ].join('\n'),
  },
  {
    pageId: 'interfaces/ddr-timing',
    type: 'interface',
    title: 'DDR 接口时序参数',
    summary: 'tRCD 以 ns 给出，并给出 800 MHz 下的周期数。',
    keywords: ['tRCD', 'T_RCD', '时序', 'ns', '周期'],
    tags: ['时序'],
    sources: [sourceRef(SRC_DDR)],
    body: [
      '## tRCD',
      '',
      'tRCD = 13.75 ns；在 800 MHz 时钟下等价于 11 个时钟周期。',
      '',
      '寄存器复位值见 [[entities/ddr-ctrl]]。',
      '',
    ].join('\n'),
  },
  {
    pageId: 'interfaces/axi-timing',
    type: 'interface',
    title: 'AXI 握手时序（图 12-3）',
    summary: '建立/保持时间来自手册时序图，正文不重复给出数值。',
    keywords: ['AXI', '握手', '时序', 'T_SETUP', 'T_HOLD', 'Figure 12-3'],
    tags: ['时序'],
    sources: [sourceRef(SRC_AXI4)],
    body: [
      '## 时序图',
      '',
      '![[fig-12-3-timing.png|Fig 12-3 AXI 握手时序]]',
      '',
      '图 12-3 标注 T_SETUP = 2 cycles，T_HOLD = 1 cycle。',
      '手册正文只给出图形出处（第 12.3 节），取值以图为准。',
      '',
    ].join('\n'),
  },
  {
    pageId: 'interfaces/noc-qos',
    type: 'interface',
    title: 'NoC QoS 等级字段',
    summary: '附录寄存器索引列出的 NoC 服务等级字段。',
    keywords: ['NoC', 'NOC_QOS_LEVEL[3:0]', 'QoS'],
    tags: ['寄存器'],
    sources: [sourceRef(SRC_APPENDIX)],
    body: [
      '## 字段',
      '',
      'NOC_QOS_LEVEL[3:0] 决定 NoC 请求的服务等级，复位值 0x0。',
      '',
    ].join('\n'),
  },
  {
    pageId: 'pitfalls/ddr-burst-overrun',
    type: 'pitfall',
    title: 'DDRC 突发超限告警 DDRC_OVERFLOW',
    summary: '现象 → 根因 → 规避 → 证据。',
    keywords: ['DDRC_OVERFLOW', '告警', '超限'],
    tags: ['已知问题'],
    sources: [sourceRef(SRC_DDR)],
    body: [
      '## 现象',
      '',
      '仿真中 DDRC_OVERFLOW 置起，总线返回 error 响应。',
      '',
      '## 根因',
      '',
      '激励按协议上限 256 拍发突发，超过 DDRC_MAX_BURST = 8 beats。',
      '',
      '## 规避',
      '',
      '约束 sequence 的 BURST_LEN，见 [[entities/ddr-ctrl]]；对照见 [[comparisons/axi-vs-dut-burst]]。',
      '',
    ].join('\n'),
  },
  {
    pageId: 'synthesis/sprd-ddr-boot-config',
    type: 'synthesis',
    title: 'DDR 启动配置综合结论 BOOT_LADDER',
    summary: '跨来源结论：接口限制与上电时序共同决定启动配置。',
    keywords: ['BOOT_LADDER', '启动', '综合'],
    tags: ['综合'],
    sources: [sourceRef(SRC_AXI4), sourceRef(SRC_DDR)],
    body: [
      '## 结论',
      '',
      'BOOT_LADDER 启动序列必须同时满足接口突发上限与上电时序。',
      '',
      '接口限制见 [[entities/ddr-ctrl]]，时序取值见 [[interfaces/ddr-timing]]。',
      '',
    ].join('\n'),
  },
];

/** 聚合页（不入检索；用于确认聚合页被正确排除） */
export const QUALITY_AGGREGATES: Array<{ pageId: string; body: string }> = [
  { pageId: 'index', body: '# 索引\n\n- [[concepts/axi-burst-limits]]\n' },
  { pageId: 'overview', body: '# 概览\n\n本库沉淀 DDRC 与 AXI 协议知识。\n' },
  { pageId: 'log', body: '# 日志\n\n- 2026-09-14 初始编译。\n' },
];

// ── 落盘 ────────────────────────────────────────────────────────

export type QualityFixture = {
  kbPath: string;
  kbId: string;
  sources: QualitySource[];
  pages: QualityPage[];
};

function serializePage(page: QualityPage): string {
  const frontmatter = stringifyYaml(
    {
      type: page.type,
      title: page.title,
      summary: page.summary,
      keywords: page.keywords,
      tags: page.tags,
      sources: page.sources.map((s) => ({
        sourceId: s.sourceId,
        sourceRevision: s.sourceRevision,
        parsedHash: s.parsedHash,
      })),
      created: FIXTURE_CREATED_AT,
      updated: FIXTURE_CREATED_AT,
    },
    { defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' },
  );
  return ['---', frontmatter.trimEnd(), '---', '', page.body].join('\n');
}

/**
 * 在给定空目录落盘完整 fixture：
 *  - manifest（sources + publish revision 1，图快照可用）
 *  - raw/sources/<path>、raw/parsed/<path>.md、raw/revisions/<sourceId>/<rev>/
 *  - raw/assets/<sourceId>/<rev>/fig-12-3-timing.png
 *  - wiki/<typeDir>/<pageId>.md、wiki/{index,overview,log}.md
 */
export async function writeQualityKb(kbPath: string): Promise<QualityFixture> {
  await initWikiLayout(kbPath, { kbId: QUALITY_KB_ID, name: QUALITY_KB_NAME });
  const layout = wikiLayout(kbPath);

  const now = new Date(FIXTURE_CREATED_AT);
  const manifest: WikiKbManifest = {
    manifestVersion: 1,
    format: 'wiki',
    kbId: QUALITY_KB_ID,
    name: QUALITY_KB_NAME,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    publish: { revision: 1, commitId: 'quality-fixture-1', at: now.toISOString() },
    sources: {},
  };

  for (const source of QUALITY_SOURCES) {
    const segments = source.sourcePath.split('/');
    const parsedAbs = join(layout.rawParsedDir, ...segments) + '.md';
    const originalAbs = join(layout.rawSourcesDir, ...segments);
    mkdirSync(join(parsedAbs, '..'), { recursive: true });
    mkdirSync(join(originalAbs, '..'), { recursive: true });
    writeFileSync(parsedAbs, source.parsedText, 'utf-8');
    writeFileSync(originalAbs, source.parsedText, 'utf-8');

    for (const rev of source.revisions) {
      const dir = join(layout.rawRevisionsDir, source.sourceId, rev.revision);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, segments[segments.length - 1]), rev.text, 'utf-8');
    }

    const currentText = source.parsedText;
    manifest.sources![source.sourceId] = {
      sourcePath: source.sourcePath,
      sourceId: source.sourceId,
      ext: source.ext,
      size: Buffer.byteLength(currentText, 'utf-8'),
      currentRevision: source.currentRevision,
      parsedRevision: source.currentRevision,
      parsedHash: sha256(currentText),
      engine: source.ext === '.md' ? 'text' : 'anydoc',
      engineFingerprint: 'fixture-engine-fp-v1',
      status: 'ready',
      assetCount: source.assetCount,
      importedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
  }

  // 时序图资产：正文只给图形出处，取值只能来自图（图文互补）
  const figureDir = join(layout.rawAssetsDir, SRC_AXI4.sourceId, SRC_AXI4.currentRevision);
  mkdirSync(figureDir, { recursive: true });
  writeFileSync(join(figureDir, TIMING_FIGURE.fileName), Buffer.from(FIGURE_PNG_BASE64, 'base64'));

  await writeWikiManifest(kbPath, manifest);

  for (const page of QUALITY_PAGES) {
    const abs = join(layout.wikiDir, ...page.pageId.split('/')) + '.md';
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, serializePage(page), 'utf-8');
  }
  for (const aggregate of QUALITY_AGGREGATES) {
    const abs = join(layout.wikiDir, ...aggregate.pageId.split('/')) + '.md';
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, aggregate.body, 'utf-8');
  }

  return { kbPath, kbId: QUALITY_KB_ID, sources: QUALITY_SOURCES, pages: QUALITY_PAGES };
}

/** 时序图资产在盘上的绝对路径（保真门禁核对引用完整性） */
export function timingFigurePath(kbPath: string): string {
  return join(
    wikiLayout(kbPath).rawAssetsDir,
    SRC_AXI4.sourceId,
    SRC_AXI4.currentRevision,
    TIMING_FIGURE.fileName,
  );
}
