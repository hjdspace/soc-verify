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
  /** 后仿标记（true = 需要跑后仿），仅由用户设置，扫描不覆盖 */
  postSim?: boolean;
};

export type SimulationRunRow = {
  runId?: string;
  caseName: string;
  subsys: string;
  status: string;
  startTime: string;
  endTime?: string;
  durationMs?: number;
  corner?: string;
  seed?: string;
  optionsJson?: string;
  /** runsim 命令（终端仿真来源，用于重新仿真） */
  command?: string;
  /** 仿真工作目录（终端仿真来源，用于重新仿真） */
  cwd?: string;
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
 * 批量插入用例（UPSERT，按 (name, subsys) 去重）。
 *
 * 使用 ON CONFLICT DO UPDATE 而非 INSERT OR REPLACE：
 * REPLACE 会整行删除重插，导致 post_sim 等用户设置字段被重置为默认值；
 * UPSERT 只更新扫描来源的字段，保留用户标记（后仿标记等）。
 * 使用 transaction + prepared statement 实现批量插入。
 */
export function insertCases(
  db: Database.Database,
  cases: CaseRow[],
): { inserted: number } {
  if (cases.length === 0) return { inserted: 0 };

  const stmt = db.prepare(`
    INSERT INTO cases (name, subsys, path, file_path, base_case, base, block, phase, updated_at)
    VALUES (@name, @subsys, @path, @filePath, @baseCase, @base, @block, @phase, datetime('now', 'localtime'))
    ON CONFLICT(name, subsys) DO UPDATE SET
      path = excluded.path,
      file_path = excluded.file_path,
      base_case = excluded.base_case,
      base = excluded.base,
      block = excluded.block,
      phase = excluded.phase,
      updated_at = excluded.updated_at
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
      SELECT name, subsys, path, file_path, base_case, base, block, phase, post_sim
      FROM cases WHERE subsys = @subsys ORDER BY name
    `).all({ subsys }) as Record<string, unknown>[];
    return rows.map(rowToCaseRow);
  }
  const rows = db.prepare(`
    SELECT name, subsys, path, file_path, base_case, base, block, phase, post_sim
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
 * 搜索用例（LIKE 子串匹配，对 name / path / file_path 三字段做 OR 查询）。
 *
 * SELECT … FROM cases
 *   WHERE (name LIKE '%q%' OR path LIKE '%q%' OR file_path LIKE '%q%')
 *   [AND subsys = ?] LIMIT ?
 *
 * 这样用户输入 "mini" 时，除了 case name 中包含 "mini" 的用例，
 * 路径中包含 "mini" 的 .cfg 文件所定义的全部用例也会被返回。
 */
export function searchCases(
  db: Database.Database,
  query: string,
  subsys?: string,
  limit = 200,
): CaseRow[] {
  const q = query.trim();
  if (!q) return [];

  const likeParam = `%${q}%`;
  const conditions = ['(name LIKE @query OR path LIKE @query OR file_path LIKE @query)'];
  const params: Record<string, unknown> = { query: likeParam };

  if (subsys) {
    conditions.push('subsys = @subsys');
    params.subsys = subsys;
  }

  const rows = db.prepare(`
    SELECT name, subsys, path, file_path, base_case, base, block, phase, post_sim
    FROM cases WHERE ${conditions.join(' AND ')}
    ORDER BY name LIMIT @limit
  `).all({ ...params, limit }) as Record<string, unknown>[];

  return rows.map(rowToCaseRow);
}

// ─── 后仿标记 ────────────────────────────────────────────

/**
 * 设置用例的后仿标记（UPDATE，仅用户操作触发）。
 *
 * @returns 更新行数（0 = 用例不存在）
 */
export function setCasePostSim(
  db: Database.Database,
  caseName: string,
  subsys: string,
  postSim: boolean,
): { updated: number } {
  const result = db.prepare(`
    UPDATE cases SET post_sim = @postSim, updated_at = datetime('now', 'localtime')
    WHERE name = @caseName AND subsys = @subsys
  `).run({ caseName, subsys, postSim: postSim ? 1 : 0 });
  return { updated: result.changes };
}

/**
 * 获取所有被标记为需要跑后仿的用例（后仿用例挑选结果）。
 */
export function getPostSimCases(db: Database.Database): CaseRow[] {
  const rows = db.prepare(`
    SELECT name, subsys, path, file_path, base_case, base, block, phase, post_sim
    FROM cases WHERE post_sim = 1 ORDER BY subsys, name
  `).all() as Record<string, unknown>[];
  return rows.map(rowToCaseRow);
}

/**
 * 获取最早一次 pass 的仿真运行（冒烟测试完成信号：用户成功调通的第一条用例）。
 *
 * @returns { caseName, subsys, startTime } | null（无 pass 记录时）
 */
export function getFirstPassRun(
  db: Database.Database,
): { caseName: string; subsys: string; startTime: string } | null {
  const row = db.prepare(`
    SELECT case_name, subsys, start_time FROM simulation_runs
    WHERE status = 'pass'
    ORDER BY start_time ASC LIMIT 1
  `).get() as { case_name: string; subsys: string; start_time: string } | undefined;
  if (!row) return null;
  return { caseName: row.case_name, subsys: row.subsys, startTime: row.start_time };
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
    (run_id, case_name, subsys, status, start_time, end_time, duration_ms, corner, seed, options_json, command, cwd)
    VALUES (@runId, @caseName, @subsys, @status, @startTime, @endTime, @durationMs, @corner, @seed, @optionsJson, @command, @cwd)
  `).run({
    runId: run.runId ?? null,
    caseName: run.caseName,
    subsys: run.subsys,
    status: run.status,
    startTime: run.startTime,
    endTime: run.endTime ?? null,
    durationMs: run.durationMs ?? null,
    corner: run.corner ?? null,
    seed: run.seed ?? null,
    optionsJson: run.optionsJson ?? null,
    command: run.command ?? null,
    cwd: run.cwd ?? null,
  });
  return { inserted: result.changes };
}

export type RecentSimulationRunRow = {
  id: number;
  runId: string | null;
  caseName: string;
  subsys: string;
  status: string;
  startTime: string;
  endTime: string | null;
  durationMs: number | null;
  seed: string | null;
  optionsJson: string | null;
  command: string | null;
  cwd: string | null;
};

/** 获取最近的仿真运行记录，供仿真页跨重启恢复运行列表。 */
export function getRecentSimulationRuns(
  db: Database.Database,
  limit = 200,
): RecentSimulationRunRow[] {
  const rows = db.prepare(`
    SELECT id, run_id, case_name, subsys, status, start_time, end_time,
      duration_ms, seed, options_json, command, cwd
    FROM (
      SELECT id, run_id, case_name, subsys, status, start_time, end_time,
        duration_ms, seed, options_json, command, cwd,
        ROW_NUMBER() OVER (
          PARTITION BY case_name, subsys
          ORDER BY start_time DESC, id DESC
        ) AS row_num
      FROM simulation_runs
    )
    WHERE row_num = 1
    ORDER BY start_time DESC, id DESC
    LIMIT @limit
  `).all({ limit: Math.max(1, Math.floor(limit)) }) as Array<{
    id: number;
    run_id: string | null;
    case_name: string;
    subsys: string;
    status: string;
    start_time: string;
    end_time: string | null;
    duration_ms: number | null;
    seed: string | null;
    options_json: string | null;
    command: string | null;
    cwd: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    runId: row.run_id,
    caseName: row.case_name,
    subsys: row.subsys,
    status: row.status,
    startTime: row.start_time,
    endTime: row.end_time,
    durationMs: row.duration_ms,
    seed: row.seed,
    optionsJson: row.options_json,
    command: row.command,
    cwd: row.cwd,
  }));
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
  status: string;
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
    SELECT case_name as caseName, subsys, status, start_time as startTime, duration_ms as durationMs
    FROM simulation_runs
    WHERE ${conditions.join(' AND ')}
    ORDER BY start_time DESC
    LIMIT 50
  `).all(params) as { caseName: string; subsys: string; status: string; startTime: string; durationMs: number | null }[];

  return rows.map((row) => ({
    caseName: row.caseName,
    subsys: row.subsys,
    status: row.status,
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

// ─── Dashboard 耗时分布 + 不稳定用例 ─────────────────────

/** Dashboard getDurationHistogram 返回结构（耗时标签页） */
export type DurationBucket = {
  bucket: string;
  count: number;
};

/** Dashboard getUnstableCases 返回结构（不稳定标签页） */
export type UnstableCaseRow = {
  caseName: string;
  subsys: string;
  passCount: number;
  failCount: number;
  totalCount: number;
  failRate: number;
  lastStatus: string;
};

/** 耗时直方图分桶定义（分钟 → 桶名） */
const DURATION_BUCKETS: { min: number; max: number; label: string }[] = [
  { min: 0, max: 60_000, label: '0-1min' },
  { min: 60_000, max: 300_000, label: '1-5min' },
  { min: 300_000, max: 900_000, label: '5-15min' },
  { min: 900_000, max: 1_800_000, label: '15-30min' },
];

/**
 * 获取仿真耗时分布直方图数据。
 *
 * 从 simulation_runs 表查询所有有 duration_ms 的记录，
 * 按 0-1min / 1-5min / 5-15min / 15-30min / 30min+ 分桶。
 * 受 subsys + timeRange 筛选。
 * 使用 SQL CASE WHEN 分桶，避免拉全量数据到前端。
 */
export function getDurationHistogram(
  db: Database.Database,
  filter?: SummaryFilter,
): DurationBucket[] {
  const subsys = filter?.subsys;
  const tr = timeRangeToClause(filter?.timeRange);

  const conditions = ['duration_ms IS NOT NULL'];
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
    SELECT
      CASE
        WHEN duration_ms < 60000 THEN '0-1min'
        WHEN duration_ms < 300000 THEN '1-5min'
        WHEN duration_ms < 900000 THEN '5-15min'
        WHEN duration_ms < 1800000 THEN '15-30min'
        ELSE '30min+'
      END as bucket,
      COUNT(*) as count
    FROM simulation_runs
    WHERE ${conditions.join(' AND ')}
    GROUP BY bucket
  `).all(params) as { bucket: string; count: number }[];

  // Build complete bucket list (fill missing buckets with zero count, preserve order)
  const countMap = new Map<string, number>();
  for (const row of rows) {
    countMap.set(row.bucket, row.count);
  }

  const allBuckets = [...DURATION_BUCKETS.map((b) => b.label), '30min+'];
  return allBuckets
    .map((label) => ({ bucket: label, count: countMap.get(label) ?? 0 }))
    .filter((b) => b.count > 0);
}

/**
 * 获取不稳定用例列表（有 pass 又有 fail 的用例）。
 *
 * 从 simulation_runs 表按 case_name + subsys 分组，
 * HAVING pass_count > 0 AND fail_count > 0。
 * 返回 { caseName, subsys, passCount, failCount, totalCount, failRate, lastStatus }[]。
 * 按失败率降序排列。
 * 受 subsys + timeRange 筛选。
 */
export function getUnstableCases(
  db: Database.Database,
  filter?: SummaryFilter,
): UnstableCaseRow[] {
  const subsys = filter?.subsys;
  const tr = timeRangeToClause(filter?.timeRange);

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

  // Use CTE to correctly compute lastStatus per case within the filtered set
  const rows = db.prepare(`
    WITH filtered_runs AS (
      SELECT case_name, subsys, status, start_time
      FROM simulation_runs
      ${where}
    ),
    aggregated AS (
      SELECT
        case_name as caseName,
        subsys,
        SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) as passCount,
        SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END) as failCount,
        COUNT(*) as totalCount
      FROM filtered_runs
      GROUP BY case_name, subsys
      HAVING passCount > 0 AND failCount > 0
    ),
    latest AS (
      SELECT case_name, subsys, status as lastStatus
      FROM (
        SELECT case_name, subsys, status,
          ROW_NUMBER() OVER (PARTITION BY case_name, subsys ORDER BY start_time DESC) as rn
        FROM filtered_runs
      ) WHERE rn = 1
    )
    SELECT a.caseName, a.subsys, a.passCount, a.failCount, a.totalCount, l.lastStatus
    FROM aggregated a
    JOIN latest l ON a.caseName = l.case_name AND a.subsys = l.subsys
    ORDER BY (CAST(a.failCount AS REAL) / a.totalCount) DESC
  `).all(params) as { caseName: string; subsys: string; passCount: number; failCount: number; totalCount: number; lastStatus: string }[];

  return rows.map((row) => ({
    caseName: row.caseName,
    subsys: row.subsys,
    passCount: row.passCount,
    failCount: row.failCount,
    totalCount: row.totalCount,
    failRate: row.totalCount > 0 ? Math.round((row.failCount / row.totalCount) * 1000) / 10 : 0,
    lastStatus: row.lastStatus,
  }));
}

// ─── Dashboard 最慢用例 + 按子系统回归进度 ─────────────────

/** Dashboard getSlowestCases 返回结构（耗时标签页 Top 10） */
export type SlowestCaseRow = {
  caseName: string;
  subsys: string;
  durationMs: number;
  status: string;
  startTime: string;
};

/** Dashboard getRegressionBySubsys 返回结构（回归标签页按子系统） */
export type RegressionBySubsysRow = {
  subsys: string;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  notRunCases: number;
};

/**
 * 获取最慢用例 Top 10。
 *
 * 从 simulation_runs 表查询有 duration_ms 的记录，
 * 按 duration_ms 降序排列，最多返回 10 条。
 * 受 subsys + timeRange 筛选。
 */
export function getSlowestCases(
  db: Database.Database,
  filter?: SummaryFilter,
): SlowestCaseRow[] {
  const subsys = filter?.subsys;
  const tr = timeRangeToClause(filter?.timeRange);

  const conditions = ['duration_ms IS NOT NULL'];
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
    SELECT case_name as caseName, subsys, duration_ms as durationMs, status, start_time as startTime
    FROM simulation_runs
    WHERE ${conditions.join(' AND ')}
    ORDER BY duration_ms DESC
    LIMIT 10
  `).all(params) as { caseName: string; subsys: string; durationMs: number; status: string; startTime: string }[];

  return rows.map((row) => ({
    caseName: row.caseName,
    subsys: row.subsys,
    durationMs: row.durationMs,
    status: row.status,
    startTime: row.startTime,
  }));
}

/**
 * 获取按子系统分组的回归进度数据。
 *
 * 从 cases 表统计每个子系统的总用例数，
 * 从 simulation_runs 表按最新终态统计每个子系统的已通过/未通过用例数。
 * 未跑用例数 = 总用例数 - 已跑用例数。
 * **不受 timeRange 影响**（回归进度衡量整体完成度）。
 * 受 subsys 筛选。
 */
export function getRegressionBySubsys(
  db: Database.Database,
  filter?: { subsys?: string },
): RegressionBySubsysRow[] {
  const subsys = filter?.subsys;

  // ─── totalCases per subsys ───
  let caseRows: { subsys: string; caseCount: number }[];
  if (subsys) {
    caseRows = db.prepare(`
      SELECT subsys, COUNT(*) as caseCount
      FROM cases WHERE subsys = ?
      GROUP BY subsys
    `).all(subsys) as { subsys: string; caseCount: number }[];
  } else {
    caseRows = db.prepare(`
      SELECT subsys, COUNT(*) as caseCount
      FROM cases
      GROUP BY subsys
    `).all() as { subsys: string; caseCount: number }[];
  }

  // ─── latest status per case per subsys ───
  const statusConditions = ["status IN ('pass', 'fail', 'error', 'aborted')"];
  const statusParams: Record<string, unknown> = {};
  if (subsys) {
    statusConditions.push('subsys = @subsys');
    statusParams.subsys = subsys;
  }

  const statusRows = db.prepare(`
    SELECT subsys, case_name, status FROM (
      SELECT subsys, case_name, status,
        ROW_NUMBER() OVER (PARTITION BY subsys, case_name ORDER BY start_time DESC) as rn
      FROM simulation_runs
      WHERE ${statusConditions.join(' AND ')}
    ) WHERE rn = 1
  `).all(statusParams) as { subsys: string; case_name: string; status: string }[];

  // ─── aggregate per subsys ───
  const statusMap = new Map<string, { passed: number; failed: number }>();
  for (const row of statusRows) {
    const entry = statusMap.get(row.subsys) ?? { passed: 0, failed: 0 };
    if (row.status === 'pass') {
      entry.passed++;
    } else {
      entry.failed++;
    }
    statusMap.set(row.subsys, entry);
  }

  return caseRows
    .map((row) => {
      const status = statusMap.get(row.subsys) ?? { passed: 0, failed: 0 };
      const runCases = status.passed + status.failed;
      return {
        subsys: row.subsys,
        totalCases: row.caseCount,
        passedCases: status.passed,
        failedCases: status.failed,
        notRunCases: Math.max(0, row.caseCount - runCases),
      };
    })
    .sort((a, b) => a.subsys.localeCompare(b.subsys));
}

// ─── Dashboard 阶段通过率 + 调试难度 ─────────────────────

/** Dashboard getPhasePassRate 返回结构（阶段标签页） */
export type PhasePassRateRow = {
  phase: string;
  total: number;
  pass: number;
  fail: number;
  error: number;
  passRate: number;
};

/** Dashboard getDebugDifficulty 返回结构（调试难度标签页） */
export type DebugDifficultyRow = {
  caseName: string;
  subsys: string;
  daysToFirstPass: number;
  failCountBeforePass: number;
};

/**
 * 获取各仿真阶段的通过率（阶段标签页）。
 *
 * JOIN cases 表获取 phase 字段，按 phase 聚合 pass/fail/error 数量。
 * phase 为 NULL 的用例归入「未分类」组。
 * 受 subsys + timeRange 筛选。
 */
export function getPhasePassRate(
  db: Database.Database,
  filter?: SummaryFilter,
): PhasePassRateRow[] {
  const subsys = filter?.subsys;
  const tr = timeRangeToClause(filter?.timeRange);

  const conditions: string[] = [];
  const params: Record<string, unknown> = {};
  if (subsys) {
    conditions.push('r.subsys = @subsys');
    params.subsys = subsys;
  }
  if (tr.clause) {
    // timeRange clause references start_time, which is r.start_time in the JOIN
    const trClause = tr.clause.replace(/start_time/g, 'r.start_time');
    conditions.push(trClause);
    Object.assign(params, tr.params);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT
      COALESCE(c.phase, '未分类') as phase,
      COUNT(*) as total,
      SUM(CASE WHEN r.status = 'pass' THEN 1 ELSE 0 END) as pass,
      SUM(CASE WHEN r.status = 'fail' THEN 1 ELSE 0 END) as fail,
      SUM(CASE WHEN r.status = 'error' THEN 1 ELSE 0 END) as error
    FROM simulation_runs r
    JOIN cases c ON c.name = r.case_name AND c.subsys = r.subsys
    ${where}
    GROUP BY COALESCE(c.phase, '未分类')
    ORDER BY phase
  `).all(params) as { phase: string; total: number; pass: number; fail: number; error: number }[];

  return rows.map((row) => ({
    phase: row.phase,
    total: row.total,
    pass: row.pass,
    fail: row.fail,
    error: row.error,
    passRate: row.total > 0 ? Math.round((row.pass / row.total) * 1000) / 10 : 0,
  }));
}

/**
 * 获取调试难度散点图数据（调试难度标签页）。
 *
 * 使用窗口函数查找每个用例的首次 run 时间和首次 pass 时间。
 * - daysToFirstPass = 首次 pass 的 start_time 减去首次 run 的 start_time（天为单位，取整）
 * - failCountBeforePass = 首次 pass 之前 status='fail' 的记录数
 * 仅包含有 pass 记录的用例（未通过的不计入散点图）。
 * 按 daysToFirstPass * failCountBeforePass 降序排列（调试难度最高者在前）。
 * 受 subsys + timeRange 筛选。
 */
export function getDebugDifficulty(
  db: Database.Database,
  filter?: SummaryFilter,
): DebugDifficultyRow[] {
  const subsys = filter?.subsys;
  const tr = timeRangeToClause(filter?.timeRange);

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

  // Use CTEs to compute first run time, first pass time, and fail count before first pass
  const rows = db.prepare(`
    WITH filtered AS (
      SELECT case_name, subsys, status, start_time
      FROM simulation_runs
      ${where}
    ),
    first_run AS (
      SELECT case_name, subsys, start_time as first_run_time
      FROM (
        SELECT case_name, subsys, start_time,
          ROW_NUMBER() OVER (PARTITION BY case_name, subsys ORDER BY start_time ASC) as rn
        FROM filtered
      ) WHERE rn = 1
    ),
    first_pass AS (
      SELECT case_name, subsys, start_time as first_pass_time
      FROM (
        SELECT case_name, subsys, start_time,
          ROW_NUMBER() OVER (PARTITION BY case_name, subsys ORDER BY start_time ASC) as rn
        FROM filtered
        WHERE status = 'pass'
      ) WHERE rn = 1
    ),
    fail_count AS (
      SELECT f.case_name, f.subsys, COUNT(*) as fail_count_before_pass
      FROM first_pass f
      JOIN filtered fr ON fr.case_name = f.case_name AND fr.subsys = f.subsys
        AND fr.status = 'fail' AND fr.start_time < f.first_pass_time
      GROUP BY f.case_name, f.subsys
    )
    SELECT
      fp.case_name as caseName,
      fp.subsys,
      CAST(julianday(fp.first_pass_time) - julianday(fr.first_run_time) AS INTEGER) as daysToFirstPass,
      COALESCE(fc.fail_count_before_pass, 0) as failCountBeforePass
    FROM first_pass fp
    JOIN first_run fr ON fr.case_name = fp.case_name AND fr.subsys = fp.subsys
    LEFT JOIN fail_count fc ON fc.case_name = fp.case_name AND fc.subsys = fp.subsys
    ORDER BY (CAST(julianday(fp.first_pass_time) - julianday(fr.first_run_time) AS INTEGER) * COALESCE(fc.fail_count_before_pass, 0)) DESC
  `).all(params) as { caseName: string; subsys: string; daysToFirstPass: number; failCountBeforePass: number }[];

  return rows.map((row) => ({
    caseName: row.caseName,
    subsys: row.subsys,
    daysToFirstPass: Math.max(0, row.daysToFirstPass),
    failCountBeforePass: row.failCountBeforePass,
  }));
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
    postSim: row['post_sim'] === 1,
  };
}
