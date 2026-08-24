/**
 * TV Scan Store — 回归扫描 / 批量处理。
 *
 * 从原 timing-violation.ts 中提取的 scan 领域。
 * 对齐主进程 scan-router。
 * batchProcess 完成后通过延迟 import 调用 tv-data 的 refreshAll 刷新违例列表。
 */

import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { getToast } from '@renderer/lib/trpc-utils';
import type { ScanResult, BatchProcessResult } from './tv-types';

// ── 跨 store 引用（延迟 import 避免循环） ──────────────────────
// batchProcess 完成后需要刷新 tv-data 的违例列表
import { useTvDataStore } from './tv-data';

type TvScanState = {
  // ── 扫描状态 ────────────────────────────────────────────
  scanning: boolean;
  scanResult: ScanResult | null;
  batchProcessing: boolean;
  batchProgress: BatchProcessResult | null;
  showScanDialog: boolean;

  // ── 扫描 Actions ───────────────────────────────────────
  scanRegression: (projectId: string, regressionRoot: string, useStandardStructure: boolean) => Promise<void>;
  batchProcess: (projectId: string, filePaths: string[]) => Promise<void>;
  pickRegressionDir: () => Promise<string | null>;
  setShowScanDialog: (show: boolean) => void;
};

export const useTvScanStore = create<TvScanState>((set) => ({
  scanning: false,
  scanResult: null,
  batchProcessing: false,
  batchProgress: null,
  showScanDialog: false,

  scanRegression: async (projectId, regressionRoot, useStandardStructure) => {
    set({ scanning: true, scanResult: null });
    try {
      const result = await trpc.scan.scanRegression.mutate({
        projectId, regressionRoot, useStandardStructure,
      });
      set({ scanResult: result as ScanResult, scanning: false });
      getToast().success(`扫描完成：发现 ${result.totalFiles} 个文件`);
    } catch (err) {
      set({ scanning: false });
      getToast().error('扫描回归目录失败', err instanceof Error ? err.message : String(err));
    }
  },

  batchProcess: async (projectId, filePaths) => {
    set({ batchProcessing: true, batchProgress: null });
    try {
      const result = await trpc.scan.batchProcess.mutate({
        projectId, filePaths,
      });
      getToast().success(`批量处理完成：${result.totalInserted} 条新增`);
      set({ batchProcessing: false, batchProgress: null });
      await useTvDataStore.getState().refreshAll(projectId);
    } catch (err) {
      set({ batchProcessing: false, batchProgress: null });
      getToast().error('批量处理失败', err instanceof Error ? err.message : String(err));
    }
  },

  pickRegressionDir: async () => {
    try {
      const result = await trpc.scan.pickDirectory.mutate({});
      if (result.canceled || !result.path) return null;
      return result.path;
    } catch {
      return null;
    }
  },

  setShowScanDialog: (show) => set({ showScanDialog: show }),
}));
