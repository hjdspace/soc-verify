/**
 * Token Store — Token Monitor 状态管理。
 *
 * Issue #1: summary 查询（今日/本月/总 token + 今日 cost）+ 时间范围选择。
 * Issue #2: trends + engineBreakdown 查询 + 引擎/模型切换。
 * 后续 issue 逐个添加 sessions / externalLogs。
 */

import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from './toast';

// ─── 类型定义 ───────────────────────────────────────────────

export type TokenTimeRange = 'all' | '7d' | '30d';
export type TrendGroupBy = 'engine' | 'model';

/** token.summary 查询返回结构 */
export type TokenSummary = {
  todayTokens: number;
  monthTokens: number;
  totalTokens: number;
  todayCostUsd: number;
};

/** 趋势图单日数据 */
export type TrendGroupEntry = {
  group: string;
  totalTokens: number;
};

export type TrendDayData = {
  date: string;
  groups: TrendGroupEntry[];
};

/** 引擎分解数据 */
export type EngineBreakdownEntry = {
  engine: string;
  todayTokens: number;
  monthTokens: number;
  totalTokens: number;
  todayCost: number;
  monthCost: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
};

// ─── Store ─────────────────────────────────────────────────

interface TokenState {
  summary: TokenSummary | null;
  trends: TrendDayData[];
  engineBreakdown: EngineBreakdownEntry[];
  loading: boolean;
  error: string | null;
  timeRange: TokenTimeRange;
  trendGroupBy: TrendGroupBy;
  /** 已加载的项目 ID（避免重复加载） */
  loadedForProject: string | null;
  setTimeRange: (range: TokenTimeRange) => void;
  setTrendGroupBy: (groupBy: TrendGroupBy) => void;
  loadSummary: (projectId: string, force?: boolean) => Promise<void>;
  loadTrends: (projectId: string, force?: boolean) => Promise<void>;
  loadEngineBreakdown: (projectId: string, force?: boolean) => Promise<void>;
}

export const useTokenStore = create<TokenState>((set, get) => ({
  summary: null,
  trends: [],
  engineBreakdown: [],
  loading: false,
  error: null,
  timeRange: 'all',
  trendGroupBy: 'engine',
  loadedForProject: null,

  setTimeRange: (range) => {
    set({ timeRange: range });
    // 时间范围变更后重新加载所有数据
    const { loadedForProject, loadSummary, loadTrends, loadEngineBreakdown } = get();
    if (loadedForProject) {
      void loadSummary(loadedForProject, true);
      void loadTrends(loadedForProject, true);
      void loadEngineBreakdown(loadedForProject, true);
    }
  },

  setTrendGroupBy: (groupBy) => {
    set({ trendGroupBy: groupBy });
    const { loadedForProject, loadTrends } = get();
    if (loadedForProject) {
      void loadTrends(loadedForProject, true);
    }
  },

  loadSummary: async (projectId, force = false) => {
    const state = get();
    if (!force && state.loadedForProject === projectId && state.summary !== null) return;
    if (!projectId) return;

    set({ loading: true, error: null });
    try {
      const result = await trpc.token.summary.query({
        projectId,
        timeRange: get().timeRange,
      });
      set({
        summary: result,
        loading: false,
        loadedForProject: projectId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '加载 Token 数据失败';
      set({ loading: false, error: message });
      useToastStore.getState().error(`Token 概览加载失败: ${message}`);
    }
  },

  loadTrends: async (projectId, force = false) => {
    const state = get();
    if (!force && state.loadedForProject === projectId && state.trends.length > 0) return;
    if (!projectId) return;

    try {
      const result = await trpc.token.trends.query({
        projectId,
        timeRange: get().timeRange,
        groupBy: get().trendGroupBy,
      });
      set({ trends: result, loadedForProject: projectId });
    } catch (err) {
      const message = err instanceof Error ? err.message : '加载趋势数据失败';
      useToastStore.getState().error(`Token 趋势加载失败: ${message}`);
    }
  },

  loadEngineBreakdown: async (projectId, force = false) => {
    const state = get();
    if (!force && state.loadedForProject === projectId && state.engineBreakdown.length > 0) return;
    if (!projectId) return;

    try {
      const result = await trpc.token.engineBreakdown.query({
        projectId,
        timeRange: get().timeRange,
      });
      set({ engineBreakdown: result, loadedForProject: projectId });
    } catch (err) {
      const message = err instanceof Error ? err.message : '加载引擎分解失败';
      useToastStore.getState().error(`Token 引擎分解加载失败: ${message}`);
    }
  },
}));
