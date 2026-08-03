/**
 * 数据访问层 — CRUD 操作
 *
 * 参考 docs/timing-violation-handoff.md §4.4 (tRPC API 设计)
 * 参考 docs/timing-violation-handoff.md §7.3 (批量插入性能)
 */

import type Database from 'better-sqlite3';
import type {
  ParsedViolation,
  ViolationWithConfirmation,
  QueryViolationsInput,
  QueryViolationsResult,
  ViolationStatistics,
  ViolationMetadata,
  ConfirmationStatus,
} from '../types';

// ─── 批量插入 ─────────────────────────────────────────────────

/**
 * 批量插入违例记录（INSERT OR IGNORE 去重）。
 * 使用 transaction + prepared statement 实现 10万+/秒的插入性能。
 *
 * @returns { inserted, skipped } 新增数和跳过数
 */
export function insertViolations(
  db: Database.Database,
  violations: ParsedViolation[],
): { inserted: number; skipped: number } {
  if (violations.length === 0) return { inserted: 0, skipped: 0 };

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO timing_violations
    (case_name, corner, seed, subsys, num, hier, time_fs, time_display, check_info, file_path)
    VALUES (@caseName, @corner, @seed, @subsys, @num, @hier, @timeFs, @timeDisplay, @checkInfo, @filePath)
  `);

  let inserted = 0;
  let skipped = 0;

  const tx = db.transaction(() => {
    for (const v of violations) {
      const result = stmt.run({
        caseName: v.caseName,
        corner: v.corner,
        seed: v.seed,
        subsys: v.subsys,
        num: v.num,
        hier: v.hier,
        timeFs: v.timeFs,
        timeDisplay: v.timeDisplay,
        checkInfo: v.checkInfo,
        filePath: v.filePath,
      });
      if (result.changes > 0) {
        inserted++;
      } else {
        skipped++;
      }
    }
  });

  tx();
  return { inserted, skipped };
}

// ─── 确认记录初始化 ───────────────────────────────────────────

/**
 * 为新插入的违例创建默认 pending 确认记录。
 * 只为没有确认记录的违例创建。
 */
export function ensureConfirmationRecords(db: Database.Database): number {
  const result = db.prepare(`
    INSERT INTO confirmation_records (violation_id, status)
    SELECT id, 'pending' FROM timing_violations
    WHERE id NOT IN (SELECT violation_id FROM confirmation_records)
  `).run();
  return result.changes;
}

// ─── 分页查询违例 ─────────────────────────────────────────────

/**
 * 分页查询违例列表（LEFT JOIN 确认记录）。
 *
 * 支持筛选（caseName/corner/status/subsys/searchText）和排序（sortField/sortOrder）。
 */
export function queryViolations(
  db: Database.Database,
  input: QueryViolationsInput,
): QueryViolationsResult {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (input.caseName) {
    conditions.push('v.case_name = @caseName');
    params.caseName = input.caseName;
  }
  if (input.corner) {
    conditions.push('v.corner = @corner');
    params.corner = input.corner;
  }
  if (input.subsys) {
    conditions.push('v.subsys = @subsys');
    params.subsys = input.subsys;
  }
  if (input.status) {
    conditions.push('COALESCE(c.status, @status) = @status');
    params.status = input.status;
  }
  if (input.searchText) {
    conditions.push('(v.hier LIKE @searchText OR v.check_info LIKE @searchText)');
    params.searchText = `%${input.searchText}%`;
  }

  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(' AND ')}`
    : '';

  // 排序
  const sortField = input.sortField ?? 'time_fs';
  const sortOrder = input.sortOrder ?? 'asc';
  const orderClause = `ORDER BY v.${sortField} ${sortOrder === 'desc' ? 'DESC' : 'ASC'}`;

  // 总数
  const countRow = db.prepare(`
    SELECT COUNT(*) as total
    FROM timing_violations v
    LEFT JOIN confirmation_records c ON v.id = c.violation_id
    ${whereClause}
  `).get(params) as { total: number };

  // 分页数据
  const offset = (input.page - 1) * input.pageSize;
  const rows = db.prepare(`
    SELECT
      v.id, v.case_name, v.corner, v.seed, v.subsys, v.num,
      v.hier, v.time_fs, v.time_display, v.check_info, v.file_path,
      v.created_at,
      COALESCE(c.status, 'pending') as status,
      c.confirmer, c.result, c.reason,
      COALESCE(c.is_auto_confirmed, 0) as is_auto_confirmed,
      c.confirmed_at
    FROM timing_violations v
    LEFT JOIN confirmation_records c ON v.id = c.violation_id
    ${whereClause}
    ${orderClause}
    LIMIT @pageSize OFFSET @offset
  `).all({ ...params, pageSize: input.pageSize, offset }) as Record<string, unknown>[];

  const items: ViolationWithConfirmation[] = rows.map(rowToViolationWithConfirmation);

  return { total: countRow.total, items };
}

// ─── 统计 ─────────────────────────────────────────────────────

/**
 * 获取统计信息（总数/已确认/待确认/已忽略 + 按维度分布）。
 */
export function getStatistics(
  db: Database.Database,
  filter?: { caseName?: string; corner?: string },
): ViolationStatistics {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (filter?.caseName) {
    conditions.push('v.case_name = @caseName');
    params.caseName = filter.caseName;
  }
  if (filter?.corner) {
    conditions.push('v.corner = @corner');
    params.corner = filter.corner;
  }

  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(' AND ')}`
    : '';

  const row = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN COALESCE(c.status, 'pending') = 'confirmed' THEN 1 ELSE 0 END) as confirmed,
      SUM(CASE WHEN COALESCE(c.status, 'pending') = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN COALESCE(c.status, 'pending') = 'ignored' THEN 1 ELSE 0 END) as ignored
    FROM timing_violations v
    LEFT JOIN confirmation_records c ON v.id = c.violation_id
    ${whereClause}
  `).get(params) as { total: number; confirmed: number; pending: number; ignored: number };

  // 按 subsys 分布
  const subsysRows = db.prepare(`
    SELECT v.subsys as key, COUNT(*) as count
    FROM timing_violations v
    ${whereClause}
    GROUP BY v.subsys
  `).all(params) as { key: string; count: number }[];
  const bySubsys: Record<string, number> = {};
  for (const r of subsysRows) {
    bySubsys[r.key ?? 'unknown'] = r.count;
  }

  // 按 corner 分布
  const cornerRows = db.prepare(`
    SELECT v.corner as key, COUNT(*) as count
    FROM timing_violations v
    ${whereClause}
    GROUP BY v.corner
  `).all(params) as { key: string; count: number }[];
  const byCorner: Record<string, number> = {};
  for (const r of cornerRows) {
    byCorner[r.key ?? 'default'] = r.count;
  }

  // 按 case 分布
  const caseRows = db.prepare(`
    SELECT v.case_name as key, COUNT(*) as count
    FROM timing_violations v
    ${whereClause}
    GROUP BY v.case_name
  `).all(params) as { key: string; count: number }[];
  const byCase: Record<string, number> = {};
  for (const r of caseRows) {
    byCase[r.key] = r.count;
  }

  return {
    total: row.total,
    confirmed: row.confirmed,
    pending: row.pending,
    ignored: row.ignored,
    bySubsys,
    byCorner,
    byCase,
  };
}

// ─── 元数据 ───────────────────────────────────────────────────

/**
 * 获取元数据（所有 corners / cases / subsys 列表）。
 */
export function getMetadata(db: Database.Database): ViolationMetadata {
  const corners = db.prepare(`
    SELECT DISTINCT corner FROM timing_violations WHERE corner IS NOT NULL ORDER BY corner
  `).all() as { corner: string }[];

  const cases = db.prepare(`
    SELECT DISTINCT case_name FROM timing_violations ORDER BY case_name
  `).all() as { case_name: string }[];

  const subsys = db.prepare(`
    SELECT DISTINCT subsys FROM timing_violations WHERE subsys IS NOT NULL ORDER BY subsys
  `).all() as { subsys: string }[];

  return {
    corners: corners.map((r) => r.corner),
    cases: cases.map((r) => r.case_name),
    subsys: subsys.map((r) => r.subsys),
  };
}

// ─── 清除数据 ─────────────────────────────────────────────────

/**
 * 清除指定用例的违例数据（含确认记录）。
 * 如果指定了 corner，只清除该 corner 的数据。
 */
export function clearCaseData(
  db: Database.Database,
  caseName: string,
  corner?: string,
): { deleted: number } {
  const tx = db.transaction(() => {
    // 先删确认记录
    let violationsQuery: string;
    let params: Record<string, unknown>;
    if (corner) {
      violationsQuery = `SELECT id FROM timing_violations WHERE case_name = @caseName AND corner = @corner`;
      params = { caseName, corner };
    } else {
      violationsQuery = `SELECT id FROM timing_violations WHERE case_name = @caseName`;
      params = { caseName };
    }

    const ids = db.prepare(violationsQuery).all(params) as { id: number }[];
    if (ids.length === 0) return 0;

    const idList = ids.map((r) => r.id);
    const placeholders = idList.map(() => '?').join(',');

    db.prepare(`DELETE FROM confirmation_records WHERE violation_id IN (${placeholders})`).run(...idList);
    db.prepare(`DELETE FROM timing_violations WHERE id IN (${placeholders})`).run(...idList);

    return ids.length;
  });

  const deleted = tx();
  return { deleted };
}

/**
 * 清空所有违例数据（含确认记录）。
 * Pattern 表不动（历史确认模式保留）。
 */
export function clearAllData(db: Database.Database): { deleted: number } {
  const tx = db.transaction(() => {
    const countRow = db.prepare('SELECT COUNT(*) as count FROM timing_violations').get() as { count: number };
    db.prepare('DELETE FROM confirmation_records').run();
    db.prepare('DELETE FROM timing_violations').run();
    return countRow.count;
  });
  const deleted = tx();
  return { deleted };
}

/**
 * 获取数据库整体统计信息。
 */
export function getDatabaseStats(db: Database.Database): {
  totalViolations: number;
  confirmed: number;
  pending: number;
  ignored: number;
  patternCount: number;
  caseCount: number;
} {
  const vRow = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN COALESCE(c.status, 'pending') = 'confirmed' THEN 1 ELSE 0 END) as confirmed,
      SUM(CASE WHEN COALESCE(c.status, 'pending') = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN COALESCE(c.status, 'pending') = 'ignored' THEN 1 ELSE 0 END) as ignored
    FROM timing_violations v
    LEFT JOIN confirmation_records c ON v.id = c.violation_id
  `).get() as { total: number; confirmed: number; pending: number; ignored: number };

  const pRow = db.prepare(`SELECT COUNT(*) as count FROM violation_patterns`).get() as { count: number };
  const cRow = db.prepare(`SELECT COUNT(DISTINCT case_name) as count FROM timing_violations`).get() as { count: number };

  return {
    totalViolations: vRow.total,
    confirmed: vRow.confirmed,
    pending: vRow.pending,
    ignored: vRow.ignored,
    patternCount: pRow.count,
    caseCount: cRow.count,
  };
}

// ─── 行映射 ───────────────────────────────────────────────────

function rowToViolationWithConfirmation(row: Record<string, unknown>): ViolationWithConfirmation {
  return {
    id: row['id'] as number,
    caseName: row['case_name'] as string,
    corner: (row['corner'] as string | null) ?? null,
    seed: (row['seed'] as string | null) ?? null,
    subsys: (row['subsys'] as string | null) ?? null,
    num: row['num'] as number,
    hier: row['hier'] as string,
    timeFs: row['time_fs'] as number,
    timeDisplay: row['time_display'] as string,
    checkInfo: row['check_info'] as string,
    filePath: row['file_path'] as string,
    createdAt: row['created_at'] as string,
    status: (row['status'] as ConfirmationStatus) ?? 'pending',
    confirmer: (row['confirmer'] as string | null) ?? null,
    result: (row['result'] as string | null) ?? null,
    reason: (row['reason'] as string | null) ?? null,
    isAutoConfirmed: Boolean(row['is_auto_confirmed']),
    confirmedAt: (row['confirmed_at'] as string | null) ?? null,
  };
}
