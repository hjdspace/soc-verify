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

/** 扫描结果 */
export type ScanResult = {
  filesScanned: number;
  filesSkipped: number;
  recordsInserted: number;
  durationMs: number;
};

// ─── 类型定义 ───────────────────────────────────────────────

export type TokenTimeRange = 'all' | '7d' | '30d';
export type TrendGroupBy = 'engine' | 'model';

/** token.summary 查询返回结构 */
export type TokenSummary = {
  todayTokens: number;
  monthTokens: number;
  totalTokens: number;
  todayCostUsd: number;
  /** 连续使用天数（含今天） */
  currentStreak: number;
  /** 历史最长连续使用天数 */
  longestStreak: number;
};

/** 热力图单日数据 */
export type HeatmapEntry = {
  date: string; // YYYY-MM-DD
  totalTokens: number;
  costUsd: number;
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

/** 模型分解数据 */
export type ModelBreakdownEntry = {
  model: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
};

/** 会话汇总数据 */
export type SessionEntry = {
  sessionId: string;
  engine: string;
  model: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  totalTokens: number;
  totalCost: number;
  messageCount: number;
};

/** 会话列表查询结果 */
export type SessionsResult = {
  sessions: SessionEntry[];
  total: number;
};

/** per-request 明细记录 */
export type SessionDetailEntry = {
  messageId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  timestamp: number;
};

/** 排序字段 */
export type SessionSortBy = 'time' | 'tokens' | 'cost';

/** 排序方向 */
export type SessionSortDir = 'asc' | 'desc';

/** 引擎筛选 */
export type SessionEngineFilter = 'all' | 'omp' | 'claude-code' | 'codex';

// ─── Store ─────────────────────────────────────────────────

interface TokenState {
  summary: TokenSummary | null;
  trends: TrendDayData[];
  engineBreakdown: EngineBreakdownEntry[];
  modelBreakdown: ModelBreakdownEntry[];
  sessions: SessionEntry[];
  sessionsTotal: number;
  sessionDetail: SessionDetailEntry[];
  sessionDetailSessionId: string | null;
  heatmap: HeatmapEntry[];
  loading: boolean;
  error: string | null;
  timeRange: TokenTimeRange;
  trendGroupBy: TrendGroupBy;
  /** 会话列表筛选/排序/分页状态 */
  sessionEngineFilter: SessionEngineFilter;
  sessionSortBy: SessionSortBy;
  sessionSortDir: SessionSortDir;
  sessionPage: number;
  sessionPageSize: number;
  /** 已加载的项目 ID（避免重复加载） */
  loadedForProject: string | null;
  /** 外部日志扫描加载状态 */
  scanLoading: boolean;
  /** 上次扫描结果 */
  lastScanResult: ScanResult | null;
  /** 上次扫描时间（ms epoch），null 表示从未扫描 */
  lastScanAt: number | null;
  setTimeRange: (range: TokenTimeRange) => void;
  setTrendGroupBy: (groupBy: TrendGroupBy) => void;
  setSessionEngineFilter: (filter: SessionEngineFilter) => void;
  setSessionSort: (sortBy: SessionSortBy, sortDir: SessionSortDir) => void;
  setSessionPage: (page: number) => void;
  loadSummary: (projectId: string, force?: boolean) => Promise<void>;
  loadTrends: (projectId: string, force?: boolean) => Promise<void>;
  loadEngineBreakdown: (projectId: string, force?: boolean) => Promise<void>;
  loadModelBreakdown: (projectId: string, force?: boolean) => Promise<void>;
  loadSessions: (projectId: string, force?: boolean) => Promise<void>;
  loadSessionDetail: (projectId: string, sessionId: string) => Promise<void>;
  clearSessionDetail: () => void;
  loadHeatmap: (projectId: string, force?: boolean) => Promise<void>;
  scanExternalLogs: (projectId: string) => Promise<ScanResult>;
}

export const useTokenStore = create<TokenState>((set, get) => ({
  summary: null,
  trends: [],
  engineBreakdown: [],
  modelBreakdown: [],
  sessions: [],
  sessionsTotal: 0,
  sessionDetail: [],
  sessionDetailSessionId: null,
  heatmap: [],
  loading: false,
  error: null,
  timeRange: 'all',
  trendGroupBy: 'engine',
  sessionEngineFilter: 'all',
  sessionSortBy: 'time',
  sessionSortDir: 'desc',
  sessionPage: 1,
  sessionPageSize: 50,
  loadedForProject: null,
  scanLoading: false,
  lastScanResult: null,
  lastScanAt: null,

  setTimeRange: (range) => {
    set({ timeRange: range });
    // 时间范围变更后重新加载所有数据
    const { loadedForProject, loadSummary, loadTrends, loadEngineBreakdown, loadModelBreakdown, loadSessions } = get();
    if (loadedForProject) {
      void loadSummary(loadedForProject, true);
      void loadTrends(loadedForProject, true);
      void loadEngineBreakdown(loadedForProject, true);
      void loadModelBreakdown(loadedForProject, true);
      void loadSessions(loadedForProject, true);
    }
  },

  setTrendGroupBy: (groupBy) => {
    set({ trendGroupBy: groupBy });
    const { loadedForProject, loadTrends } = get();
    if (loadedForProject) {
      void loadTrends(loadedForProject, true);
    }
  },

  setSessionEngineFilter: (filter) => {
    set({ sessionEngineFilter: filter, sessionPage: 1 });
    const { loadedForProject, loadSessions } = get();
    if (loadedForProject) {
      void loadSessions(loadedForProject, true);
    }
  },

  setSessionSort: (sortBy, sortDir) => {
    set({ sessionSortBy: sortBy, sessionSortDir: sortDir, sessionPage: 1 });
    const { loadedForProject, loadSessions } = get();
    if (loadedForProject) {
      void loadSessions(loadedForProject, true);
    }
  },

  setSessionPage: (page) => {
    set({ sessionPage: page });
    const { loadedForProject, loadSessions } = get();
    if (loadedForProject) {
      void loadSessions(loadedForProject, true);
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

  loadModelBreakdown: async (projectId, force = false) => {
    const state = get();
    if (!force && state.loadedForProject === projectId && state.modelBreakdown.length > 0) return;
    if (!projectId) return;

    try {
      const result = await trpc.token.modelBreakdown.query({
        projectId,
        timeRange: get().timeRange,
      });
      set({ modelBreakdown: result, loadedForProject: projectId });
    } catch (err) {
      const message = err instanceof Error ? err.message : '加载模型分解失败';
      useToastStore.getState().error(`Token 模型分解加载失败: ${message}`);
    }
  },

  loadSessions: async (projectId, force = false) => {
    const state = get();
    const engine = state.sessionEngineFilter === 'all' ? undefined : state.sessionEngineFilter;
    if (!force && state.loadedForProject === projectId && state.sessions.length > 0
      && state.sessionDetailSessionId === null) return;
    if (!projectId) return;

    try {
      const result = await trpc.token.sessions.query({
        projectId,
        engine,
        sortBy: state.sessionSortBy,
        sortDir: state.sessionSortDir,
        page: state.sessionPage,
        pageSize: state.sessionPageSize,
      });
      set({
        sessions: result.sessions,
        sessionsTotal: result.total,
        loadedForProject: projectId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '加载会话列表失败';
      useToastStore.getState().error(`Token 会话列表加载失败: ${message}`);
    }
  },

  loadSessionDetail: async (projectId, sessionId) => {
    if (!projectId) return;

    try {
      const result = await trpc.token.sessionDetail.query({
        projectId,
        sessionId,
      });
      set({ sessionDetail: result, sessionDetailSessionId: sessionId });
    } catch (err) {
      const message = err instanceof Error ? err.message : '加载会话明细失败';
      useToastStore.getState().error(`Token 会话明细加载失败: ${message}`);
    }
  },

  clearSessionDetail: () => {
    set({ sessionDetail: [], sessionDetailSessionId: null });
  },

  loadHeatmap: async (projectId, force = false) => {
    const state = get();
    if (!force && state.loadedForProject === projectId && state.heatmap.length > 0) return;
    if (!projectId) return;

    try {
      const result = await trpc.token.heatmap.query({ projectId });
      set({ heatmap: result, loadedForProject: projectId });
    } catch (err) {
      const message = err instanceof Error ? err.message : '加载热力图数据失败';
      useToastStore.getState().error(`Token 热力图加载失败: ${message}`);
    }
  },

  scanExternalLogs: async (projectId) => {
    if (!projectId) {
      return { filesScanned: 0, filesSkipped: 0, recordsInserted: 0, durationMs: 0 };
    }

    set({ scanLoading: true });
    try {
      const result = await trpc.token.scanExternalLogs.mutate({ projectId });
      set({
        lastScanResult: result,
        scanLoading: false,
        lastScanAt: Date.now(),
      });
      // 扫描后刷新所有面板数据
      const { loadSummary, loadHeatmap, loadTrends, loadEngineBreakdown, loadModelBreakdown, loadSessions } = get();
      void loadSummary(projectId, true);
      void loadHeatmap(projectId, true);
      void loadTrends(projectId, true);
      void loadEngineBreakdown(projectId, true);
      void loadModelBreakdown(projectId, true);
      void loadSessions(projectId, true);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : '外部日志扫描失败';
      set({ scanLoading: false });
      useToastStore.getState().error(`外部日志扫描失败: ${message}`);
      return { filesScanned: 0, filesSkipped: 0, recordsInserted: 0, durationMs: 0 };
    }
  },
}));
