/**
 * Pattern Router — tRPC API
 *
 * 参考 docs/timing-violation-handoff.md §4.4
 *
 * Procedures:
 *   - getPatterns:        获取所有 Pattern 列表
 *   - getPatternSuggestion: 获取 Pattern 建议（精确/模糊匹配）
 *   - savePattern:        手动保存 Pattern
 *   - clearAllPatterns:   清除所有 Pattern
 *   - exportPatterns:     导出 Pattern 为 Excel/CSV/DB
 *   - importPatterns:     从 DB 文件导入 Pattern（合并模式）
 *   - mergeDatabases:     合并多个完整数据库
 */

import { dialog } from 'electron';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { t, TRPCError } from '../router-context';
import { getTvDb } from '../../timing-violation/db/tv-db-cache';
import { loadTvConfig, ensureExportDir } from '../../timing-violation/tv-config';
import { requireProject } from '../../services/project-service';
import { getPatterns, clearAllPatterns } from '../../timing-violation/db/tv-repository';
import { savePattern } from '../../timing-violation/confirm/confirmation-manager';
import { getPatternSuggestion } from '../../timing-violation/confirm/pattern-matcher';
import { exportPatternsToExcel, exportPatternsToCsv } from '../../timing-violation/export/tv-exporter';
import { exportPatternsToDatabase, importPatternsFromDatabase, mergeDatabases } from '../../timing-violation/export/tv-db-transfer';

// ─── Router ───────────────────────────────────────────────────

export const patternRouter = t.router({
  /**
   * 获取所有 Pattern 列表。
   */
  getPatterns: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .query(async ({ input }) => {
      const db = getTvDb(input.projectId);
      return getPatterns(db);
    }),

  /**
   * 获取 Pattern 建议（精确/模糊匹配）。
   */
  getPatternSuggestion: t.procedure
    .input((raw): { projectId: string; hier: string; check: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      if (typeof r.hier !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'hier is required' });
      }
      if (typeof r.check !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'check is required' });
      }
      return { projectId: r.projectId, hier: r.hier, check: r.check };
    })
    .query(async ({ input }) => {
      const db = getTvDb(input.projectId);
      return getPatternSuggestion(db, input.hier, input.check);
    }),

  /**
   * 手动保存 Pattern。
   */
  savePattern: t.procedure
    .input((raw): {
      projectId: string;
      hier: string;
      check: string;
      confirmer: string;
      result: string;
      reason: string;
    } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      if (typeof r.hier !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'hier is required' });
      }
      if (typeof r.check !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'check is required' });
      }
      return {
        projectId: r.projectId,
        hier: r.hier,
        check: r.check,
        confirmer: typeof r.confirmer === 'string' ? r.confirmer : '',
        result: typeof r.result === 'string' ? r.result : 'pass',
        reason: typeof r.reason === 'string' ? r.reason : '',
      };
    })
    .mutation(async ({ input }) => {
      const db = getTvDb(input.projectId);
      savePattern(db, input.hier, input.check, input.confirmer, input.result, input.reason);
      return { success: true };
    }),

  /**
   * 清除所有 Pattern。
   */
  clearAllPatterns: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .mutation(async ({ input }) => {
      const db = getTvDb(input.projectId);
      return clearAllPatterns(db);
    }),

  /**
   * 导出 Pattern 为 Excel/CSV/DB 文件。
   */
  exportPatterns: t.procedure
    .input((raw): {
      projectId: string;
      format: 'excel' | 'csv' | 'db';
      filePath?: string;
    } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      const format = r.format === 'csv' ? 'csv' : r.format === 'db' ? 'db' : 'excel';
      return {
        projectId: r.projectId,
        format,
        filePath: typeof r.filePath === 'string' ? r.filePath : undefined,
      };
    })
    .mutation(async ({ input }) => {
      const db = getTvDb(input.projectId);

      // 如果没有指定路径，弹出保存对话框
      let filePath = input.filePath;
      if (!filePath) {
        const ext = input.format === 'excel' ? 'xlsx' : input.format === 'csv' ? 'csv' : 'db';
        const project = requireProject(input.projectId);
        const config = loadTvConfig(project.rootPath);
        const exportBase = ensureExportDir(project.rootPath, config.dataDir);
        const patternsDir = join(exportBase, 'patterns');
        mkdirSync(patternsDir, { recursive: true });
        const defaultPath = join(patternsDir, `violation_patterns.${ext}`);
        const result = await dialog.showSaveDialog({
          title: '导出 Pattern',
          defaultPath,
          filters: [
            { name: input.format === 'excel' ? 'Excel' : input.format === 'csv' ? 'CSV' : 'Database', extensions: [ext] },
            { name: '所有文件', extensions: ['*'] },
          ],
        });
        if (result.canceled || !result.filePath) {
          return { success: false as const, count: 0, canceled: true as const };
        }
        filePath = result.filePath;
      }

      if (input.format === 'excel') {
        const result = await exportPatternsToExcel(db, filePath);
        return { success: true as const, count: result.count, filePath, canceled: false as const };
      } else if (input.format === 'csv') {
        const result = exportPatternsToCsv(db, filePath);
        return { success: true as const, count: result.count, filePath, canceled: false as const };
      } else {
        const result = exportPatternsToDatabase(db, filePath);
        return { success: true as const, count: result.count, filePath, canceled: false as const };
      }
    }),

  /**
   * 从 DB 文件导入 Pattern（合并模式，相同 Pattern 累加 match_count）。
   */
  importPatterns: t.procedure
    .input((raw): {
      projectId: string;
      filePath?: string;
    } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return {
        projectId: r.projectId,
        filePath: typeof r.filePath === 'string' ? r.filePath : undefined,
      };
    })
    .mutation(async ({ input }) => {
      const db = getTvDb(input.projectId);

      // 如果没有指定路径，弹出文件选择对话框
      let filePath = input.filePath;
      if (!filePath) {
        const result = await dialog.showOpenDialog({
          title: '选择 Pattern 数据库文件',
          properties: ['openFile'],
          filters: [
            { name: 'Database', extensions: ['db'] },
            { name: '所有文件', extensions: ['*'] },
          ],
        });
        if (result.canceled || result.filePaths.length === 0) {
          return { importedCount: 0, updatedCount: 0, canceled: true as const };
        }
        filePath = result.filePaths[0];
      }

      const result = importPatternsFromDatabase(db, filePath);
      return { ...result, canceled: false as const };
    }),

  /**
   * 合并多个完整数据库。
   * 合并前自动备份目标数据库。
   */
  mergeDatabases: t.procedure
    .input((raw): {
      projectId: string;
      sourceFilePaths: string[];
      backup?: boolean;
    } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      const sourceFilePaths = Array.isArray(r.sourceFilePaths)
        ? r.sourceFilePaths.filter((p) => typeof p === 'string')
        : [];
      return {
        projectId: r.projectId,
        sourceFilePaths,
        backup: r.backup !== false,
      };
    })
    .mutation(async ({ input }) => {
      const db = getTvDb(input.projectId);

      let backupPath: string | undefined;
      if (input.backup) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        backupPath = `${db.name}.backup-${ts}`;
      }

      const result = mergeDatabases(db, input.sourceFilePaths, backupPath);
      return result;
    }),
});
