/**
 * TV Confirmations Store — 确认流程 / AI 建议。
 *
 * 从原 timing-violation.ts 中提取的 confirmation 领域。
 * 确认操作完成后通过延迟 import 调用 tv-data 的 refreshAll 刷新违例列表。
 */

import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { getToast } from '@renderer/lib/trpc-utils';
import type {
  ConfirmationStatus,
  ConfirmResult,
  AISuggestion,
  ViolationWithConfirmation,
} from './tv-types';

// ── 跨 store 引用（延迟 import 避免循环） ──────────────────────
// 确认完成后需要刷新 tv-data 的违例列表
import { useTvDataStore } from './tv-data';

type TvConfirmationsState = {
  // ── 确认状态 ──────────────────────────────────────────
  confirming: boolean;
  showConfirmDialog: boolean;
  confirmDialogViolation: ViolationWithConfirmation | null;

  // ── AI 建议状态 ────────────────────────────────────────
  aiSuggesting: boolean;
  aiSuggestion: AISuggestion | null;
  aiSuggestionViolationId: number | null;

  // ── 确认 Actions ───────────────────────────────────────
  autoConfirmByResetTime: (projectId: string, caseName: string | undefined, resetTimeNs: number) => Promise<void>;
  autoConfirmByInterval: (projectId: string, caseName: string | undefined, opts: { resetTimeNs?: number; intervalStartNs?: number; intervalEndNs?: number }) => Promise<void>;
  updateConfirmation: (projectId: string, violationId: number, status: ConfirmationStatus, confirmer: string, result: ConfirmResult, reason: string) => Promise<void>;
  batchUpdateConfirmations: (projectId: string, violationIds: number[], status: ConfirmationStatus, confirmer: string, result: ConfirmResult, reason: string) => Promise<void>;

  toggleViolationSelection: (id: number) => void;
  selectAllVisibleViolations: () => void;
  clearSelection: () => void;
  openConfirmDialog: (violation: ViolationWithConfirmation | null) => void;
  closeConfirmDialog: () => void;

  // ── AI 建议相关 Actions ────────────────────────────────
  suggestConfirmation: (projectId: string, violationId: number) => Promise<void>;
  startAISuggestion: (projectId: string, violationId: number) => Promise<{ sessionId: string; promptMessage: string } | null>;
  parseAISuggestionResponse: (responseText: string) => Promise<AISuggestion | null>;
  clearAISuggestion: () => void;
  applyAISuggestion: (projectId: string, violationId: number, suggestion: AISuggestion) => Promise<void>;

  // ── Pattern 相关 Actions（历史确认应用） ──────────────
  applyHistoricalConfirmations: (projectId: string, caseName?: string, corner?: string) => Promise<void>;
};

export const useTvConfirmationsStore = create<TvConfirmationsState>((set, get) => ({
  confirming: false,
  showConfirmDialog: false,
  confirmDialogViolation: null,

  aiSuggesting: false,
  aiSuggestion: null,
  aiSuggestionViolationId: null,

  autoConfirmByResetTime: async (projectId, caseName, resetTimeNs) => {
    set({ confirming: true });
    try {
      const result = await trpc.confirmation.autoConfirmByResetTime.mutate({
        projectId, caseName, resetTimeNs,
      });
      getToast().success(`自动确认完成：${result.confirmedCount} 条违例已确认`);
      await useTvDataStore.getState().refreshAll(projectId);
    } catch (err) {
      getToast().error('自动确认失败', err instanceof Error ? err.message : String(err));
    } finally {
      set({ confirming: false });
    }
  },

  autoConfirmByInterval: async (projectId, caseName, opts) => {
    set({ confirming: true });
    try {
      const result = await trpc.confirmation.autoConfirmByInterval.mutate({
        projectId, caseName,
        resetTimeNs: opts.resetTimeNs,
        intervalStartNs: opts.intervalStartNs,
        intervalEndNs: opts.intervalEndNs,
      });
      getToast().success(`自动确认完成：${result.confirmedCount} 条违例已确认`);
      await useTvDataStore.getState().refreshAll(projectId);
    } catch (err) {
      getToast().error('自动确认失败', err instanceof Error ? err.message : String(err));
    } finally {
      set({ confirming: false });
    }
  },

  updateConfirmation: async (projectId, violationId, status, confirmer, result, reason) => {
    set({ confirming: true });
    try {
      await trpc.confirmation.updateConfirmation.mutate({
        projectId, violationId, status, confirmer, result, reason,
      });
      getToast().success('确认成功');
      set({ showConfirmDialog: false, confirmDialogViolation: null });
      await useTvDataStore.getState().refreshAll(projectId);
    } catch (err) {
      getToast().error('确认失败', err instanceof Error ? err.message : String(err));
    } finally {
      set({ confirming: false });
    }
  },

  batchUpdateConfirmations: async (projectId, violationIds, status, confirmer, result, reason) => {
    set({ confirming: true });
    try {
      const res = await trpc.confirmation.batchUpdateConfirmations.mutate({
        projectId, violationIds, status, confirmer, result, reason,
      });
      getToast().success(`批量确认完成：${res.updatedCount} 条已更新`);
      set({ showConfirmDialog: false, confirmDialogViolation: null });
      useTvDataStore.getState().clearSelection();
      await useTvDataStore.getState().refreshAll(projectId);
    } catch (err) {
      getToast().error('批量确认失败', err instanceof Error ? err.message : String(err));
    } finally {
      set({ confirming: false });
    }
  },

  toggleViolationSelection: (id) => {
    useTvDataStore.getState().toggleViolationSelection(id);
  },

  selectAllVisibleViolations: () => {
    useTvDataStore.getState().selectAllVisibleViolations();
  },

  clearSelection: () => {
    useTvDataStore.getState().clearSelection();
  },

  openConfirmDialog: (violation) => set({ showConfirmDialog: true, confirmDialogViolation: violation }),
  closeConfirmDialog: () => set({ showConfirmDialog: false, confirmDialogViolation: null }),

  suggestConfirmation: async (projectId, violationId) => {
    set({ aiSuggesting: true, aiSuggestion: null, aiSuggestionViolationId: violationId });
    try {
      const suggestion = await trpc.confirmation.suggestConfirmation.query({
        projectId,
        violationId,
      });
      set({ aiSuggestion: suggestion as AISuggestion, aiSuggesting: false });
    } catch (err) {
      set({ aiSuggesting: false, aiSuggestion: null, aiSuggestionViolationId: null });
      getToast().error('AI 建议获取失败', err instanceof Error ? err.message : String(err));
    }
  },

  startAISuggestion: async (projectId, violationId) => {
    set({ aiSuggesting: true, aiSuggestion: null, aiSuggestionViolationId: violationId });
    try {
      const result = await trpc.confirmation.startAISuggestion.mutate({
        projectId,
        violationId,
      });
      return result;
    } catch (err) {
      set({ aiSuggesting: false, aiSuggestion: null, aiSuggestionViolationId: null });
      getToast().error('AI 分析启动失败', err instanceof Error ? err.message : String(err));
      return null;
    }
  },

  parseAISuggestionResponse: async (responseText) => {
    try {
      const suggestion = await trpc.confirmation.parseAISuggestion.query({
        responseText,
      });
      set({ aiSuggestion: suggestion as AISuggestion, aiSuggesting: false });
      return suggestion as AISuggestion;
    } catch (err) {
      set({ aiSuggesting: false });
      getToast().error('AI 建议解析失败', err instanceof Error ? err.message : String(err));
      return null;
    }
  },

  clearAISuggestion: () => set({ aiSuggestion: null, aiSuggestionViolationId: null }),

  applyAISuggestion: async (projectId, violationId, suggestion) => {
    if (!suggestion.confirmer || !suggestion.result) {
      getToast().error('AI 建议信息不完整，无法应用');
      return;
    }
    await get().updateConfirmation(
      projectId,
      violationId,
      'confirmed',
      suggestion.confirmer,
      suggestion.result as ConfirmResult,
      suggestion.reason ?? '',
    );
    set({ aiSuggestion: null, aiSuggestionViolationId: null });
  },

  applyHistoricalConfirmations: async (projectId, caseName, corner) => {
    set({ confirming: true });
    try {
      const result = await trpc.confirmation.applyHistoricalConfirmations.mutate({
        projectId, caseName, corner,
      });
      const msg = caseName
        ? `应用历史确认完成：${result.appliedCount} 条违例已确认`
        : `全局应用历史确认完成：${result.appliedCount} 条违例已确认`;
      getToast().success(msg);
      await useTvDataStore.getState().refreshAll(projectId);
    } catch (err) {
      getToast().error('应用历史确认失败', err instanceof Error ? err.message : String(err));
    } finally {
      set({ confirming: false });
    }
  },
}));
