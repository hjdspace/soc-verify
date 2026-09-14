/**
 * issue 29 — 验收 SoC 知识与检索证据质量（spec §Testing Decisions；验收映射 A05/A14/A18）。
 *
 * 本文件是**质量门禁**，不是「把问题改到绿」的兜底票：
 *
 *  1. 硬门禁：关键词（产品当前唯一在跑的路径）Recall@10 ≥ 0.9；
 *     嵌入降级与关键词逐条一致；保真门禁零错误；注入错误全部检出（门禁非空转）。
 *  2. 混合模式 Recall@10 由确定性 fixture 嵌入端点 + 真实 RRF 管线测得，
 *     若未达门禁，**必须**留下定位到责任票（24/22/21）的失败记录——
 *     断言的是「失败被记录」，不能通过降低样例难度或隐藏失败结案。
 *  3. 混合检索是否已接入产品调用点由源码探测核对，探测结论与失败记录必须一致
 *     （防止结论过期后仍留在报告里）。
 *
 * 报告落到 `.scratch/llm-wiki/spikes/29-quality/{report.json,report.md}`。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeQualityKb } from './quality/kb-quality-fixture';
import {
  FIDELITY_FACTS,
  checkCitationResolvability,
  checkFidelity,
  readFidelitySample,
  runMutationControls,
  type CitationError,
  type FidelityError,
  type FidelitySample,
  type MutationOutcome,
} from './quality/kb-quality-fidelity';
import {
  describeEnvironment,
  probeHybridWiring,
  runBenchmark,
  type BenchmarkResult,
  type HybridWiring,
} from './quality/kb-quality-benchmark';
import {
  buildReport,
  probeEmbeddingEndpoint,
  readLlmSetting,
  writeReport,
  type EndpointProbe,
  type QualityReport,
} from './quality/kb-quality-report';
import {
  fixtureEmbeddingConfig,
  startFixtureEmbeddingServer,
  type FixtureEmbeddingServer,
} from './quality/kb-quality-embedding';
import { MIN_QUERY_COUNT, QUALITY_QUERIES, REQUIRED_CATEGORIES } from './quality/kb-quality-queries';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPORT_DIR = process.env.KB_QUALITY_REPORT_DIR
  ?? join(REPO_ROOT, '.scratch', 'llm-wiki', 'spikes', '29-quality');

const HOOK_TIMEOUT_MS = 180_000;

let kbPath: string;
let embeddingServer: FixtureEmbeddingServer;
let benchmark: BenchmarkResult;
let sample: FidelitySample;
let fidelityErrors: FidelityError[];
let citationErrors: CitationError[];
let mutations: MutationOutcome[];
let wiring: HybridWiring;
let endpointProbe: EndpointProbe;
let report: QualityReport;

beforeAll(async () => {
  kbPath = mkdtempSync(join(tmpdir(), 'sv-kb-quality-29-'));
  await writeQualityKb(kbPath);

  embeddingServer = await startFixtureEmbeddingServer();
  try {
    benchmark = await runBenchmark(kbPath, 'kb-quality-29', {
      embeddingCfg: fixtureEmbeddingConfig(embeddingServer.endpoint),
      httpStats: () => ({ requests: embeddingServer.requests(), inputs: embeddingServer.inputs() }),
    });

    sample = await readFidelitySample(kbPath);
    fidelityErrors = checkFidelity({ facts: FIDELITY_FACTS, sample });
    citationErrors = await checkCitationResolvability(kbPath, sample);
    mutations = runMutationControls({ facts: FIDELITY_FACTS, sample });

    wiring = await probeHybridWiring(REPO_ROOT);
    endpointProbe = await probeEmbeddingEndpoint();
    const llm = await readLlmSetting();

    report = buildReport({
      environment: describeEnvironment(),
      fixture: {
        kbId: 'kb-quality-29',
        pages: sample.pages.size,
        sources: sample.sources.size,
        factCount: FIDELITY_FACTS.length,
      },
      benchmark,
      fidelityErrors,
      citationErrors,
      mutations,
      wiring,
      endpointProbe,
      llm,
      realModelCallExecuted: false,
      notes: [
        `混合模式由确定性 fixture 嵌入端点（${embeddingServer.endpoint}）驱动，只度量融合与排序管线，不构成模型语义质量结论。`,
        '样本「零数值/单位/位宽/引用错误」仅对该样例成立，不是对任意模型输出的正确性保证。',
        '图补召回按 wiki-search 契约追加在 topK 之后，因此不参与 Recall@10，单独断言 seed 标注。',
      ],
    });
    await writeReport(REPORT_DIR, report);
  } finally {
    await embeddingServer.close();
  }
}, HOOK_TIMEOUT_MS);

afterAll(() => {
  rmSync(kbPath, { recursive: true, force: true });
});

// ── 样例与查询集完整性 ────────────────────────────────────────────

describe('查询集与样例覆盖', () => {
  it('查询数不少于 20 且六类样例特征均有覆盖', () => {
    expect(QUALITY_QUERIES.length).toBeGreaterThanOrEqual(MIN_QUERY_COUNT);
    const categories = new Set(QUALITY_QUERIES.map((q) => q.category));
    for (const required of REQUIRED_CATEGORIES) {
      expect(categories.has(required), `缺少类别 ${required}`).toBe(true);
    }
    expect(report.fixture.queries).toBe(QUALITY_QUERIES.length);
  });

  it('每条查询都保存了预期来源/章节（预期证据非空且唯一）', () => {
    for (const q of QUALITY_QUERIES) {
      expect(q.expected.length, `${q.id} 缺少预期证据`).toBeGreaterThan(0);
      expect(new Set(q.expected).size, `${q.id} 预期证据重复`).toBe(q.expected.length);
    }
  });

  it('被撤回值与图文互补两类都断言了完整性（stale 或图资产）', () => {
    const retracted = QUALITY_QUERIES.filter((q) => q.category === 'retracted');
    expect(retracted.length).toBeGreaterThan(0);
    // 撤回类里必须有查询断言 stale（过时页仍在结果中但不得冒充当前）
    expect(retracted.filter((q) => (q.mustFlagStale ?? []).length > 0).length).toBeGreaterThanOrEqual(2);

    const figure = QUALITY_QUERIES.filter((q) => q.category === 'figure-text');
    expect(figure.length).toBeGreaterThan(0);
    const figureFacts = FIDELITY_FACTS.filter((f) => f.kind === 'figureValue');
    expect(figureFacts.length).toBeGreaterThan(0);
    expect(figureFacts.every((f) => (f.figureAsset ?? '').length > 0)).toBe(true);
  });
});

// ── 召回门禁 ────────────────────────────────────────────────────

describe('检索召回门禁', () => {
  it('关键词（产品实际路径）Recall@10 达到门禁', () => {
    expect(report.gates.keyword.measured).toBeGreaterThanOrEqual(report.threshold);
    expect(report.modes.keyword.recallAt10).toBeGreaterThanOrEqual(report.threshold);
  });

  it('嵌入降级不改变关键词结果（spec：降级时关键词/图保持可用）', () => {
    expect(report.modes['keyword-degraded'].vectorStatusDegraded).toBe(true);
    expect(report.degradedMatchesKeyword, report.degradedMismatchDetail.join('\n')).toBe(true);
  });

  it('混合模式确实走了向量融合（RRF）而不是退化成关键词', () => {
    expect(report.modes.hybrid.observedModes.some((m) => m.startsWith('hybrid'))).toBe(true);
    expect(report.modes.hybrid.vectorStatusDegraded).toBe(false);
    // 真的通过 HTTP 打了 fixture 嵌入端点（不是 mock 掉的能力）
    expect(report.embeddingHttp.requests).toBeGreaterThan(0);
    expect(report.embedIndex.embedded).toBeGreaterThanOrEqual(report.embedIndex.pages);
    expect(report.embedIndex.failed).toBe(0);
  });

  it('混合 Recall@10 单独报告，且未达门禁时留下定位到责任票的失败记录', () => {
    // 混合与关键词分别报告（数值不必相同）
    expect(report.modes.hybrid.recallAt10).toBeLessThanOrEqual(1);
    expect(report.gates.hybrid.measured).toBe(report.modes.hybrid.recallAt10);

    if (report.gates.hybrid.met) {
      // 达标时不得继续挂「未达标」记录
      expect(report.findings.some((f) => f.id === 'hybrid-recall-below-gate')).toBe(false);
      return;
    }
    const finding = report.findings.find((f) => f.id === 'hybrid-recall-below-gate');
    expect(finding, '混合未达门禁必须留下失败记录，不得隐藏失败结案').toBeDefined();
    expect(finding!.ticket).toBe('24');
    expect(report.gates.hybrid.responsibleTickets.length).toBeGreaterThan(0);
    expect(finding!.evidence.length).toBeGreaterThan(3);
    // 失败记录必须给出具体未召回查询（不是只有一句结论）
    expect(finding!.evidence.some((e) => e.includes('未召回'))).toBe(true);
  });

  it('unions：放宽窗口（topK=20）时召回回升，缺口是排名窗口而非证据丢失', () => {
    // 诊断指标，不设门禁；用于把混合的门禁缺口定位清楚
    expect(report.modes.hybrid.recallAt20).toBeGreaterThanOrEqual(report.modes.hybrid.recallAt10);
    expect(report.modes.keyword.recallAt20).toBeGreaterThanOrEqual(report.modes.keyword.recallAt10);
  });

  it('判别性查询（同名寄存器/唯一符号）在关键词模式下第 1 位正确', () => {
    const gated = QUALITY_QUERIES.filter(
      (q) => q.expectedTop1 !== undefined && q.top1Gated !== false,
    );
    expect(gated.length).toBeGreaterThanOrEqual(5);
    for (const q of gated) {
      const run = report.modes.keyword.runs.find((r) => r.queryId === q.id);
      expect(run, `缺少查询运行结果 ${q.id}`).toBeDefined();
      expect(run!.top1, `${q.id} 第 1 位不是预期证据`).toBe(q.expectedTop1);
    }
    // 同名寄存器跨 IP 的判别必须被覆盖
    expect(gated.some((q) => q.id === 'sym-pcie-ctrl-reset')).toBe(true);
  });

  it('排序精度缺口被记录而不隐藏（top1 未满 / 混合精度低于关键词）', () => {
    if ((report.modes.keyword.top1Accuracy ?? 1) < 1) {
      const f = report.findings.find((x) => x.id === 'keyword-top1-tiebreak');
      expect(f, '关键词 top1 未满必须留下精度记录').toBeDefined();
      expect(f!.evidence.length).toBeGreaterThan(0);
    }
    const diluted = report.modes.hybrid.recallAt10 < report.modes.keyword.recallAt10
      || report.modes.hybrid.mrr < report.modes.keyword.mrr;
    expect(report.findings.some((x) => x.id === 'hybrid-dilutes-keyword-ranking')).toBe(diluted);
  });
});

// ── 保真门禁 ────────────────────────────────────────────────────

describe('关键数值/单位/位宽/引用保真', () => {
  it('样例的错误数为零', () => {
    expect(fidelityErrors.map((e) => `${e.factId}:${e.reason}`)).toEqual([]);
    expect(citationErrors.map((c) => `${c.pageId}→${c.sourceId}:${c.reason}`)).toEqual([]);
    expect(report.fidelity.facts).toBe(FIDELITY_FACTS.length);
  });

  it('注入错误全部被检出（门禁非空转）', () => {
    expect(mutations.length).toBeGreaterThanOrEqual(5);
    const undetected = mutations.filter((m) => m.undetected.length > 0);
    expect(undetected.map((m) => `${m.id}:${m.undetected.join(',')}`)).toEqual([]);
  });

  it('位宽/单位/数值/引用四类注入都有对应负向对照', () => {
    const ids = mutations.map((m) => m.id);
    for (const required of ['unit-swap', 'bit-width-drift', 'value-drift', 'citation-removed', 'figure-asset-removed', 'source-literal-drift']) {
      expect(ids).toContain(required);
    }
  });
});

// ── 被撤回值与图补召回契约 ────────────────────────────────────────

describe('被撤回值与图补召回', () => {
  it('引用已失效修订的页必须被标 stale（旧知识可定位但不冒充当前）', () => {
    const staleQueries = QUALITY_QUERIES.filter((q) => (q.mustFlagStale ?? []).length > 0);
    expect(staleQueries.length).toBeGreaterThan(0);
    for (const id of staleQueries.map((q) => q.id)) {
      const run = report.modes.keyword.runs.find((r) => r.queryId === id);
      expect(run, `缺少查询运行结果 ${id}`).toBeDefined();
      expect(run!.staleViolations, `${id} stale 未满足`).toEqual([]);
    }
  });

  it('当前有效值（8 笔）可从当前修订全文召回，过时值页也仍在结果中', () => {
    const run = report.modes.keyword.runs.find((r) => r.queryId === 'retract-outstanding-limit');
    expect(run).toBeDefined();
    expect(run!.foundAt10.some((k) => k.startsWith('parsed:'))).toBe(true);
    expect(run!.foundAt10).toContain('wiki:concepts/axi-outstanding');
  });

  it('图补召回在关键词模式下按契约追加并标注 seed', () => {
    const graphQueries = QUALITY_QUERIES.filter((q) => q.graphSupplement !== undefined);
    expect(graphQueries.length).toBeGreaterThan(0);
    for (const q of graphQueries) {
      const run = report.modes.keyword.runs.find((r) => r.queryId === q.id);
      expect(run, `缺少查询运行结果 ${q.id}`).toBeDefined();
      expect(run!.graphSupplementDetail).not.toBeNull();
      expect(run!.graphSupplementMet, `${q.id}: ${run!.graphSupplementDetail}`).toBe(true);
    }
    expect(report.modes.keyword.graphExpandedTotal).toBeGreaterThan(0);
  });
});

// ── 接线探测与失败记录一致（结论不许过期）──────────────────────────

describe('混合检索接线探测', () => {
  it('接线探测结论与失败记录一致', () => {
    const recorded = report.findings.some((f) => f.id === 'hybrid-not-wired');
    // 未接线 → 必须有记录；已接线 → 记录必须消失
    expect(recorded).toBe(wiring.callersPassContext === false);
    if (!wiring.callersPassContext) {
      expect(wiring.serviceConstructed).toBe(false);
      expect(wiring.lancedbBackend).toBe(false);
    }
  });

  it('报告已落盘且包含可复述的门禁数值', async () => {
    const { jsonPath, mdPath } = await writeReport(REPORT_DIR, report);
    expect(jsonPath.endsWith('report.json')).toBe(true);
    expect(mdPath.endsWith('report.md')).toBe(true);
    expect(report.gates.keyword.threshold).toBe(report.threshold);
    expect(report.endpointProbe.message.length).toBeGreaterThan(0);
  });
});
