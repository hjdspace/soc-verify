/**
 * issue 30 — 固定规模性能门禁 fixture（spec §Testing Decisions「检索与模型质量样例」）。
 *
 * 数据规模按 spec 固定：**1000 页 / 10000 图边 / 约 50 MB parsed 全文**。
 * 该规模是基准 fixture，不是产品容量硬上限；生成参数必须原样记录进报告，
 * 不允许为凑门禁降低规模（验收条目「不以降低数据规模假装通过」）。
 *
 * fixture 是「编译产物的形状」（已发布页 + 当前 parsed 全文 + manifest），
 * 与 issue 29 的质量样例（tests/quality/kb-quality-fixture.ts）互补：
 *  - issue 29：小而精，覆盖六类语义特征，用于检索质量门禁；
 *  - issue 30：大而固定，用于性能/取消/内存门禁与打包 GUI 旅程。
 *
 * 生成完全确定性（无随机数、无时间戳依赖），同一参数重复生成得到逐字节
 * 一致的库，因此测量值可以跨机器/跨运行比较。
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { initWikiLayout, writeWikiManifest, wikiLayout } from '../../src/main/kb/wiki-layout';
import type { WikiKbManifest } from '../../src/main/kb/wiki-layout';
import { sourceIdFor } from '../../src/main/kb/source-identity';
import type { WikiPageType, WikiSourceRef } from '@shared/kb-types';

export const PACKAGE_KB_ID = 'kb-package-30';
export const PACKAGE_KB_NAME = '固定规模性能门禁库';

// ── 固定生成参数（进报告，不许静默调整）─────────────────────────

export type PackageFixtureParams = {
  seed: number;
  /** wiki 页数（不含聚合页） */
  pageCount: number;
  /** 目标图边数（来自页间 wikilink，实测以图快照为准） */
  targetEdges: number;
  /** 每页出链数（页内簇内 + 跨簇），10 × 1000 = 10000 */
  outLinksPerPage: number;
  /** parsed 来源数 */
  sourceCount: number;
  /** parsed 全文总字节目标（约 50MB） */
  parsedBytesTarget: number;
};

export const FIXTURE_PARAMS: PackageFixtureParams = {
  seed: 20260914,
  pageCount: 1000,
  targetEdges: 10000,
  outLinksPerPage: 10,
  sourceCount: 40,
  parsedBytesTarget: 50 * 1024 * 1024,
};

// ── 领域词表（内容要对 SoC 工程师可读，不是乱码填充）─────────────

const DOMAINS = [
  'AXI 总线',
  'DDR 控制器',
  'PCIe 控制器',
  'GPIO 控制器',
  'NoC 互连',
  '时钟复位',
  '跨时钟域',
  '低功耗设计',
  'DFT 可测性',
  '验证方法学',
] as const;

const DOMAIN_SLUGS = ['axi', 'ddr', 'pcie', 'gpio', 'noc', 'clkrst', 'cdc', 'lowpower', 'dft', 'verif'] as const;

const PAGE_TYPES: WikiPageType[] = [
  'concept',
  'entity',
  'interface',
  'pitfall',
  'comparison',
  'synthesis',
  'source',
  'query',
];

const TYPE_DIRS: Record<WikiPageType, string> = {
  source: 'sources',
  entity: 'entities',
  concept: 'concepts',
  comparison: 'comparisons',
  synthesis: 'synthesis',
  query: 'queries',
  pitfall: 'pitfalls',
  interface: 'interfaces',
};

/** 精确符号池：查询集会引用，页面 keywords/正文必须包含 */
const SYMBOLS = [
  'AWLEN[7:0]',
  'ARLEN[7:0]',
  'CTRL[7:0]',
  'tRCD',
  'NOC_QOS_LEVEL[3:0]',
  'BURST_LEN[2:0]',
  'LTSSM_EN[0]',
  'PWR_CTRL[15:8]',
  'TCK_GATE[1:0]',
  'ATPG_EN[4]',
] as const;

const TAGS = ['协议', 'IP', '时序', '寄存器', '已知问题', '综合', '对照'] as const;

// ── 锚点来源（有真实语义，查询集依赖它们）───────────────────────

type AnchorSource = { sourcePath: string; parsedText: string };

/** 手册正文按节生成；锚点来源嵌入六类语义特征（与 issue 29 同源的设计） */
function anchorSources(): AnchorSource[] {
  return [
    {
      sourcePath: 'manuals/amba-axi4-spec.pdf',
      parsedText: [
        '# AMBA AXI4 协议规范（R3 摘录）',
        '',
        '## 3.2 突发长度',
        '',
        'AWLEN[7:0] 与 ARLEN[7:0] 为 8 位字段。INCR 突发的长度范围为 1–256 拍；',
        '当 AxLEN = 0xFF 时表示 256 拍，此时突发不得跨越 4KB 边界。',
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
    },
    {
      sourcePath: 'manuals/ddr-ctrl-ug.pdf',
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
    },
    {
      sourcePath: 'manuals/noc-qos-ug.md',
      parsedText: [
        '# NoC QoS 用户指南',
        '',
        'NOC_QOS_LEVEL[3:0] 决定 NoC 请求的服务等级，复位值 0x0。',
        '该字段只在本附录列出，正文未展开。',
        '',
      ].join('\n'),
    },
  ];
}

// ── parsed 全文（体积担当，同时保证内容真实可检索）───────────────

/**
 * 生成一份 ≈ `bytesTarget` 的手册全文：按节循环，节内参数随节号变化，
 * 保证「不同查询命中不同来源」而不是所有查询都命中同一大文件。
 */
function generateManualText(domain: string, symbol: string, index: number, bytesTarget: number): string {
  const header = `# ${domain} 用户手册（第 ${index} 册）\n\n`;
  let bytes = Buffer.byteLength(header, 'utf-8');
  let section = 0;
  const lines: string[] = [header];
  while (bytes < bytesTarget) {
    section += 1;
    const beatBase = 100 + ((section * 7 + index) % 800);
    const latencyNs = ((section * 13 + index) % 900) / 10;
    const chunk = [
      `## ${section}.1 ${domain} 寄存器组 ${section}`,
      '',
      `${symbol}（偏移 0x${((section * 4) % 0x100).toString(16)}) 控制该组功能，复位值 0x${((section * 3) % 0xFF).toString(16)}。`,
      `描述：本节给出 ${domain} 第 ${section} 组寄存器的字段定义、访问类型与复位行为。`,
      '',
      `## ${section}.2 时序与吞吐`,
      '',
      `本组接口的最小间隔为 ${latencyNs.toFixed(2)} ns，对应 ${beatBase} 拍突发下的等效吞吐。`,
      `约束：当 ${symbol} 使能时，连续两次访问之间至少间隔 ${latencyNs.toFixed(2)} ns。`,
      '',
      `## ${section}.3 配置示例`,
      '',
      '推荐流程：先写全局使能，再配置本组参数，最后轮询状态位。',
      `在 ${domain} 场景下，${symbol} 的配置必须与上游约定一致，避免速率失配。`,
      '',
    ].join('\n');
    lines.push(chunk);
    bytes += Buffer.byteLength(chunk, 'utf-8');
  }
  return lines.join('\n');
}

// ── 页面生成 ────────────────────────────────────────────────────

export type PackagePageMeta = {
  pageId: string;
  type: WikiPageType;
  title: string;
  keywords: string[];
};

export function pageMetaAt(index: number): PackagePageMeta {
  const domainIdx = index % DOMAINS.length;
  const type = PAGE_TYPES[index % PAGE_TYPES.length]!;
  const seq = String(index).padStart(4, '0');
  return {
    pageId: `${TYPE_DIRS[type]}/${DOMAIN_SLUGS[domainIdx]}-p${seq}`,
    type,
    title: `${DOMAINS[domainIdx]} 主题 ${seq}`,
    keywords: [
      SYMBOLS[index % SYMBOLS.length]!,
      `topic${domainIdx}`,
      `${DOMAINS[domainIdx]}`,
      `群组${Math.floor(index / 100)}`,
    ],
  };
}

/** 页面 i 的出链目标（确定性；10 条 = 9 条簇内 + 1 条跨簇 → 10000 边） */
export function outlinkTargets(index: number, pageCount: number, perPage: number): number[] {
  const targets = new Set<number>();
  for (let k = 1; targets.size < perPage - 1 && k <= perPage * 4; k++) {
    const t = (index + k * 7) % pageCount;
    if (t !== index) targets.add(t);
  }
  // 跨簇 1 条：跳到下一个「百页组」
  targets.add((index + 137) % pageCount);
  return Array.from(targets).filter((t) => t !== index).slice(0, perPage);
}

// ── 查询集（延迟测量的负载；每条都必须有真实命中）─────────────────

export type PackageQuery = {
  query: string;
  kind: 'exact-symbol' | 'zh-natural' | 'cross-source' | 'retracted' | 'figure-text';
  /** 至少应命中的 pageId/来源标识（用于证明测的是真实检索路径，不是空查询早退） */
  mustHit: string;
};

export const PACKAGE_QUERIES: PackageQuery[] = [
  { query: 'AWLEN[7:0] 256 拍', kind: 'exact-symbol', mustHit: 'axi-p' },
  { query: 'tRCD 13.75 ns', kind: 'exact-symbol', mustHit: 'ddr-p' },
  { query: 'CTRL[7:0] 复位值', kind: 'exact-symbol', mustHit: 'p' },
  { query: 'NOC_QOS_LEVEL[3:0] 服务等级', kind: 'exact-symbol', mustHit: 'noc-p' },
  { query: 'BURST_LEN[2:0] 突发长度', kind: 'exact-symbol', mustHit: 'ddr-p' },
  { query: 'LTSSM_EN[0] 链路训练', kind: 'exact-symbol', mustHit: 'pcie-p' },
  { query: 'PWR_CTRL[15:8] 低功耗', kind: 'exact-symbol', mustHit: 'lowpower-p' },
  { query: 'TCK_GATE[1:0] 时钟门控', kind: 'exact-symbol', mustHit: 'dft-p' },
  { query: 'DDR 控制器支持多长的突发', kind: 'zh-natural', mustHit: 'p' },
  { query: '跨时钟域同步应该怎么处理', kind: 'zh-natural', mustHit: 'cdc-p' },
  { query: '时钟复位树怎么规划', kind: 'zh-natural', mustHit: 'clkrst-p' },
  { query: '低功耗设计有哪些约束', kind: 'zh-natural', mustHit: 'lowpower-p' },
  { query: '验证方法学的覆盖率达到多少', kind: 'zh-natural', mustHit: 'verif-p' },
  { query: 'GPIO 控制器上电默认状态', kind: 'zh-natural', mustHit: 'gpio-p' },
  { query: 'AXI4 协议上限与 DDRC 限制对照', kind: 'cross-source', mustHit: 'axi-p' },
  { query: '协议 256 拍 DUT 8 拍 差异', kind: 'cross-source', mustHit: 'p' },
  { query: 'NoC QoS 与 AXI 优先级关系', kind: 'cross-source', mustHit: 'noc-p' },
  { query: 'DFT 与验证方法学怎么配合', kind: 'cross-source', mustHit: 'p' },
  { query: 'outstanding 建议上限 16', kind: 'retracted', mustHit: 'axi-p' },
  { query: '每 ID 16 笔未完成事务', kind: 'retracted', mustHit: 'p' },
  { query: 'T_SETUP 取值', kind: 'figure-text', mustHit: 'axi-p' },
  { query: '图 12-3 握手时序', kind: 'figure-text', mustHit: 'axi-p' },
  { query: '时序图 建立时间 保持时间', kind: 'figure-text', mustHit: 'p' },
  { query: '复位值 0x18 控制寄存器', kind: 'exact-symbol', mustHit: 'p' },
];

// ── 落盘 ────────────────────────────────────────────────────────

export type PackageFixture = {
  kbPath: string;
  kbId: string;
  params: PackageFixtureParams;
  pageCount: number;
  edgeCount: number;
  sourceCount: number;
  /** raw/parsed 字节数（门禁口径「约 50MB 全文」） */
  parsedBytes: number;
  /** raw/sources 字节数（原件与 parsed 等大落盘） */
  sourceBytes: number;
  wikiBytes: number;
  queries: PackageQuery[];
  /** 生成耗时（ms，进报告的环境记录） */
  generateMs: number;
};

const FIXTURE_CREATED_AT = '2026-09-14T00:00:00Z';
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf-8').digest('hex');

function serializePage(page: {
  pageId: string;
  type: WikiPageType;
  title: string;
  summary: string;
  keywords: string[];
  tags: string[];
  sources: WikiSourceRef[];
  body: string;
}): string {
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

/** 同步递归统计目录字节数（fixture 落盘后报告用） */
function dirBytesSync(root: string): number {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const abs = join(root, entry.name);
    if (entry.isDirectory()) total += dirBytesSync(abs);
    else total += statSync(abs).size;
  }
  return total;
}

/**
 * 在给定目录落盘固定规模 fixture。
 * 已存在同名库时直接复用（幂等），保证重复跑门禁不重写 50MB。
 */
export async function writePackageKb(kbPath: string, options?: { force?: boolean }): Promise<PackageFixture> {
  const startedAt = Date.now();
  const layout = wikiLayout(kbPath);
  const params = FIXTURE_PARAMS;

  // 幂等：已有 manifest 且页数一致 → 复用
  if (!options?.force) {
    const existing = await import('node:fs/promises').then((fs) => fs.readFile(layout.manifestPath, 'utf-8').catch(() => null));
    if (existing) {
      try {
        const manifest = JSON.parse(existing) as WikiKbManifest;
        const wikiDir = layout.wikiDir;
        const pageCount = countPagesSync(wikiDir);
        if (manifest.kbId === PACKAGE_KB_ID && pageCount === params.pageCount) {
          const edgeCount = await measureEdgeCount(kbPath);
          return {
            kbPath,
            kbId: PACKAGE_KB_ID,
            params,
            pageCount,
            edgeCount,
            sourceCount: Object.keys(manifest.sources ?? {}).length,
            parsedBytes: dirBytesSync(layout.rawParsedDir),
            sourceBytes: dirBytesSync(layout.rawSourcesDir),
            wikiBytes: dirBytesSync(wikiDir),
            queries: PACKAGE_QUERIES,
            generateMs: Date.now() - startedAt,
          };
        }
      } catch {
        // 损坏 → 重建
      }
    }
  }

  await initWikiLayout(kbPath, { kbId: PACKAGE_KB_ID, name: PACKAGE_KB_NAME });

  // ── 1. 来源与 parsed 全文（约 50MB）─────────────────────────
  const anchors = anchorSources();
  const fillerCount = Math.max(0, params.sourceCount - anchors.length);
  const perSourceBytes = Math.max(1024, Math.floor(params.parsedBytesTarget / params.sourceCount));

  const now = new Date(FIXTURE_CREATED_AT);
  const manifest: WikiKbManifest = {
    manifestVersion: 1,
    format: 'wiki',
    kbId: PACKAGE_KB_ID,
    name: PACKAGE_KB_NAME,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    publish: { revision: 1, commitId: 'package-fixture-1', at: now.toISOString() },
    sources: {},
  };

  type SourceEntry = { sourceId: string; sourcePath: string; revision: string; text: string; ext: string };
  const sources: SourceEntry[] = [];

  for (const anchor of anchors) {
    sources.push({
      sourceId: sourceIdFor(anchor.sourcePath),
      sourcePath: anchor.sourcePath,
      revision: 'rev1-anchor',
      text: anchor.parsedText,
      ext: anchor.sourcePath.slice(anchor.sourcePath.lastIndexOf('.') + 1),
    });
  }
  for (let i = 0; i < fillerCount; i++) {
    const domainIdx = i % DOMAINS.length;
    const symbol = SYMBOLS[i % SYMBOLS.length]!;
    const sourcePath = `manuals/${DOMAIN_SLUGS[domainIdx]}-vol${String(i).padStart(3, '0')}.pdf`;
    sources.push({
      sourceId: sourceIdFor(sourcePath),
      sourcePath,
      revision: `rev1-v${i}`,
      text: generateManualText(DOMAINS[domainIdx]!, symbol, i, perSourceBytes),
      ext: 'pdf',
    });
  }

  for (const source of sources) {
    const segments = source.sourcePath.split('/');
    const parsedAbs = join(layout.rawParsedDir, ...segments) + '.md';
    const originalAbs = join(layout.rawSourcesDir, ...segments);
    mkdirSync(join(parsedAbs, '..'), { recursive: true });
    mkdirSync(join(originalAbs, '..'), { recursive: true });
    writeFileSync(parsedAbs, source.text, 'utf-8');
    writeFileSync(originalAbs, source.text, 'utf-8');
    manifest.sources![source.sourceId] = {
      sourceId: source.sourceId,
      sourcePath: source.sourcePath,
      ext: source.ext,
      size: Buffer.byteLength(source.text, 'utf-8'),
      currentRevision: source.revision,
      parsedRevision: source.revision,
      parsedHash: sha256(source.text),
      engine: source.ext === 'md' ? 'text' : 'anydoc',
      engineFingerprint: 'package-fixture-engine-v1',
      status: 'ready',
      assetCount: 0,
      importedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
  }

  await writeWikiManifest(kbPath, manifest);

  // ── 2. wiki 页面（1000 页 / 10000 边）────────────────────────
  const pages: PackagePageMeta[] = [];
  for (let i = 0; i < params.pageCount; i++) pages.push(pageMetaAt(i));
  const hashes = new Map(sources.map((s) => [s.sourceId, sha256(s.text)]));

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!;
    const domainIdx = i % DOMAINS.length;
    const targets = outlinkTargets(i, pages.length, params.outLinksPerPage);
    const links = targets
      .map((t) => {
        const target = pages[t]!;
        return `- [[${target.pageId}|${target.title}]]`;
      })
      .join('\n');
    const symbol = SYMBOLS[i % SYMBOLS.length]!;
    const primary = sources[(i * 3) % sources.length]!;
    const secondary = sources[(i * 7 + 1) % sources.length]!;
    const refs = [primary, secondary].map(
      (s): WikiSourceRef => ({
        sourceId: s.sourceId,
        sourceRevision: s.revision,
        parsedHash: hashes.get(s.sourceId)!,
      }),
    );
    const body = [
      `## 定义`,
      '',
      `${page.title}：${DOMAINS[domainIdx]}域的知识页，围绕 ${symbol} 展开配置、时序与验证要点。`,
      `关键词：${symbol}、${DOMAINS[domainIdx]}、群组${Math.floor(i / 100)}。`,
      '',
      `## 要点`,
      '',
      `1. ${symbol} 的配置必须与 ${DOMAINS[domainIdx]} 上游约定一致；`,
      `2. 时序参数以手册为准，正文不重复给数值；`,
      `3. 与相邻群组的差异见下方关联页。`,
      '',
      `## 关联页`,
      '',
      links,
      '',
    ].join('\n');
    const abs = join(layout.wikiDir, ...page.pageId.split('/')) + '.md';
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(
      abs,
      serializePage({
        pageId: page.pageId,
        type: page.type,
        title: page.title,
        summary: `${DOMAINS[domainIdx]} 第 ${Math.floor(i / 100) + 1} 群组的${page.type}页，围绕 ${symbol}。`,
        keywords: page.keywords,
        tags: [TAGS[i % TAGS.length]!],
        sources: refs,
        body,
      }),
      'utf-8',
    );
  }

  // 聚合页（检索会正确排除它们）
  writeFileSync(join(layout.wikiDir, 'index.md'), '# 索引\n\n固定规模性能门禁库。\n', 'utf-8');
  writeFileSync(join(layout.wikiDir, 'overview.md'), '# 概览\n\n1000 页 / 10000 边 / 约 50MB parsed。\n', 'utf-8');
  writeFileSync(join(layout.wikiDir, 'log.md'), '# 日志\n\n- 2026-09-14 fixture 初始生成。\n', 'utf-8');

  const edgeCount = await measureEdgeCount(kbPath);

  return {
    kbPath,
    kbId: PACKAGE_KB_ID,
    params,
    pageCount: pages.length,
    edgeCount,
    sourceCount: sources.length,
    parsedBytes: dirBytesSync(layout.rawParsedDir),
    sourceBytes: dirBytesSync(layout.rawSourcesDir),
    wikiBytes: dirBytesSync(layout.wikiDir),
    queries: PACKAGE_QUERIES,
    generateMs: Date.now() - startedAt,
  };
}

/** 递归统计 wiki/ 下的 .md 页数（不含聚合页由调用方自行判断；这里只数文件） */
function countPagesSync(wikiDir: string): number {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(wikiDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const abs = join(wikiDir, entry.name);
    if (entry.isDirectory()) total += countPagesSync(abs);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) total += 1;
  }
  return total;
}

/** 用生产图快照测实际边数（同时预热图快照缓存） */
export async function measureEdgeCount(kbPath: string): Promise<number> {
  const { getWikiGraphSnapshot } = await import('../../src/main/kb/wiki-graph');
  const result = await getWikiGraphSnapshot(kbPath);
  if (!result.ok) throw new Error(`图快照构建失败: ${JSON.stringify(result)}`);
  return result.snapshot.edges.length;
}

/** 延迟语义：略（见 kb-package-perf.ts） */
export type FixtureQueryProbe = {
  query: string;
  kind: PackageQuery['kind'];
  hits: number;
  firstHit: string | null;
};

/** 快速校验查询集都有真实命中（防止在空查询上测延迟） */
export async function probeQueryCoverage(kbPath: string): Promise<FixtureQueryProbe[]> {
  const { searchWiki } = await import('../../src/main/kb/wiki-search');
  const probes: FixtureQueryProbe[] = [];
  for (const q of PACKAGE_QUERIES) {
    const result = await searchWiki(kbPath, { query: q.query, topK: 20 });
    if (!result.ok) {
      probes.push({ query: q.query, kind: q.kind, hits: 0, firstHit: `error:${result.error.code}` });
      continue;
    }
    probes.push({
      query: q.query,
      kind: q.kind,
      hits: result.result.hits.length,
      firstHit: result.result.hits[0]?.id ?? null,
    });
  }
  return probes;
}
