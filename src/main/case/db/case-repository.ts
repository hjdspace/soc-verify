/**
 * Case Repository — 数据访问层（CRUD + 聚合查询）
 *
 * 参考 docs/adr/0017-case-database-architecture.md → DB Schema
 * 镜像 src/main/timing-violation/db/tv-repository.ts 模式
 *
 * 使用 transaction() + prepare() 保证批量操作性能和原子性。
 */

import type Database from 'better-sqlite3';

// ─── 行类型 ───────────────────────────────────────────────

export type SubsysRow = {
  name: string;
  path?: string;
  description?: string;
};

export type CaseRow = {
  name: string;
  subsys: string;
  path: string;
  filePath?: string;
  baseCase?: string;
  base?: string;
  block?: string;
  phase?: string;
};

export type SimulationRunRow = {
  caseName: string;
  subsys: string;
  status: string;
  startTime: string;
  endTime?: string;
  durationMs?: number;
  corner?: string;
  seed?: string;
  optionsJson?: string;
};

export type SubsysWithCaseCount = {
  id: number;
  name: string;
  path: string | null;
  description: string | null;
  caseCount: number;
};

// ─── subsystems ──────────────────────────────────────────

/**
 * 批量插入子系统（INSERT OR REPLACE，按 name 去重）。
 * 使用 transaction + prepared statement 实现批量插入。
 */
export function insertSubsystems(
  db: Database.Database,
  subsystems: SubsysRow[],
): { inserted: number } {
  if (subsystems.length === 0) return { inserted: 0 };

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO subsystems (name, path, description, updated_at)
    VALUES (@name, @path, @description, datetime('now', 'localtime'))
  `);

  let inserted = 0;
  const tx = db.transaction(() => {
    for (const s of subsystems) {
      stmt.run({
        name: s.name,
        path: s.path ?? null,
        description: s.description ?? null,
      });
      inserted++;
    }
  });
  tx();
  return { inserted };
}

/**
 * 查询所有子系统。可按名称过滤（LIKE）。
 */
export function getSubsystems(
  db: Database.Database,
  filter?: string,
): SubsysRow[] {
  if (filter) {
    const rows = db.prepare(`
      SELECT name, path, description FROM subsystems
      WHERE name LIKE @filter
      ORDER BY name
    `).all({ filter: `%${filter}%` }) as Record<string, unknown>[];
    return rows.map(rowToSubsysRow);
  }
  const rows = db.prepare(`
    SELECT name, path, description FROM subsystems ORDER BY name
  `).all() as Record<string, unknown>[];
  return rows.map(rowToSubsysRow);
}

/**
 * 获取所有子系统名称列表（用于 Dashboard 下拉筛选）。
 * 返回按名称排序的字符串数组。
 */
export function getSubsysList(db: Database.Database): string[] {
  const rows = db.prepare(`
    SELECT name FROM subsystems ORDER BY name
  `).all() as { name: string }[];
  return rows.map((r) => r.name);
}

// ─── cases ───────────────────────────────────────────────

/**
 * 批量插入用例（INSERT OR REPLACE，按 (name, subsys) 去重）。
 * 使用 transaction + prepared statement 实现批量插入。
 */
export function insertCases(
  db: Database.Database,
  cases: CaseRow[],
): { inserted: number } {
  if (cases.length === 0) return { inserted: 0 };

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO cases (name, subsys, path, file_path, base_case, base, block, phase, updated_at)
    VALUES (@name, @subsys, @path, @filePath, @baseCase, @base, @block, @phase, datetime('now', 'localtime'))
  `);

  let inserted = 0;
  const tx = db.transaction(() => {
    for (const c of cases) {
      stmt.run({
        name: c.name,
        subsys: c.subsys,
        path: c.path,
        filePath: c.filePath ?? null,
        baseCase: c.baseCase ?? null,
        base: c.base ?? null,
        block: c.block ?? null,
        phase: c.phase ?? null,
      });
      inserted++;
    }
  });
  tx();
  return { inserted };
}

/**
 * 查询用例。可按 subsys 过滤。
 */
export function getCases(
  db: Database.Database,
  subsys?: string,
): CaseRow[] {
  if (subsys) {
    const rows = db.prepare(`
      SELECT name, subsys, path, file_path, base_case, base, block, phase
      FROM cases WHERE subsys = @subsys ORDER BY name
    `).all({ subsys }) as Record<string, unknown>[];
    return rows.map(rowToCaseRow);
  }
  const rows = db.prepare(`
    SELECT name, subsys, path, file_path, base_case, base, block, phase
    FROM cases ORDER BY name
  `).all() as Record<string, unknown>[];
  return rows.map(rowToCaseRow);
}

// ─── 聚合查询 ────────────────────────────────────────────

/**
 * 获取子系统列表及各子系统用例数（LEFT JOIN 聚合）。
 *
 * SELECT s.*, COUNT(c.id) as caseCount
 * FROM subsystems s LEFT JOIN cases c ON c.subsys = s.name
 * GROUP BY s.name
 */
export function getSubsysWithCaseCount(
  db: Database.Database,
  filter?: string,
): SubsysWithCaseCount[] {
  const filterClause = filter
    ? `WHERE s.name LIKE @filter`
    : '';
  const params = filter ? { filter: `%${filter}%` } : {};

  const rows = db.prepare(`
    SELECT s.id, s.name, s.path, s.description, COUNT(c.id) as caseCount
    FROM subsystems s
    LEFT JOIN cases c ON c.subsys = s.name
    ${filterClause}
    GROUP BY s.id, s.name, s.path, s.description
    ORDER BY s.name
  `).all(params) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: row['id'] as number,
    name: row['name'] as string,
    path: (row['path'] as string | null) ?? null,
    description: (row['description'] as string | null) ?? null,
    caseCount: row['caseCount'] as number,
  }));
}

// ─── 搜索 ────────────────────────────────────────────────

/**
 * 搜索用例（LIKE 子串匹配）。
 *
 * SELECT * FROM cases WHERE name LIKE '%query%' [AND subsys=?] LIMIT ?
 */
export function searchCases(
  db: Database.Database,
  query: string,
  subsys?: string,
  limit = 200,
): CaseRow[] {
  const q = query.trim();
  if (!q) return [];

  const conditions = ['name LIKE @query'];
  const params: Record<string, unknown> = { query: `%${q}%` };

  if (subsys) {
    conditions.push('subsys = @subsys');
    params.subsys = subsys;
  }

  const rows = db.prepare(`
    SELECT name, subsys, path, file_path, base_case, base, block, phase
    FROM cases WHERE ${conditions.join(' AND ')}
    ORDER BY name LIMIT @limit
  `).all({ ...params, limit }) as Record<string, unknown>[];

  return rows.map(rowToCaseRow);
}

// ─── simulation_runs ────────────────────────────────────

/**
 * 插入一条仿真运行记录。
 */
export function insertSimulationRun(
  db: Database.Database,
  run: SimulationRunRow,
): { inserted: number } {
  const result = db.prepare(`
    INSERT INTO simulation_runs
    (case_name, subsys, status, start_time, end_time, duration_ms, corner, seed, options_json)
    VALUES (@caseName, @subsys, @status, @startTime, @endTime, @durationMs, @corner, @seed, @optionsJson)
  `).run({
    caseName: run.caseName,
    subsys: run.subsys,
    status: run.status,
    startTime: run.startTime,
    endTime: run.endTime ?? null,
    durationMs: run.durationMs ?? null,
    corner: run.corner ?? null,
    seed: run.seed ?? null,
    optionsJson: run.optionsJson ?? null,
  });
  return { inserted: result.changes };
}

/**
 * 获取指定用例最近一次仿真的状态。
 * 按 start_time 倒序取第一条。
 */
export function getLatestRunStatus(
  db: Database.Database,
  caseName: string,
  subsys: string,
): string | null {
  const row = db.prepare(`
    SELECT status FROM simulation_runs
    WHERE case_name = @caseName AND subsys = @subsys
    ORDER BY start_time DESC LIMIT 1
  `).get({ caseName, subsys }) as { status: string } | undefined;
  return row?.status ?? null;
}

/**
 * 获取指定子系统下所有用例的最近一次终态状态（ADR 0017 决策 4）。
 *
 * 只返回终态（pass/fail/error/aborted），running 状态由 SimulationManager.activeRuns 提供。
 * 使用 ROW_NUMBER() 窗口函数取每个 case 的最新一条终态记录。
 *
 * @returns Map<caseName, status> — 无终态记录的 case 不在 map 中（调用方默认 pending）
 */
export function getLatestStatusBySubsys(
  db: Database.Database,
  subsys: string,
): Map<string, string> {
  const rows = db.prepare(`
    SELECT case_name, status FROM (
      SELECT case_name, status,
        ROW_NUMBER() OVER (PARTITION BY case_name ORDER BY start_time DESC) as rn
      FROM simulation_runs
      WHERE subsys = @subsys AND status IN ('pass', 'fail', 'error', 'aborted')
    ) WHERE rn = 1
  `).all({ subsys }) as { case_name: string; status: string }[];

  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.case_name, row.status);
  }
  return map;
}

/**
 * 获取所有子系统下所有用例的最近一次终态状态（ADR 0017 决策 4）。
 *
 * 用于 getProjectOverview：一次查询获取全局状态映射，避免逐子系统 N+1 查询。
 *
 * @returns Map<subsys, Map<caseName, status>>
 */
export function getAllLatestStatuses(
  db: Database.Database,
): Map<string, Map<string, string>> {
  const rows = db.prepare(`
    SELECT subsys, case_name, status FROM (
      SELECT subsys, case_name, status,
        ROW_NUMBER() OVER (PARTITION BY subsys, case_name ORDER BY start_time DESC) as rn
      FROM simulation_runs
      WHERE status IN ('pass', 'fail', 'error', 'aborted')
    ) WHERE rn = 1
  `).all() as { subsys: string; case_name: string; status: string }[];

  const globalMap = new Map<string, Map<string, string>>();
  for (const row of rows) {
    let subsysMap = globalMap.get(row.subsys);
    if (!subsysMap) {
      subsysMap = new Map();
      globalMap.set(row.subsys, subsysMap);
    }
    subsysMap.set(row.case_name, row.status);
  }
  return globalMap;
}

/**
 * 构建用例名 → 子系统名的映射表（ADR 0017）。
 *
 * SELECT name, subsys FROM cases
 * 用于时序违例模块的 case→subsys 映射，替代旧的 discovery 遍历。
 */
export function getCaseNameToSubsysMap(
  db: Database.Database,
): Map<string, string> {
  const rows = db.prepare(`
    SELECT name, subsys FROM cases
  `).all() as { name: string; subsys: string }[];

  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.name, row.subsys);
  }
  return map;
}

// ─── Dashboard 聚合查询 ───────────────────────────────────

/** Dashboard 时间范围筛选 */
export type DashboardTimeRange = 'all' | '7d' | '30d' | { start: string; end: string };

/** Dashboard getSummary 筛选参数 */
export type SummaryFilter = {
  subsys?: string;
  timeRange?: DashboardTimeRange;
};

/** Dashboard getSummary 返回结构 */
export type SummaryResult = {
  subsysCount: number;
  caseCount: number;
  passRate: number;
  failCount: number;
  trend7d: { date: string; pass: number; fail: number; error: number }[];
};

/** Dashboard getTrend 返回结构 */
export type TrendPoint = { date: string; pass: number; fail: number; error: number };

/** Dashboard getSubsysStatus 返回结构（概览标签页子系统状态表） */
export type SubsysStatus = {
  name: string;
  caseCount: number;
  pass: number;
  fail: number;
  passRate: number;
};

/** Dashboard getSubsysHeatmap 返回结构（子系统热力图标签页） */
export type SubsysHeatmapRow = {
  subsys: string;
  pass: number;
  fail: number;
  error: number;
  total: number;
  passRate: number;
};

/** 将 timeRange 转换为 SQL WHERE 子句片段和参数 */
function timeRangeToClause(
  timeRange?: DashboardTimeRange,
): { clause: string; params: Record<string, string> } {
  if (!timeRange || timeRange === 'all') return { clause: '', params: {} };
  if (timeRange === '7d') {
    return { clause: "date(start_time) >= date('now', '-7 days')", params: {} };
  }
  if (timeRange === '30d') {
    return { clause: "date(start_time) >= date('now', '-30 days')", params: {} };
  }
  // custom range
  return {
    clause: 'date(start_time) >= date(@trStart) AND date(start_time) <= date(@trEnd)',
    params: { trStart: timeRange.start, trEnd: timeRange.end },
  };
}

/**
 * 获取 Dashboard 概览汇总数据。
 *
 * - subsysCount: 从 subsystems 表 COUNT（有 subsys 过滤时为 1 或 0）
 * - caseCount: 从 cases 表 COUNT（有 subsys 过滤时追加 WHERE subsys = ?）
 * - passRate / failCount: 从 simulation_runs 按 status 聚合（受 subsys + timeRange 影响）
 * - trend7d: 最近 7 天每日 pass/fail/error 趋势（受 subsys 影响，不受 timeRange 影响）
 */
export function getDashboardSummary(
  db: Database.Database,
  filter?: SummaryFilter,
): SummaryResult {
  const subsys = filter?.subsys;
  const tr = timeRangeToClause(filter?.timeRange);

  // ─── subsysCount ───
  let subsysCount: number;
  if (subsys) {
    const row = db.prepare('SELECT COUNT(*) as c FROM subsystems WHERE name = ?').get(subsys) as { c: number };
    subsysCount = row.c;
  } else {
    const row = db.prepare('SELECT COUNT(*) as c FROM subsystems').get() as { c: number };
    subsysCount = row.c;
  }

  // ─── caseCount ───
  let caseCount: number;
  if (subsys) {
    const row = db.prepare('SELECT COUNT(*) as c FROM cases WHERE subsys = ?').get(subsys) as { c: number };
    caseCount = row.c;
  } else {
    const row = db.prepare('SELECT COUNT(*) as c FROM cases').get() as { c: number };
    caseCount = row.c;
  }

  // ─── passRate / failCount (from simulation_runs, filtered by subsys + timeRange) ───
  const runConditions: string[] = [];
  const runParams: Record<string, unknown> = {};
  if (subsys) {
    runConditions.push('subsys = @subsys');
    runParams.subsys = subsys;
  }
  if (tr.clause) {
    runConditions.push(tr.clause);
    Object.assign(runParams, tr.params);
  }
  const runWhere = runConditions.length > 0 ? `WHERE ${runConditions.join(' AND ')}` : '';

  const statusRows = db.prepare(`
    SELECT status, COUNT(*) as c
    FROM simulation_runs
    ${runWhere}
    GROUP BY status
  `).all(runParams) as { status: string; c: number }[];

  let totalRuns = 0;
  let passRuns = 0;
  let failCount = 0;
  for (const row of statusRows) {
    totalRuns += row.c;
    if (row.status === 'pass') passRuns = row.c;
    if (row.status === 'fail') failCount = row.c;
  }
  const passRate = totalRuns > 0 ? Math.round((passRuns / totalRuns) * 1000) / 10 : 0;

  // ─── trend7d (last 7 days, filtered by subsys but NOT timeRange) ───
  const trendConditions = ["date(start_time) >= date('now', '-6 days')"];
  const trendParams: Record<string, unknown> = {};
  if (subsys) {
    trendConditions.push('subsys = @subsys');
    trendParams.subsys = subsys;
  }
  const trendWhere = trendConditions.join(' AND ');

  const trendRows = db.prepare(`
    SELECT
      date(start_time) as dt,
      SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) as pass,
      SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END) as fail,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error
    FROM simulation_runs
    WHERE ${trendWhere}
    GROUP BY date(start_time)
    ORDER BY dt
  `).all(trendParams) as { dt: string; pass: number; fail: number; error: number }[];

  // Build complete 7-day array (fill missing days with zeros)
  const trendMap = new Map<string, { pass: number; fail: number; error: number }>();
  for (const row of trendRows) {
    trendMap.set(row.dt, { pass: row.pass, fail: row.fail, error: row.error });
  }
  const trend7d: SummaryResult['trend7d'] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dt = d.toISOString().slice(0, 10);
    const entry = trendMap.get(dt);
    trend7d.push({
      date: dt,
      pass: entry?.pass ?? 0,
      fail: entry?.fail ?? 0,
      error: entry?.error ?? 0,
    });
  }

  return { subsysCount, caseCount, passRate, failCount, trend7d };
}

/**
 * 获取 Dashboard 趋势数据。
 *
 * - granularity='daily': 按 date(start_time) 分组
 * - granularity='weekly': 按 strftime('%Y-%W', start_time) 分组
 * - 受 subsys + timeRange 筛选
 *
 * @returns 趋势数据点数组，按日期/周排序
 */
export function getDashboardTrend(
  db: Database.Database,
  filter?: SummaryFilter & { granularity?: 'daily' | 'weekly' },
): TrendPoint[] {
  const subsys = filter?.subsys;
  const tr = timeRangeToClause(filter?.timeRange);
  const granularity = filter?.granularity ?? 'daily';

  const conditions: string[] = [];
  const params: Record<string, unknown> = {};
  if (subsys) {
    conditions.push('subsys = @subsys');
    params.subsys = subsys;
  }
  if (tr.clause) {
    conditions.push(tr.clause);
    Object.assign(params, tr.params);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const groupExpr = granularity === 'weekly'
    ? "strftime('%Y-%W', start_time)"
    : 'date(start_time)';

  const rows = db.prepare(`
    SELECT
      ${groupExpr} as dt,
      SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) as pass,
      SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END) as fail,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error
    FROM simulation_runs
    ${where}
    GROUP BY ${groupExpr}
    ORDER BY dt
  `).all(params) as { dt: string; pass: number; fail: number; error: number }[];

  return rows.map((row) => ({
    date: row.dt,
    pass: row.pass,
    fail: row.fail,
    error: row.error,
  }));
}

// ─── scan_metadata ───────────────────────────────────────

/**
 * 获取子系统热力图数据（子系统标签页）。
 *
 * 按 subsys 聚合 pass/fail/error 数量，计算 total 和 passRate。
 * 不支持 subsys 参数筛选（本标签页展示所有子系统分布）。
 * 受 timeRange 筛选影响。
 */
export function getSubsysHeatmap(
  db: Database.Database,
  filter?: SummaryFilter,
): SubsysHeatmapRow[] {
  const tr = timeRangeToClause(filter?.timeRange);

  const conditions: string[] = [];
  const params: Record<string, unknown> = {};
  if (tr.clause) {
    conditions.push(tr.clause);
    Object.assign(params, tr.params);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT
      subsys,
      SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) as pass,
      SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END) as fail,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error,
      COUNT(*) as total
    FROM simulation_runs
    ${where}
    GROUP BY subsys
    ORDER BY subsys
  `).all(params) as { subsys: string; pass: number; fail: number; error: number; total: number }[];

  return rows.map((row) => ({
    subsys: row.subsys,
    pass: row.pass,
    fail: row.fail,
    error: row.error,
    total: row.total,
    passRate: row.total > 0 ? Math.round((row.pass / row.total) * 1000) / 10 : 0,
  }));
}

/**
 * 获取各子系统状态汇总（概览标签页子系统状态表）。
 *
 * 对每个子系统，从 cases 表统计用例数，从 simulation_runs 表统计 pass/fail 数。
 * 受 timeRange 筛选影响。
 */
export function getSubsysStatus(
  db: Database.Database,
  filter?: SummaryFilter,
): SubsysStatus[] {
  const tr = timeRangeToClause(filter?.timeRange);

  // 用例数从 cases 表
  const caseRows = db.prepare(`
    SELECT subsys, COUNT(*) as caseCount
    FROM cases
    GROUP BY subsys
  `).all() as { subsys: string; caseCount: number }[];

  // pass/fail 从 simulation_runs 表
  const runConditions: string[] = [];
  const runParams: Record<string, unknown> = {};
  if (tr.clause) {
    runConditions.push(tr.clause);
    Object.assign(runParams, tr.params);
  }
  const runWhere = runConditions.length > 0 ? `WHERE ${runConditions.join(' AND ')}` : '';

  const runRows = db.prepare(`
    SELECT
      subsys,
      SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) as pass,
      SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END) as fail
    FROM simulation_runs
    ${runWhere}
    GROUP BY subsys
  `).all(runParams) as { subsys: string; pass: number; fail: number }[];

  const runMap = new Map<string, { pass: number; fail: number }>();
  for (const row of runRows) {
    runMap.set(row.subsys, { pass: row.pass, fail: row.fail });
  }

  return caseRows
    .map((row) => {
      const runs = runMap.get(row.subsys) ?? { pass: 0, fail: 0 };
      const total = runs.pass + runs.fail;
      const passRate = total > 0 ? Math.round((runs.pass / total) * 1000) / 10 : 0;
      return {
        name: row.subsys,
        caseCount: row.caseCount,
        pass: runs.pass,
        fail: runs.fail,
        passRate,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Dashboard getRecentFailures 返回结构（失败标签页） */
export type RecentFailureRow = {
  caseName: string;
  subsys: string;
  startTime: string;
  durationMs: number | null;
};

/** Dashboard getRegressionProgress 返回结构（回归标签页） */
export type RegressionProgress = {
  totalCases: number;
  runCases: number;
  passedCases: number;
  failedCases: number;
  notRunCases: number;
  passRate: number;
};

/**
 * 获取最近失败的用例列表。
 *
 * 从 simulation_runs 表查询 status='fail' 的记录，
 * 按 start_time 倒序排列，最多返回 50 条。
 * 不返回 corner 字段（Corner 是 post sim 阶段概念，前仿真不展示）。
 * 受 subsys + timeRange 筛选。
 */
export function getRecentFailures(
  db: Database.Database,
  filter?: SummaryFilter,
): RecentFailureRow[] {
  const subsys = filter?.subsys;
  const tr = timeRangeToClause(filter?.timeRange);

  const conditions = ["status = 'fail'"];
  const params: Record<string, unknown> = {};
  if (subsys) {
    conditions.push('subsys = @subsys');
    params.subsys = subsys;
  }
  if (tr.clause) {
    conditions.push(tr.clause);
    Object.assign(params, tr.params);
  }

  const rows = db.prepare(`
    SELECT case_name as caseName, subsys, start_time as startTime, duration_ms as durationMs
    FROM simulation_runs
    WHERE ${conditions.join(' AND ')}
    ORDER BY start_time DESC
    LIMIT 50
  `).all(params) as { caseName: string; subsys: string; startTime: string; durationMs: number | null }[];

  return rows.map((row) => ({
    caseName: row.caseName,
    subsys: row.subsys,
    startTime: row.startTime,
    durationMs: row.durationMs,
  }));
}

/**
 * 获取回归进度数据。
 *
 * 从 cases 表统计总用例数，从 simulation_runs 表统计已跑用例数、通过数和失败数。
 * 已跑/通过/失败基于每个用例的最新终态（pass/fail/error/aborted）统计。
 * **不受 timeRange 影响**（回归进度衡量整体完成度，始终按全量统计）。
 * 受 subsys 筛选（有值时仅统计该子系统的用例）。
 */
export function getRegressionProgress(
  db: Database.Database,
  filter?: { subsys?: string },
): RegressionProgress {
  const subsys = filter?.subsys;

  // ─── totalCases: 从 cases 表统计 ───
  let totalCases: number;
  if (subsys) {
    const row = db.prepare('SELECT COUNT(*) as c FROM cases WHERE subsys = ?').get(subsys) as { c: number };
    totalCases = row.c;
  } else {
    const row = db.prepare('SELECT COUNT(*) as c FROM cases').get() as { c: number };
    totalCases = row.c;
  }

  // ─── latest status per case ───
  const statusConditions = ["status IN ('pass', 'fail', 'error', 'aborted')"];
  const statusParams: Record<string, unknown> = {};
  if (subsys) {
    statusConditions.push('subsys = @subsys');
    statusParams.subsys = subsys;
  }

  const statusRows = db.prepare(`
    SELECT case_name, status FROM (
      SELECT case_name, status,
        ROW_NUMBER() OVER (PARTITION BY case_name ORDER BY start_time DESC) as rn
      FROM simulation_runs
      WHERE ${statusConditions.join(' AND ')}
    ) WHERE rn = 1
  `).all(statusParams) as { case_name: string; status: string }[];

  let passedCases = 0;
  let failedCases = 0;
  for (const row of statusRows) {
    if (row.status === 'pass') {
      passedCases++;
    } else {
      failedCases++;
    }
  }

  const runCases = passedCases + failedCases;
  const notRunCases = Math.max(0, totalCases - runCases);
  const passRate = runCases > 0 ? Math.round((passedCases / runCases) * 1000) / 10 : 0;

  return { totalCases, runCases, passedCases, failedCases, notRunCases, passRate };
}

// ─── scan_metadata (original) ──────────────────────────────

/**
 * 获取扫描元数据。
 */
export function getScanMetadata(
  db: Database.Database,
  key: string,
): string | null {
  const row = db.prepare(`
    SELECT value FROM scan_metadata WHERE key = @key
  `).get({ key }) as { value: string } | undefined;
  return row?.value ?? null;
}

/**
 * 设置扫描元数据（INSERT OR REPLACE）。
 */
export function setScanMetadata(
  db: Database.Database,
  key: string,
  value: string,
): void {
  db.prepare(`
    INSERT OR REPLACE INTO scan_metadata (key, value) VALUES (@key, @value)
  `).run({ key, value });
}

// ─── 清除 ────────────────────────────────────────────────

/**
 * 清除所有用例数据（保留 subsystems 表）。
 */
export function clearAllCases(db: Database.Database): void {
  db.prepare('DELETE FROM cases').run();
}

/**
 * 清除所有子系统数据（保留 cases 表）。
 * 用于 sync 模式下全量重扫前清理旧的子系统记录。
 */
export function clearAllSubsystems(db: Database.Database): void {
  db.prepare('DELETE FROM subsystems').run();
}

// ─── 行映射 ───────────────────────────────────────────────

function rowToSubsysRow(row: Record<string, unknown>): SubsysRow {
  return {
    name: row['name'] as string,
    path: (row['path'] as string | null) ?? undefined,
    description: (row['description'] as string | null) ?? undefined,
  };
}

function rowToCaseRow(row: Record<string, unknown>): CaseRow {
  return {
    name: row['name'] as string,
    subsys: row['subsys'] as string,
    path: row['path'] as string,
    filePath: (row['file_path'] as string | null) ?? undefined,
    baseCase: (row['base_case'] as string | null) ?? undefined,
    base: (row['base'] as string | null) ?? undefined,
    block: (row['block'] as string | null) ?? undefined,
    phase: (row['phase'] as string | null) ?? undefined,
  };
}
