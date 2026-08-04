/**
 * Scan Router — tRPC API
 *
 * 参考 docs/timing-violation-handoff.md §4.4
 *
 * Procedures:
 *   - scanRegression:  扫描回归目录
 *   - batchProcess:    批量处理选中的文件
 *   - pickDirectory:   弹出目录选择对话框
 */

import { dialog } from 'electron';
import { t, TRPCError } from '../router-context';
import {
  scanRegressionDirectory,
  batchProcessFiles,
} from '../../timing-violation/scanner/violation-scanner';

// ─── Router ───────────────────────────────────────────────────

export const scanRouter = t.router({
  /**
   * 扫描回归目录，发现所有 vio_summary.log 文件。
   */
  scanRegression: t.procedure
    .input((raw): { projectId: string; regressionRoot: string; useStandardStructure: boolean } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      if (typeof r.regressionRoot !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'regressionRoot is required' });
      }
      return {
        projectId: r.projectId,
        regressionRoot: r.regressionRoot,
        useStandardStructure: typeof r.useStandardStructure === 'boolean' ? r.useStandardStructure : true,
      };
    })
    .mutation(async ({ input }) => {
      return scanRegressionDirectory(
        input.regressionRoot,
        input.useStandardStructure,
        input.projectId,
      );
    }),

  /**
   * 批量处理选中的文件，逐个解析导入数据库。
   */
  batchProcess: t.procedure
    .input((raw): { projectId: string; filePaths: string[] } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      if (!Array.isArray(r.filePaths) || r.filePaths.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'filePaths must be a non-empty array' });
      }
      return {
        projectId: r.projectId,
        filePaths: r.filePaths as string[],
      };
    })
    .mutation(async ({ input }) => {
      return batchProcessFiles(input.filePaths, input.projectId);
    }),

  /**
   * 弹出目录选择对话框。
   */
  pickDirectory: t.procedure
    .input((raw): { defaultPath?: string } => {
      const r = raw as Record<string, unknown>;
      return { defaultPath: typeof r.defaultPath === 'string' ? r.defaultPath : undefined };
    })
    .mutation(async ({ input }) => {
      const result = await dialog.showOpenDialog({
        title: '选择回归目录',
        defaultPath: input.defaultPath,
        properties: ['openDirectory'],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true as const, path: null };
      }
      return { canceled: false as const, path: result.filePaths[0] };
    }),
});
