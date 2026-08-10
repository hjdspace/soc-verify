/**
 * DebugTab — 调试难度标签页：调试难度散点图。
 *
 * Issue 07: ECharts scatter plot showing debug difficulty。
 * X 轴=天数（首次提交到首次 pass），Y 轴=fail 次数。
 * 每个点代表一个用例，右上角用例为调试难度最高者。
 * 支持悬停 tooltip 显示用例名和具体数值。
 */

import { useMemo, useEffect, useState } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { useDashboardStore } from '@renderer/stores/dashboard';
import { getEChartsTheme, onThemeChange } from '@renderer/lib/echarts-theme';

export function DebugTab() {
  const debugDifficulty = useDashboardStore((s) => s.debugDifficulty);

  // Re-render when theme changes
  const [, setThemeTick] = useState(0);
  useEffect(() => {
    return onThemeChange(() => setThemeTick((t) => t + 1));
  }, []);

  const option = useMemo<EChartsOption>(() => {
    if (!debugDifficulty || debugDifficulty.length === 0) return {};

    const theme = getEChartsTheme();

    const scatterData = debugDifficulty.map((d) => ({
      value: [d.daysToFirstPass, d.failCountBeforePass],
      caseName: d.caseName,
      subsys: d.subsys,
    }));

    return {
      ...theme.toDefaults(),
      tooltip: {
        ...theme.toDefaults().tooltip,
        trigger: 'item',
        formatter: (params: unknown) => {
          const p = params as { data: { caseName: string; subsys: string; value: [number, number] } };
          return `${p.data.caseName}<br/>子系统: ${p.data.subsys}<br/>天数: ${p.data.value[0]}<br/>Fail次数: ${p.data.value[1]}`;
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
        type: 'value',
        name: '天数',
        nameTextStyle: { color: theme.mutedColor },
        axisLabel: { color: theme.mutedColor },
      },
      yAxis: {
        type: 'value',
        name: 'Fail次数',
        nameTextStyle: { color: theme.mutedColor },
        axisLabel: { color: theme.mutedColor },
      },
      series: [
        {
          type: 'scatter',
          data: scatterData,
          symbolSize: 10,
          itemStyle: {
            color: theme.colors[0],
            opacity: 0.7,
          },
          emphasis: {
            itemStyle: {
              shadowBlur: 10,
              shadowColor: 'rgba(0, 0, 0, 0.3)',
            },
          },
        },
      ],
    };
  }, [debugDifficulty]);

  if (!debugDifficulty || debugDifficulty.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border bg-card p-3">
        <div className="mb-2 text-xs font-semibold text-muted-foreground">
          调试难度分布（共 {debugDifficulty.length} 个已通过用例，右上角难度最高）
        </div>
        <ReactECharts
          option={option}
          style={{ height: '400px', width: '100%' }}
          opts={{ renderer: 'canvas' }}
        />
      </div>
    </div>
  );
}
