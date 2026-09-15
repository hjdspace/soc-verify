/**
 * Coverage Waive Store — .vRefine waive 文件自动生成（docs/coverage_auto_waive.md）。
 *
 * 领域：RTL 静态分析 → 结构性不可覆盖信号 → Cadence .vRefine 排除文件。
 * 与 detail 解析（coverage-core.parseDetailMetrics）衔接：waive 生成前置条件
 * 是 detail.txt 已解析（<sessionId>-detail.json 存在）。
 *
 * 生成进度走 coverage:waive-progress IPC 事件（与 detail-progress 同模式）。
 */

import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from '../toast';
import type { WaiveAnalysisData, WaiveHistoryEntry } from '@shared/types';
import type { ImportStepLogEntry } from './coverage-types';

type WaiveProgressEvent = {
  step: string;
  message: string;
  percent?: number;
  durationMs?: number;
  details?: Record<string, unknown>;
};

type CoverageWaiveState = {
  // ─── 生成状态 ──────────────────────────────────────────────
  /** 是否正在生成 waive 文件 */
  generating: boolean;
  /** 生成进度百分比 0-100 */
  progress: number;
  /** 当前步骤描述 */
  step: string;
  /** 步骤历史日志 */
  stepLog: ImportStepLogEntry[];
  /** 是否显示进度面板 */
  showProgress: boolean;
  /** coverage:waive-progress 监听器是否已注册 */
  progressListenerRegistered: boolean;

  // ─── 历史记录 ──────────────────────────────────────────────
  /** 生成历史（最新在前，持久化在主进程） */
  history: WaiveHistoryEntry[];
  /** 历史加载中 */
  historyLoading: boolean;
  /** 当前展开查看中间产物明细的 runId */
  expandedRunId: string | null;
  /** 展开的 run 对应的 waive-analysis.json 数据 */
  expandedAnalysis: WaiveAnalysisData | null;
  analysisLoading: boolean;

  // ─── Actions ──────────────────────────────────────────────
  generateWaive: (projectId: string, sessionId: string) => Promise<boolean>;
  loadHistory: (projectId: string) => Promise<void>;
  deleteHistoryEntry: (projectId: string, runId: string) => Promise<void>;
  toggleExpand: (projectId: string, runId: string) => Promise<void>;
  openWaiveDir: (projectId: string, runId?: string) => Promise<void>;
  registerProgressListener: () => void;
  handleProgress: (event: WaiveProgressEvent) => void;
  clearProgress: () => void;
};

export const useCoverageWaiveStore = create<CoverageWaiveState>((set, get) => ({
  generating: false,
  progress: 0,
  step: '',
  stepLog: [],
  showProgress: false,
  progressListenerRegistered: false,

  history: [],
  historyLoading: false,
  expandedRunId: null,
  expandedAnalysis: null,
  analysisLoading: false,

  // ─── 生成（detail 已解析后可重复触发，每次产生新 runId） ──

  generateWaive: async (projectId, sessionId) => {
    set({ generating: true, showProgress: true, stepLog: [], progress: 0 });
    try {
      const entry = await trpc.coverage.generateWaive.mutate({ projectId, sessionId });
      set({ generating: false });
      // 成功后刷新历史（新 runId 在最前）
      await get().loadHistory(projectId);
      const counts = entry.signalCounts;
      useToastStore.getState().success(
        'waive 文件生成完成',
        `${entry.ruleCount} 条 rule（assign ${counts.const_assign} / tie ${counts.input_tie} / floating ${counts.output_floating}）`,
      );
      return true;
    } catch (err) {
      set({ generating: false });
      useToastStore.getState().error('waive 文件生成失败', err instanceof Error ? err.message : String(err));
      return false;
    }
  },

  loadHistory: async (projectId) => {
    set({ historyLoading: true });
    try {
      const result = await trpc.coverage.listWaiveHistory.query({ projectId });
      set({ history: result.history, historyLoading: false });
    } catch (err) {
      set({ historyLoading: false });
      useToastStore.getState().error('加载 waive 历史失败', err instanceof Error ? err.message : String(err));
    }
  },

  deleteHistoryEntry: async (projectId, runId) => {
    try {
      await trpc.coverage.deleteWaiveHistory.mutate({ projectId, runId });
      set((s) => ({
        history: s.history.filter((e) => e.runId !== runId),
        expandedRunId: s.expandedRunId === runId ? null : s.expandedRunId,
        expandedAnalysis: s.expandedRunId === runId ? null : s.expandedAnalysis,
      }));
      useToastStore.getState().success('已删除 waive 记录', runId);
    } catch (err) {
      useToastStore.getState().error('删除 waive 记录失败', err instanceof Error ? err.message : String(err));
    }
  },

  toggleExpand: async (projectId, runId) => {
    const { expandedRunId } = get();
    if (expandedRunId === runId) {
      set({ expandedRunId: null, expandedAnalysis: null });
      return;
    }
    set({ expandedRunId: runId, expandedAnalysis: null, analysisLoading: true });
    try {
      const result = await trpc.coverage.getWaiveAnalysis.query({ projectId, runId });
      set({ expandedAnalysis: result.analysis, analysisLoading: false });
    } catch (err) {
      set({ analysisLoading: false });
      useToastStore.getState().error('加载 waive 明细失败', err instanceof Error ? err.message : String(err));
    }
  },

  openWaiveDir: async (projectId, runId) => {
    try {
      await trpc.coverage.openWaiveDir.mutate({ projectId, runId });
    } catch (err) {
      useToastStore.getState().error('打开目录失败', err instanceof Error ? err.message : String(err));
    }
  },

  registerProgressListener: () => {
    if (get().progressListenerRegistered) return;
    if (!window.eventBridge) return;
    set({ progressListenerRegistered: true });
    window.eventBridge.onCoverageWaiveProgress((event) => {
      get().handleProgress(event);
    });
  },

  handleProgress: (event) => {
    const logEntry: ImportStepLogEntry = {
      step: event.step,
      message: event.message,
      timestamp: Date.now(),
      durationMs: event.durationMs,
    };
    set((s) => ({
      progress: event.percent ?? s.progress,
      step: event.message,
      showProgress: true,
      stepLog: [...s.stepLog, logEntry],
    }));
    if (event.step === 'done') {
      setTimeout(() => {
        set({ showProgress: false });
      }, 3000);
    }
  },

  clearProgress: () => set({
    progress: 0,
    step: '',
    stepLog: [],
    showProgress: false,
  }),
}));
