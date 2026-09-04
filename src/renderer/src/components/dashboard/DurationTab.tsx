/**
 * DurationTab — 耗时标签页：仿真耗时分布直方图 + 最慢用例 Top 10。
 *
 * Issue 06: ECharts bar chart showing duration distribution。
 * Update: 调整柱状图样式（圆角+颜色区分），补充最慢用例 Top 10 表格。
 */

import { useMemo, useEffect, useState } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { useDashboardStore } from '@renderer/stores/dashboard';
import { getEChartsTheme, onThemeChange } from '@renderer/lib/echarts-theme';

/** 将毫秒耗时格式化为可读字符串 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m${sec}s`;
}

/** 将 ISO 时间字符串格式化为本地日期时间 */
function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}/${dd} ${hh}:${mi}`;
  } catch {
    return iso;
  }
}

export function DurationTab() {
  const durationHistogram = useDashboardStore((s) => s.durationHistogram);
  const slowestCases = useDashboardStore((s) => s.slowestCases);

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

    // 找到最后一个非零桶作为 P95 近似
    const lastNonZeroIdx = counts.reduce((last, v, i) => v > 0 ? i : last, 0);

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
        bottom: '12%',
        top: '5%',
        containLabel: true,
      },
      xAxis: {
        type: 'category',
        data: buckets,
        axisLabel: { color: theme.mutedColor, fontSize: 9 },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: theme.mutedColor },
      },
      series: [
        {
          type: 'bar',
          data: counts.map((v, i) => ({
            value: v,
            itemStyle: {
              color: i >= lastNonZeroIdx ? theme.statusFail : theme.statusPass,
              borderRadius: [2, 2, 0, 0],
            },
          })),
          barWidth: '60%',
          markLine: lastNonZeroIdx < buckets.length ? {
            silent: true,
            data: [{
              xAxis: lastNonZeroIdx,
              label: { formatter: 'P95', color: theme.statusFail, fontSize: 10 },
            }],
            lineStyle: { color: theme.statusFail, width: 2, type: 'dashed' },
          } : undefined,
        },
      ],
    };
  }, [durationHistogram]);

  if (!durationHistogram || durationHistogram.length === 0) return null;

  return (
    <div className="space-y-3">
      {/* ─── 耗时分布直方图 ───────────────────────────────── */}
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

      {/* ─── 最慢用例 Top 10 ──────────────────────────────── */}
      {slowestCases && slowestCases.length > 0 && (
        <div className="rounded-md border border-border bg-card p-3">
          <div className="mb-2 text-xs font-semibold text-muted-foreground">
            最慢用例 Top 10
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
                  耗时
                </th>
                <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-left text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                  状态
                </th>
                <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-right text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                  时间
                </th>
              </tr>
            </thead>
            <tbody>
              {slowestCases.map((s, idx) => (
                <tr key={`${s.caseName}-${idx}`} className="hover:bg-accent">
                  <td className="border-b border-border px-2.5 py-1 text-foreground">
                    {s.caseName}
                  </td>
                  <td className="border-b border-border px-2.5 py-1 text-muted-foreground">
                    {s.subsys}
                  </td>
                  <td className="border-b border-border px-2.5 py-1 text-right font-semibold tabular-nums text-foreground">
                    {formatDuration(s.durationMs)}
                  </td>
                  <td className="border-b border-border px-2.5 py-1">
                    <span className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle ${s.status === 'pass' ? 'bg-status-pass' : 'bg-status-fail'}`} />
                    {s.status}
                  </td>
                  <td className="border-b border-border px-2.5 py-1 text-right tabular-nums text-muted-foreground">
                    {formatTime(s.startTime)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
