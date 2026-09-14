/**
 * issue 29 — 质量基准驱动器：跑三种模式的检索、装配门禁结论与失败定位记录。
 *
 * 三种模式：
 *  - `keyword`           不传 ctx（= 当前产品调用点实际走的路径）
 *  - `keyword-degraded`  传 ctx 但嵌入未配置（真实降级路径，须与 keyword 排名一致）
 *  - `hybrid`            传 ctx + 确定性 fixture 嵌入端点（度量融合管线，非模型质量）
 *
 * 门禁阈值为 spec §Testing Decisions 的 Recall@10 ≥ 0.9。
 */

import { readFile, readdir } from 'node:fs/promises';
import { cpus, release, totalmem, arch as osArch, platform as osPlatform } from 'node:os';
import { join } from 'node:path';
import { searchWiki } from '../../src/main/kb/wiki-search';
import { EmbeddingService } from '../../src/main/kb/embedding-service';
import { VectorStore, MemoryVectorBackend } from '../../src/main/kb/vector-store';
import { rebuildEmbeddingIndex } from '../../src/main/kb/index-rebuilder';
import { scanWikiCatalog } from '../../src/main/kb/wiki-catalog';
import {
  evaluateQuery,
  summarize,
  type QueryRun,
  type RecallSummary,
} from './kb-quality-recall';
import { QUALITY_QUERIES, type QualityQuery } from './kb-quality-queries';
import { UNCONFIGURED_EMBEDDING } from './kb-quality-embedding';
import type { EmbeddingRuntimeConfig } from '@shared/kb-types';

export const RECALL_THRESHOLD = 0.9;
export const BENCH_TOP_K = 10;
export const BENCH_TOP_K_DIAGNOSTIC = 20;

export type ModeId = 'keyword' | 'keyword-degraded' | 'hybrid';

export type ModeSummary = {
  mode: ModeId;
  threshold: number;
  /** 门禁指标：宏平均 Recall@10 */
  recallAt10: number;
  /** 诊断：宏平均 Recall@20（同一返回列表放宽窗口） */
  recallAt20: number;
  queriesFullyRecalled: number;
  mrr: number;
  top1Accuracy: number | null;
  /** 实际返回的 mode 字符串集合（keyword / keyword+graph / hybrid …） */
  observedModes: string[];
  /** 前 10 条里 wiki / parsed 各多少（召回缺口定位） */
  evidenceMixAt10: { wiki: number; parsed: number };
  vectorStatusDegraded: boolean | null;
  vectorDegradeReason: string | null;
  graphExpandedTotal: number;
  graphSupplementAsserted: number;
  graphSupplementMet: number;
  /** 平均返回条数 */
  returnedAvg: number;
  msTotal: number;
  msP50: number;
  runs: QueryRun[];
};

export type Finding = {
  id: string;
  /** 责任票（issue 编号） */
  ticket: string;
  severity: 'blocker' | 'high' | 'info';
  title: string;
  detail: string;
  evidence: string[];
};

export type GateVerdict = {
  threshold: number;
  measured: number;
  met: boolean;
  /** 未达目标时的责任票 */
  responsibleTickets: string[];
};

/** 生产接线探测（防止「未接线」这条结论过期） */
export type HybridWiring = {
  searchCallers: string[];
  /** 调用点是否传入了嵌入上下文（识别 `embeddingService` 标识） */
  callersPassContext: boolean;
  /** 生产代码是否构造过嵌入服务/向量存储 */
  serviceConstructed: boolean;
  /** 生产代码是否有 LanceDB 后端实现 */
  lancedbBackend: boolean;
};

export const SEARCH_CALLER_FILES = [
  'src/main/ipc/routers/kb-router.ts',
  'src/main/host/tools/kb-tools.ts',
];

/** 读生产源码判定混合检索是否已接线（不是行为测试，是防止结论过期的自检） */
export async function probeHybridWiring(repoRoot: string): Promise<HybridWiring> {
  const texts = new Map<string, string>();
  for (const rel of SEARCH_CALLER_FILES) {
    try {
      texts.set(rel, await readFile(join(repoRoot, rel), 'utf-8'));
    } catch {
      texts.set(rel, '');
    }
  }

  let anyMainSource = '';
  for (const dir of ['src/main/kb', 'src/main/ipc', 'src/main/host']) {
    try {
      for (const file of await readdir(join(repoRoot, dir))) {
        if (!file.endsWith('.ts')) continue;
        anyMainSource += await readFile(join(repoRoot, dir, file), 'utf-8');
      }
    } catch {
      // 目录不存在 → 跳过
    }
  }

  return {
    searchCallers: SEARCH_CALLER_FILES,
    callersPassContext: [...texts.values()].some((t) => t.includes('embeddingService')),
    serviceConstructed: /new\s+EmbeddingService\s*\(/.test(anyMainSource)
      && /new\s+VectorStore\s*\(/.test(anyMainSource),
    lancedbBackend: /class\s+LanceDbVectorBackend/.test(anyMainSource),
  };
}

// ── 单模式运行 ──────────────────────────────────────────────────

type SearchContextArg = { embeddingService: EmbeddingService; embeddingCfg: EmbeddingRuntimeConfig };

async function runQueries(
  kbPath: string,
  mode: ModeId,
  queries: QualityQuery[],
  ctx: SearchContextArg | undefined,
  topK: number,
): Promise<{ runs: QueryRun[]; ms: number[]; observed: string[]; expanded: number; vectorDegraded: boolean | null; degradeReason: string | null }> {
  const runs: QueryRun[] = [];
  const ms: number[] = [];
  const observed: string[] = [];
  let expanded = 0;
  let vectorDegraded: boolean | null = null;
  let degradeReason: string | null = null;

  for (const q of queries) {
    const started = Date.now();
    const res = await searchWiki(kbPath, { query: q.query, topK }, ctx);
    ms.push(Date.now() - started);
    if (!res.ok) {
      throw new Error(`[${mode}] 查询 ${q.id} 检索失败: ${res.error.code} ${res.error.message}`);
    }
    observed.push(res.result.mode);
    const expandedThis = res.result.graphExpansion?.expanded ?? 0;
    expanded += expandedThis;
    if (res.result.vectorStatus) {
      vectorDegraded = res.result.vectorStatus.degraded;
      degradeReason = res.result.vectorStatus.degradeReason ?? res.result.vectorStatus.errorKind ?? null;
    }
    runs.push(evaluateQuery(q, res.result.hits, topK, expandedThis));
  }

  return { runs, ms, observed, expanded, vectorDegraded, degradeReason };
}

function modeSummary(
  mode: ModeId,
  runs: QueryRun[],
  ms: number[],
  observed: string[],
  expanded: number,
  vectorDegraded: boolean | null,
  degradeReason: string | null,
  runsAt20: QueryRun[],
): ModeSummary {
  const s10: RecallSummary = summarize(runs);
  const s20: RecallSummary = summarize(runsAt20);
  const sorted = [...ms].sort((a, b) => a - b);
  const foundKeys = runs.flatMap((r) => r.foundAt10);
  const mix = {
    wiki: foundKeys.filter((k) => k.startsWith('wiki:')).length,
    parsed: foundKeys.filter((k) => k.startsWith('parsed:')).length,
  };

  return {
    mode,
    threshold: RECALL_THRESHOLD,
    recallAt10: s10.macroRecall,
    recallAt20: s20.macroRecall,
    queriesFullyRecalled: s10.queriesFullyRecalled,
    mrr: s10.mrr,
    top1Accuracy: s10.top1Accuracy,
    observedModes: [...new Set(observed)].sort(),
    evidenceMixAt10: mix,
    vectorStatusDegraded: vectorDegraded,
    vectorDegradeReason: degradeReason,
    graphExpandedTotal: expanded,
    graphSupplementAsserted: runs.filter((r) => r.graphSupplementMet !== null).length,
    graphSupplementMet: runs.filter((r) => r.graphSupplementMet === true).length,
    returnedAvg: runs.length === 0 ? 0 : runs.reduce((a, r) => a + r.returned, 0) / runs.length,
    msTotal: ms.reduce((a, b) => a + b, 0),
    msP50: sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)],
    runs,
  };
}

// ── 全量运行 ────────────────────────────────────────────────────

export type BenchmarkResult = {
  modes: Record<ModeId, ModeSummary>;
  /** keyword 与 keyword-degraded 的返回键序列是否逐条完全一致 */
  degradedMatchesKeyword: boolean;
  degradedMismatchDetail: string[];
  embedIndex: { pages: number; embedded: number; failed: number; skipped: number };
  embeddingHttp: { requests: number; inputs: number };
};

export type RunBenchmarkOptions = {
  /** 索引已发布页向量所用的嵌入配置（fixture 端点） */
  embeddingCfg: EmbeddingRuntimeConfig;
  /** 诊断嵌入调用是否真的走了 HTTP */
  httpStats: () => { requests: number; inputs: number };
};

export async function runBenchmark(
  kbPath: string,
  kbId: string,
  options: RunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const queries = QUALITY_QUERIES;

  // ── 1) keyword（产品实际路径）──────────────────────────────────
  const keyword10 = await runQueries(kbPath, 'keyword', queries, undefined, BENCH_TOP_K);
  const keyword20 = await runQueries(kbPath, 'keyword', queries, undefined, BENCH_TOP_K_DIAGNOSTIC);

  // ── 2) keyword-degraded（传 ctx，嵌入未配置）──────────────────
  const store = new VectorStore(new MemoryVectorBackend());
  const service = new EmbeddingService(store);
  const degraded = await runQueries(
    kbPath,
    'keyword-degraded',
    queries,
    { embeddingService: service, embeddingCfg: UNCONFIGURED_EMBEDDING },
    BENCH_TOP_K,
  );

  // 降级不得改变关键词结果：逐条比较完整返回键序列
  const keywordKeys = keyword10.runs.map((r) => `${r.foundAt10.join(',')}|${r.top1}|${r.returned}`);
  const degradedKeys = degraded.runs.map((r) => `${r.foundAt10.join(',')}|${r.top1}|${r.returned}`);
  const degradedMismatchDetail: string[] = [];
  for (let i = 0; i < queries.length; i++) {
    if (keywordKeys[i] !== degradedKeys[i]) {
      degradedMismatchDetail.push(`${queries[i].id}: keyword=${keywordKeys[i]} degraded=${degradedKeys[i]}`);
    }
  }

  // ── 3) hybrid（fixture 嵌入端点 + 真实 RRF 管线）──────────────
  const scan = await scanWikiCatalog(kbPath);
  if (!scan.ok) throw new Error('fixture catalog 不可解析');
  const embedIndex = await rebuildEmbeddingIndex(kbPath, kbId, service, options.embeddingCfg);
  if (!embedIndex.ok) {
    throw new Error(`向量索引重建未完成（cancelled=${embedIndex.cancelled}）`);
  }

  const hybrid10 = await runQueries(
    kbPath,
    'hybrid',
    queries,
    { embeddingService: service, embeddingCfg: options.embeddingCfg },
    BENCH_TOP_K,
  );
  const hybrid20 = await runQueries(
    kbPath,
    'hybrid',
    queries,
    { embeddingService: service, embeddingCfg: options.embeddingCfg },
    BENCH_TOP_K_DIAGNOSTIC,
  );

  return {
    modes: {
      keyword: modeSummary('keyword', keyword10.runs, keyword10.ms, keyword10.observed, keyword10.expanded, keyword10.vectorDegraded, keyword10.degradeReason, keyword20.runs),
      'keyword-degraded': modeSummary('keyword-degraded', degraded.runs, degraded.ms, degraded.observed, degraded.expanded, degraded.vectorDegraded, degraded.degradeReason, degraded.runs),
      hybrid: modeSummary('hybrid', hybrid10.runs, hybrid10.ms, hybrid10.observed, hybrid10.expanded, hybrid10.vectorDegraded, hybrid10.degradeReason, hybrid20.runs),
    },
    degradedMatchesKeyword: degradedMismatchDetail.length === 0,
    degradedMismatchDetail,
    embedIndex: {
      pages: scan.catalog.pages.filter((p) => p.parse.ok).length,
      embedded: embedIndex.embedded,
      failed: embedIndex.failed,
      skipped: embedIndex.skipped,
    },
    embeddingHttp: options.httpStats(),
  };
}

/** 环境自描述（固定测试机记录用） */
export function describeEnvironment(): Record<string, string | number> {
  return {
    node: process.version,
    platform: osPlatform(),
    arch: osArch(),
    osRelease: release(),
    cpuModel: cpus()[0]?.model ?? 'unknown',
    cpuCount: cpus().length,
    totalMemMB: Math.round(totalmem() / (1024 * 1024)),
  };
}

export type { QueryRun };
