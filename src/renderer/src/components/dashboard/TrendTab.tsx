/**
 * TrendTab — 趋势标签页：每日/每周 pass/fail/error 堆叠柱状图 + 累计通过率趋势折线图。
 *
 * Issue 03: ECharts stacked bar chart + daily/weekly toggle。
 * Update: 补充累计通过率趋势折线图。
 */

import { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { useDashboardStore } from '@renderer/stores/dashboard';
import { getEChartsTheme, onThemeChange } from '@renderer/lib/echarts-theme';
import { useEffect, useState } from 'react';

export function TrendTab() {
  const trend = useDashboardStore((s) => s.trend);
  const granularity = useDashboardStore((s) => s.trendGranularity);
  const setTrendGranularity = useDashboardStore((s) => s.setTrendGranularity);

  // Re-render when theme changes
  const [, setThemeTick] = useState(0);
  useEffect(() => {
    return onThemeChange(() => setThemeTick((t) => t + 1));
  }, []);

  const stackedOption = useMemo<EChartsOption>(() => {
    if (!trend || trend.length === 0) return {};

    const theme = getEChartsTheme();
    const dates = trend.map((t) => t.date);
    const passData = trend.map((t) => t.pass);
    const failData = trend.map((t) => t.fail);
    const errorData = trend.map((t) => t.error);

    return {
      ...theme.toDefaults(),
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        ...theme.toDefaults().tooltip,
      },
      legend: {
        data: ['Pass', 'Fail', 'Error'],
        bottom: 0,
        textStyle: { color: theme.mutedColor },
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
      series: [
        {
          name: 'Pass',
          type: 'bar',
          stack: 'total',
          data: passData,
          itemStyle: { color: theme.statusPass },
        },
        {
          name: 'Fail',
          type: 'bar',
          stack: 'total',
          data: failData,
          itemStyle: { color: theme.statusFail },
        },
        {
          name: 'Error',
          type: 'bar',
          stack: 'total',
          data: errorData,
          itemStyle: { color: theme.statusError },
        },
      ],
    };
  }, [trend]);

  // ─── 累计通过率 ────────────────────────────────────────────
  const cumulativeOption = useMemo<EChartsOption>(() => {
    if (!trend || trend.length === 0) return {};

    const theme = getEChartsTheme();
    let cumPass = 0;
    let cumTotal = 0;
    const cumRate = trend.map((d) => {
      cumPass += d.pass;
      cumTotal += d.pass + d.fail + d.error;
      return cumTotal > 0 ? Math.round((cumPass / cumTotal) * 1000) / 10 : 0;
    });

    return {
      ...theme.toDefaults(),
      tooltip: {
        trigger: 'axis',
        ...theme.toDefaults().tooltip,
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
        data: trend.map((t) => t.date),
      },
      yAxis: {
        type: 'value',
        max: 100,
        axisLabel: { formatter: '{value}%', color: theme.mutedColor },
      },
      series: [
        {
          name: '累计通过率',
          type: 'line',
          smooth: true,
          data: cumRate,
          itemStyle: { color: theme.colors[0] },
          areaStyle: { opacity: 0.1 },
        },
      ],
    };
  }, [trend]);

  if (!trend || trend.length === 0) return null;

  return (
    <div className="space-y-3">
      {/* ─── 日/周切换 ───────────────────────────────────── */}
      <div className="flex items-center justify-end">
        <div className="flex overflow-hidden rounded border border-border">
          <GranularityButton
            active={granularity === 'daily'}
            onClick={() => setTrendGranularity('daily')}
          >
            每日
          </GranularityButton>
          <GranularityButton
            active={granularity === 'weekly'}
            onClick={() => setTrendGranularity('weekly')}
          >
            每周
          </GranularityButton>
        </div>
      </div>

      {/* ─── 堆叠柱状图 ───────────────────────────────────── */}
      <div className="rounded-md border border-border bg-card p-3">
        <div className="mb-2 text-xs font-semibold text-muted-foreground">
          {granularity === 'daily' ? '每日' : '每周'} Pass/Fail/Error 趋势
        </div>
        <ReactECharts
          option={stackedOption}
          style={{ height: '360px', width: '100%' }}
          opts={{ renderer: 'canvas' }}
        />
      </div>

      {/* ─── 累计通过率折线图 ─────────────────────────────── */}
      <div className="rounded-md border border-border bg-card p-3">
        <div className="mb-2 text-xs font-semibold text-muted-foreground">
          累计通过率趋势
        </div>
        <ReactECharts
          option={cumulativeOption}
          style={{ height: '200px', width: '100%' }}
          opts={{ renderer: 'canvas' }}
        />
      </div>
    </div>
  );
}

function GranularityButton({
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
      onClick={onClick}
      className={
        active
          ? 'bg-primary px-2.5 py-1 text-[10px] font-medium text-primary-foreground'
          : 'bg-transparent px-2.5 py-1 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground'
      }
    >
      {children}
    </button>
  );
}
