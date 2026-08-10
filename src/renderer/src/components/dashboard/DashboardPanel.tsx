/**
 * DashboardPanel — 验证数据可视化面板主组件。
 *
 * ADR 0019: 9 个标签页 + 顶部工具栏（子系统下拉 + 时间范围 + 刷新）。
 * Issue 01: 标签页骨架 + 空状态引导提示 + 工具栏交互 + 布局持久化。
 * 后续 issue 逐个添加图表渲染。
 */

import { useEffect, useCallback } from 'react';
import { RefreshCw, Filter, Clock } from 'lucide-react';
import { useDashboardStore, DASHBOARD_TABS, TAB_EMPTY_HINTS, type DashboardTab } from '@renderer/stores/dashboard';
import { useProjectStore } from '@renderer/stores/project';
import { cn } from '@renderer/lib/utils';
import { startThemeObserver, stopThemeObserver } from '@renderer/lib/echarts-theme';

const TIME_RANGE_OPTIONS: { value: 'all' | '7d' | '30d'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: '7d', label: '最近7天' },
  { value: '30d', label: '最近30天' },
];

export function DashboardPanel() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);

  const activeTab = useDashboardStore((s) => s.activeTab);
  const selectedSubsys = useDashboardStore((s) => s.selectedSubsys);
  const timeRange = useDashboardStore((s) => s.timeRange);
  const subsysList = useDashboardStore((s) => s.subsysList);
  const subsysListLoading = useDashboardStore((s) => s.subsysListLoading);
  const loadingTab = useDashboardStore((s) => s.loadingTab);
  const tabLoaded = useDashboardStore((s) => s.tabLoaded);
  const tabError = useDashboardStore((s) => s.tabError);
  const layoutLoaded = useDashboardStore((s) => s.layoutLoaded);

  const setActiveTab = useDashboardStore((s) => s.setActiveTab);
  const setSubsys = useDashboardStore((s) => s.setSubsys);
  const setTimeRange = useDashboardStore((s) => s.setTimeRange);
  const loadSubsysList = useDashboardStore((s) => s.loadSubsysList);
  const loadTabData = useDashboardStore((s) => s.loadTabData);
  const refresh = useDashboardStore((s) => s.refresh);
  const loadLayout = useDashboardStore((s) => s.loadLayout);
  const saveLayout = useDashboardStore((s) => s.saveLayout);

  // ─── Mount: 启动 ECharts 主题监听 + 加载布局 + 加载子系统列表 ───
  useEffect(() => {
    startThemeObserver();
    return () => {
      stopThemeObserver();
    };
  }, []);

  useEffect(() => {
    if (!currentProjectId) return;
    if (!layoutLoaded) {
      loadLayout(currentProjectId).then(() => {
        loadSubsysList(currentProjectId);
      });
    } else {
      loadSubsysList(currentProjectId);
    }
  }, [currentProjectId, layoutLoaded, loadLayout, loadSubsysList]);

  // ─── Unmount: 保存布局 ───────────────────────────────────
  useEffect(() => {
    return () => {
      if (currentProjectId) {
        saveLayout(currentProjectId);
      }
    };
  }, [currentProjectId, saveLayout]);

  // ─── 标签页切换时自动加载 ─────────────────────────────────
  useEffect(() => {
    if (!currentProjectId) return;
    if (!tabLoaded[activeTab]) {
      loadTabData(activeTab, currentProjectId);
    }
  }, [activeTab, currentProjectId, tabLoaded, loadTabData]);

  // ─── 标签页切换 ───────────────────────────────────────────
  const handleTabClick = useCallback((tab: DashboardTab) => {
    setActiveTab(tab);
  }, [setActiveTab]);

  // ─── 子系统筛选 ───────────────────────────────────────────
  const handleSubsysChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    setSubsys(value === '__all__' ? null : value);
  }, [setSubsys]);

  // ─── 时间范围筛选 ─────────────────────────────────────────
  const handleTimeRangeChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    if (value === 'all' || value === '7d' || value === '30d') {
      setTimeRange(value);
    }
  }, [setTimeRange]);

  // ─── 刷新 ─────────────────────────────────────────────────
  const handleRefresh = useCallback(() => {
    if (currentProjectId) {
      refresh(currentProjectId);
    }
  }, [currentProjectId, refresh]);

  if (!currentProjectId) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        请先打开项目
      </div>
    );
  }

  const isLoading = loadingTab === activeTab;
  const error = tabError[activeTab];
  const hasData = tabLoaded[activeTab] && !error;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* ─── 工具栏 ────────────────────────────────────────── */}
      <div className="flex items-center gap-3 border-b border-border px-3 py-2">
        {/* 子系统筛选 */}
        <div className="flex items-center gap-1.5">
          <Filter className="h-3.5 w-3.5 text-muted-foreground" />
          <select
            value={selectedSubsys ?? '__all__'}
            onChange={handleSubsysChange}
            disabled={subsysListLoading}
            className="h-7 rounded border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary"
          >
            <option value="__all__">全部子系统</option>
            {subsysList.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        {/* 时间范围 */}
        <div className="flex items-center gap-1.5">
          <Clock className="h-3.5 w-3.5 text-muted-foreground" />
          <select
            value={typeof timeRange === 'string' ? timeRange : 'all'}
            onChange={handleTimeRangeChange}
            className="h-7 rounded border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary"
          >
            {TIME_RANGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {/* 刷新按钮 */}
        <button
          onClick={handleRefresh}
          title="刷新"
          className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
        </button>
      </div>

      {/* ─── 标签页栏 ──────────────────────────────────────── */}
      <div className="flex items-center gap-1 border-b border-border px-2">
        {DASHBOARD_TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => handleTabClick(tab.id)}
            data-active={activeTab === tab.id}
            className={cn(
              'relative px-3 py-2 text-xs font-medium transition-colors',
              activeTab === tab.id
                ? 'text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
            {activeTab === tab.id && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
            )}
          </button>
        ))}
      </div>

      {/* ─── 标签页内容 ────────────────────────────────────── */}
      <div className="flex-1 overflow-auto p-4">
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            加载中...
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center text-xs text-destructive">
            加载失败: {error}
          </div>
        ) : hasData ? (
          // 后续 issue 在此渲染图表。当前显示空状态引导提示。
          <EmptyState hint={TAB_EMPTY_HINTS[activeTab]} />
        ) : (
          <EmptyState hint={TAB_EMPTY_HINTS[activeTab]} />
        )}
      </div>
    </div>
  );
}

/** 空状态引导提示组件 */
function EmptyState({ hint }: { hint: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2">
      <div className="text-xs text-muted-foreground">{hint}</div>
    </div>
  );
}
