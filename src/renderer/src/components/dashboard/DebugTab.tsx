/**
 * DebugTab — 调试难度标签页：调试难度散点图 + Top 10 列表。
 *
 * Issue 07: ECharts scatter plot showing debug difficulty。
 * Update: 散点图动态大小（sqrt(difficulty)*2+4）+颜色分级（红/黄/绿），
 *         补充调试难度最高用例 Top 10 列表。
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

  // ─── 计算难度指数并排序 ──────────────────────────────────
  const sortedData = useMemo(() => {
    if (!debugDifficulty) return [];
    return debugDifficulty
      .map((d) => ({
        ...d,
        difficulty: d.daysToFirstPass * d.failCountBeforePass,
      }))
      .sort((a, b) => b.difficulty - a.difficulty);
  }, [debugDifficulty]);

  const option = useMemo<EChartsOption>(() => {
    if (sortedData.length === 0) return {};

    const theme = getEChartsTheme();

    const scatterData = sortedData.map((d) => ({
      value: [d.daysToFirstPass, d.failCountBeforePass, d.caseName, d.difficulty],
    }));

    return {
      ...theme.toDefaults(),
      tooltip: {
        ...theme.toDefaults().tooltip,
        trigger: 'item',
        formatter: (params: unknown) => {
          const p = params as { data: { value: [number, number, string, number] } };
          return `${p.data.value[2]}<br/>调试天数: ${p.data.value[0]}<br/>Pass 前 Fail: ${p.data.value[1]}<br/>难度指数: ${p.data.value[3]}`;
        },
      },
      grid: {
        left: '3%',
        right: '4%',
        bottom: '12%',
        top: '5%',
        containLabel: true,
      },
      xAxis: {
        type: 'value',
        name: '首次提交→首次 pass 天数',
        nameTextStyle: { color: theme.mutedColor },
        nameLocation: 'middle',
        nameGap: 30,
        axisLabel: { color: theme.mutedColor },
      },
      yAxis: {
        type: 'value',
        name: 'Pass 前 Fail 次数',
        nameTextStyle: { color: theme.mutedColor },
        nameLocation: 'middle',
        nameGap: 40,
        axisLabel: { color: theme.mutedColor },
      },
      series: [
        {
          type: 'scatter',
          data: scatterData,
          symbolSize: (data: number[]) => Math.sqrt(data[3] || 1) * 2 + 4,
          itemStyle: {
            color: (params: { data: { value: [number, number, string, number] } }) => {
              const diff = params.data.value[3];
              if (diff > 100) return theme.statusFail;
              if (diff > 30) return theme.colors[2];
              return theme.statusPass;
            },
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
  }, [sortedData]);

  if (sortedData.length === 0) return null;

  return (
    <div className="space-y-3">
      {/* ─── 散点图 ───────────────────────────────────────── */}
      <div className="rounded-md border border-border bg-card p-3">
        <div className="mb-2 text-xs font-semibold text-muted-foreground">
          调试难度散点图 — X: 首次提交到首次 pass 天数 · Y: pass 前 fail 次数（共 {sortedData.length} 个已通过用例，右上角难度最高）
        </div>
        <ReactECharts
          option={option}
          style={{ height: '360px', width: '100%' }}
          opts={{ renderer: 'canvas' }}
        />
      </div>

      {/* ─── 调试难度最高用例 Top 10 ──────────────────────── */}
      <div className="rounded-md border border-border bg-card p-3">
        <div className="mb-2 text-xs font-semibold text-muted-foreground">
          调试难度最高用例 Top 10
        </div>
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-left text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                用例名
              </th>
              <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-left text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                子系统
              </th>
              <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-right text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                调试天数
              </th>
              <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-right text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                Pass 前 Fail
              </th>
              <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-right text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                难度指数
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedData.slice(0, 10).map((d, idx) => (
              <tr key={`${d.caseName}-${idx}`} className="hover:bg-accent">
                <td className="border-b border-border px-2.5 py-1 text-foreground">
                  {d.caseName}
                </td>
                <td className="border-b border-border px-2.5 py-1 text-muted-foreground">
                  {d.subsys}
                </td>
                <td className="border-b border-border px-2.5 py-1 text-right font-semibold tabular-nums text-foreground">
                  {d.daysToFirstPass} 天
                </td>
                <td className="border-b border-border px-2.5 py-1 text-right font-semibold tabular-nums text-status-fail-foreground">
                  {d.failCountBeforePass}
                </td>
                <td className={`border-b border-border px-2.5 py-1 text-right font-semibold tabular-nums ${d.difficulty > 100 ? 'text-status-fail-foreground' : d.difficulty > 30 ? 'text-foreground' : 'text-status-pass-foreground'}`}>
                  {d.difficulty}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
