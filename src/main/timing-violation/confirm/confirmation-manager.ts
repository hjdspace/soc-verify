/**
 * Confirmation Manager — 确认逻辑（自动 + 手动）
 *
 * 参考 Python models.py 中 auto_confirm_by_reset_time / auto_confirm_by_reset_time_and_interval /
 * update_confirmation / batch_update_confirmations / save_pattern 的逻辑。
 *
 * 自动确认规则（来自 docs/timing-violation-handoff.md §2.4.6）：
 * 1. 复位时间确认：time_fs <= reset_time_ns * 1000000 且 status='pending'
 * 2. 复位区间确认：time_fs 在 [interval_start_fs, interval_end_fs] 范围内
 * 3. OR 关系：同时使用复位时间和复位区间时，满足任一条件即可确认
 * 4. 全局确认：caseName 为空时对所有用例进行确认；corner 不参与过滤
 */

import type Database from 'better-sqlite3';
import type { ConfirmationStatus } from '../types';
import { findMatchingPattern } from './pattern-matcher';

// ─── 自动确认（复位时间） ─────────────────────────────────────

/**
 * 根据复位时间自动确认违例。
 *
 * 确认所有 time_fs <= resetTimeNs * 1000000 且 status='pending' 的违例。
 * caseName 为空时对所有用例进行确认（全局自动确认）。
 * corner 不参与过滤——自动确认是按时间维度的全局操作。
 *
 * @returns 确认的记录数
 */
export function autoConfirmByResetTime(
  db: Database.Database,
  caseName: string | undefined,
  resetTimeNs: number,
): { confirmedCount: number } {
  const resetTimeFs = Math.round(resetTimeNs * 1_000_000);
  const reason = `复位期间时序违例（<= ${resetTimeNs}ns），可以忽略`;

  const ids = findPendingViolationIds(
    db, caseName,
    'v.time_fs <= @resetTimeFs',
    { resetTimeFs },
  );

  if (ids.length > 0) {
    applyAutoConfirmation(db, ids, reason);
    return { confirmedCount: ids.length };
  }

  return { confirmedCount: 0 };
}

// ─── 自动确认（复位时间 + 复位区间，OR 关系） ──────────────────

/**
 * 根据复位时间和/或复位区间自动确认违例。
 *
 * 支持同时使用复位时间和复位区间条件（OR 关系）。
 * caseName 为空时对所有用例进行确认（全局自动确认）。
 * corner 不参与过滤——自动确认是按时间维度的全局操作。
 *
 * @returns 确认的记录数
 */
export function autoConfirmByInterval(
  db: Database.Database,
  caseName: string | undefined,
  resetTimeNs?: number,
  intervalStartNs?: number,
  intervalEndNs?: number,
): { confirmedCount: number } {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

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

  const ids = findPendingViolationIds(
    db, caseName,
    timeCondition,
    params,
  );

  if (ids.length > 0) {
    applyAutoConfirmation(db, ids, reason);
    return { confirmedCount: ids.length };
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

// ─── 应用历史确认（Pattern 匹配） ─────────────────────────────

/**
 * 对指定用例的待确认违例一键应用历史确认模式。
 *
 * 逻辑：
 * 1. 检查 Pattern 表是否为空，空则返回 0
 * 2. 获取该用例的所有 pending 违例（corner 无关）
 * 3. 对每条违例，先尝试精确匹配，再尝试模糊匹配
 * 4. 匹配成功后应用确认结论，并更新 Pattern 的 match_count + last_used
 *
 * Pattern 匹配不依赖 corner（corner 无关）。
 *
 * @returns 应用的确认记录数
 */
export function applyHistoricalConfirmations(
  db: Database.Database,
  caseName: string,
  corner?: string,
): { appliedCount: number } {
  // 检查 Pattern 表是否为空
  const patternCountRow = db.prepare('SELECT COUNT(*) as count FROM violation_patterns').get() as { count: number };
  if (patternCountRow.count === 0) {
    return { appliedCount: 0 };
  }

  // 获取待确认违例
  let pendingQuery: string;
  let queryParams: Record<string, unknown>;

  if (corner) {
    pendingQuery = `
      SELECT v.id, v.hier, v.check_info, v.corner
      FROM timing_violations v
      JOIN confirmation_records c ON v.id = c.violation_id
      WHERE v.case_name = @caseName AND v.corner = @corner AND c.status = 'pending'
    `;
    queryParams = { caseName, corner };
  } else {
    pendingQuery = `
      SELECT v.id, v.hier, v.check_info, v.corner
      FROM timing_violations v
      JOIN confirmation_records c ON v.id = c.violation_id
      WHERE v.case_name = @caseName AND c.status = 'pending'
    `;
    queryParams = { caseName };
  }

  const pendingViolations = db.prepare(pendingQuery).all(queryParams) as {
    id: number; hier: string; check_info: string; corner: string | null;
  }[];

  if (pendingViolations.length === 0) {
    return { appliedCount: 0 };
  }

  const tx = db.transaction(() => {
    let appliedCount = 0;
    const now = new Date().toLocaleString('sv-SE');

    for (const v of pendingViolations) {
      const matchResult = findMatchingPattern(db, v.hier, v.check_info);

      if (matchResult) {
        const { pattern, matched } = matchResult;

        // 应用历史确认信息
        db.prepare(`
          UPDATE confirmation_records
          SET status = 'confirmed',
              confirmer = @confirmer,
              result = @result,
              reason = @reason,
              is_auto_confirmed = 0,
              confirmed_at = @now,
              updated_at = @now
          WHERE violation_id = @violationId
        `).run({
          confirmer: pattern.defaultConfirmer ?? '',
          result: pattern.defaultResult ?? 'pass',
          reason: pattern.defaultReason ?? '',
          now,
          violationId: v.id,
        });

        // 更新 Pattern 的 match_count + last_used
        db.prepare(`
          UPDATE violation_patterns
          SET match_count = @matchCount, last_used = @now
          WHERE id = @patternId
        `).run({
          matchCount: pattern.matchCount + 1,
          now,
          patternId: pattern.id,
        });

        appliedCount++;

        // 避免未使用变量警告
        void matched;
      }
    }

    return appliedCount;
  });

  const appliedCount = tx();
  return { appliedCount };
}

// ─── 内部辅助 ─────────────────────────────────────────────────

/**
 * 查找待确认违例 ID。
 *
 * caseName 为空时不过滤用例（全局确认），corner 不参与过滤。
 * 返回匹配的违例 ID 列表（可能为空）。
 */
function findPendingViolationIds(
  db: Database.Database,
  caseName: string | undefined,
  timeCondition: string,
  params: Record<string, unknown>,
): number[] {
  const caseFilter = caseName ? 'v.case_name = @caseName AND' : '';
  const queryParams = caseName ? { ...params, caseName } : params;

  const rows = db.prepare(`
    SELECT v.id
    FROM timing_violations v
    LEFT JOIN confirmation_records c ON v.id = c.violation_id
    WHERE ${caseFilter} (${timeCondition})
      AND COALESCE(c.status, 'pending') = 'pending'
  `).all(queryParams) as { id: number }[];

  return rows.map((r) => r.id);
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
