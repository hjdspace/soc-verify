/**
 * issue 29 — 质量基准报告装配（JSON + Markdown）。
 *
 * 报告是**验收证据**：既给出门禁数值，也把未达目标的原因绑定到责任票，
 * 不允许通过降低样例难度或隐藏失败结案。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CHUNK_ANALYSIS_PROMPT_VERSION } from '../../src/main/kb/compile-prompts';
import { fetchEmbedding } from '../../src/main/kb/embedding-endpoint';
import {
  BENCH_TOP_K,
  BENCH_TOP_K_DIAGNOSTIC,
  RECALL_THRESHOLD,
  type BenchmarkResult,
  type Finding,
  type GateVerdict,
  type HybridWiring,
  type ModeId,
  type ModeSummary,
} from './kb-quality-benchmark';
import type { CitationError, FidelityError, MutationOutcome } from './kb-quality-fidelity';
import { QUALITY_QUERIES, REQUIRED_CATEGORIES, MIN_QUERY_COUNT } from './kb-quality-queries';
import { FIXTURE_EMBEDDING_DIMS, FIXTURE_EMBEDDING_MODEL } from './kb-quality-embedding';

export type ModelConfigRecord = {
  /** KB 设置里的模型（本环境读取失败则为 null） */
  llm: { providerId: string; model: string } | null;
  llmSource: string;
  embedding: { mode: 'fixture-token-hash' | 'real' | 'unavailable'; model: string; dims: number | null };
  promptConfig: { promptVersion: number; note: string };
  /** 本票是否执行了真实模型调用 */
  realModelCallExecuted: boolean;
};

export type EndpointProbe = {
  requested: boolean;
  configured: boolean;
  ok: boolean | null;
  errorKind: string | null;
  message: string;
};

export type QualityReport = {
  schemaVersion: 1;
  ticket: '29';
  title: string;
  generatedAt: string;
  threshold: number;
  topK: number;
  topKDiagnostic: number;
  environment: Record<string, string | number>;
  fixture: {
    kbId: string;
    pages: number;
    sources: number;
    queries: number;
    minQueries: number;
    categories: Record<string, number>;
    requiredCategories: string[];
  };
  modelConfig: ModelConfigRecord;
  endpointProbe: EndpointProbe;
  modes: Record<ModeId, ModeSummary>;
  gates: Record<'keyword' | 'hybrid', GateVerdict>;
  degradedMatchesKeyword: boolean;
  degradedMismatchDetail: string[];
  embedIndex: BenchmarkResult['embedIndex'];
  embeddingHttp: BenchmarkResult['embeddingHttp'];
  fidelity: {
    facts: number;
    errors: FidelityError[];
    citations: CitationError[];
    mutations: Array<Pick<MutationOutcome, 'id' | 'describe' | 'expectedFactIds' | 'detectedFactIds' | 'undetected'>>;
  };
  wiring: HybridWiring;
  findings: Finding[];
  notes: string[];
};

/** 只读 KB 设置里的 llm 段（不含任何密钥；读不到就记 null） */
export async function readLlmSetting(): Promise<{ value: ModelConfigRecord['llm']; source: string }> {
  const appData = process.env.APPDATA;
  const candidates = [
    appData ? join(appData, 'soc-verify', 'socverify-data', 'kb-settings.json') : null,
  ].filter((p): p is string => p !== null);
  for (const path of candidates) {
    try {
      const raw = await readFile(path, 'utf-8');
      const parsed = JSON.parse(raw) as { llm?: { providerId?: string; model?: string } };
      if (parsed.llm?.providerId) {
        return {
          value: { providerId: parsed.llm.providerId, model: parsed.llm.model ?? '(默认)' },
          source: path,
        };
      }
    } catch {
      // 读不到 → 继续
    }
  }
  return { value: null, source: '未找到 kb-settings.json（不影响检索门禁）' };
}

/** 真实嵌入端点探测：只有显式提供环境变量时才发起请求（不读取用户凭据） */
export async function probeEmbeddingEndpoint(): Promise<EndpointProbe> {
  const endpoint = process.env.KB_QUALITY_PROBE_ENDPOINT;
  const apiKey = process.env.KB_QUALITY_PROBE_API_KEY;
  const model = process.env.KB_QUALITY_PROBE_MODEL ?? 'probe';
  if (!endpoint || !apiKey) {
    return {
      requested: false,
      configured: false,
      ok: null,
      errorKind: null,
      message:
        '本环境未提供嵌入端点（KB 设置无 embedding 配置）。'
        + '设 KB_QUALITY_PROBE_ENDPOINT / KB_QUALITY_PROBE_API_KEY 可复述真实端点。',
    };
  }
  const result = await fetchEmbedding('SoC 检索探针', {
    endpoint,
    apiKey,
    model,
    maxChunkChars: 800,
    overlapChunkChars: 100,
    concurrency: 1,
  });
  return result.ok
    ? { requested: true, configured: true, ok: true, errorKind: null, message: `维度 ${result.value.length}` }
    : { requested: true, configured: true, ok: false, errorKind: result.error.kind, message: result.error.message };
}

export type BuildReportInput = {
  environment: Record<string, string | number>;
  fixture: { kbId: string; pages: number; sources: number; factCount: number };
  benchmark: BenchmarkResult;
  fidelityErrors: FidelityError[];
  citationErrors: CitationError[];
  mutations: MutationOutcome[];
  wiring: HybridWiring;
  endpointProbe: EndpointProbe;
  llm: { value: ModelConfigRecord['llm']; source: string };
  realModelCallExecuted: boolean;
  notes?: string[];
};

function gate(measured: number, tickets: string[]): GateVerdict {
  return {
    threshold: RECALL_THRESHOLD,
    measured,
    met: measured >= RECALL_THRESHOLD,
    responsibleTickets: measured >= RECALL_THRESHOLD ? [] : tickets,
  };
}

/** 从测量结果派生失败定位记录（未达目标必须留痕） */
export function deriveFindings(input: BuildReportInput): Finding[] {
  const findings: Finding[] = [];
  const { benchmark, wiring, endpointProbe } = input;
  const keyword = benchmark.modes.keyword;
  const hybrid = benchmark.modes.hybrid;

  if (keyword.recallAt10 < RECALL_THRESHOLD) {
    findings.push({
      id: 'keyword-recall-below-gate',
      ticket: '14',
      severity: 'blocker',
      title: `关键词 Recall@10 ${keyword.recallAt10.toFixed(3)} < ${RECALL_THRESHOLD}`,
      detail: '产品当前唯一在跑的检索路径未达门禁，需在关键词排序（wiki-search 打分/分词）侧修复。',
      evidence: keyword.runs
        .filter((r) => r.missedAt10.length > 0)
        .map((r) => `${r.queryId}: 未召回 ${r.missedAt10.join(', ')}`),
    });
  }

  if (wiring.callersPassContext === false) {
    findings.push({
      id: 'hybrid-not-wired',
      ticket: '24',
      severity: 'blocker',
      title: '混合检索尚未接入产品调用点',
      detail:
        'searchWiki 的生产调用点均未传入嵌入上下文，且 src/main 下没有任何 `new EmbeddingService(` / '
        + '`new VectorStore(` 调用，也没有 LanceDB 后端实现 → 产品只会走关键词分支，'
        + '`mode` 永远不会是 hybrid，向量索引/重建能力在应用内不可达。',
      evidence: [
        `调用点: ${wiring.searchCallers.join(', ')}`,
        `调用点传入嵌入上下文: ${wiring.callersPassContext}`,
        `生产代码构造嵌入服务/向量存储: ${wiring.serviceConstructed}`,
        `存在 LanceDB 后端实现: ${wiring.lancedbBackend}`,
      ],
    });
  }

  if (hybrid.recallAt10 < RECALL_THRESHOLD) {
    const missed = hybrid.runs.filter((r) => r.missedAt10.length > 0);
    findings.push({
      id: 'hybrid-recall-below-gate',
      ticket: '24',
      severity: 'blocker',
      title: `混合 Recall@10 ${hybrid.recallAt10.toFixed(3)} < ${RECALL_THRESHOLD}（不得当成功结案）`,
      detail:
        '在真实 RRF 管线上（fixture 嵌入端点）混合模式的 top-10 被「向量侧零相关候选」填满：'
        + 'MemoryVectorBackend.searchChunks 只按 top-K 截断、没有相似度下限，'
        + '与关键词排名做 RRF 后把只靠关键词才能命中的 parsed（来源全文）证据挤出前 10。'
        + '同一返回列表放宽到 topK=20 时召回恢复到 1.0，说明缺口是排名窗口问题而不是证据丢失。'
        + '修复建议（归 24）：向量候选收集加相似度下限或只在非降级且非零相关时计票。',
      evidence: [
        `混合 top-10 命中证据构成: wiki=${hybrid.evidenceMixAt10.wiki}, parsed=${hybrid.evidenceMixAt10.parsed}`,
        `关键词同口径: wiki=${keyword.evidenceMixAt10.wiki}, parsed=${keyword.evidenceMixAt10.parsed}`,
        `Recall@10=${hybrid.recallAt10.toFixed(3)} vs Recall@${BENCH_TOP_K_DIAGNOSTIC}=${hybrid.recallAt20.toFixed(3)}`,
        ...missed.map((r) => `${r.queryId}: 未召回 ${r.missedAt10.join(', ')}（top1=${r.top1}）`),
      ],
    });
  }

  // ── 非门禁的精度观测（记录但不改门禁，也不因此改样例难度）──────

  const keywordTop1Missed = keyword.runs.filter((r) => r.top1Correct === false);
  if (keywordTop1Missed.length > 0) {
    findings.push({
      id: 'keyword-top1-tiebreak',
      ticket: '14',
      severity: 'info',
      title: `关键词第 1 位精度 ${(keyword.top1Accuracy ?? 0).toFixed(2)}（门禁只看 Recall@10）`,
      detail:
        '失手项都是**同分**后按规范身份 `(kind, id)` 字典序 tie-break 的结果：'
        + '查询的区别性词（如 tRCD）与泛化词（如 DDR）权重相同，'
        + '命中区别性词的页面因此可能被只命中泛化词的页面以 pageId 排序压过；'
        + '以及「页面 vs 来源全文」在同等权威时 `parsed:` 身份排在 `wiki:` 之前。'
        + '这些查询的 top1Gated=false：记录精度缺口，不改变门禁结论，也不调低样例难度。',
      evidence: keywordTop1Missed.map(
        (r) => `${r.queryId}: top1=${r.top1}（预期第 1 位见查询定义的 expectedTop1）`,
      ),
    });
  }

  if (hybrid.recallAt10 < keyword.recallAt10 || hybrid.mrr < keyword.mrr) {
    findings.push({
      id: 'hybrid-dilutes-keyword-ranking',
      ticket: '24',
      severity: 'info',
      title: `混合模式排序精度低于关键词（MRR ${keyword.mrr.toFixed(3)} → ${hybrid.mrr.toFixed(3)}）`,
      detail:
        '向量侧没有相似度下限（searchChunks 只按 top-K 截断），与查询零相关的 chunk 也进入向量排名；'
        + 'RRF 把这些「填充候选」与关键词排名一起计票，于是关键词侧已经正确的第 1 名被拉平，'
        + '同名寄存器（同一寄存器名 + 不同复位值）的判别力下降，只靠关键词才能命中的来源全文证据被挤出前 10。'
        + '本数值用确定性 fixture 嵌入测得，不构成模型语义质量结论；'
        + '但 RRF 计票结构对「关键词已正确」没有保护机制，真实模型下同样可能发生——'
        + '需在 24 决定是否加相似度下限、权重或 top-1 保护。',
      evidence: [
        `Recall@10 ${keyword.recallAt10.toFixed(3)} → ${hybrid.recallAt10.toFixed(3)}；`
          + `MRR ${keyword.mrr.toFixed(3)} → ${hybrid.mrr.toFixed(3)}；`
          + `top1 ${keyword.top1Accuracy === null ? '—' : keyword.top1Accuracy.toFixed(2)}`
          + ` → ${hybrid.top1Accuracy === null ? '—' : hybrid.top1Accuracy.toFixed(2)}`,
        `top-10 证据构成 keyword=${JSON.stringify(keyword.evidenceMixAt10)}`
          + ` hybrid=${JSON.stringify(hybrid.evidenceMixAt10)}`,
        `图补召回契约命中 keyword=${keyword.graphSupplementMet}/${keyword.graphSupplementAsserted}`
          + ` → hybrid=${hybrid.graphSupplementMet}/${hybrid.graphSupplementAsserted}`,
        `混合模式下投错第 1 位的查询: ${
          hybrid.runs.filter((r) => r.top1Correct === false).map((r) => r.queryId).join(', ') || '无'
        }`,
        ...hybrid.runs
          .filter((r) => r.missedAt10.length > 0)
          .map((r) => `${r.queryId}: 混合未召回 ${r.missedAt10.join(', ')}（top1=${r.top1}）`),
      ],
    });
  }

  if (keyword.evidenceMixAt10.parsed > 0 && hybrid.evidenceMixAt10.parsed === 0) {
    findings.push({
      id: 'parsed-not-vectorized',
      ticket: '22',
      severity: 'high',
      title: '原文（parsed）全文没有向量覆盖，混合模式对其零贡献',
      detail:
        'EmbeddingService 只有 embedPage（页面）入口，index-rebuilder 也只枚举已发布 wiki 页；'
        + 'raw/parsed 的来源全文没有任何向量。因此凡是权威证据在来源全文的查询，'
        + '混合模式只能靠关键词一侧计票，任何向量填充都会压低它。',
      evidence: [
        'src/main/kb/embedding-service.ts: 仅 embedPage / searchByQuery',
        'src/main/kb/index-rebuilder.ts: 只枚举 catalog.pages',
        `样例证据构成: keyword parsed=${keyword.evidenceMixAt10.parsed} → hybrid parsed=${hybrid.evidenceMixAt10.parsed}`,
      ],
    });
  }

  if (!endpointProbe.configured) {
    findings.push({
      id: 'embedding-endpoint-unavailable',
      ticket: '21',
      severity: 'high',
      title: '本环境无可用嵌入端点，混合检索的真实模型质量未验收',
      detail:
        '报告中混合 Recall@10 由确定性 fixture 嵌入端点测得，只覆盖融合与排序管线，'
        + '不构成模型语义质量结论；真实端点仍需按 issue 21 复述。',
      evidence: [endpointProbe.message],
    });
  }

  if (!input.realModelCallExecuted) {
    findings.push({
      id: 'llm-compile-not-executed',
      ticket: '30',
      severity: 'info',
      title: '本环境未执行真实模型编译，保真门禁跑在样例编译产物形状上',
      detail:
        '「关键数值/单位/位宽/引用错误为零」只对本样例的页面成立，'
        + '不能泛化为对任意模型输出的正确性保证；真实模型编译需在安装包旅程（issue 30）里复述。',
      evidence: [
        `prompt 版本 CHUNK_ANALYSIS_PROMPT_VERSION=${CHUNK_ANALYSIS_PROMPT_VERSION}`,
        '页面由 fixture 直接物化为「编译产物形状」（含 frontmatter 引用与图资产）',
      ],
    });
  }

  const undetected = input.mutations.filter((m) => m.undetected.length > 0);
  if (undetected.length > 0) {
    findings.push({
      id: 'fidelity-gate-vacuous',
      ticket: '29',
      severity: 'blocker',
      title: '保真门禁未检出注入错误（门禁失效）',
      detail: '负向对照存在未检出项，保真结论不可信。',
      evidence: undetected.map((m) => `${m.id}: 未检出 ${m.undetected.join(', ')}`),
    });
  }

  if (input.citationErrors.length > 0 || input.fidelityErrors.length > 0) {
    findings.push({
      id: 'sample-value-errors',
      ticket: '29',
      severity: 'blocker',
      title: '样例关键数值/单位/位宽/引用存在错误',
      detail: 'spec 要求样例错误为零。',
      evidence: [
        ...input.fidelityErrors.map((e) => `${e.factId}: ${e.reason} — ${e.detail}`),
        ...input.citationErrors.map((c) => `${c.pageId} → ${c.sourceId}@${c.revision}: ${c.reason}`),
      ],
    });
  }

  if (!benchmark.degradedMatchesKeyword) {
    findings.push({
      id: 'degrade-changes-keyword-results',
      ticket: '24',
      severity: 'high',
      title: '嵌入降级改变了关键词结果（spec 要求降级时关键词/图保持可用）',
      detail: 'keyword 与 keyword-degraded 的返回不一致。',
      evidence: benchmark.degradedMismatchDetail,
    });
  }

  return findings;
}

export function buildReport(input: BuildReportInput): QualityReport {
  const categoryCounts: Record<string, number> = {};
  for (const q of QUALITY_QUERIES) categoryCounts[q.category] = (categoryCounts[q.category] ?? 0) + 1;

  return {
    schemaVersion: 1,
    ticket: '29',
    title: 'SoC 知识与检索证据质量验收',
    generatedAt: new Date().toISOString(),
    threshold: RECALL_THRESHOLD,
    topK: BENCH_TOP_K,
    topKDiagnostic: BENCH_TOP_K_DIAGNOSTIC,
    environment: input.environment,
    fixture: {
      kbId: input.fixture.kbId,
      pages: input.fixture.pages,
      sources: input.fixture.sources,
      queries: QUALITY_QUERIES.length,
      minQueries: MIN_QUERY_COUNT,
      categories: categoryCounts,
      requiredCategories: [...REQUIRED_CATEGORIES],
    },
    modelConfig: {
      llm: input.llm.value,
      llmSource: input.llm.source,
      embedding: {
        mode: 'fixture-token-hash',
        model: FIXTURE_EMBEDDING_MODEL,
        dims: FIXTURE_EMBEDDING_DIMS,
      },
      promptConfig: {
        promptVersion: CHUNK_ANALYSIS_PROMPT_VERSION,
        note: '本票未执行模型编译；仅记录编译提示词版本以固定复述条件',
      },
      realModelCallExecuted: input.realModelCallExecuted,
    },
    endpointProbe: input.endpointProbe,
    modes: input.benchmark.modes,
    gates: {
      keyword: gate(input.benchmark.modes.keyword.recallAt10, ['14']),
      hybrid: gate(input.benchmark.modes.hybrid.recallAt10, ['24', '22', '21']),
    },
    degradedMatchesKeyword: input.benchmark.degradedMatchesKeyword,
    degradedMismatchDetail: input.benchmark.degradedMismatchDetail,
    embedIndex: input.benchmark.embedIndex,
    embeddingHttp: input.benchmark.embeddingHttp,
    fidelity: {
      facts: input.fixture.factCount,
      errors: input.fidelityErrors,
      citations: input.citationErrors,
      mutations: input.mutations.map((m) => ({
        id: m.id,
        describe: m.describe,
        expectedFactIds: m.expectedFactIds,
        detectedFactIds: m.detectedFactIds,
        undetected: m.undetected,
      })),
    },
    wiring: input.wiring,
    findings: deriveFindings(input),
    notes: input.notes ?? [],
  };
}

// ── 渲染 ────────────────────────────────────────────────────────

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

function modeTable(report: QualityReport): string[] {
  const rows: string[] = [
    '| 模式 | Recall@10（门禁） | 达标 | Recall@20（诊断） | MRR | Top1 | 图补召回 | 返回均值 | p50 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  const ids: ModeId[] = ['keyword', 'keyword-degraded', 'hybrid'];
  for (const id of ids) {
    const m = report.modes[id];
    const met = m.recallAt10 >= report.threshold ? '✅' : '❌';
    rows.push(
      `| ${id} | ${m.recallAt10.toFixed(3)} (${pct(m.recallAt10)}) | ${met} | `
      + `${m.recallAt20.toFixed(3)} | ${m.mrr.toFixed(3)} | `
      + `${m.top1Accuracy === null ? '—' : pct(m.top1Accuracy)} | `
      + `${m.graphSupplementMet}/${m.graphSupplementAsserted} | ${m.returnedAvg.toFixed(1)} | ${m.msP50}ms |`,
    );
  }
  return rows;
}

function queryTable(mode: ModeSummary): string[] {
  const rows: string[] = [
    '| 查询 | 类别 | 预期 | Recall@10 | 未召回 | top1 | stale | 图补召回 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of mode.runs) {
    rows.push(
      `| ${r.queryId} | ${r.category} | ${r.foundAt10.length + r.missedAt10.length} | `
      + `${r.recallAt10.toFixed(2)} | ${r.missedAt10.length === 0 ? '—' : r.missedAt10.join('<br>')} | `
      + `${r.top1 ?? '—'} | ${r.staleViolations.length === 0 ? 'ok' : r.staleViolations.join('<br>')} | `
      + `${r.graphSupplementMet === null ? '—' : r.graphSupplementMet ? 'ok' : r.graphSupplementDetail ?? '—'} |`,
    );
  }
  return rows;
}

export function renderMarkdown(report: QualityReport): string {
  const lines: string[] = [];
  lines.push(`# issue 29 — ${report.title}`);
  lines.push('');
  lines.push(`生成时间：${report.generatedAt}`);
  lines.push('');
  lines.push('## 结论');
  lines.push('');
  lines.push(`- 关键词（产品当前唯一在跑的路径）Recall@10 = **${report.modes.keyword.recallAt10.toFixed(3)}** `
    + `（门禁 ${report.threshold} → ${report.gates.keyword.met ? '达标' : '未达标'}）`);
  lines.push(`- 混合（fixture 嵌入端点 + 真实 RRF 管线）Recall@10 = **${report.modes.hybrid.recallAt10.toFixed(3)}** `
    + `（门禁 ${report.threshold} → ${report.gates.hybrid.met ? '达标' : '未达标'}）`);
  lines.push(`- 保真门禁：事实错误 ${report.fidelity.errors.length}，引用不可解析 ${report.fidelity.citations.length}，`
    + `注入错误检出 ${report.fidelity.mutations.filter((m) => m.undetected.length === 0).length}/${report.fidelity.mutations.length}`);
  lines.push(`- 降级一致性（keyword-degraded 与 keyword 逐条一致）：${report.degradedMatchesKeyword ? '✅' : '❌'}`);
  lines.push('');
  lines.push('## 门禁数值');
  lines.push('');
  lines.push(...modeTable(report));
  lines.push('');
  lines.push('## 样例库与查询集');
  lines.push('');
  lines.push(`- fixture 库：${report.fixture.kbId}，页面 ${report.fixture.pages}，来源 ${report.fixture.sources}`);
  lines.push(`- 查询：${report.fixture.queries}（下限 ${report.fixture.minQueries}）`);
  lines.push(`- 类别分布：${Object.entries(report.fixture.categories).map(([k, v]) => `${k}=${v}`).join('，')}`);
  lines.push('');
  lines.push('## 模型与提示配置');
  lines.push('');
  lines.push(`- KB 设置模型：${report.modelConfig.llm ? `${report.modelConfig.llm.providerId} / ${report.modelConfig.llm.model}` : '未读到'}`);
  lines.push(`- 嵌入：${report.modelConfig.embedding.mode} / ${report.modelConfig.embedding.model} / dims=${report.modelConfig.embedding.dims}`);
  lines.push(`- 编译提示词版本：${report.modelConfig.promptConfig.promptVersion}`);
  lines.push(`- 本票执行真实模型调用：${report.modelConfig.realModelCallExecuted ? '是' : '否'}`);
  lines.push(`- 真实嵌入端点探测：${report.endpointProbe.message}`);
  lines.push('');
  lines.push('## 关键词模式逐条结果');
  lines.push('');
  lines.push(...queryTable(report.modes.keyword));
  lines.push('');
  lines.push('## 混合模式逐条结果');
  lines.push('');
  lines.push(...queryTable(report.modes.hybrid));
  lines.push('');
  lines.push('## 失败定位（责任票）');
  lines.push('');
  if (report.findings.length === 0) {
    lines.push('无未达标项。');
  } else {
    for (const f of report.findings) {
      lines.push(`### [${f.severity}] ${f.id} → issue ${f.ticket}`);
      lines.push('');
      lines.push(`**${f.title}**`);
      lines.push('');
      lines.push(f.detail);
      lines.push('');
      for (const e of f.evidence.slice(0, 12)) lines.push(`- ${e}`);
      lines.push('');
    }
  }
  lines.push('## 注入错误负向对照（门禁有效性）');
  lines.push('');
  lines.push('| 注入 | 说明 | 应命中事实 | 实检 | 未检出 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const m of report.fidelity.mutations) {
    lines.push(`| ${m.id} | ${m.describe} | ${m.expectedFactIds.join(', ')} | `
      + `${m.detectedFactIds.join(', ') || '—'} | ${m.undetected.join(', ') || '—'} |`);
  }
  lines.push('');
  lines.push('## 环境');
  lines.push('');
  for (const [k, v] of Object.entries(report.environment)) lines.push(`- ${k}: ${v}`);
  lines.push(`- 嵌入 fixture HTTP 请求: ${report.embeddingHttp.requests}（输入 ${report.embeddingHttp.inputs} 条）`);
  lines.push(`- 向量索引: 页面 ${report.embedIndex.pages}，已嵌入 ${report.embedIndex.embedded}，失败 ${report.embedIndex.failed}，跳过 ${report.embedIndex.skipped}`);
  lines.push('');
  if (report.notes.length > 0) {
    lines.push('## 备注');
    lines.push('');
    for (const n of report.notes) lines.push(`- ${n}`);
    lines.push('');
  }
  return lines.join('\n');
}

export async function writeReport(
  dir: string,
  report: QualityReport,
): Promise<{ jsonPath: string; mdPath: string }> {
  await mkdir(dir, { recursive: true });
  const jsonPath = join(dir, 'report.json');
  const mdPath = join(dir, 'report.md');
  await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf-8');
  await writeFile(mdPath, renderMarkdown(report), 'utf-8');
  return { jsonPath, mdPath };
}
