/**
 * OverviewTab — 概览标签页：汇总指标卡片 + Pass/Fail 饼图 + 14天趋势 + 子系统通过率柱状图。
 *
 * Issue 02: 从 dashboard store 读取 summary + subsysStatus 数据。
 * Update: 补充仿真通过/失败分布饼图、近14天趋势折线图、子系统通过率柱状图。
 */

import { useMemo, useEffect, useState } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { useDashboardStore } from '@renderer/stores/dashboard';
import { getEChartsTheme, onThemeChange } from '@renderer/lib/echarts-theme';

export function OverviewTab() {
  const summary = useDashboardStore((s) => s.summary);
  const subsysStatus = useDashboardStore((s) => s.subsysStatus);

  // Re-render when theme changes
  const [, setThemeTick] = useState(0);
  useEffect(() => {
    return onThemeChange(() => setThemeTick((t) => t + 1));
  }, []);

  if (!summary) return null;

  return (
    <div className="space-y-4">
      {/* ─── 汇总指标卡片 ─────────────────────────────────── */}
      <div className="grid grid-cols-4 gap-2.5">
        <MetricCard
          label="子系统"
          value={summary.subsysCount.toString()}
          variant="info"
        />
        <MetricCard
          label="用例总数"
          value={summary.caseCount.toString()}
          variant="violet"
        />
        <MetricCard
          label="通过率"
          value={`${summary.passRate}%`}
          variant="pass"
        />
        <MetricCard
          label="失败数"
          value={summary.failCount.toString()}
          variant="fail"
        />
      </div>

      {/* ─── Pass/Fail 饼图 + 14天趋势折线图 ──────────────── */}
      <div className="grid grid-cols-2 gap-3">
        <PassFailChart summary={summary} />
        <TrendChart trend7d={summary.trend7d} />
      </div>

      {/* ─── 子系统通过率柱状图 ─────────────────────────────── */}
      {subsysStatus && subsysStatus.length > 0 && (
        <SubsysBarChart subsysStatus={subsysStatus} />
      )}

      {/* ─── 子系统状态表 ─────────────────────────────────── */}
      {subsysStatus && subsysStatus.length > 0 && (
        <div className="rounded-md border border-border bg-card p-3">
          <div className="mb-2 text-xs font-semibold text-muted-foreground">
            子系统通过率明细表
          </div>
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-left text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                  子系统
                </th>
                <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-right text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                  用例数
                </th>
                <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-right text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                  Pass
                </th>
                <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-right text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                  Fail
                </th>
                <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-right text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                  通过率
                </th>
              </tr>
            </thead>
            <tbody>
              {subsysStatus.map((s) => (
                <tr key={s.name} className="hover:bg-accent">
                  <td className="border-b border-border px-2.5 py-1 text-foreground">
                    {s.name}
                  </td>
                  <td className="border-b border-border px-2.5 py-1 text-right font-semibold tabular-nums text-foreground">
                    {s.caseCount}
                  </td>
                  <td className="border-b border-border px-2.5 py-1 text-right font-semibold tabular-nums text-status-pass-foreground">
                    {s.pass}
                  </td>
                  <td className="border-b border-border px-2.5 py-1 text-right font-semibold tabular-nums text-status-fail-foreground">
                    {s.fail}
                  </td>
                  <td className="border-b border-border px-2.5 py-1 text-right font-semibold tabular-nums text-foreground">
                    {s.passRate}%
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

// ─── Pass/Fail 饼图 ──────────────────────────────────────────

function PassFailChart({ summary }: { summary: { passRate: number; failCount: number; caseCount: number; trend7d: { pass: number; fail: number; error: number }[] } }) {
  const totalPass = summary.trend7d.reduce((s, t) => s + t.pass, 0);
  const totalFail = summary.trend7d.reduce((s, t) => s + t.fail, 0);
  const totalError = summary.trend7d.reduce((s, t) => s + t.error, 0);

  const option = useMemo<EChartsOption>(() => {
    const theme = getEChartsTheme();
    return {
      backgroundColor: 'transparent',
      tooltip: { trigger: 'item' },
      legend: { bottom: 0, textStyle: { color: theme.mutedColor, fontSize: 10 } },
      series: [{
        type: 'pie',
        radius: ['40%', '65%'],
        center: ['50%', '45%'],
        label: { show: false },
        data: [
          { value: totalPass, name: 'Pass', itemStyle: { color: theme.statusPass } },
          { value: totalFail, name: 'Fail', itemStyle: { color: theme.statusFail } },
          { value: totalError, name: 'Error', itemStyle: { color: theme.statusError } },
        ],
      }],
    };
  }, [totalPass, totalFail, totalError]);

  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="mb-2 text-xs font-semibold text-muted-foreground">仿真通过/失败分布</div>
      <ReactECharts option={option} style={{ height: '200px', width: '100%' }} opts={{ renderer: 'canvas' }} />
    </div>
  );
}

// ─── 14天趋势折线图 ──────────────────────────────────────────

function TrendChart({ trend7d }: { trend7d: { date: string; pass: number; fail: number; error: number }[] }) {
  const option = useMemo<EChartsOption>(() => {
    const theme = getEChartsTheme();
    return {
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis' },
      legend: { bottom: 0, textStyle: { color: theme.mutedColor, fontSize: 10 } },
      grid: { left: '3%', right: '4%', bottom: '15%', top: '5%', containLabel: true },
      xAxis: {
        type: 'category',
        data: trend7d.map((t) => t.date),
        axisLabel: { fontSize: 9, color: theme.mutedColor },
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 9, color: theme.mutedColor },
      },
      series: [
        {
          name: 'Pass', type: 'line', smooth: true,
          data: trend7d.map((t) => t.pass),
          itemStyle: { color: theme.statusPass },
          areaStyle: { opacity: 0.1 },
        },
        {
          name: 'Fail', type: 'line', smooth: true,
          data: trend7d.map((t) => t.fail),
          itemStyle: { color: theme.statusFail },
        },
      ],
    };
  }, [trend7d]);

  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="mb-2 text-xs font-semibold text-muted-foreground">近 7 天趋势</div>
      <ReactECharts option={option} style={{ height: '200px', width: '100%' }} opts={{ renderer: 'canvas' }} />
    </div>
  );
}

// ─── 子系统通过率柱状图 ──────────────────────────────────────

function SubsysBarChart({ subsysStatus }: { subsysStatus: { name: string; caseCount: number; pass: number; fail: number; passRate: number }[] }) {
  const option = useMemo<EChartsOption>(() => {
    const theme = getEChartsTheme();
    return {
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis' },
      legend: { bottom: 0, textStyle: { color: theme.mutedColor, fontSize: 10 } },
      grid: { left: '3%', right: '4%', bottom: '15%', top: '5%', containLabel: true },
      xAxis: {
        type: 'category',
        data: subsysStatus.map((s) => s.name),
        axisLabel: { fontSize: 9, rotate: 30, color: theme.mutedColor },
      },
      yAxis: {
        type: 'value',
        max: 100,
        axisLabel: { fontSize: 9, formatter: '{value}%', color: theme.mutedColor },
      },
      series: [
        {
          name: '通过率',
          type: 'bar',
          data: subsysStatus.map((s) => s.passRate),
          itemStyle: { color: theme.statusPass, borderRadius: [2, 2, 0, 0] },
        },
      ],
    };
  }, [subsysStatus]);

  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="mb-2 text-xs font-semibold text-muted-foreground">子系统通过率概览</div>
      <ReactECharts option={option} style={{ height: '280px', width: '100%' }} opts={{ renderer: 'canvas' }} />
    </div>
  );
}

// ─── Metric Card ────────────────────────────────────────────

function MetricCard({
  label,
  value,
  variant,
}: {
  label: string;
  value: string;
  variant: 'pass' | 'fail' | 'info' | 'violet';
}) {
  const colorClasses: Record<typeof variant, string> = {
    pass: 'border-status-pass/30 bg-status-pass/8 text-status-pass-foreground',
    fail: 'border-status-fail/30 bg-status-fail/8 text-status-fail-foreground',
    info: 'border-primary/30 bg-primary/8 text-primary',
    violet: 'border-accent/30 bg-accent/8 text-accent-foreground',
  };

  return (
    <div className={`rounded-md border p-3 ${colorClasses[variant]}`}>
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-lg font-bold text-foreground">{value}</div>
    </div>
  );
}
