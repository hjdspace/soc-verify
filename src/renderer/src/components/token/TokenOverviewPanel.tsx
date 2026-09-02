/**
 * TokenOverviewPanel — Token Monitor 概览面板。
 *
 * 展示四张 KPI 卡片：今日 Token / 本月 Token / 总 Token / 今日费用。
 * 含时间范围选择器（全部 / 7 天 / 30 天）。
 *
 * Issue #1: 最小闭环 — 仅展示 summary 汇总数据。
 * 先例：DashboardView 的 KpiRow + 时间范围选择器模式。
 */

import { useEffect } from 'react';
import { Coins, CalendarDays, TrendingUp, DollarSign } from 'lucide-react';
import { ViewHeader } from '@renderer/components/layout/ViewHeader';
import { useTokenStore, type TokenTimeRange } from '@renderer/stores/token';
import { useProjectStore } from '@renderer/stores/project';
import { cn } from '@renderer/lib/utils';

/** 时间范围选项 */
const TIME_RANGE_OPTIONS: Array<{ value: TokenTimeRange; label: string }> = [
  { value: 'all', label: '全部' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
];

/** 时间范围选择器 */
function TimeRangeSelector() {
  const timeRange = useTokenStore((s) => s.timeRange);
  const setTimeRange = useTokenStore((s) => s.setTimeRange);
  return (
    <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-0.5">
      {TIME_RANGE_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          data-testid={`token-time-range-${opt.value}`}
          className={cn(
            'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
            timeRange === opt.value
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:text-foreground',
          )}
          onClick={() => setTimeRange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/** KPI 卡片 */
function KpiCard({
  label,
  value,
  icon: Icon,
  testId,
}: {
  label: string;
  value: string;
  icon: typeof Coins;
  testId: string;
}) {
  return (
    <div
      data-testid={testId}
      className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4"
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="size-4" strokeWidth={1.8} />
        <span className="text-xs font-medium">{label}</span>
      </div>
      <span className="text-2xl font-bold tracking-tight text-foreground">{value}</span>
    </div>
  );
}

/** 格式化 token 数量（千分位） */
function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

/** 格式化费用（美元） */
function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

export function TokenOverviewPanel() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const summary = useTokenStore((s) => s.summary);
  const loading = useTokenStore((s) => s.loading);
  const error = useTokenStore((s) => s.error);
  const loadSummary = useTokenStore((s) => s.loadSummary);

  useEffect(() => {
    if (!currentProjectId) return;
    void loadSummary(currentProjectId);
  }, [currentProjectId, loadSummary]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden p-4">
      <ViewHeader title="Token Monitor" subtitle="AI 用量概览">
        <TimeRangeSelector />
      </ViewHeader>

      {loading && !summary && (
        <div className="flex flex-1 items-center justify-center">
          <span className="text-sm text-muted-foreground">加载中…</span>
        </div>
      )}

      {error && !loading && (
        <div className="flex flex-1 items-center justify-center">
          <span className="text-sm text-status-fail">{error}</span>
        </div>
      )}

      {summary && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiCard
            label="今日 Token"
            value={formatTokens(summary.todayTokens)}
            icon={Coins}
            testId="token-kpi-today"
          />
          <KpiCard
            label="本月 Token"
            value={formatTokens(summary.monthTokens)}
            icon={CalendarDays}
            testId="token-kpi-month"
          />
          <KpiCard
            label="总 Token"
            value={formatTokens(summary.totalTokens)}
            icon={TrendingUp}
            testId="token-kpi-total"
          />
          <KpiCard
            label="今日费用"
            value={formatCost(summary.todayCostUsd)}
            icon={DollarSign}
            testId="token-kpi-cost"
          />
        </div>
      )}

      {!loading && !error && !summary && (
        <div className="flex flex-1 items-center justify-center">
          <span className="text-sm text-muted-foreground">暂无 Token 用量数据</span>
        </div>
      )}
    </div>
  );
}
