/**
 * Violation Router — tRPC API
 *
 * 参考 docs/timing-violation-handoff.md §4.4
 *
 * Procedures:
 *   - parseLog:         解析单个日志文件
 *   - queryViolations:  分页查询违例列表
 *   - getStatistics:    获取统计信息
 *   - getMetadata:      获取元数据
 *   - getDatabaseStats: 获取数据库整体统计
 *   - clearCaseData:    清除用例数据
 *   - pickFile:         弹出文件选择对话框
 */

import { dialog } from 'electron';
import { t, TRPCError } from '../router-context';
import { getTvDb } from '../../timing-violation/db/tv-db-cache';
import { loadTvConfig } from '../../timing-violation/tv-config';
import {
  insertViolations,
  ensureConfirmationRecords,
  queryViolations,
  getStatistics,
  getMetadata,
  getDatabaseStats,
  clearCaseData,
  clearAllData,
} from '../../timing-violation/db/tv-repository';
import type {
  QueryViolationsInput,
  ConfirmationStatus,
  ParseLogInput,
} from '../../timing-violation/types';

// ─── 排序字段白名单 ───────────────────────────────────────────

const VALID_SORT_FIELDS = ['time_fs', 'num', 'hier', 'created_at'] as const;
const VALID_STATUSES = ['pending', 'confirmed', 'ignored'] as const;

// ─── Router ───────────────────────────────────────────────────

export const violationRouter = t.router({
  /**
   * 弹出文件选择对话框，选择 vio_summary.log。
   */
  pickFile: t.procedure
    .input((raw): { defaultPath?: string } => {
      const r = raw as Record<string, unknown>;
      return { defaultPath: typeof r.defaultPath === 'string' ? r.defaultPath : undefined };
    })
    .mutation(async ({ input }) => {
      const result = await dialog.showOpenDialog({
        title: '选择 vio_summary.log 文件',
        defaultPath: input.defaultPath,
        properties: ['openFile'],
        filters: [{ name: 'Timing Violation Log', extensions: ['log'] }, { name: '所有文件', extensions: ['*'] }],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true as const, filePath: null };
      }
      return { canceled: false as const, filePath: result.filePaths[0] };
    }),

  /**
   * 解析单个日志文件。
   * 在主进程中流式解析（readline 非阻塞），批量插入数据库。
   */
  parseLog: t.procedure
    .input((raw): { projectId: string } & ParseLogInput => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      if (typeof r.filePath !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'filePath is required' });
      }
      return {
        projectId: r.projectId,
        filePath: r.filePath,
        caseName: typeof r.caseName === 'string' ? r.caseName : undefined,
        corner: typeof r.corner === 'string' ? r.corner : undefined,
      };
    })
    .mutation(async ({ input }) => {
      const db = getTvDb(input.projectId);
      const config = loadTvConfig(input.projectId);

      const { parseLogFile } = await import('../../timing-violation/parser/vio-parser');
      const result = await parseLogFile(input.filePath, {
        caseName: input.caseName,
        corner: input.corner,
        corners: config.corners,
        subsysPatterns: config.subsysPatterns,
      });

      const { inserted, skipped } = insertViolations(db, result.violations);
      ensureConfirmationRecords(db);

      return {
        success: true,
        total: result.violations.length,
        inserted,
        skipped,
        errors: result.errors,
      };
    }),

  /**
   * 分页查询违例列表。
   */
  queryViolations: t.procedure
    .input((raw): { projectId: string } & QueryViolationsInput => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      const page = typeof r.page === 'number' && r.page > 0 ? r.page : 1;
      const pageSize = typeof r.pageSize === 'number' && r.pageSize > 0 ? Math.min(r.pageSize, 10000) : 50;

      const sortField = VALID_SORT_FIELDS.includes(r.sortField as typeof VALID_SORT_FIELDS[number])
        ? (r.sortField as typeof VALID_SORT_FIELDS[number])
        : undefined;
      const sortOrder = r.sortOrder === 'desc' ? 'desc' : 'asc';
      const status = VALID_STATUSES.includes(r.status as typeof VALID_STATUSES[number])
        ? (r.status as ConfirmationStatus)
        : undefined;

      return {
        projectId: r.projectId,
        page,
        pageSize,
        caseName: typeof r.caseName === 'string' ? r.caseName : undefined,
        corner: typeof r.corner === 'string' ? r.corner : undefined,
        status,
        subsys: typeof r.subsys === 'string' ? r.subsys : undefined,
        searchText: typeof r.searchText === 'string' ? r.searchText : undefined,
        sortField,
        sortOrder,
      };
    })
    .query(async ({ input }) => {
      const { projectId, ...queryInput } = input;
      const db = getTvDb(projectId);
      return queryViolations(db, queryInput);
    }),

  /**
   * 获取统计信息。
   */
  getStatistics: t.procedure
    .input((raw): { projectId: string; caseName?: string; corner?: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return {
        projectId: r.projectId,
        caseName: typeof r.caseName === 'string' ? r.caseName : undefined,
        corner: typeof r.corner === 'string' ? r.corner : undefined,
      };
    })
    .query(async ({ input }) => {
      const db = getTvDb(input.projectId);
      return getStatistics(db, { caseName: input.caseName, corner: input.corner });
    }),

  /**
   * 获取元数据（corners / cases / subsys 列表）。
   */
  getMetadata: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .query(async ({ input }) => {
      const db = getTvDb(input.projectId);
      return getMetadata(db);
    }),

  /**
   * 获取数据库整体统计。
   */
  getDatabaseStats: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .query(async ({ input }) => {
      const db = getTvDb(input.projectId);
      return getDatabaseStats(db);
    }),

  /**
   * 清除指定用例数据。
   */
  clearCaseData: t.procedure
    .input((raw): { projectId: string; caseName: string; corner?: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      if (typeof r.caseName !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'caseName is required' });
      }
      return {
        projectId: r.projectId,
        caseName: r.caseName,
        corner: typeof r.corner === 'string' ? r.corner : undefined,
      };
    })
    .mutation(async ({ input }) => {
      const db = getTvDb(input.projectId);
      return clearCaseData(db, input.caseName, input.corner);
    }),

  /**
   * 清空所有违例数据（含确认记录，Pattern 保留）。
   */
  clearAllData: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .mutation(async ({ input }) => {
      const db = getTvDb(input.projectId);
      return clearAllData(db);
    }),
});
