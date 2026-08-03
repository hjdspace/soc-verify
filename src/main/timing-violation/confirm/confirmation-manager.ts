/**
 * Confirmation Manager — 确认逻辑（自动 + 手动）
 *
 * 参考 Python models.py 中 auto_confirm_by_reset_time / auto_confirm_by_reset_time_and_interval /
 * update_confirmation / batch_update_confirmations / save_pattern 的逻辑。
 *
 * 自动确认规则（来自 docs/timing-violation-handoff.md §2.4.6）：
 * 1. 复位时间确认：time_fs <= reset_time_ns * 1000000 且 status='pending'
 * 2. 复位区间确认：time_fs 在 [interval_start_fs, interval_end_fs] 范围内
 * 3. Corner 回退：如果指定 corner 未找到记录，回退到 'default' corner
 * 4. OR 关系：同时使用复位时间和复位区间时，满足任一条件即可确认
 */

import type Database from 'better-sqlite3';
import type { ConfirmationStatus } from '../types';

// ─── 自动确认（复位时间） ─────────────────────────────────────

/**
 * 根据复位时间自动确认违例。
 *
 * 确认所有 time_fs <= resetTimeNs * 1000000 且 status='pending' 的违例。
 * 如果指定 corner 未找到记录，回退到 'default' corner。
 *
 * @returns 确认的记录数
 */
export function autoConfirmByResetTime(
  db: Database.Database,
  caseName: string,
  corner: string,
  resetTimeNs: number,
): { confirmedCount: number } {
  const resetTimeFs = Math.round(resetTimeNs * 1_000_000);
  const reason = `复位期间时序违例（<= ${resetTimeNs}ns），可以忽略`;

  const result = findPendingViolationIds(
    db, caseName, corner,
    'v.time_fs <= @resetTimeFs',
    { caseName, resetTimeFs },
  );

  if (result) {
    applyAutoConfirmation(db, result.ids, reason);
    return { confirmedCount: result.ids.length };
  }

  return { confirmedCount: 0 };
}

// ─── 自动确认（复位时间 + 复位区间，OR 关系） ──────────────────

/**
 * 根据复位时间和/或复位区间自动确认违例。
 *
 * 支持同时使用复位时间和复位区间条件（OR 关系）。
 * 如果指定 corner 未找到记录，回退到 'default' corner。
 *
 * @returns 确认的记录数
 */
export function autoConfirmByInterval(
  db: Database.Database,
  caseName: string,
  corner: string,
  resetTimeNs?: number,
  intervalStartNs?: number,
  intervalEndNs?: number,
): { confirmedCount: number } {
  const conditions: string[] = [];
  const params: Record<string, unknown> = { caseName };

  if (resetTimeNs !== undefined) {
    const resetTimeFs = Math.round(resetTimeNs * 1_000_000);
    conditions.push('v.time_fs <= @resetTimeFs');
    params.resetTimeFs = resetTimeFs;
  }

  if (intervalStartNs !== undefined && intervalEndNs !== undefined) {
    const intervalStartFs = Math.round(intervalStartNs * 1_000_000);
    const intervalEndFs = Math.round(intervalEndNs * 1_000_000);
    conditions.push('(v.time_fs >= @intervalStartFs AND v.time_fs <= @intervalEndFs)');
    params.intervalStartFs = intervalStartFs;
    params.intervalEndFs = intervalEndFs;
  }

  if (conditions.length === 0) {
    return { confirmedCount: 0 };
  }

  // OR 关系
  const timeCondition = conditions.join(' OR ');

  // 构建确认理由
  const reasonParts: string[] = [];
  if (resetTimeNs !== undefined) {
    reasonParts.push(`复位期间时序违例（<= ${resetTimeNs}ns）`);
  }
  if (intervalStartNs !== undefined && intervalEndNs !== undefined) {
    reasonParts.push(`复位区间内时序违例（${intervalStartNs}ns~${intervalEndNs}ns）`);
  }
  const reason = `${reasonParts.join('，')}，可以忽略`;

  const result = findPendingViolationIds(
    db, caseName, corner,
    timeCondition,
    params,
  );

  if (result) {
    applyAutoConfirmation(db, result.ids, reason);
    return { confirmedCount: result.ids.length };
  }

  return { confirmedCount: 0 };
}

// ─── 手动确认（单条） ─────────────────────────────────────────

/**
 * 手动确认单条违例。
 *
 * 更新确认状态、确认人、结果、理由。
 * 确认后自动保存 Pattern（hier + check_info → confirmer + result + reason）。
 */
export function updateConfirmation(
  db: Database.Database,
  violationId: number,
  status: ConfirmationStatus,
  confirmer: string,
  result: string,
  reason: string,
): { success: boolean } {
  const tx = db.transaction(() => {
    const now = new Date().toLocaleString('sv-SE'); // YYYY-MM-DD HH:mm:ss format

    db.prepare(`
      UPDATE confirmation_records
      SET status = @status, confirmer = @confirmer, result = @result, reason = @reason,
          is_auto_confirmed = 0, confirmed_at = @now, updated_at = @now
      WHERE violation_id = @violationId
    `).run({ status, confirmer, result, reason, now, violationId });

    // 保存 Pattern（hier + check_info → confirmer + result + reason）
    const violation = db.prepare(`
      SELECT hier, check_info FROM timing_violations WHERE id = ?
    `).get(violationId) as { hier: string; check_info: string } | undefined;

    if (violation) {
      savePattern(db, violation.hier, violation.check_info, confirmer, result, reason);
    }
  });

  tx();
  return { success: true };
}

// ─── 批量确认 ─────────────────────────────────────────────────

/**
 * 批量确认多条违例。
 *
 * 将相同的确认人/结果/理由应用到所有选中的违例。
 * 每条违例都会自动保存 Pattern。
 */
export function batchUpdateConfirmations(
  db: Database.Database,
  violationIds: number[],
  status: ConfirmationStatus,
  confirmer: string,
  result: string,
  reason: string,
): { updatedCount: number } {
  if (violationIds.length === 0) return { updatedCount: 0 };

  const tx = db.transaction(() => {
    const now = new Date().toLocaleString('sv-SE');
    const placeholders = violationIds.map(() => '?').join(',');

    const updateResult = db.prepare(`
      UPDATE confirmation_records
      SET status = ?, confirmer = ?, result = ?, reason = ?,
          is_auto_confirmed = 0, confirmed_at = ?, updated_at = ?
      WHERE violation_id IN (${placeholders})
    `).run(status, confirmer, result, reason, now, now, ...violationIds);

    // 为每条违例保存 Pattern
    const violations = db.prepare(`
      SELECT hier, check_info FROM timing_violations WHERE id IN (${placeholders})
    `).all(...violationIds) as { hier: string; check_info: string }[];

    for (const v of violations) {
      savePattern(db, v.hier, v.check_info, confirmer, result, reason);
    }

    return updateResult.changes;
  });

  const updatedCount = tx();
  return { updatedCount };
}

// ─── Pattern 保存 ─────────────────────────────────────────────

/**
 * 保存确认模式到 violation_patterns 表。
 *
 * 如果 (hier_pattern, check_pattern) 已存在，更新确认信息并累加 match_count。
 * 否则插入新记录。
 */
export function savePattern(
  db: Database.Database,
  hier: string,
  check: string,
  confirmer: string,
  result: string,
  reason: string,
): void {
  const now = new Date().toLocaleString('sv-SE');

  const existing = db.prepare(`
    SELECT id, match_count FROM violation_patterns
    WHERE hier_pattern = ? AND check_pattern = ?
  `).get(hier, check) as { id: number; match_count: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE violation_patterns
      SET default_confirmer = ?, default_result = ?, default_reason = ?,
          match_count = ?, last_used = ?
      WHERE id = ?
    `).run(confirmer, result, reason, existing.match_count + 1, now, existing.id);
  } else {
    db.prepare(`
      INSERT INTO violation_patterns
      (hier_pattern, check_pattern, default_confirmer, default_result,
       default_reason, match_count, last_used)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `).run(hier, check, confirmer, result, reason, now);
  }
}

// ─── 内部辅助 ─────────────────────────────────────────────────

/**
 * 获取 corner 回退列表：指定 corner 非默认时，先尝试指定 corner，再回退到 'default'。
 */
function cornersToTry(corner: string): string[] {
  return corner !== 'default' ? [corner, 'default'] : ['default'];
}

/**
 * 在 corner 回退列表中查找待确认违例 ID。
 * 返回第一个找到结果的 corner 的违例 ID 列表，如果都没有则返回 null。
 */
function findPendingViolationIds(
  db: Database.Database,
  caseName: string,
  corner: string,
  timeCondition: string,
  params: Record<string, unknown>,
): { ids: number[]; corner: string } | null {
  for (const tryCorner of cornersToTry(corner)) {
    const queryParams = { ...params, corner: tryCorner };
    const rows = db.prepare(`
      SELECT v.id
      FROM timing_violations v
      LEFT JOIN confirmation_records c ON v.id = c.violation_id
      WHERE v.case_name = @caseName AND v.corner = @corner AND (${timeCondition})
        AND COALESCE(c.status, 'pending') = 'pending'
    `).all(queryParams) as { id: number }[];

    if (rows.length > 0) {
      return { ids: rows.map((r) => r.id), corner: tryCorner };
    }
  }
  return null;
}

/**
 * 批量应用自动确认（内部使用）。
 * 更新确认记录状态为 confirmed、确认人为"系统自动"、结果为 pass。
 */
function applyAutoConfirmation(
  db: Database.Database,
  violationIds: number[],
  reason: string,
): void {
  const tx = db.transaction(() => {
    const now = new Date().toLocaleString('sv-SE');
    const placeholders = violationIds.map(() => '?').join(',');

    db.prepare(`
      UPDATE confirmation_records
      SET status = 'confirmed', result = 'pass', reason = ?,
          confirmer = '系统自动', is_auto_confirmed = 1,
          confirmed_at = ?, updated_at = ?
      WHERE violation_id IN (${placeholders})
    `).run(reason, now, now, ...violationIds);
  });

  tx();
}
