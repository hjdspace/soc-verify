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

// ─── scan_metadata ───────────────────────────────────────

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
