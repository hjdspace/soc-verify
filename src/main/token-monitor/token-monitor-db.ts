/**
 * Token Monitor DB — SQLite 连接管理 + 表初始化 + 写入/查询。
 *
 * 独立于 Case Database，关注点分离。
 * 参考 docs/prd/prd-token-monitor.md → SQLite 表结构
 * 镜像 src/main/timing-violation/db/tv-database.ts 的 WAL + PRAGMA 模式
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ─── Types ─────────────────────────────────────────────────

/** Token Monitor 引擎标识 */
export type TokenEngine = 'omp' | 'claude-code' | 'codex';

/** Token Usage Record — 一次 LLM API 交互的 token 用量记录 */
export type TokenUsageRecord = {
  engine: TokenEngine;
  sessionId: string;
  messageId: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number;
  timestamp: number; // ms epoch
  projectId: string;
  cwd: string;
};

/** 概览汇总数据 */
export type TokenSummary = {
  todayTokens: number;
  monthTokens: number;
  totalTokens: number;
  todayCostUsd: number;
};

/** 趋势图单日数据（按引擎或模型分组） */
export type TrendGroupEntry = {
  group: string; // engine 名或 model 名
  totalTokens: number;
};

export type TrendDayData = {
  date: string; // YYYY-MM-DD
  groups: TrendGroupEntry[];
};

/** 引擎分解数据（单引擎聚合） */
export type EngineBreakdownEntry = {
  engine: TokenEngine;
  todayTokens: number;
  monthTokens: number;
  totalTokens: number;
  todayCost: number;
  monthCost: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
};

// ─── Schema ───────────────────────────────────────────────

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  engine TEXT NOT NULL,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  model TEXT,
  provider TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  timestamp INTEGER NOT NULL,
  project_id TEXT,
  cwd TEXT,
  UNIQUE(engine, session_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_token_usage_timestamp ON token_usage(timestamp);
CREATE INDEX IF NOT EXISTS idx_token_usage_engine ON token_usage(engine);
CREATE INDEX IF NOT EXISTS idx_token_usage_session ON token_usage(session_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_model ON token_usage(model);
`;

export const PRAGMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = 10000;
PRAGMA temp_store = MEMORY;
`;

// ─── Database lifecycle ────────────────────────────────────

export type TokenMonitorDb = Database.Database;

/**
 * 初始化数据库（创建文件、执行 PRAGMA、创建表和索引）。
 *
 * @param dbFullPath 数据库文件完整路径（如 .socverify/token-monitor.db）
 */
export function initDatabase(dbFullPath: string): TokenMonitorDb {
  const dir = dirname(dbFullPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbFullPath);
  db.exec(PRAGMA_SQL);
  db.exec(SCHEMA_SQL);
  return db;
}

/**
 * 关闭数据库连接。
 */
export function closeDatabase(db: TokenMonitorDb): void {
  if (db.open) {
    db.close();
  }
}

/**
 * 创建内存数据库（用于测试）。
 */
export function createMemoryDatabase(): TokenMonitorDb {
  const db = new Database(':memory:');
  db.exec(PRAGMA_SQL.replace('PRAGMA journal_mode = WAL;', 'PRAGMA journal_mode = MEMORY;'));
  db.exec(SCHEMA_SQL);
  return db;
}

// ─── Write ─────────────────────────────────────────────────

const INSERT_SQL = `
INSERT OR IGNORE INTO token_usage (
  engine, session_id, message_id, model, provider,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  reasoning_tokens, total_tokens, cost_usd, timestamp, project_id, cwd
) VALUES (
  @engine, @sessionId, @messageId, @model, @provider,
  @inputTokens, @outputTokens, @cacheReadTokens, @cacheWriteTokens,
  @reasoningTokens, @totalTokens, @costUsd, @timestamp, @projectId, @cwd
)
`;

/**
 * 写入一条 Token Usage Record。
 * 通过 INSERT OR IGNORE 实现 (engine, session_id, message_id) 组合去重。
 */
export function recordUsage(db: TokenMonitorDb, record: TokenUsageRecord): void {
  db.prepare(INSERT_SQL).run(record);
}

// ─── Read: Summary ─────────────────────────────────────────

/**
 * 获取概览汇总（今日/本月/总 token + 今日 cost）。
 *
 * 今日 = 当天 00:00:00 到现在的 token 总量
 * 本月 = 当月 1 号 00:00:00 到现在的 token 总量
 * 总 = 全部记录的 token 总量
 */
export function getSummary(db: TokenMonitorDb): TokenSummary {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);

  const todayTs = todayStart.getTime();
  const monthTs = monthStart.getTime();

  const todayRow = db.prepare(
    'SELECT COALESCE(SUM(total_tokens), 0) as tokens, COALESCE(SUM(cost_usd), 0) as cost FROM token_usage WHERE timestamp >= ?',
  ).get(todayTs) as { tokens: number; cost: number };

  const monthRow = db.prepare(
    'SELECT COALESCE(SUM(total_tokens), 0) as tokens FROM token_usage WHERE timestamp >= ?',
  ).get(monthTs) as { tokens: number };

  const totalRow = db.prepare(
    'SELECT COALESCE(SUM(total_tokens), 0) as tokens FROM token_usage',
  ).get() as { tokens: number };

  return {
    todayTokens: todayRow.tokens,
    monthTokens: monthRow.tokens,
    totalTokens: totalRow.tokens,
    todayCostUsd: todayRow.cost,
  };
}

// ─── Read: Trends ──────────────────────────────────────────

/** 趋势图分组维度 */
export type TrendGroupBy = 'engine' | 'model';

/**
 * 获取按日 + 引擎/模型聚合的趋势数据。
 *
 * @param sinceTs 时间戳下限（ms epoch），0 表示不过滤
 * @param groupBy 分组维度：'engine' → 按引擎分组；'model' → 按模型分组
 * @returns 按日期升序排列的数组，每天含各分组的 token 总量
 */
export function getTrends(
  db: TokenMonitorDb,
  sinceTs: number,
  groupBy: TrendGroupBy,
): TrendDayData[] {
  const groupCol = groupBy === 'engine' ? 'engine' : 'model';

  // 按日 + 分组维度聚合（使用 localtime 将 epoch 转为本地日期）
  const rows = db.prepare(
    `SELECT
       strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch', 'localtime') as date,
       ${groupCol} as grp,
       SUM(total_tokens) as tokens
     FROM token_usage
     WHERE timestamp >= ?
     GROUP BY date, grp
     ORDER BY date ASC`,
  ).all(sinceTs) as { date: string; grp: string; tokens: number }[];

  // 按日期重组为 TrendDayData[]
  const dayMap = new Map<string, TrendGroupEntry[]>();
  for (const row of rows) {
    let groups = dayMap.get(row.date);
    if (!groups) {
      groups = [];
      dayMap.set(row.date, groups);
    }
    groups.push({ group: row.grp, totalTokens: row.tokens });
  }

  return Array.from(dayMap.entries()).map(([date, groups]) => ({
    date,
    groups,
  }));
}

// ─── Read: Engine Breakdown ────────────────────────────────

/**
 * 获取按引擎分解的聚合数据（omp / claude-code / codex）。
 *
 * 每个引擎返回今日/本月/总的 token 和 cost，以及全量 input/output/cache 分拆。
 *
 * @param sinceTs 时间戳下限（ms epoch），0 表示不过滤。
 *   "总" 统计范围受 sinceTs 过滤；"今日" 和 "本月" 始终按自然边界计算。
 */
export function getEngineBreakdown(
  db: TokenMonitorDb,
  sinceTs: number,
): EngineBreakdownEntry[] {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const todayTs = todayStart.getTime();
  const monthTs = monthStart.getTime();

  const engines: TokenEngine[] = ['omp', 'claude-code', 'codex'];

  return engines.map((engine) => {
    // 今日
    const todayRow = db.prepare(
      `SELECT COALESCE(SUM(total_tokens), 0) as tokens, COALESCE(SUM(cost_usd), 0) as cost
       FROM token_usage WHERE engine = ? AND timestamp >= ?`,
    ).get(engine, todayTs) as { tokens: number; cost: number };

    // 本月
    const monthRow = db.prepare(
      `SELECT COALESCE(SUM(total_tokens), 0) as tokens, COALESCE(SUM(cost_usd), 0) as cost
       FROM token_usage WHERE engine = ? AND timestamp >= ?`,
    ).get(engine, monthTs) as { tokens: number; cost: number };

    // 总（受 sinceTs 过滤）
    const totalRow = db.prepare(
      `SELECT
         COALESCE(SUM(total_tokens), 0) as tokens,
         COALESCE(SUM(cost_usd), 0) as cost,
         COALESCE(SUM(input_tokens), 0) as input_tokens,
         COALESCE(SUM(output_tokens), 0) as output_tokens,
         COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
         COALESCE(SUM(cache_write_tokens), 0) as cache_write_tokens,
         COALESCE(SUM(reasoning_tokens), 0) as reasoning_tokens
       FROM token_usage WHERE engine = ? AND timestamp >= ?`,
    ).get(engine, sinceTs) as {
      tokens: number;
      cost: number;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      reasoning_tokens: number;
    };

    return {
      engine,
      todayTokens: todayRow.tokens,
      monthTokens: monthRow.tokens,
      totalTokens: totalRow.tokens,
      todayCost: todayRow.cost,
      monthCost: monthRow.cost,
      totalCost: totalRow.cost,
      inputTokens: totalRow.input_tokens,
      outputTokens: totalRow.output_tokens,
      cacheReadTokens: totalRow.cache_read_tokens,
      cacheWriteTokens: totalRow.cache_write_tokens,
      reasoningTokens: totalRow.reasoning_tokens,
    };
  });
}
