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
 * 使用单条 UPDATE + 子查询避免 "too many SQL variables" 错误
 * （当匹配的违例数量超过 SQLite 变量上限时会发生）。
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

  return applyAutoConfirmWithSubquery(db, caseName, reason, 'v.time_fs <= @resetTimeFs', { resetTimeFs });
}

// ─── 自动确认（复位时间 + 复位区间，OR 关系） ──────────────────

/**
 * 根据复位时间和/或复位区间自动确认违例。
 *
 * 支持同时使用复位时间和复位区间条件（OR 关系）。
 * caseName 为空时对所有用例进行确认（全局自动确认）。
 * corner 不参与过滤——自动确认是按时间维度的全局操作。
 *
 * 使用单条 UPDATE + 子查询避免 "too many SQL variables" 错误。
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

  return applyAutoConfirmWithSubquery(db, caseName, reason, timeCondition, params);
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
 *
 * 使用分批处理（每批 500 条）避免 "too many SQL variables" 错误。
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

  const BATCH_SIZE = 500;

  const tx = db.transaction(() => {
    const now = new Date().toLocaleString('sv-SE');
    let totalChanges = 0;

    // 分批 UPDATE
    for (let i = 0; i < violationIds.length; i += BATCH_SIZE) {
      const batch = violationIds.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map(() => '?').join(',');

      const updateResult = db.prepare(`
        UPDATE confirmation_records
        SET status = ?, confirmer = ?, result = ?, reason = ?,
            is_auto_confirmed = 0, confirmed_at = ?, updated_at = ?
        WHERE violation_id IN (${placeholders})
      `).run(status, confirmer, result, reason, now, now, ...batch);

      totalChanges += updateResult.changes;
    }

    // 分批查询并保存 Pattern（按 hier+check_info 去重，大幅减少 SQL 操作次数）
    for (let i = 0; i < violationIds.length; i += BATCH_SIZE) {
      const batch = violationIds.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map(() => '?').join(',');

      const violations = db.prepare(`
        SELECT hier, check_info FROM timing_violations WHERE id IN (${placeholders})
      `).all(...batch) as { hier: string; check_info: string }[];

      // 按 (hier, check_info) 去重，统计每个 pattern 出现次数
      const patternCounts = new Map<string, number>();
      for (const v of violations) {
        const key = `${v.hier}\0${v.check_info}`;
        patternCounts.set(key, (patternCounts.get(key) ?? 0) + 1);
      }

      // 每个 unique pattern 只调用一次 savePattern
      for (const [key, cnt] of patternCounts) {
        const [hier, check] = key.split('\0');
        savePattern(db, hier, check, confirmer, result, reason, cnt);
      }
    }

    return totalChanges;
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
 *
 * @param count match_count 增量（默认 1）。批量确认时同一 pattern 的多条违例
 *   只需累加一次 count，而非逐条调用。
 */
export function savePattern(
  db: Database.Database,
  hier: string,
  check: string,
  confirmer: string,
  result: string,
  reason: string,
  count = 1,
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
    `).run(confirmer, result, reason, existing.match_count + count, now, existing.id);
  } else {
    db.prepare(`
      INSERT INTO violation_patterns
      (hier_pattern, check_pattern, default_confirmer, default_result,
       default_reason, match_count, last_used)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(hier, check, confirmer, result, reason, count, now);
  }
}

// ─── 应用历史确认（Pattern 匹配） ─────────────────────────────

/**
 * 对待确认违例一键应用历史确认模式。
 *
 * 逻辑：
 * 1. 检查 Pattern 表是否为空，空则返回 0
 * 2. 获取待确认违例（caseName 为空时获取所有用例的 pending 违例）
 * 3. 对每条违例，先尝试精确匹配，再尝试模糊匹配
 * 4. 匹配成功后应用确认结论，并更新 Pattern 的 match_count + last_used
 *
 * Pattern 匹配不依赖 corner（corner 无关）。
 * caseName 为空时对所有用例的待确认违例进行应用（全局应用）。
 *
 * @returns 应用的确认记录数
 */
export function applyHistoricalConfirmations(
  db: Database.Database,
  caseName?: string,
  corner?: string,
): { appliedCount: number } {
  // 检查 Pattern 表是否为空
  const patternCountRow = db.prepare('SELECT COUNT(*) as count FROM violation_patterns').get() as { count: number };
  if (patternCountRow.count === 0) {
    return { appliedCount: 0 };
  }

  // 获取待确认违例（caseName 为空时获取所有 pending 违例）
  const conditions: string[] = ["c.status = 'pending'"];
  const queryParams: Record<string, unknown> = {};

  if (caseName) {
    conditions.push('v.case_name = @caseName');
    queryParams.caseName = caseName;
  }
  if (corner) {
    conditions.push('v.corner = @corner');
    queryParams.corner = corner;
  }

  const pendingQuery = `
    SELECT v.id, v.hier, v.check_info, v.corner
    FROM timing_violations v
    JOIN confirmation_records c ON v.id = c.violation_id
    WHERE ${conditions.join(' AND ')}
  `;

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
 * 使用子查询批量应用自动确认（内部使用）。
 *
 * 通过单条 UPDATE + 子查询直接更新匹配的违例，
 * 避免 SELECT IDs → UPDATE IN (...) 两步法导致的 "too many SQL variables" 错误。
 *
 * 子查询选取满足时间条件且 status='pending' 的违例 ID，
 * 外层 UPDATE 直接更新这些记录。
 *
 * @returns 确认的记录数
 */
function applyAutoConfirmWithSubquery(
  db: Database.Database,
  caseName: string | undefined,
  reason: string,
  timeCondition: string,
  params: Record<string, unknown>,
): { confirmedCount: number } {
  const caseFilter = caseName ? 'v.case_name = @caseName AND' : '';
  const queryParams = caseName ? { ...params, caseName, reason, now: new Date().toLocaleString('sv-SE') } : { ...params, reason, now: new Date().toLocaleString('sv-SE') };

  const result = db.prepare(`
    UPDATE confirmation_records
    SET status = 'confirmed', result = 'pass', reason = @reason,
        confirmer = '系统自动', is_auto_confirmed = 1,
        confirmed_at = @now, updated_at = @now
    WHERE violation_id IN (
      SELECT v.id
      FROM timing_violations v
      LEFT JOIN confirmation_records c ON v.id = c.violation_id
      WHERE ${caseFilter} (${timeCondition})
        AND COALESCE(c.status, 'pending') = 'pending'
    )
  `).run(queryParams);

  return { confirmedCount: result.changes };
}
