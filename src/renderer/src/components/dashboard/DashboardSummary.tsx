/**
 * DashboardSummary — 左栏概览页的 Dashboard 缩略信息。
 *
 * Issue 02: 迷你回归进度条 + 7 天 pass/fail sparkline + 打开仪表盘按钮。
 * 数据来源为 dashboard.getSummary procedure（复用概览标签页数据）。
 */

import { useEffect, useMemo, useState } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { LayoutDashboard } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import { useWorkbenchStore } from '@renderer/stores/workbench';
import { getEChartsTheme, onThemeChange } from '@renderer/lib/echarts-theme';
import type { SummaryData } from '@renderer/stores/dashboard';

export function DashboardSummary({ projectId }: { projectId: string }) {
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [loading, setLoading] = useState(false);
  const openDestination = useWorkbenchStore((s) => s.open);

  // Re-render when theme changes
  const [, setThemeTick] = useState(0);
  useEffect(() => {
    return onThemeChange(() => setThemeTick((t) => t + 1));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    trpc.dashboard.getSummary.query({ projectId })
      .then((data) => {
        if (!cancelled) {
          setSummary(data);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [projectId]);

  if (loading || !summary) return null;

  // Mini progress: use pass runs as "已跑" approximation
  // trend7d total pass+fail+error as recent runs
  const recentRuns = summary.trend7d.reduce(
    (sum, t) => sum + t.pass + t.fail + t.error,
    0,
  );
  const recentPass = summary.trend7d.reduce((sum, t) => sum + t.pass, 0);
  const progressPercent = summary.caseCount > 0
    ? Math.min(100, Math.round((recentPass / summary.caseCount) * 100))
    : 0;

  return (
    <div className="mt-2 space-y-2">
      {/* ─── 迷你回归进度条 ──────────────────────────────── */}
      <div className="rounded-md border border-border/50 bg-background/40 px-2.5 py-2">
        <div className="mb-1 text-[10px] text-muted-foreground">回归进度</div>
        <div className="h-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-status-pass transition-all"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
        <div className="mt-1 flex justify-between text-[9px] text-muted-foreground">
          <span>已跑 {recentRuns} / {summary.caseCount}</span>
          <span>{progressPercent}%</span>
        </div>
      </div>

      {/* ─── 7 天 sparkline ──────────────────────────────── */}
      <div className="rounded-md border border-border/50 bg-background/40 px-2.5 py-2">
        <div className="mb-1 text-[10px] text-muted-foreground">近 7 天 pass/fail 趋势</div>
        <Sparkline trend7d={summary.trend7d} />
      </div>

      {/* ─── 打开仪表盘按钮 ──────────────────────────────── */}
      <button
        onClick={() => openDestination({ type: 'dashboard' })}
        className="flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-[11px] font-semibold text-primary-foreground transition-opacity hover:opacity-85"
      >
        <LayoutDashboard className="h-3 w-3" />
        打开完整仪表盘
      </button>
    </div>
  );
}

// ─── Sparkline ──────────────────────────────────────────────

function Sparkline({
  trend7d,
}: {
  trend7d: { date: string; pass: number; fail: number; error: number }[];
}) {
  const [, setThemeTick] = useState(0);
  useEffect(() => {
    return onThemeChange(() => setThemeTick((t) => t + 1));
  }, []);

  const option = useMemo<EChartsOption>(() => {
    const theme = getEChartsTheme();
    const dates = trend7d.map((t) => t.date);
    return {
      backgroundColor: 'transparent',
      xAxis: {
        type: 'category',
        data: dates,
        show: false,
      },
      yAxis: {
        type: 'value',
        show: false,
      },
      grid: {
        left: 0,
        right: 0,
        top: 2,
        bottom: 0,
      },
      series: [
        {
          name: 'Pass',
          type: 'line',
          data: trend7d.map((t) => t.pass),
          smooth: true,
          symbol: 'none',
          lineStyle: { width: 1.5, color: theme.statusPass },
          areaStyle: { opacity: 0.15, color: theme.statusPass },
        },
        {
          name: 'Fail',
          type: 'line',
          data: trend7d.map((t) => t.fail),
          smooth: true,
          symbol: 'none',
          lineStyle: { width: 1.5, color: theme.statusFail },
          areaStyle: { opacity: 0.15, color: theme.statusFail },
        },
      ],
      tooltip: { show: false },
    };
  }, [trend7d]);

  return (
    <ReactECharts
      option={option}
      style={{ height: '40px', width: '100%' }}
      opts={{ renderer: 'canvas' }}
    />
  );
}
