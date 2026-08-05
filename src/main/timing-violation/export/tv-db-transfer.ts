/**
 * TV DB Transfer — Pattern DB 导出导入 + 完整数据库合并
 *
 * 参考 Python models.py 中 export_patterns_to_database / import_patterns_from_database / merge_databases
 * 参考 docs/timing-violation-handoff.md §4.4 (tRPC API 设计)
 *
 * Pattern DB 导出：创建只含 violation_patterns 表的独立 SQLite 文件。
 * Pattern 导入：从外部 DB 文件读取 Pattern，合并到当前 DB（相同 Pattern 累加 match_count）。
 * 完整数据库合并：合并多个 DB 的 violations + confirmations + patterns。
 */

import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA_SQL, PRAGMA_SQL } from '../db/tv-schema';

// ─── Pattern DB 导出 ─────────────────────────────────────────

/**
 * 导出 Pattern 为独立数据库文件（只含 violation_patterns 表）。
 */
export function exportPatternsToDatabase(
  sourceDb: Database.Database,
  targetFilePath: string,
): { success: boolean; count: number } {
  // 确保目标目录存在
  const dir = dirname(targetFilePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const targetDb = new Database(targetFilePath);
  try {
    targetDb.exec(PRAGMA_SQL);

    // 只创建 violation_patterns 表
    targetDb.exec(`
      CREATE TABLE IF NOT EXISTS violation_patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hier_pattern TEXT NOT NULL,
        check_pattern TEXT NOT NULL,
        default_confirmer TEXT,
        default_result TEXT,
        default_reason TEXT,
        match_count INTEGER DEFAULT 1,
        last_used TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(hier_pattern, check_pattern)
      );
      CREATE INDEX IF NOT EXISTS idx_patterns_hier_check ON violation_patterns(hier_pattern, check_pattern);
    `);

    // 读取源 DB 的所有 Pattern
    const patterns = sourceDb.prepare(`
      SELECT hier_pattern, check_pattern,
             default_confirmer, default_result, default_reason,
             match_count, last_used
      FROM violation_patterns
    `).all() as Record<string, unknown>[];

    // 写入目标 DB
    const insertStmt = targetDb.prepare(`
      INSERT OR REPLACE INTO violation_patterns
        (hier_pattern, check_pattern, default_confirmer, default_result, default_reason, match_count, last_used)
      VALUES (@hier_pattern, @check_pattern, @default_confirmer, @default_result, @default_reason, @match_count, @last_used)
    `);

    const tx = targetDb.transaction(() => {
      for (const p of patterns) {
        insertStmt.run(p);
      }
    });
    tx();

    return { success: true, count: patterns.length };
  } finally {
    targetDb.close();
  }
}

// ─── Pattern 导入（合并模式） ───────────────────────────────

/**
 * 从外部 DB 文件导入 Pattern，合并到当前 DB。
 * 相同 Pattern（hier_pattern + check_pattern）累加 match_count。
 *
 * @returns { importedCount, updatedCount }
 */
export function importPatternsFromDatabase(
  targetDb: Database.Database,
  sourceFilePath: string,
): { importedCount: number; updatedCount: number } {
  if (!existsSync(sourceFilePath)) {
    throw new Error(`Source database file not found: ${sourceFilePath}`);
  }

  const sourceDb = new Database(sourceFilePath, { readonly: true });
  try {
    // 读取源 DB 的所有 Pattern
    const sourcePatterns = sourceDb.prepare(`
      SELECT hier_pattern, check_pattern,
             default_confirmer, default_result, default_reason,
             match_count, last_used
      FROM violation_patterns
    `).all() as Record<string, unknown>[];

    let importedCount = 0;
    let updatedCount = 0;

    const tx = targetDb.transaction(() => {
      const existingStmt = targetDb.prepare(`
        SELECT id, match_count FROM violation_patterns
        WHERE hier_pattern = ? AND check_pattern = ?
      `);

      const insertStmt = targetDb.prepare(`
        INSERT INTO violation_patterns
          (hier_pattern, check_pattern, default_confirmer, default_result, default_reason, match_count, last_used)
        VALUES (@hier_pattern, @check_pattern, @default_confirmer, @default_result, @default_reason, @match_count, @last_used)
      `);

      const updateStmt = targetDb.prepare(`
        UPDATE violation_patterns
        SET match_count = match_count + @match_count,
            last_used = @last_used
        WHERE id = @id
      `);

      for (const p of sourcePatterns) {
        const existing = existingStmt.get(
          p['hier_pattern'],
          p['check_pattern'],
        ) as { id: number; match_count: number } | undefined;

        if (existing) {
          // 累加 match_count，更新 last_used
          updateStmt.run({
            id: existing.id,
            match_count: p['match_count'] as number,
            last_used: p['last_used'] as string,
          });
          updatedCount++;
        } else {
          // 新 Pattern
          insertStmt.run(p);
          importedCount++;
        }
      }
    });
    tx();

    return { importedCount, updatedCount };
  } finally {
    sourceDb.close();
  }
}

// ─── 完整数据库合并 ─────────────────────────────────────────

/**
 * 合并多个完整数据库到目标数据库。
 * 合并 violations + confirmations + patterns。
 * 合并前自动备份目标数据库。
 *
 * @param targetDb 目标数据库
 * @param sourceFilePaths 源数据库文件路径列表
 * @param backupPath 备份路径（可选，不传则不备份）
 * @returns { mergedViolations, mergedPatterns, backupPath }
 */
export function mergeDatabases(
  targetDb: Database.Database,
  sourceFilePaths: string[],
  backupPath?: string,
): {
  mergedViolations: number;
  mergedPatterns: number;
  backupPath: string | null;
} {
  // 自动备份
  let actualBackupPath: string | null = null;
  if (backupPath) {
    const dir = dirname(backupPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    // 获取目标 DB 文件路径
    const targetPath = targetDb.name;
    if (targetPath && targetPath !== ':memory:' && existsSync(targetPath)) {
      copyFileSync(targetPath, backupPath);
      actualBackupPath = backupPath;
    }
  }

  let mergedViolations = 0;
  let mergedPatterns = 0;


  for (const sourcePath of sourceFilePaths) {
    if (!existsSync(sourcePath)) continue;
    const sourceDb = new Database(sourcePath, { readonly: true });
    try {
      // 合并 violations + confirmations
      const violations = sourceDb.prepare(`
        SELECT case_name, corner, seed, subsys, num, hier, time_fs, time_display, check_info, file_path
        FROM timing_violations
      `).all() as Record<string, unknown>[];

      const insertViolation = targetDb.prepare(`
        INSERT OR IGNORE INTO timing_violations
          (case_name, corner, seed, subsys, num, hier, time_fs, time_display, check_info, file_path)
        VALUES (@case_name, @corner, @seed, @subsys, @num, @hier, @time_fs, @time_display, @check_info, @file_path)
      `);

      const getIdStmt = targetDb.prepare(`
        SELECT id FROM timing_violations
        WHERE case_name = @case_name AND corner = @corner AND seed = @seed
          AND hier = @hier AND check_info = @check_info AND time_fs = @time_fs
      `);

      const _insertConfirmation = targetDb.prepare(`
        INSERT OR IGNORE INTO confirmation_records (violation_id, status)
        SELECT id, 'pending' FROM timing_violations
        WHERE id = @violationId
          AND id NOT IN (SELECT violation_id FROM confirmation_records WHERE violation_id = @violationId)
      `);

      // 获取源 DB 中已确认的记录（status != 'pending'），用于合并到目标
      const getSourceConfirmations = sourceDb.prepare(`
        SELECT cr.violation_id, cr.status, cr.confirmer, cr.result, cr.reason,
               cr.is_auto_confirmed, cr.confirmed_at,
               v.case_name, v.corner, v.seed, v.hier, v.check_info, v.time_fs
        FROM confirmation_records cr
        INNER JOIN timing_violations v ON cr.violation_id = v.id
        WHERE cr.status != 'pending'
      `).all() as Record<string, unknown>[];

      const updateConfirmation = targetDb.prepare(`
        UPDATE confirmation_records
        SET status = @status, confirmer = @confirmer, result = @result,
            reason = @reason, is_auto_confirmed = @is_auto_confirmed,
            confirmed_at = @confirmed_at,
            updated_at = datetime('now', 'localtime')
        WHERE violation_id = @targetViolationId AND status = 'pending'
      `);

      const tx = targetDb.transaction(() => {
        // 插入 violations
        for (const v of violations) {
          const result = insertViolation.run(v);
          if (result.changes > 0) {
            mergedViolations++;
          }
        }

        // 确保所有 violation 都有 confirmation record
        targetDb.prepare(`
          INSERT INTO confirmation_records (violation_id, status)
          SELECT id, 'pending' FROM timing_violations
          WHERE id NOT IN (SELECT violation_id FROM confirmation_records)
        `).run();

        // 合并确认记录：通过源 violation 的唯一键定位目标 violation
        for (const sc of getSourceConfirmations) {
          const targetViolation = getIdStmt.get({
            case_name: sc['case_name'],
            corner: sc['corner'],
            seed: sc['seed'],
            hier: sc['hier'],
            check_info: sc['check_info'],
            time_fs: sc['time_fs'],
          }) as { id: number } | undefined;

          if (!targetViolation) continue;

          // 只在目标确认状态为 pending 时才覆盖（避免覆盖已有的确认）
          updateConfirmation.run({
            targetViolationId: targetViolation.id,
            status: sc['status'],
            confirmer: sc['confirmer'],
            result: sc['result'],
            reason: sc['reason'],
            is_auto_confirmed: sc['is_auto_confirmed'] as number,
            confirmed_at: sc['confirmed_at'],
          });
        }
      });
      tx();

      // 合并 patterns
      const sourcePatterns = sourceDb.prepare(`
        SELECT hier_pattern, check_pattern,
               default_confirmer, default_result, default_reason,
               match_count, last_used
        FROM violation_patterns
      `).all() as Record<string, unknown>[];

      const existingPattern = targetDb.prepare(`
        SELECT id, match_count FROM violation_patterns
        WHERE hier_pattern = ? AND check_pattern = ?
      `);

      const insertPattern = targetDb.prepare(`
        INSERT INTO violation_patterns
          (hier_pattern, check_pattern, default_confirmer, default_result, default_reason, match_count, last_used)
        VALUES (@hier_pattern, @check_pattern, @default_confirmer, @default_result, @default_reason, @match_count, @last_used)
      `);

      const updatePattern = targetDb.prepare(`
        UPDATE violation_patterns
        SET match_count = match_count + @match_count, last_used = @last_used
        WHERE id = @id
      `);

      const patternTx = targetDb.transaction(() => {
        for (const p of sourcePatterns) {
          const existing = existingPattern.get(p['hier_pattern'], p['check_pattern']) as { id: number; match_count: number } | undefined;
          if (existing) {
            updatePattern.run({
              id: existing.id,
              match_count: p['match_count'] as number,
              last_used: p['last_used'] as string,
            });
          } else {
            insertPattern.run(p);
            mergedPatterns++;
          }
        }
      });
      patternTx();
    } finally {
      sourceDb.close();
    }
  }

  return {
    mergedViolations,
    mergedPatterns,
    backupPath: actualBackupPath,
  };
}

/**
 * 创建一个仅含 Schema 的空数据库（用于测试或初始化）。
 */
export function createEmptyDatabase(dbPath: string): Database.Database {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  db.exec(PRAGMA_SQL);
  db.exec(SCHEMA_SQL);
  return db;
}
