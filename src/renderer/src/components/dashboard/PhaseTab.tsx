/**
 * PhaseTab — 阶段标签页：各仿真阶段通过率柱状图。
 *
 * Issue 07: ECharts bar chart showing pass rate per phase。
 * X 轴为阶段名，Y 轴为通过率百分比，支持悬停 tooltip。
 */

import { useMemo, useEffect, useState } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { useDashboardStore } from '@renderer/stores/dashboard';
import { getEChartsTheme, onThemeChange } from '@renderer/lib/echarts-theme';

export function PhaseTab() {
  const phasePassRate = useDashboardStore((s) => s.phasePassRate);

  // Re-render when theme changes
  const [, setThemeTick] = useState(0);
  useEffect(() => {
    return onThemeChange(() => setThemeTick((t) => t + 1));
  }, []);

  const option = useMemo<EChartsOption>(() => {
    if (!phasePassRate || phasePassRate.length === 0) return {};

    const theme = getEChartsTheme();
    const phases = phasePassRate.map((p) => p.phase);
    const passRates = phasePassRate.map((p) => p.passRate);

    return {
      ...theme.toDefaults(),
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        ...theme.toDefaults().tooltip,
        formatter: (params: unknown) => {
          const p = (params as Array<{ name: string; value: number; dataIndex: number }>)[0];
          const row = phasePassRate[p.dataIndex];
          return `${p.name}<br/>通过率: ${p.value}%<br/>总数: ${row.total}<br/>通过: ${row.pass}<br/>失败: ${row.fail}<br/>错误: ${row.error}`;
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
        data: phases,
        axisLabel: { color: theme.mutedColor },
      },
      yAxis: {
        type: 'value',
        max: 100,
        axisLabel: { color: theme.mutedColor, formatter: '{value}%' },
      },
      series: [
        {
          type: 'bar',
          data: passRates,
          itemStyle: { color: theme.statusPass },
          barWidth: '50%',
          label: {
            show: true,
            position: 'top',
            formatter: '{c}%',
            fontSize: 10,
            color: theme.mutedColor,
          },
        },
      ],
    };
  }, [phasePassRate]);

  if (!phasePassRate || phasePassRate.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border bg-card p-3">
        <div className="mb-2 text-xs font-semibold text-muted-foreground">
          各阶段通过率（共 {phasePassRate.length} 个阶段）
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
