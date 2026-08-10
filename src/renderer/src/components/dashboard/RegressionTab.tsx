/**
 * RegressionTab — 回归标签页：回归进度环形图 + 统计数字。
 *
 * Issue 05: 从 dashboard store 读取 regressionProgress 数据。
 * ECharts pie chart 展示已跑/未跑占比。
 */

import { useMemo, useEffect, useState } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { useDashboardStore } from '@renderer/stores/dashboard';
import { getEChartsTheme, onThemeChange } from '@renderer/lib/echarts-theme';

export function RegressionTab() {
  const regressionProgress = useDashboardStore((s) => s.regressionProgress);

  // Re-render when theme changes
  const [, setThemeTick] = useState(0);
  useEffect(() => {
    return onThemeChange(() => setThemeTick((t) => t + 1));
  }, []);

  const option = useMemo<EChartsOption>(() => {
    if (!regressionProgress) return {};

    const theme = getEChartsTheme();
    const runCases = regressionProgress.runCases;
    const notRunCases = regressionProgress.notRunCases;

    return {
      ...theme.toDefaults(),
      tooltip: {
        ...theme.toDefaults().tooltip,
        trigger: 'item',
        formatter: '{b}: {c} ({d}%)',
      },
      legend: {
        bottom: 10,
        textStyle: { color: theme.mutedColor },
      },
      series: [
        {
          type: 'pie',
          radius: ['45%', '70%'],
          center: ['50%', '45%'],
          avoidLabelOverlap: false,
          label: {
            show: true,
            position: 'center',
            formatter: () => {
              const rate = regressionProgress.totalCases > 0
                ? Math.round((runCases / regressionProgress.totalCases) * 100)
                : 0;
              return `{a|${rate}%}\n{b|完成度}`;
            },
            rich: {
              a: { fontSize: 28, fontWeight: 'bold', color: theme.textColor },
              b: { fontSize: 11, color: theme.mutedColor, padding: [4, 0, 0, 0] },
            },
          },
          data: [
            { value: runCases, name: '已跑', itemStyle: { color: theme.statusPass } },
            { value: notRunCases, name: '未跑', itemStyle: { color: theme.mutedColor } },
          ],
        },
      ],
    };
  }, [regressionProgress]);

  if (!regressionProgress) return null;

  return (
    <div className="space-y-3">
      {/* ─── ECharts 环形图 ────────────────────────────────── */}
      <div className="rounded-md border border-border bg-card p-3">
        <div className="mb-2 text-xs font-semibold text-muted-foreground">
          回归进度
        </div>
        <ReactECharts
          option={option}
          style={{ height: '280px', width: '100%' }}
          opts={{ renderer: 'canvas' }}
        />
      </div>

      {/* ─── 统计数字 ──────────────────────────────────────── */}
      <div className="grid grid-cols-6 gap-2.5">
        <StatCard label="总用例" value={regressionProgress.totalCases} variant="info" />
        <StatCard label="已跑" value={regressionProgress.runCases} variant="pass" />
        <StatCard label="通过" value={regressionProgress.passedCases} variant="pass" />
        <StatCard label="失败" value={regressionProgress.failedCases} variant="fail" />
        <StatCard label="未跑" value={regressionProgress.notRunCases} variant="muted" />
        <StatCard label="通过率" value={`${regressionProgress.passRate}%`} variant="info" />
      </div>
    </div>
  );
}

// ─── Stat Card ────────────────────────────────────────────────

function StatCard({
  label,
  value,
  variant,
}: {
  label: string;
  value: string | number;
  variant: 'pass' | 'fail' | 'info' | 'muted';
}) {
  const colorClasses: Record<typeof variant, string> = {
    pass: 'border-status-pass/30 bg-status-pass/8 text-status-pass-foreground',
    fail: 'border-status-fail/30 bg-status-fail/8 text-status-fail-foreground',
    info: 'border-primary/30 bg-primary/8 text-primary',
    muted: 'border-border/50 bg-muted/8 text-muted-foreground',
  };

  return (
    <div className={`rounded-md border p-3 ${colorClasses[variant]}`}>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-lg font-bold text-foreground">{value}</div>
    </div>
  );
}
