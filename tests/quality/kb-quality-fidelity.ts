/**
 * issue 29 — 关键数值 / 单位 / 位宽 / 引用保真门禁（spec §Testing Decisions）。
 *
 * 门禁口径：样例中出现的每个关键事实，必须在**页面正文**与**权威来源全文**
 * 中逐字一致（位宽、复位值、单位、周期数等不得被改写），且页面必须声明
 * 该来源引用、引用修订必须在 manifest / raw/revisions 中可解析。
 *
 * 门禁自身有效性由**注入错误负向对照**保证：每次注入一种确定性错误
 * （单位改写、位宽漂移、数值漂移、引用删除、图资产缺失、来源侧漂移），
 * 未检出即视为门禁失效。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scanWikiCatalog } from '../../src/main/kb/wiki-catalog';
import { readWikiManifest, wikiLayout } from '../../src/main/kb/wiki-layout';
import { QUALITY_SOURCES, TIMING_FIGURE } from './kb-quality-fixture';

const SRC = {
  axi4: QUALITY_SOURCES[0].sourceId,
  ddr: QUALITY_SOURCES[1].sourceId,
  pcie: QUALITY_SOURCES[2].sourceId,
  gpio: QUALITY_SOURCES[3].sourceId,
  appendix: QUALITY_SOURCES[4].sourceId,
};

export type FidelityFactKind = 'value' | 'unit' | 'bitWidth' | 'figureValue';

export type FidelityFact = {
  id: string;
  kind: FidelityFactKind;
  /** 断言该事实的页面 */
  pageId: string;
  /** 权威来源 */
  sourceId: string;
  /** 必须逐字出现在页面（figureValue 除外来源）中的字面量 */
  literal: string;
  /** figureValue：取值只在图上，须核对页面引用了该资产 */
  figureAsset?: string;
  note: string;
};

export type FidelityErrorReason =
  | 'page-missing-literal'
  | 'source-missing-literal'
  | 'page-missing-citation'
  | 'figure-asset-missing'
  | 'page-not-found';

export type FidelityError = {
  factId: string;
  kind: FidelityFactKind | 'citation';
  reason: FidelityErrorReason;
  detail: string;
};

export type FidelityPageView = {
  text: string;
  sourceRefs: Array<{ sourceId: string; sourceRevision: string }>;
};

export type FidelitySample = {
  pages: Map<string, FidelityPageView>;
  sources: Map<string, string>;
  /** 盘上资产清单（figureValue 核对） */
  assets: Set<string>;
};

/** 关键事实表（样例的权威取值清单） */
export const FIDELITY_FACTS: FidelityFact[] = [
  {
    id: 'axi-awlen-width',
    kind: 'bitWidth',
    pageId: 'concepts/axi-burst-limits',
    sourceId: SRC.axi4,
    literal: 'AWLEN[7:0]',
    note: 'AWLEN 位宽 8 位',
  },
  {
    id: 'axi-awlen-encode-256',
    kind: 'value',
    pageId: 'concepts/axi-burst-limits',
    sourceId: SRC.axi4,
    literal: '0xFF',
    note: 'AxLEN = 0xFF 表示 256 拍',
  },
  {
    id: 'ddr-max-burst',
    kind: 'value',
    pageId: 'entities/ddr-ctrl',
    sourceId: SRC.ddr,
    literal: 'DDRC_MAX_BURST = 8',
    note: 'DUT 单次突发上限 8 拍',
  },
  {
    id: 'ddr-ctrl-reset',
    kind: 'value',
    pageId: 'entities/ddr-ctrl',
    sourceId: SRC.ddr,
    literal: '复位值 0x00',
    note: 'DDRC CTRL[7:0] 复位值',
  },
  {
    id: 'ddr-burst-len-width',
    kind: 'bitWidth',
    pageId: 'entities/ddr-ctrl',
    sourceId: SRC.ddr,
    literal: 'BURST_LEN[2:0]',
    note: 'BURST_LEN 位宽 3 位',
  },
  {
    id: 'pcie-ctrl-reset',
    kind: 'value',
    pageId: 'entities/pcie-ctrl',
    sourceId: SRC.pcie,
    literal: '复位值 0x18',
    note: 'PCIe CTRL[7:0] 复位值',
  },
  {
    id: 'pcie-ltssm-width',
    kind: 'bitWidth',
    pageId: 'entities/pcie-ctrl',
    sourceId: SRC.pcie,
    literal: 'LTSSM_EN[0]',
    note: 'LTSSM_EN 位宽 1 位',
  },
  {
    id: 'gpio-ctrl-reset',
    kind: 'value',
    pageId: 'entities/gpio-ctrl',
    sourceId: SRC.gpio,
    literal: '复位值 0xFF',
    note: 'GPIO CTRL[7:0] 复位值',
  },
  {
    id: 'ddr-trcd-ns',
    kind: 'unit',
    pageId: 'interfaces/ddr-timing',
    sourceId: SRC.ddr,
    literal: '13.75 ns',
    note: 'tRCD 以纳秒给出',
  },
  {
    id: 'ddr-trcd-cycles',
    kind: 'unit',
    pageId: 'interfaces/ddr-timing',
    sourceId: SRC.ddr,
    literal: '11 个时钟周期',
    note: '800 MHz 下的周期数',
  },
  {
    id: 'noc-qos-width',
    kind: 'bitWidth',
    pageId: 'interfaces/noc-qos',
    sourceId: SRC.appendix,
    literal: 'NOC_QOS_LEVEL[3:0]',
    note: 'NoC QoS 等级位宽 4 位',
  },
  {
    id: 'noc-qos-reset',
    kind: 'value',
    pageId: 'interfaces/noc-qos',
    sourceId: SRC.appendix,
    literal: '复位值 0x0',
    note: 'NoC QoS 复位值',
  },
  {
    id: 'axi-timing-setup',
    kind: 'figureValue',
    pageId: 'interfaces/axi-timing',
    sourceId: SRC.axi4,
    literal: 'T_SETUP = 2 cycles',
    figureAsset: TIMING_FIGURE.fileName,
    note: '取值只在 Figure 12-3 上',
  },
  {
    id: 'axi-timing-hold',
    kind: 'figureValue',
    pageId: 'interfaces/axi-timing',
    sourceId: SRC.axi4,
    literal: 'T_HOLD = 1 cycle',
    figureAsset: TIMING_FIGURE.fileName,
    note: '取值只在 Figure 12-3 上',
  },
];

// ── 采样（从盘上的 fixture 读，验证物化结果本身）─────────────────

/** 从盘上读取保真检查所需的样本（页面正文 + 来源全文 + 资产清单）。 */
export async function readFidelitySample(kbPath: string): Promise<FidelitySample> {
  const layout = wikiLayout(kbPath);
  const scan = await scanWikiCatalog(kbPath);
  if (!scan.ok) throw new Error('fixture schema 无法解析');

  const pages = new Map<string, FidelityPageView>();
  for (const page of scan.catalog.pages) {
    if (!page.parse.ok) continue;
    pages.set(page.pageId, {
      text: page.parse.body,
      sourceRefs: page.parse.frontmatter.sources.map((s) => ({
        sourceId: s.sourceId,
        sourceRevision: s.sourceRevision,
      })),
    });
  }

  const sources = new Map<string, string>();
  const assets = new Set<string>();
  const manifest = await readWikiManifest(kbPath);
  if (manifest.ok) {
    for (const rec of Object.values(manifest.manifest.sources ?? {})) {
      const abs = join(layout.rawParsedDir, ...rec.sourcePath.split('/')) + '.md';
      try {
        sources.set(rec.sourceId, await readFile(abs, 'utf-8'));
      } catch {
        // 缺 parsed 全文 → 交由门禁报 source-missing-literal
      }
    }
    for (const rec of Object.values(manifest.manifest.sources ?? {})) {
      const dir = join(layout.rawAssetsDir, rec.sourceId, rec.currentRevision);
      for (const name of [TIMING_FIGURE.fileName]) {
        try {
          await readFile(join(dir, name));
          assets.add(`${rec.sourceId}:${rec.currentRevision}:${name}`);
        } catch {
          // 不存在
        }
      }
    }
  }

  return { pages, sources, assets };
}

// ── 检查 ────────────────────────────────────────────────────────

export type FidelityCheckInput = {
  facts: FidelityFact[];
  sample: FidelitySample;
  /** 图资产存在性判定（默认查 sample.assets）；负向对照可注入 false */
  assetExists?: (sourceId: string, fileName: string) => boolean;
};

/**
 * 逐事实核对页面 / 来源 / 引用 / 图资产。返回错误列表（空 = 门禁通过）。
 *
 *  - 非 figureValue：页面正文与权威来源都必须含字面量。
 *  - figureValue：字面量只须在页面（取值来自图）；改核对该页引用了来源、
 *    且图资产在盘上存在。
 *  - 所有事实：页面必须声明该来源引用。
 */
export function checkFidelity(input: FidelityCheckInput): FidelityError[] {
  const errors: FidelityError[] = [];
  const assetExists = input.assetExists
    ?? ((sourceId: string, fileName: string) =>
      input.sample.assets.has(`${sourceId}:${fileName}`) || [...input.sample.assets].some((k) => k.endsWith(`:${fileName}`)));

  for (const fact of input.facts) {
    const page = input.sample.pages.get(fact.pageId);
    if (!page) {
      errors.push({
        factId: fact.id,
        kind: fact.kind,
        reason: 'page-not-found',
        detail: `页面 ${fact.pageId} 不在编目中`,
      });
      continue;
    }

    if (!page.text.includes(fact.literal)) {
      errors.push({
        factId: fact.id,
        kind: fact.kind,
        reason: 'page-missing-literal',
        detail: `页面 ${fact.pageId} 正文缺少权威字面量「${fact.literal}」`,
      });
    }

    if (!page.sourceRefs.some((r) => r.sourceId === fact.sourceId)) {
      errors.push({
        factId: fact.id,
        kind: fact.kind,
        reason: 'page-missing-citation',
        detail: `页面 ${fact.pageId} 未声明来源 ${fact.sourceId}`,
      });
    }

    if (fact.kind !== 'figureValue') {
      const sourceText = input.sample.sources.get(fact.sourceId);
      if (sourceText === undefined || !sourceText.includes(fact.literal)) {
        errors.push({
          factId: fact.id,
          kind: fact.kind,
          reason: 'source-missing-literal',
          detail: `来源 ${fact.sourceId} 全文中找不到「${fact.literal}」`,
        });
      }
    } else if (fact.figureAsset && !assetExists(fact.sourceId, fact.figureAsset)) {
      errors.push({
        factId: fact.id,
        kind: fact.kind,
        reason: 'figure-asset-missing',
        detail: `图资产 ${fact.figureAsset} 在 ${fact.sourceId} 当前修订下不存在`,
      });
    }
  }
  return errors;
}

/** 引用可解析性：每个页面声明的来源修订必须能在 manifest 当前修订或历史修订中解析。 */
export type CitationError = { pageId: string; sourceId: string; revision: string; reason: string };

export async function checkCitationResolvability(
  kbPath: string,
  sample: FidelitySample,
): Promise<CitationError[]> {
  const layout = wikiLayout(kbPath);
  const manifest = await readWikiManifest(kbPath);
  if (!manifest.ok) return [];
  const errors: CitationError[] = [];

  for (const [pageId, page] of sample.pages) {
    for (const ref of page.sourceRefs) {
      const rec = manifest.manifest.sources?.[ref.sourceId];
      if (!rec) {
        errors.push({
          pageId,
          sourceId: ref.sourceId,
          revision: ref.sourceRevision,
          reason: '来源不在 manifest',
        });
        continue;
      }
      if (ref.sourceRevision === rec.currentRevision) continue;
      const revDir = join(layout.rawRevisionsDir, ref.sourceId, ref.sourceRevision);
      try {
        await readFile(join(revDir, rec.sourcePath.split('/').pop() ?? 'x'));
      } catch {
        errors.push({
          pageId,
          sourceId: ref.sourceId,
          revision: ref.sourceRevision,
          reason: '历史修订原件不可读',
        });
      }
    }
  }
  return errors;
}

// ── 负向对照（门禁有效性）─────────────────────────────────────────

export type MutationId =
  | 'unit-swap'
  | 'bit-width-drift'
  | 'value-drift'
  | 'citation-removed'
  | 'figure-asset-removed'
  | 'source-literal-drift';

export type Mutation = {
  id: MutationId;
  /** 被注入的错误应命中的事实 id */
  expectedFactIds: string[];
  describe: string;
  /** 返回被改动的样本；不改原样本 */
  apply: (sample: FidelitySample) => { sample: FidelitySample; assetExists?: (s: string, f: string) => boolean };
};

const cloneSample = (sample: FidelitySample): FidelitySample => ({
  pages: new Map(
    [...sample.pages].map(([id, page]) => [
      id,
      { text: page.text, sourceRefs: page.sourceRefs.map((r) => ({ ...r })) },
    ]),
  ),
  sources: new Map(sample.sources),
  assets: new Set(sample.assets),
});

/** 确定性的注入错误集（每次只注入一种，便于归因） */
export const MUTATIONS: Mutation[] = [
  {
    id: 'unit-swap',
    expectedFactIds: ['ddr-trcd-ns'],
    describe: '把 tRCD 的单位 ns 改写成 cycles',
    apply: (sample) => {
      const next = cloneSample(sample);
      const page = next.pages.get('interfaces/ddr-timing');
      if (page) page.text = page.text.replace('13.75 ns', '13.75 cycles');
      return { sample: next };
    },
  },
  {
    id: 'bit-width-drift',
    expectedFactIds: ['axi-awlen-width'],
    describe: '把 AWLEN[7:0] 的位宽改成 AWLEN[3:0]',
    apply: (sample) => {
      const next = cloneSample(sample);
      const page = next.pages.get('concepts/axi-burst-limits');
      if (page) page.text = page.text.replace('AWLEN[7:0]', 'AWLEN[3:0]');
      return { sample: next };
    },
  },
  {
    id: 'value-drift',
    expectedFactIds: ['pcie-ctrl-reset'],
    describe: '把 PCIe CTRL 复位值 0x18 改成 0x1C',
    apply: (sample) => {
      const next = cloneSample(sample);
      const page = next.pages.get('entities/pcie-ctrl');
      if (page) page.text = page.text.replace('复位值 0x18', '复位值 0x1C');
      return { sample: next };
    },
  },
  {
    id: 'citation-removed',
    expectedFactIds: ['pcie-ctrl-reset', 'pcie-ltssm-width'],
    describe: '删掉 PCIe 页的来源引用',
    apply: (sample) => {
      const next = cloneSample(sample);
      const page = next.pages.get('entities/pcie-ctrl');
      if (page) page.sourceRefs = [];
      return { sample: next };
    },
  },
  {
    id: 'figure-asset-removed',
    expectedFactIds: ['axi-timing-setup', 'axi-timing-hold'],
    describe: '图 12-3 资产不在盘上',
    apply: (sample) => ({ sample: cloneSample(sample), assetExists: () => false }),
  },
  {
    id: 'source-literal-drift',
    expectedFactIds: ['ddr-trcd-ns'],
    describe: '来源全文里的 13.75 ns 被写成 13.75 us',
    apply: (sample) => {
      const next = cloneSample(sample);
      for (const [id, text] of next.sources) {
        next.sources.set(id, text.replace('13.75 ns', '13.75 us'));
      }
      return { sample: next };
    },
  },
];

export type MutationOutcome = {
  id: MutationId;
  describe: string;
  expectedFactIds: string[];
  detectedFactIds: string[];
  /** expectedFactIds 中未被任何错误命中的项 */
  undetected: string[];
  errors: FidelityError[];
};

/** 对注入错误逐条跑门禁，统计检出情况（undetected 非空 = 门禁失效） */
export function runMutationControls(input: FidelityCheckInput): MutationOutcome[] {
  return MUTATIONS.map((mutation) => {
    const mutated = mutation.apply(input.sample);
    const errors = checkFidelity({
      facts: input.facts,
      sample: mutated.sample,
      ...(mutated.assetExists ? { assetExists: mutated.assetExists } : {}),
    });
    const detectedFactIds = [...new Set(errors.map((e) => e.factId))];
    return {
      id: mutation.id,
      describe: mutation.describe,
      expectedFactIds: mutation.expectedFactIds,
      detectedFactIds,
      undetected: mutation.expectedFactIds.filter((id) => !detectedFactIds.includes(id)),
      errors,
    };
  });
}
