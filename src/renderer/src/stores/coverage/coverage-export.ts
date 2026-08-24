/**
 * Coverage Export Store — 报告导出对话框 / 格式 / 范围 / 导出执行。
 *
 * 从原 coverage.ts 中提取的 export 领域。
 * currentSessionId 归 coverage-core，本 store 通过参数传入。
 */

import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from '../toast';
import type { ExportFormat, ExportScope } from './coverage-types';

// ─── 跨 store 引用 ──────────────────────────────────────────
// openExportDialog 需要从 core store 读取 currentSessionId 设默认值
import { useCoverageCoreStore } from './coverage-core';

type CoverageExportState = {
  // ─── 报告导出状态 ────────────────────────────────────────
  /** 导出对话框是否打开 */
  exportDialogOpen: boolean;
  /** 导出格式 */
  exportFormat: ExportFormat;
  /** 导出范围：当前 session / 两个 session 对比 */
  exportScope: ExportScope;
  /** 对比范围时的 After session（Before 固定为当前 session） */
  exportCompareSessionId: string | null;
  /** 导出文件保存路径 */
  exportOutputPath: string;
  /** 是否正在执行导出（异步，非阻塞 UI） */
  exporting: boolean;

  // ─── Actions ──────────────────────────────────────────────
  /** 打开导出对话框（重置为默认状态，Before 固定为当前 session） */
  openExportDialog: () => void;
  /** 关闭导出对话框 */
  closeExportDialog: () => void;
  /** 设置导出格式（HTML / JSON） */
  setExportFormat: (format: ExportFormat) => void;
  /** 设置导出范围（current / compare） */
  setExportScope: (scope: ExportScope) => void;
  /** 设置对比范围的 After session */
  setExportCompareSessionId: (sessionId: string | null) => void;
  /** 设置导出文件保存路径 */
  setExportOutputPath: (path: string) => void;
  /** 调用主进程原生保存对话框选择导出路径 */
  pickExportPath: () => Promise<void>;
  /** 执行导出（异步，非阻塞 UI，完成发 toast 通知） */
  runExport: (projectId: string) => Promise<boolean>;
};

export const useCoverageExportStore = create<CoverageExportState>((set, get) => ({
  exportDialogOpen: false,
  exportFormat: 'html',
  exportScope: 'current',
  exportCompareSessionId: null,
  exportOutputPath: '',
  exporting: false,

  openExportDialog: () => {
    // 打开时重置为默认值；Before 固定为当前 session（从 core store 读取），After 留空待选
    const current = useCoverageCoreStore.getState().currentSessionId;
    set({
      exportDialogOpen: true,
      exportFormat: 'html',
      exportScope: 'current',
      exportCompareSessionId: null,
      exportOutputPath: '',
      exporting: false,
    });
    // 默认文件名带当前 session 前缀（仅用于建议，不强制）
    if (current) {
      set({ exportOutputPath: '' });
    }
  },

  closeExportDialog: () => set({ exportDialogOpen: false, exporting: false }),

  setExportFormat: (format) => {
    set({ exportFormat: format });
    // 切换格式时清空旧路径扩展名不匹配的情况——保留路径但提示用户重新选择
    const cur = get().exportOutputPath;
    if (cur) {
      const ext = format === 'html' ? '.html' : '.json';
      const oldExt = format === 'html' ? '.json' : '.html';
      if (cur.endsWith(oldExt)) {
        set({ exportOutputPath: cur.slice(0, -oldExt.length) + ext });
      }
    }
  },

  setExportScope: (scope) => set({ exportScope: scope }),

  setExportCompareSessionId: (sessionId) => set({ exportCompareSessionId: sessionId }),

  setExportOutputPath: (path) => set({ exportOutputPath: path }),

  pickExportPath: async () => {
    const format = get().exportFormat;
    const current = useCoverageCoreStore.getState().currentSessionId;
    const defaultName = current ? `coverage-${current}.${format}` : `coverage-report.${format}`;
    try {
      const result = await trpc.coverage.pickExportPath.mutate({ format, defaultName });
      if (result.outputPath) {
        set({ exportOutputPath: result.outputPath });
      }
      // 用户取消时保持原路径不变
    } catch (err) {
      useToastStore.getState().error('选择导出路径失败', err instanceof Error ? err.message : String(err));
    }
  },

  runExport: async (projectId) => {
    const { exportFormat, exportScope, exportCompareSessionId, exportOutputPath } = get();
    const currentSessionId = useCoverageCoreStore.getState().currentSessionId;
    if (!exportOutputPath.trim()) {
      useToastStore.getState().warning('请先选择导出文件保存路径');
      return false;
    }
    if (exportScope === 'compare') {
      if (!currentSessionId || !exportCompareSessionId) {
        useToastStore.getState().warning('对比导出需要选择 Before 和 After 两个 session');
        return false;
      }
      if (currentSessionId === exportCompareSessionId) {
        useToastStore.getState().warning('对比导出的两个 session 不能相同');
        return false;
      }
    }
    set({ exporting: true });
    try {
      const result = await trpc.coverage.exportReport.mutate({
        projectId,
        scope: exportScope,
        sessionId: exportScope === 'compare' ? currentSessionId ?? undefined : currentSessionId ?? undefined,
        compareSessionId: exportScope === 'compare' ? exportCompareSessionId ?? undefined : undefined,
        format: exportFormat,
        outputPath: exportOutputPath,
      });
      set({ exporting: false, exportDialogOpen: false });
      const fmtLabel = exportFormat === 'html' ? 'HTML' : 'JSON';
      const scopeLabel = exportScope === 'compare' ? '对比' : '';
      useToastStore.getState().success(
        `${scopeLabel}覆盖率报告已导出（${fmtLabel}）`,
        result.outputPath,
      );
      return true;
    } catch (err) {
      set({ exporting: false });
      useToastStore.getState().error('导出覆盖率报告失败', err instanceof Error ? err.message : String(err));
      return false;
    }
  },
}));
