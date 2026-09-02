/**
 * TokenTrendsPanel — Token Monitor 趋势图面板。
 *
 * Issue #2: 按日堆叠柱状图（ECharts），支持按引擎/模型分色切换。
 * 时间轴与顶部时间范围选择器联动。
 *
 * 先例：src/renderer/src/components/dashboard/TrendTab.tsx
 */

import { useEffect, useMemo, useState } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { useTokenStore, type TrendGroupBy } from '@renderer/stores/token';
import { useProjectStore } from '@renderer/stores/project';
import { getEChartsTheme, onThemeChange } from '@renderer/lib/echarts-theme';
import { cn } from '@renderer/lib/utils';

/** 引擎 → 语义色映射 */
function getEngineColor(engine: string, theme: ReturnType<typeof getEChartsTheme>): string {
  if (engine === 'omp') return theme.chartOmp;
  if (engine === 'claude-code') return theme.chartClaude;
  if (engine === 'codex') return theme.chartCodex;
  return theme.colors[0] ?? '#5470c6';
}

/** 分组维度切换按钮 */
function GroupByButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-2.5 py-1 text-[10px] font-medium transition-colors',
        active
          ? 'bg-primary text-primary-foreground'
          : 'bg-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground',
      )}
    >
      {children}
    </button>
  );
}

export function TokenTrendsPanel() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const trends = useTokenStore((s) => s.trends);
  const trendGroupBy = useTokenStore((s) => s.trendGroupBy);
  const setTrendGroupBy = useTokenStore((s) => s.setTrendGroupBy);
  const loadTrends = useTokenStore((s) => s.loadTrends);

  useEffect(() => {
    if (!currentProjectId) return;
    void loadTrends(currentProjectId);
  }, [currentProjectId, loadTrends]);

  // Re-render when theme changes
  const [, setThemeTick] = useState(0);
  useEffect(() => {
    return onThemeChange(() => setThemeTick((t) => t + 1));
  }, []);

  const option = useMemo<EChartsOption>(() => {
    if (!trends || trends.length === 0) return {};

    const theme = getEChartsTheme();
    const isEngine = trendGroupBy === 'engine';
    const dates = trends.map((d) => d.date);

    // Collect all unique groups across all days (with totals for ranking)
    const totals = new Map<string, number>();
    for (const day of trends) {
      for (const g of day.groups) {
        totals.set(g.group, (totals.get(g.group) ?? 0) + g.totalTokens);
      }
    }

    // 模型数量可能很多（legend 挤压），Top-N 之外的聚合为「其他」（灰色）
    const MAX_SERIES = 8;
    const ranked = Array.from(totals.keys()).sort(
      (a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0),
    );
    const showTop = !isEngine && ranked.length > MAX_SERIES;
    const topGroups = showTop ? ranked.slice(0, MAX_SERIES) : ranked;
    const restGroups = showTop ? ranked.slice(MAX_SERIES) : [];
    const othersName = `其他 (${restGroups.length})`;
    // 显示顺序 = 用量降序，「其他」排最后
    const groups = [...topGroups, ...(restGroups.length > 0 ? [othersName] : [])];

    const seriesData = (grp: string): number[] =>
      trends.map((day) => {
        if (grp === othersName) {
          return day.groups
            .filter((g) => restGroups.includes(g.group))
            .reduce((sum, g) => sum + g.totalTokens, 0);
        }
        const entry = day.groups.find((g) => g.group === grp);
        return entry ? entry.totalTokens : 0;
      });

    const series = groups.map((grp, idx) => {
      const data = seriesData(grp);
      let color: string | undefined;
      if (isEngine) {
        color = getEngineColor(grp, theme);
      } else if (grp === othersName) {
        color = theme.mutedColor;
      } else {
        color = theme.colors[idx % theme.colors.length];
      }
      return {
        name: grp,
        type: 'bar' as const,
        stack: 'total' as const,
        data,
        ...(color ? { itemStyle: { color } } : {}),
      };
    });

    return {
      ...theme.toDefaults(),
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        ...theme.toDefaults().tooltip,
      },
      legend: {
        data: groups,
        type: 'scroll',
        bottom: 0,
        textStyle: { color: theme.mutedColor },
        pageIconColor: theme.mutedColor,
        pageIconInactiveColor: theme.borderColor,
        pageTextStyle: { color: theme.mutedColor },
      },
      grid: {
        left: '3%',
        right: '4%',
        bottom: '10%',
        top: '5%',
        containLabel: true,
      },
      xAxis: {
        type: 'category',
        data: dates,
      },
      yAxis: {
        type: 'value',
      },
      series,
    };
  }, [trends, trendGroupBy]);

  if (!trends || trends.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <span className="text-sm text-muted-foreground">暂无趋势数据</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      {/* ─── 分色维度切换 ─────────────────────────────────── */}
      <div className="flex items-center justify-end">
        <div className="flex overflow-hidden rounded border border-border">
          <GroupByButton
            active={trendGroupBy === 'engine'}
            onClick={() => setTrendGroupBy('engine' as TrendGroupBy)}
          >
            按引擎
          </GroupByButton>
          <GroupByButton
            active={trendGroupBy === 'model'}
            onClick={() => setTrendGroupBy('model' as TrendGroupBy)}
          >
            按模型
          </GroupByButton>
        </div>
      </div>

      {/* ─── 堆叠柱状图 ───────────────────────────────────── */}
      <div className="rounded-md border border-border bg-card p-3" data-testid="token-trends-chart">
        <div className="mb-2 text-xs font-semibold text-muted-foreground">
          每日 Token 用量趋势（{trendGroupBy === 'engine' ? '按引擎' : '按模型'}分色）
        </div>
        <ReactECharts
          option={option}
          style={{ height: '360px', width: '100%' }}
          opts={{ renderer: 'canvas' }}
        />
      </div>
    </div>
  );
}
