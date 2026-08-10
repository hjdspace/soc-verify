/**
 * RegressionTab — 回归标签页：统计数字卡片 + 整体通过率进度条 + 按子系统回归进度图。
 *
 * Issue 05: 从 dashboard store 读取 regressionProgress 数据。
 * Update: 修复环形图尺寸，补充整体通过率进度条和按子系统回归进度堆叠柱状图。
 */

import { useMemo, useEffect, useState } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { useDashboardStore } from '@renderer/stores/dashboard';
import { getEChartsTheme, onThemeChange } from '@renderer/lib/echarts-theme';

export function RegressionTab() {
  const regressionProgress = useDashboardStore((s) => s.regressionProgress);
  const regressionBySubsys = useDashboardStore((s) => s.regressionBySubsys);

  // Re-render when theme changes
  const [, setThemeTick] = useState(0);
  useEffect(() => {
    return onThemeChange(() => setThemeTick((t) => t + 1));
  }, []);

  // ─── 按子系统回归进度堆叠柱状图 ──────────────────────────
  const bySubsysOption = useMemo<EChartsOption>(() => {
    if (!regressionBySubsys || regressionBySubsys.length === 0) return {};

    const theme = getEChartsTheme();
    const subsysNames = regressionBySubsys.map((s) => s.subsys);

    return {
      ...theme.toDefaults(),
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        ...theme.toDefaults().tooltip,
      },
      legend: {
        data: ['Pass', 'Fail/Error', '未跑'],
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
        data: subsysNames,
        axisLabel: { fontSize: 9, rotate: 30, color: theme.mutedColor },
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 9, color: theme.mutedColor },
      },
      series: [
        {
          name: 'Pass',
          type: 'bar',
          stack: 'total',
          data: regressionBySubsys.map((s) => s.passedCases),
          itemStyle: { color: theme.statusPass },
        },
        {
          name: 'Fail/Error',
          type: 'bar',
          stack: 'total',
          data: regressionBySubsys.map((s) => s.failedCases),
          itemStyle: { color: theme.statusFail },
        },
        {
          name: '未跑',
          type: 'bar',
          stack: 'total',
          data: regressionBySubsys.map((s) => s.notRunCases),
          itemStyle: { color: theme.mutedColor },
        },
      ],
    };
  }, [regressionBySubsys]);

  if (!regressionProgress) return null;

  const passRate = regressionProgress.passRate;

  return (
    <div className="space-y-3">
      {/* ─── 统计数字卡片 ──────────────────────────────────── */}
      <div className="grid grid-cols-4 gap-2.5">
        <StatCard label="用例总数" value={regressionProgress.totalCases} variant="info" />
        <StatCard label="已通过" value={regressionProgress.passedCases} variant="pass" />
        <StatCard label="已跑未通过" value={regressionProgress.failedCases} variant="fail" />
        <StatCard label="未运行" value={regressionProgress.notRunCases} variant="muted" />
      </div>

      {/* ─── 整体通过率进度条 ─────────────────────────────── */}
      <div className="rounded-md border border-border bg-card p-3">
        <div className="mb-2 text-xs font-semibold text-muted-foreground">整体通过率</div>
        <div className="flex items-center gap-4 py-2">
          <div className="text-3xl font-bold text-status-pass-foreground">{passRate}%</div>
          <div className="flex-1">
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-status-pass transition-all"
                style={{ width: `${Math.min(100, passRate)}%` }}
              />
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
              <span>{regressionProgress.passedCases} pass / {regressionProgress.totalCases} total</span>
              <span>目标: 90%</span>
            </div>
          </div>
        </div>
      </div>

      {/* ─── 按子系统回归进度图 ───────────────────────────── */}
      {regressionBySubsys && regressionBySubsys.length > 0 && (
        <div className="rounded-md border border-border bg-card p-3">
          <div className="mb-2 text-xs font-semibold text-muted-foreground">
            按子系统回归进度
          </div>
          <ReactECharts
            option={bySubsysOption}
            style={{ height: '360px', width: '100%' }}
            opts={{ renderer: 'canvas' }}
          />
        </div>
      )}
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
    <div className={`rounded-md border p-3 text-center ${colorClasses[variant]}`}>
      <div className="text-lg font-bold text-foreground">{value}</div>
      <div className="mt-0.5 text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}
