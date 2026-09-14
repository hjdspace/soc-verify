/**
 * issue 30 — 固定规模性能测量核心（spec §Testing Decisions）。
 *
 * 只提供**测量语义**，不做断言；门禁阈值与判定在 kb-package-gate.test.ts：
 *  - 缓存热关键词查询 p95 ≤ 1000ms（初始目标，spec §Testing Decisions）
 *  - 内存峰值采样（RSS + V8 heap，25ms 间隔）
 *  - 延迟统计：p50/p95/max/mean，真实模型延迟单独计（本文件不含模型调用）
 *
 * 「缓存热」的定义：fixture 落盘后先完整跑一遍查询集（预热 OS page cache
 * 与图快照缓存），随后逐轮计时。应用层没有检索结果缓存（searchWiki 每次
 * 重读页面与 parsed 全文），因此这里测的是真实产品路径的热稳态。
 */

import type { PackageQuery } from './kb-package-fixture';

// ── 延迟统计 ────────────────────────────────────────────────────

export type LatencyStats = {
  samples: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  meanMs: number;
};

export function summarizeLatencies(values: number[]): LatencyStats {
  if (values.length === 0) {
    return { samples: 0, minMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, meanMs: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
  return {
    samples: sorted.length,
    minMs: round1(sorted[0]!),
    p50Ms: round1(percentile(sorted, 0.5)),
    p95Ms: round1(percentile(sorted, 0.95)),
    maxMs: round1(sorted[sorted.length - 1]!),
    meanMs: round1(mean),
  };
}

/** 线性插值百分位（与常见基准口径一致） */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const rank = p * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo]!;
  return sortedAsc[lo]! + (sortedAsc[hi]! - sortedAsc[lo]!) * (rank - lo);
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

// ── 内存峰值采样 ────────────────────────────────────────────────

export type MemoryPeak = {
  /** RSS 峰值（字节） */
  rssPeakBytes: number;
  /** V8 heap used 峰值（字节） */
  heapUsedPeakBytes: number;
  /** 采样点数 */
  samples: number;
  intervalMs: number;
};

export type MemorySampler = {
  start: () => void;
  stop: () => MemoryPeak;
};

/** 定时采样当前进程内存；测量区间由 start/stop 圈定 */
export function createMemorySampler(intervalMs = 25): MemorySampler {
  let timer: NodeJS.Timeout | null = null;
  let rssPeak = 0;
  let heapPeak = 0;
  let count = 0;
  return {
    start: () => {
      rssPeak = 0;
      heapPeak = 0;
      count = 0;
      timer = setInterval(() => {
        const usage = process.memoryUsage();
        if (usage.rss > rssPeak) rssPeak = usage.rss;
        if (usage.heapUsed > heapPeak) heapPeak = usage.heapUsed;
        count += 1;
      }, intervalMs);
      // 立即采一个基线点
      const usage = process.memoryUsage();
      rssPeak = usage.rss;
      heapPeak = usage.heapUsed;
      count = 1;
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
      return { rssPeakBytes: rssPeak, heapUsedPeakBytes: heapPeak, samples: count, intervalMs };
    },
  };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

// ── 关键词检索延迟 ──────────────────────────────────────────────

export type KeywordQuerySample = {
  query: string;
  kind: PackageQuery['kind'];
  ms: number;
  hits: number;
};

export type KeywordLatencyResult = {
  /** 全部计时样本（warm 稳态） */
  samples: KeywordQuerySample[];
  stats: LatencyStats;
  /** 按查询类别的分桶统计 */
  byKind: Record<string, LatencyStats>;
  /** 预热轮数 / 计时轮数 */
  warmupPasses: number;
  measuredPasses: number;
  /** 单次查询集用时（第一轮计时，供报告参考） */
  passMs: number[];
  /** 计时期间内存峰值 */
  memoryPeak: MemoryPeak;
  /** 查询覆盖率：全部查询都返回了命中 */
  allQueriesHit: boolean;
  /** 无命中的查询（若有，说明测的不是真实检索路径） */
  zeroHitQueries: string[];
};

export type KeywordLatencyOptions = {
  warmupPasses?: number;
  measuredPasses?: number;
  topK?: number;
  trackMemory?: boolean;
};

export type KeywordSearchFn = (query: string, topK: number) => Promise<{ hits: number }>;

/**
 * 测量关键词检索延迟。
 *
 * `runQuery` 由调用方注入（生产路径 = searchWiki 的 keyword 模式），
 * 本函数只负责预热、计时与统计，保证测量语义可复用。
 */
export async function measureKeywordLatency(
  queries: PackageQuery[],
  runQuery: KeywordSearchFn,
  options: KeywordLatencyOptions = {},
): Promise<KeywordLatencyResult> {
  const warmupPasses = options.warmupPasses ?? 1;
  const measuredPasses = options.measuredPasses ?? 5;
  const topK = options.topK ?? 20;

  for (let i = 0; i < warmupPasses; i++) {
    for (const q of queries) await runQuery(q.query, topK);
  }

  const sampler = createMemorySampler(options.trackMemory === false ? 100 : 25);
  const samples: KeywordQuerySample[] = [];
  const passMs: number[] = [];

  sampler.start();
  for (let pass = 0; pass < measuredPasses; pass++) {
    const passStart = performance.now();
    for (const q of queries) {
      const t0 = performance.now();
      const r = await runQuery(q.query, topK);
      const ms = performance.now() - t0;
      samples.push({ query: q.query, kind: q.kind, ms: round1(ms), hits: r.hits });
    }
    passMs.push(round1(performance.now() - passStart));
  }
  const memoryPeak = sampler.stop();

  const stats = summarizeLatencies(samples.map((s) => s.ms));
  const byKind: Record<string, LatencyStats> = {};
  for (const kind of new Set(queries.map((q) => q.kind))) {
    byKind[kind] = summarizeLatencies(samples.filter((s) => s.kind === kind).map((s) => s.ms));
  }
  const zeroHitQueries = [...new Set(samples.filter((s) => s.hits === 0).map((s) => s.query))];

  return {
    samples,
    stats,
    byKind,
    warmupPasses,
    measuredPasses,
    passMs,
    memoryPeak,
    allQueriesHit: zeroHitQueries.length === 0,
    zeroHitQueries,
  };
}

// ── 取消响应 ────────────────────────────────────────────────────

export type CancelLatencyResult = {
  /** 从发起取消到队列确认停止的耗时（ms） */
  cancelAckMs: number;
  /** 取消期间主线程可响应（轮询 tick 最大间隔，ms） */
  tickMaxGapMs: number;
  /** 取消后迟到的引擎结果是否被拒绝提交 */
  lateResultRejected: boolean;
};

export type CancelProbeDeps = {
  /** 发起取消（生产路径 = queue.pause() / cancelTask()） */
  cancel: () => Promise<void>;
  /** 轮询队列直到确认停止（返回 true = 已停止） */
  waitStopped: () => Promise<boolean>;
  /** 释放被阻塞的引擎调用，返回迟到结果是否被拒绝提交 */
  releaseLateResult: () => Promise<boolean>;
  /** 取消期间的轻量主线程探测 tick */
  tick: () => Promise<void>;
};
