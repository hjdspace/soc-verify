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
  getModelBreakdown,
  getSessions,
  getSessionDetail,
  getHeatmap,
  getStreaks,
  type TokenSummary,
  type TrendGroupBy,
  type ModelBreakdownEntry,
  type TokenEngine,
  type SessionSortBy,
  type SessionSortDir,
  type HeatmapEntry,
} from '../../token-monitor/token-monitor-db';
import { ScanScheduler } from '../../token-monitor/scan-scheduler';

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

type ModelBreakdownInput = {
  projectId: string;
  timeRange?: TimeRange;
};

function validateModelBreakdownInput(raw: unknown): ModelBreakdownInput {
  const r = raw as Record<string, unknown>;
  if (typeof r.projectId !== 'string') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
  }
  const input: ModelBreakdownInput = { projectId: r.projectId };
  if (typeof r.timeRange === 'string' && ['all', '7d', '30d'].includes(r.timeRange)) {
    input.timeRange = r.timeRange as TimeRange;
  }
  return input;
}

type SessionsInput = {
  projectId: string;
  engine?: TokenEngine;
  sortBy?: SessionSortBy;
  sortDir?: SessionSortDir;
  page?: number;
  pageSize?: number;
};

function validateSessionsInput(raw: unknown): SessionsInput {
  const r = raw as Record<string, unknown>;
  if (typeof r.projectId !== 'string') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
  }
  const input: SessionsInput = { projectId: r.projectId };
  if (typeof r.engine === 'string' && ['omp', 'claude-code', 'codex'].includes(r.engine)) {
    input.engine = r.engine as TokenEngine;
  }
  if (typeof r.sortBy === 'string' && ['time', 'tokens', 'cost'].includes(r.sortBy)) {
    input.sortBy = r.sortBy as SessionSortBy;
  }
  if (typeof r.sortDir === 'string' && ['asc', 'desc'].includes(r.sortDir)) {
    input.sortDir = r.sortDir as SessionSortDir;
  }
  if (typeof r.page === 'number' && r.page > 0) {
    input.page = r.page;
  }
  if (typeof r.pageSize === 'number' && r.pageSize > 0) {
    input.pageSize = r.pageSize;
  }
  return input;
}

type SessionDetailInput = {
  projectId: string;
  sessionId: string;
};

function validateSessionDetailInput(raw: unknown): SessionDetailInput {
  const r = raw as Record<string, unknown>;
  if (typeof r.projectId !== 'string') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
  }
  if (typeof r.sessionId !== 'string') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'sessionId is required' });
  }
  return { projectId: r.projectId, sessionId: r.sessionId };
}

type ScanExternalLogsInput = {
  projectId: string;
};

function validateScanExternalLogsInput(raw: unknown): ScanExternalLogsInput {
  const r = raw as Record<string, unknown>;
  if (typeof r.projectId !== 'string' || r.projectId === '') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
  }
  return { projectId: r.projectId };
}

/** heatmap 只需 projectId */
function validateProjectIdInput(raw: unknown): { projectId: string } {
  const r = raw as Record<string, unknown>;
  if (typeof r.projectId !== 'string' || r.projectId === '') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
  }
  return { projectId: r.projectId };
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

  const streaks = getStreaks(db);

  return {
    todayTokens: todayRow.tokens,
    monthTokens: monthRow.tokens,
    totalTokens: totalRow.tokens,
    todayCostUsd: todayRow.cost,
    currentStreak: streaks.currentStreak,
    longestStreak: streaks.longestStreak,
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

  /**
   * 模型分解数据（按模型聚合的 token 用量）。
   *
   * 不分引擎——同模型不同引擎的记录聚合到同一行。
   * 支持 timeRange 参数过滤时间范围。
   */
  modelBreakdown: t.procedure
    .input(validateModelBreakdownInput)
    .query(({ input }) => {
      const project = requireProject(input.projectId);
      const db = tokenMonitorRegistry.getOrCreateDb(project.rootPath);
      const sinceTs = timeRangeToTimestamp(input.timeRange);
      return getModelBreakdown(db, sinceTs) satisfies ModelBreakdownEntry[];
    }),

  /**
   * 会话列表（分页 + 引擎筛选 + 排序）。
   *
   * 按 session_id 聚合，每个会话返回汇总数据。
   * 支持按引擎筛选、按时间/token/cost 排序、分页（默认每页 50 条）。
   */
  sessions: t.procedure
    .input(validateSessionsInput)
    .query(({ input }) => {
      const project = requireProject(input.projectId);
      const db = tokenMonitorRegistry.getOrCreateDb(project.rootPath);
      return getSessions(db, {
        engine: input.engine,
        sortBy: input.sortBy,
        sortDir: input.sortDir,
        page: input.page,
        pageSize: input.pageSize,
      });
    }),

  /**
   * 单会话 per-request 明细。
   *
   * 返回指定 session_id 的所有 LLM 调用记录（按时间升序）。
   */
  sessionDetail: t.procedure
    .input(validateSessionDetailInput)
    .query(({ input }) => {
      const project = requireProject(input.projectId);
      const db = tokenMonitorRegistry.getOrCreateDb(project.rootPath);
      return getSessionDetail(db, input.sessionId);
    }),

  /**
   * 热力图数据（最近 365 天按日聚合 token + cost）。
   *
   * 用于概览面板的 GitHub 风格热力图。
   * 只返回有记录的日期，不填充空日期。
   */
  heatmap: t.procedure
    .input(validateProjectIdInput)
    .query(({ input }) => {
      const project = requireProject(input.projectId);
      const db = tokenMonitorRegistry.getOrCreateDb(project.rootPath);
      return getHeatmap(db, 365) satisfies HeatmapEntry[];
    }),

  /**
   * 手动触发外部日志扫描（claude-code + codex）。
   *
   * 执行一次增量扫描，解析所有发现的 JSONL 文件，
   * 通过 INSERT OR IGNORE 去重后写入 token_usage 表。
   *
   * 返回扫描结果统计（扫描文件数 / 跳过的文件数 / 插入记录数 / 耗时）。
   */
  scanExternalLogs: t.procedure
    .input(validateScanExternalLogsInput)
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      const db = tokenMonitorRegistry.getOrCreateDb(project.rootPath);

      const scheduler = new ScanScheduler(db);
      return scheduler.scanOnce();
    }),
});
