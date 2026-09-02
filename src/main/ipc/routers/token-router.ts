/**
 * Token router — Token Monitor API。
 *
 * Issue #1 仅实现 summary procedure（概览汇总）。
 * 后续 issue 逐个添加 trends / engineBreakdown / modelBreakdown / sessions / scanExternalLogs。
 *
 * 先例：src/main/ipc/routers/dashboard-router.ts
 */

import { t, TRPCError } from '../router-context';
import { requireProject } from '../../services/project-service';
import { tokenMonitorRegistry } from '../../token-monitor/token-monitor-registry';
import {
  getSummary,
  getTrends,
  getEngineBreakdown,
  type TokenSummary,
  type TrendGroupBy,
} from '../../token-monitor/token-monitor-db';

// ─── Input validation ──────────────────────────────────────

type TimeRange = 'all' | '7d' | '30d';

type SummaryInput = {
  projectId: string;
  timeRange?: TimeRange;
};

function validateSummaryInput(raw: unknown): SummaryInput {
  const r = raw as Record<string, unknown>;
  if (typeof r.projectId !== 'string') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
  }
  const input: SummaryInput = { projectId: r.projectId };
  if (typeof r.timeRange === 'string' && ['all', '7d', '30d'].includes(r.timeRange)) {
    input.timeRange = r.timeRange as TimeRange;
  }
  return input;
}

type TrendsInput = {
  projectId: string;
  timeRange?: TimeRange;
  groupBy?: TrendGroupBy;
};

function validateTrendsInput(raw: unknown): TrendsInput {
  const r = raw as Record<string, unknown>;
  if (typeof r.projectId !== 'string') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
  }
  const input: TrendsInput = { projectId: r.projectId };
  if (typeof r.timeRange === 'string' && ['all', '7d', '30d'].includes(r.timeRange)) {
    input.timeRange = r.timeRange as TimeRange;
  }
  if (typeof r.groupBy === 'string' && ['engine', 'model'].includes(r.groupBy)) {
    input.groupBy = r.groupBy as TrendGroupBy;
  }
  return input;
}

type EngineBreakdownInput = {
  projectId: string;
  timeRange?: TimeRange;
};

function validateEngineBreakdownInput(raw: unknown): EngineBreakdownInput {
  const r = raw as Record<string, unknown>;
  if (typeof r.projectId !== 'string') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
  }
  const input: EngineBreakdownInput = { projectId: r.projectId };
  if (typeof r.timeRange === 'string' && ['all', '7d', '30d'].includes(r.timeRange)) {
    input.timeRange = r.timeRange as TimeRange;
  }
  return input;
}

/**
 * 计算时间范围对应的时间戳下限（ms epoch）。
 * - 'all' → 0（不过滤）
 * - '7d' → 7 天前
 * - '30d' → 30 天前
 */
function timeRangeToTimestamp(timeRange: TimeRange | undefined): number {
  if (timeRange === '7d') return Date.now() - 7 * 24 * 60 * 60 * 1000;
  if (timeRange === '30d') return Date.now() - 30 * 24 * 60 * 60 * 1000;
  return 0; // 'all' or undefined
}

/**
 * 带时间范围过滤的 summary 查询。
 */
function getSummaryWithTimeRange(
  db: ReturnType<typeof tokenMonitorRegistry.getOrCreateDb>,
  timeRange: TimeRange | undefined,
): TokenSummary {
  const sinceTs = timeRangeToTimestamp(timeRange);

  // Today
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const todayTs = todayStart.getTime();

  // Month
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const monthTs = monthStart.getTime();

  // If timeRange is specified, use the later of sinceTs and today/month boundaries
  const effectiveTodayTs = timeRange ? Math.max(todayTs, sinceTs) : todayTs;
  const effectiveMonthTs = timeRange ? Math.max(monthTs, sinceTs) : monthTs;

  const todayRow = db.prepare(
    'SELECT COALESCE(SUM(total_tokens), 0) as tokens, COALESCE(SUM(cost_usd), 0) as cost FROM token_usage WHERE timestamp >= ?',
  ).get(effectiveTodayTs) as { tokens: number; cost: number };

  const monthRow = db.prepare(
    'SELECT COALESCE(SUM(total_tokens), 0) as tokens FROM token_usage WHERE timestamp >= ?',
  ).get(effectiveMonthTs) as { tokens: number };

  const totalRow = db.prepare(
    'SELECT COALESCE(SUM(total_tokens), 0) as tokens FROM token_usage WHERE timestamp >= ?',
  ).get(sinceTs) as { tokens: number };

  return {
    todayTokens: todayRow.tokens,
    monthTokens: monthRow.tokens,
    totalTokens: totalRow.tokens,
    todayCostUsd: todayRow.cost,
  };
}

// ─── Router ────────────────────────────────────────────────

export const tokenRouter = t.router({
  /**
   * 概览汇总（今日/本月/总 token + 今日 cost）。
   *
   * 支持 timeRange 参数过滤（all / 7d / 30d）。
   * timeRange 过滤时，"总 token" 仅统计时间范围内的记录。
   */
  summary: t.procedure
    .input(validateSummaryInput)
    .query(({ input }) => {
      const project = requireProject(input.projectId);
      const db = tokenMonitorRegistry.getOrCreateDb(project.rootPath);

      if (input.timeRange && input.timeRange !== 'all') {
        return getSummaryWithTimeRange(db, input.timeRange);
      }

      // No time range filter → use default getSummary
      return getSummary(db);
    }),

  /**
   * 趋势图数据（按日 + 引擎/模型分组聚合）。
   *
   * 支持 timeRange 参数过滤时间范围，groupBy 切换分色维度（engine / model）。
   */
  trends: t.procedure
    .input(validateTrendsInput)
    .query(({ input }) => {
      const project = requireProject(input.projectId);
      const db = tokenMonitorRegistry.getOrCreateDb(project.rootPath);
      const sinceTs = timeRangeToTimestamp(input.timeRange);
      return getTrends(db, sinceTs, input.groupBy ?? 'engine');
    }),

  /**
   * 引擎分解数据（omp / claude-code / codex 三引擎的 token/cost/cache 细节）。
   *
   * 支持 timeRange 参数过滤"总"统计范围。
   * 今日和本月始终按自然时间边界计算。
   */
  engineBreakdown: t.procedure
    .input(validateEngineBreakdownInput)
    .query(({ input }) => {
      const project = requireProject(input.projectId);
      const db = tokenMonitorRegistry.getOrCreateDb(project.rootPath);
      const sinceTs = timeRangeToTimestamp(input.timeRange);
      return getEngineBreakdown(db, sinceTs);
    }),
});
