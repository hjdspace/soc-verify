/**
 * DurationTab — 耗时标签页：仿真耗时分布直方图。
 *
 * Issue 06: ECharts bar chart showing duration distribution。
 * X 轴为耗时区间，Y 轴为用例数量，支持悬停 tooltip。
 */

import { useMemo, useEffect, useState } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { useDashboardStore } from '@renderer/stores/dashboard';
import { getEChartsTheme, onThemeChange } from '@renderer/lib/echarts-theme';

export function DurationTab() {
  const durationHistogram = useDashboardStore((s) => s.durationHistogram);

  // Re-render when theme changes
  const [, setThemeTick] = useState(0);
  useEffect(() => {
    return onThemeChange(() => setThemeTick((t) => t + 1));
  }, []);

  const totalCount = useMemo(() => {
    if (!durationHistogram) return 0;
    return durationHistogram.reduce((sum, b) => sum + b.count, 0);
  }, [durationHistogram]);

  const option = useMemo<EChartsOption>(() => {
    if (!durationHistogram || durationHistogram.length === 0) return {};

    const theme = getEChartsTheme();
    const buckets = durationHistogram.map((b) => b.bucket);
    const counts = durationHistogram.map((b) => b.count);

    return {
      ...theme.toDefaults(),
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        ...theme.toDefaults().tooltip,
        formatter: (params: unknown) => {
          const p = (params as Array<{ name: string; value: number }>)[0];
          return `${p.name}<br/>运行次数: ${p.value}`;
        },
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
        data: buckets,
        axisLabel: { color: theme.mutedColor },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: theme.mutedColor },
      },
      series: [
        {
          type: 'bar',
          data: counts,
          itemStyle: { color: theme.colors[0] },
          barWidth: '60%',
        },
      ],
    };
  }, [durationHistogram]);

  if (!durationHistogram || durationHistogram.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border bg-card p-3">
        <div className="mb-2 text-xs font-semibold text-muted-foreground">
          仿真耗时分布（共 {totalCount} 次运行）
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
