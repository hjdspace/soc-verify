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
  /** 连续使用天数（含今天） */
  currentStreak: number;
  /** 历史最长连续使用天数 */
  longestStreak: number;
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

CREATE TABLE IF NOT EXISTS scan_state (
  file_path TEXT PRIMARY KEY,
  last_mtime REAL NOT NULL,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  scanned_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scan_state_scanned_at ON scan_state(scanned_at);
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

/**
 * 在单个事务中批量写入 Token Usage Records。
 *
 * 与逐条 recordUsage 的差异：
 * - 一次事务提交替代 N 次自动提交（WAL 下每次自动提交都触发 fsync，
 *   大批量扫描时是数量级的性能差距）
 * - 通过 INSERT OR IGNORE 的 res.changes 统计实际插入数，
 *   不需要前后两次 SELECT COUNT(*) 全表扫描
 *
 * @returns 实际插入的记录数（被唯一键去重忽略的不计）
 */
export function recordUsageBatch(db: TokenMonitorDb, records: TokenUsageRecord[]): number {
  if (records.length === 0) return 0;
  const stmt = db.prepare(INSERT_SQL);
  let inserted = 0;
  db.transaction(() => {
    for (const record of records) {
      inserted += stmt.run(record).changes;
    }
  })();
  return inserted;
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

// ─── Read: Model Breakdown ────────────────────────────────

/** 模型分解数据（单模型聚合） */
export type ModelBreakdownEntry = {
  model: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
};

/**
 * 获取按模型聚合的 token 用量分解数据。
 *
 * 不分引擎——同模型不同引擎的记录聚合到同一行。
 *
 * @param sinceTs 时间戳下限（ms epoch），0 表示不过滤
 * @returns 按模型分组的聚合数组，每个模型一行
 */
export function getModelBreakdown(
  db: TokenMonitorDb,
  sinceTs: number,
): ModelBreakdownEntry[] {
  const rows = db.prepare(
    `SELECT
       model,
       COALESCE(SUM(total_tokens), 0) as total_tokens,
       COALESCE(SUM(input_tokens), 0) as input_tokens,
       COALESCE(SUM(output_tokens), 0) as output_tokens,
       COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
       COALESCE(SUM(cache_write_tokens), 0) as cache_write_tokens,
       COALESCE(SUM(cost_usd), 0) as cost_usd
     FROM token_usage
     WHERE timestamp >= ?
     GROUP BY model
     ORDER BY total_tokens DESC`,
  ).all(sinceTs) as {
    model: string;
    total_tokens: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    cost_usd: number;
  }[];

  return rows.map((row) => ({
    model: row.model,
    totalTokens: row.total_tokens,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    costUsd: row.cost_usd,
  }));
}

// ─── Read: Sessions ────────────────────────────────────────

/** 会话汇总数据（一行一个会话） */
export type SessionEntry = {
  sessionId: string;
  engine: TokenEngine;
  model: string;
  startTime: number; // ms epoch（会话第一条消息时间）
  endTime: number; // ms epoch（会话最后一条消息时间）
  durationMs: number; // endTime - startTime
  totalTokens: number;
  totalCost: number;
  messageCount: number;
};

/** sessions 查询结果（含分页信息） */
export type SessionsResult = {
  sessions: SessionEntry[];
  total: number;
};

/** 排序字段 */
export type SessionSortBy = 'time' | 'tokens' | 'cost';

/** 排序方向 */
export type SessionSortDir = 'asc' | 'desc';

/**
 * 获取会话列表（分页 + 引擎筛选 + 排序）。
 *
 * 按 session_id 聚合，每个会话返回汇总数据。
 * 持续时间 = 会话内最后一条消息时间 - 第一条消息时间。
 */
export function getSessions(
  db: TokenMonitorDb,
  options: {
    engine?: TokenEngine;
    sortBy?: SessionSortBy;
    sortDir?: SessionSortDir;
    page?: number;
    pageSize?: number;
  },
): SessionsResult {
  const {
    engine,
    sortBy = 'time',
    sortDir = 'desc',
    page = 1,
    pageSize = 50,
  } = options;

  // Build WHERE clause
  const whereClause = engine ? 'WHERE engine = ?' : '';
  const whereParams: unknown[] = engine ? [engine] : [];

  // Get total count
  const countRow = db.prepare(
    `SELECT COUNT(DISTINCT session_id) as cnt FROM token_usage ${whereClause}`,
  ).get(...whereParams) as { cnt: number };
  const total = countRow.cnt;

  // Build ORDER BY clause
  let orderCol: string;
  switch (sortBy) {
    case 'tokens':
      orderCol = 'total_tokens';
      break;
    case 'cost':
      orderCol = 'total_cost';
      break;
    case 'time':
    default:
      orderCol = 'start_time';
      break;
  }
  const orderDir = sortDir === 'asc' ? 'ASC' : 'DESC';

  // Pagination
  const offset = (page - 1) * pageSize;

  const rows = db.prepare(
    `SELECT
       session_id,
       engine,
       model,
       MIN(timestamp) as start_time,
       MAX(timestamp) as end_time,
       SUM(total_tokens) as total_tokens,
       SUM(cost_usd) as total_cost,
       COUNT(*) as message_count
     FROM token_usage
     ${whereClause}
     GROUP BY session_id
     ORDER BY ${orderCol} ${orderDir}
     LIMIT ? OFFSET ?`,
  ).all(...whereParams, pageSize, offset) as {
    session_id: string;
    engine: string;
    model: string;
    start_time: number;
    end_time: number;
    total_tokens: number;
    total_cost: number;
    message_count: number;
  }[];

  const sessions: SessionEntry[] = rows.map((row) => ({
    sessionId: row.session_id,
    engine: row.engine as TokenEngine,
    model: row.model,
    startTime: row.start_time,
    endTime: row.end_time,
    durationMs: row.end_time - row.start_time,
    totalTokens: row.total_tokens,
    totalCost: row.total_cost,
    messageCount: row.message_count,
  }));

  return { sessions, total };
}

// ─── Read: Session Detail ─────────────────────────────────

/** per-request 明细记录 */
export type SessionDetailEntry = {
  messageId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  timestamp: number; // ms epoch
};

/**
 * 获取单会话的所有 per-request 记录（按时间升序）。
 */
export function getSessionDetail(
  db: TokenMonitorDb,
  sessionId: string,
): SessionDetailEntry[] {
  const rows = db.prepare(
    `SELECT
       message_id,
       model,
       input_tokens,
       output_tokens,
       cache_read_tokens,
       cache_write_tokens,
       total_tokens,
       cost_usd,
       timestamp
     FROM token_usage
     WHERE session_id = ?
     ORDER BY timestamp ASC`,
  ).all(sessionId) as {
    message_id: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    total_tokens: number;
    cost_usd: number;
    timestamp: number;
  }[];

  return rows.map((row) => ({
    messageId: row.message_id,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    totalTokens: row.total_tokens,
    costUsd: row.cost_usd,
    timestamp: row.timestamp,
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

// ─── Read: Heatmap (365-day) ────────────────────────────────

/** 热力图单日数据 */
export type HeatmapEntry = {
  date: string; // YYYY-MM-DD
  totalTokens: number;
  costUsd: number;
};

/**
 * 获取最近 N 天的按日聚合数据（用于热力图）。
 *
 * 只返回有记录的日期，不填充空日期。
 *
 * @param days 天数（如 365）
 */
export function getHeatmap(
  db: TokenMonitorDb,
  days: number,
): HeatmapEntry[] {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const sinceTs = todayStart.getTime() - (days - 1) * 24 * 60 * 60 * 1000;

  const rows = db.prepare(
    `SELECT
       strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch', 'localtime') as date,
       COALESCE(SUM(total_tokens), 0) as tokens,
       COALESCE(SUM(cost_usd), 0) as cost
     FROM token_usage
     WHERE timestamp >= ?
     GROUP BY date
     ORDER BY date ASC`,
  ).all(sinceTs) as { date: string; tokens: number; cost: number }[];

  return rows.map((row) => ({
    date: row.date,
    totalTokens: row.tokens,
    costUsd: row.cost,
  }));
}

// ─── Read: Streaks (连续使用天数) ───────────────────────────

/** 连续使用天数统计 */
export type Streaks = {
  /** 当前连续使用天数（含今天）。今天无记录则返回 0。 */
  currentStreak: number;
  /** 历史最长连续使用天数 */
  longestStreak: number;
};

/**
 * 计算连续使用天数。
 *
 * - currentStreak：从今天往前回溯，连续有记录的天数（含今天）。今天无记录则为 0。
 * - longestStreak：历史所有连续天数中的最大值。
 */
export function getStreaks(db: TokenMonitorDb): Streaks {
  // 获取所有有记录的日期（升序去重）
  const rows = db.prepare(
    `SELECT DISTINCT strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch', 'localtime') as date
     FROM token_usage
     ORDER BY date ASC`,
  ).all() as { date: string }[];

  if (rows.length === 0) {
    return { currentStreak: 0, longestStreak: 0 };
  }

  const dates = rows.map((r) => r.date);
  const dateSet = new Set(dates);

  // ── longestStreak: 遍历所有日期找最长连续 ──
  let longest = 1;
  let current = 1;
  for (let i = 1; i < dates.length; i++) {
    const prev = new Date(dates[i - 1]);
    const curr = new Date(dates[i]);
    const diffDays = Math.round((curr.getTime() - prev.getTime()) / (24 * 60 * 60 * 1000));
    if (diffDays === 1) {
      current++;
      if (current > longest) longest = current;
    } else {
      current = 1;
    }
  }

  // ── currentStreak: 从今天往前回溯 ──
  const now = new Date();
  const todayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayStr = `${todayDate.getFullYear()}-${String(todayDate.getMonth() + 1).padStart(2, '0')}-${String(todayDate.getDate()).padStart(2, '0')}`;

    let currentStreak = 0;
    // If today has no record, current streak is 0
    if (dateSet.has(todayStr)) {
      currentStreak = 1;
      const checkDate = new Date(todayDate);
      checkDate.setDate(checkDate.getDate() - 1);
    while (true) {
      const checkStr = `${checkDate.getFullYear()}-${String(checkDate.getMonth() + 1).padStart(2, '0')}-${String(checkDate.getDate()).padStart(2, '0')}`;
      if (dateSet.has(checkStr)) {
        currentStreak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else {
        break;
      }
    }
  }

  return { currentStreak, longestStreak: longest };
}

// ─── Scan State (增量扫描) ────────────────────────────────

/** scan_state 表一行 */
export type ScanStateEntry = {
  filePath: string;
  lastMtime: number;
  byteOffset: number;
  scannedAt: number; // ms epoch
};

/**
 * 获取指定文件的 scan_state 记录。
 * 如果不存在，返回 null。
 */
export function getScanState(db: TokenMonitorDb, filePath: string): ScanStateEntry | null {
  const row = db.prepare(
    'SELECT file_path, last_mtime, byte_offset, scanned_at FROM scan_state WHERE file_path = ?',
  ).get(filePath) as {
    file_path: string;
    last_mtime: number;
    byte_offset: number;
    scanned_at: number;
  } | undefined;

  if (!row) return null;

  return {
    filePath: row.file_path,
    lastMtime: row.last_mtime,
    byteOffset: row.byte_offset,
    scannedAt: row.scanned_at,
  };
}

/**
 * 插入或更新 scan_state 记录（UPSERT）。
 */
export function upsertScanState(
  db: TokenMonitorDb,
  entry: ScanStateEntry,
): void {
  db.prepare(
    `INSERT INTO scan_state (file_path, last_mtime, byte_offset, scanned_at)
     VALUES (@filePath, @lastMtime, @byteOffset, @scannedAt)
     ON CONFLICT(file_path) DO UPDATE SET
       last_mtime = excluded.last_mtime,
       byte_offset = excluded.byte_offset,
       scanned_at = excluded.scanned_at`,
  ).run(entry);
}

/**
 * 获取所有 scan_state 记录（用于增量扫描时检查）。
 */
export function getAllScanStates(db: TokenMonitorDb): Map<string, ScanStateEntry> {
  const rows = db.prepare(
    'SELECT file_path, last_mtime, byte_offset, scanned_at FROM scan_state',
  ).all() as Array<{
    file_path: string;
    last_mtime: number;
    byte_offset: number;
    scanned_at: number;
  }>;

  const map = new Map<string, ScanStateEntry>();
  for (const row of rows) {
    map.set(row.file_path, {
      filePath: row.file_path,
      lastMtime: row.last_mtime,
      byteOffset: row.byte_offset,
      scannedAt: row.scanned_at,
    });
  }
  return map;
}
