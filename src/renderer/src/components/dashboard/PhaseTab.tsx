/**
 * PhaseTab — 阶段标签页：按仿真阶段分组的通过率+失败率柱状图 + 阶段明细表。
 *
 * Issue 07: ECharts bar chart showing pass rate per phase。
 * Update: 改为分组柱状图（通过率+失败率），补充阶段明细表。
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
    const failRates = phasePassRate.map((p) =>
      p.total > 0 ? Math.round((p.fail / p.total) * 1000) / 10 : 0,
    );

    return {
      ...theme.toDefaults(),
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        ...theme.toDefaults().tooltip,
        formatter: (params: unknown) => {
          const arr = params as Array<{ name: string; dataIndex: number; value: number }>;
          const p = arr[0];
          if (!p) return '';
          const row = phasePassRate[p.dataIndex];
          return `${p.name}<br/>通过率: ${arr[0]?.value ?? 0}%<br/>失败率: ${arr[1]?.value ?? 0}%<br/>总数: ${row.total}<br/>通过: ${row.pass}<br/>失败: ${row.fail}<br/>错误: ${row.error}`;
        },
      },
      legend: {
        data: ['通过率', '失败率'],
        bottom: 0,
        textStyle: { color: theme.mutedColor, fontSize: 10 },
      },
      grid: {
        left: '3%',
        right: '4%',
        bottom: '12%',
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
          name: '通过率',
          type: 'bar',
          data: passRates,
          itemStyle: { color: theme.statusPass, borderRadius: [2, 2, 0, 0] },
        },
        {
          name: '失败率',
          type: 'bar',
          data: failRates,
          itemStyle: { color: theme.statusFail, borderRadius: [2, 2, 0, 0] },
        },
      ],
    };
  }, [phasePassRate]);

  if (!phasePassRate || phasePassRate.length === 0) return null;

  return (
    <div className="space-y-3">
      {/* ─── 分组柱状图 ───────────────────────────────────── */}
      <div className="rounded-md border border-border bg-card p-3">
        <div className="mb-2 text-xs font-semibold text-muted-foreground">
          按仿真阶段分组的通过率（共 {phasePassRate.length} 个阶段）
        </div>
        <ReactECharts
          option={option}
          style={{ height: '320px', width: '100%' }}
          opts={{ renderer: 'canvas' }}
        />
      </div>

      {/* ─── 阶段明细表 ───────────────────────────────────── */}
      <div className="rounded-md border border-border bg-card p-3">
        <div className="mb-2 text-xs font-semibold text-muted-foreground">
          阶段明细
        </div>
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                阶段
              </th>
              <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                用例数
              </th>
              <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Pass
              </th>
              <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Fail
              </th>
              <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Error
              </th>
              <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                通过率
              </th>
            </tr>
          </thead>
          <tbody>
            {phasePassRate.map((p) => (
              <tr key={p.phase} className="hover:bg-accent">
                <td className="border-b border-border px-2.5 py-1 text-foreground">
                  {p.phase}
                </td>
                <td className="border-b border-border px-2.5 py-1 text-right font-semibold tabular-nums text-foreground">
                  {p.total}
                </td>
                <td className="border-b border-border px-2.5 py-1 text-right font-semibold tabular-nums text-status-pass-foreground">
                  {p.pass}
                </td>
                <td className="border-b border-border px-2.5 py-1 text-right font-semibold tabular-nums text-status-fail-foreground">
                  {p.fail}
                </td>
                <td className="border-b border-border px-2.5 py-1 text-right font-semibold tabular-nums text-status-fail-foreground">
                  {p.error}
                </td>
                <td className={`border-b border-border px-2.5 py-1 text-right font-semibold tabular-nums ${p.passRate > 70 ? 'text-status-pass-foreground' : p.passRate < 50 ? 'text-status-fail-foreground' : 'text-foreground'}`}>
                  {p.passRate}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
