/**
 * Dashboard Store — 验证数据可视化面板状态管理。
 *
 * ADR 0019: 按标签页存储数据 + 全局筛选状态 + 加载状态。
 * Issue 01: 仅实现标签页骨架 + 筛选状态 + 空状态。后续 issue 逐个添加数据加载。
 */

import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from './toast';

// ─── 类型定义 ───────────────────────────────────────────────

export type DashboardTab =
  | 'overview'
  | 'trend'
  | 'subsys'
  | 'failures'
  | 'regression'
  | 'duration'
  | 'unstable'
  | 'phase'
  | 'debug';

export type TimeRange = 'all' | '7d' | '30d' | { start: string; end: string };

/** 标签页列表（固定顺序，不支持重排） */
export const DASHBOARD_TABS: { id: DashboardTab; label: string }[] = [
  { id: 'overview', label: '概览' },
  { id: 'trend', label: '趋势' },
  { id: 'subsys', label: '子系统' },
  { id: 'failures', label: '失败' },
  { id: 'regression', label: '回归' },
  { id: 'duration', label: '耗时' },
  { id: 'unstable', label: '不稳定' },
  { id: 'phase', label: '阶段' },
  { id: 'debug', label: '调试难度' },
];

/** 每个标签页的空状态引导提示 */
export const TAB_EMPTY_HINTS: Record<DashboardTab, string> = {
  overview: '运行仿真后此处将展示汇总指标卡片和子系统状态表',
  trend: '运行仿真后此处将展示每日/每周 pass/fail 趋势折线图',
  subsys: '运行仿真后此处将展示各子系统 pass/fail 分布热力图',
  failures: '运行仿真后此处将展示最近失败用例列表',
  regression: '运行仿真后此处将展示回归进度环形图',
  duration: '运行仿真后此处将展示仿真耗时分布直方图',
  unstable: '运行仿真后此处将展示不稳定用例列表',
  phase: '运行仿真后此处将展示各仿真阶段通过率柱状图',
  debug: '运行仿真后此处将展示调试难度散点图',
};

interface DashboardStoreState {
  // ─── 筛选状态 ─────────────────────────────────────────────
  activeTab: DashboardTab;
  selectedSubsys: string | null; // null = 全部子系统
  timeRange: TimeRange;

  // ─── 子系统列表（工具栏下拉） ─────────────────────────────
  subsysList: string[];
  subsysListLoading: boolean;

  // ─── 按标签页存储数据 ─────────────────────────────────────
  // key = tab id, value = tab-specific data (后续 issue 填充)
  tabData: Partial<Record<DashboardTab, unknown>>;
  tabLoaded: Partial<Record<DashboardTab, boolean>>;
  tabError: Partial<Record<DashboardTab, string>>;

  // ─── 加载状态 ─────────────────────────────────────────────
  loadingTab: DashboardTab | null;

  // ─── 布局 ─────────────────────────────────────────────────
  layoutLoaded: boolean;

  // ─── 操作 ─────────────────────────────────────────────────
  setActiveTab: (tab: DashboardTab) => void;
  setSubsys: (subsys: string | null) => void;
  setTimeRange: (range: TimeRange) => void;
  clearCache: () => void;
  loadSubsysList: (projectId: string) => Promise<void>;
  loadTabData: (tab: DashboardTab, projectId: string) => Promise<void>;
  refresh: (projectId: string) => Promise<void>;
  loadLayout: (projectId: string) => Promise<void>;
  saveLayout: (projectId: string) => Promise<void>;
}

// ─── 辅助函数 ───────────────────────────────────────────────

function buildFilter(projectId: string, subsys: string | null, timeRange: TimeRange) {
  const filter: Record<string, unknown> = { projectId };
  if (subsys) filter.subsys = subsys;
  if (timeRange !== 'all') filter.timeRange = timeRange;
  return filter;
}

// ─── Store ──────────────────────────────────────────────────

export const useDashboardStore = create<DashboardStoreState>((set, get) => ({
  // 初始状态
  activeTab: 'overview',
  selectedSubsys: null,
  timeRange: 'all',
  subsysList: [],
  subsysListLoading: false,
  tabData: {},
  tabLoaded: {},
  tabError: {},
  loadingTab: null,
  layoutLoaded: false,

  // ─── 标签页切换 ───────────────────────────────────────────
  setActiveTab: (tab) => set({ activeTab: tab }),

  // ─── 子系统筛选 ───────────────────────────────────────────
  setSubsys: (subsys) => {
    set({
      selectedSubsys: subsys,
      tabData: {},
      tabLoaded: {},
      tabError: {},
    });
  },

  // ─── 时间范围筛选 ─────────────────────────────────────────
  setTimeRange: (range) => {
    set({
      timeRange: range,
      tabData: {},
      tabLoaded: {},
      tabError: {},
    });
  },

  // ─── 清除缓存 ─────────────────────────────────────────────
  clearCache: () => set({ tabData: {}, tabLoaded: {}, tabError: {} }),

  // ─── 加载子系统列表 ───────────────────────────────────────
  loadSubsysList: async (projectId) => {
    set({ subsysListLoading: true });
    try {
      const result = await trpc.dashboard.getSubsysList.query({ projectId });
      set({ subsysList: result, subsysListLoading: false });
    } catch (err) {
      set({ subsysListLoading: false });
      useToastStore.getState().error(
        '加载子系统列表失败',
        err instanceof Error ? err.message : String(err),
      );
    }
  },

  // ─── 加载标签页数据 ───────────────────────────────────────
  loadTabData: async (tab, projectId) => {
    const state = get();

    // 已加载且无错误 → 跳过
    if (state.tabLoaded[tab] && !state.tabError[tab]) return;

    set({ loadingTab: tab });

    try {
      const filter = buildFilter(projectId, state.selectedSubsys, state.timeRange);

      // Issue 01: 大多数 procedure 尚未实现，仅标记为已加载（空数据）。
      // 后续 issue 逐个添加真实查询。
      // 可用的 procedure: getSubsysList（已在 loadSubsysList 中使用）
      // 尚未实现的 procedure: getSummary, getTrend, getSubsysHeatmap, getRecentFailures,
      //   getRegressionProgress, getDurationHistogram, getUnstableCases,
      //   getPhasePassRate, getDebugDifficulty
      void filter; // 后续 issue 使用

      // 标记为已加载（数据为 null — 显示空状态引导提示）
      set({
        loadingTab: null,
        tabData: { ...get().tabData, [tab]: null },
        tabLoaded: { ...get().tabLoaded, [tab]: true },
        tabError: { ...get().tabError, [tab]: undefined },
      });
    } catch (err) {
      set({
        loadingTab: null,
        tabLoaded: { ...get().tabLoaded, [tab]: true },
        tabError: {
          ...get().tabError,
          [tab]: err instanceof Error ? err.message : String(err),
        },
      });
    }
  },

  // ─── 刷新当前标签页 ───────────────────────────────────────
  refresh: async (projectId) => {
    const { activeTab } = get();
    // 强制重新加载（清除 loaded 标记）
    set({
      tabLoaded: { ...get().tabLoaded, [activeTab]: false },
    });
    await get().loadTabData(activeTab, projectId);
  },

  // ─── 加载布局 ─────────────────────────────────────────────
  loadLayout: async (projectId) => {
    try {
      const layout = await trpc.dashboard.getLayout.query({ projectId });
      if (layout && typeof layout === 'object') {
        const l = layout as Record<string, unknown>;
        if (typeof l.activeTab === 'string') {
          const tab = DASHBOARD_TABS.find((t) => t.id === l.activeTab);
          if (tab) set({ activeTab: tab.id });
        }
        if (l.timeRange !== undefined) {
          if (typeof l.timeRange === 'string' && ['all', '7d', '30d'].includes(l.timeRange)) {
            set({ timeRange: l.timeRange as TimeRange });
          } else if (typeof l.timeRange === 'object' && l.timeRange !== null) {
            const tr = l.timeRange as Record<string, unknown>;
            if (typeof tr.start === 'string' && typeof tr.end === 'string') {
              set({ timeRange: { start: tr.start, end: tr.end } });
            }
          }
        }
        if (typeof l.selectedSubsys === 'string') {
          set({ selectedSubsys: l.selectedSubsys });
        } else if (l.selectedSubsys === null) {
          set({ selectedSubsys: null });
        }
      }
      set({ layoutLoaded: true });
    } catch {
      set({ layoutLoaded: true });
    }
  },

  // ─── 保存布局 ─────────────────────────────────────────────
  saveLayout: async (projectId) => {
    const { activeTab, timeRange, selectedSubsys } = get();
    try {
      await trpc.dashboard.saveLayout.mutate({
        projectId,
        layout: { activeTab, timeRange, selectedSubsys },
      });
    } catch {
      // 布局保存失败不阻断用户操作
    }
  },
}));
