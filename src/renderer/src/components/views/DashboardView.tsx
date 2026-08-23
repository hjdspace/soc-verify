/**
 * 总览视图（Mission Control 仪表盘）— 应用默认视图。
 *
 * 自上而下：ViewHeader（动作区）/ 里程碑 / KPI 行 / 中部网格（运行中仿真流 +
 * 覆盖率环）/ 底部网格（AI 活动流 + 失败聚焦）。
 * 数据全部只读复用现有 store 与查询：本视图是「重新编排 + 视觉统一」，
 * 不重写数据层（Issue #3 / Plan Slice 2）。
 */

import { useEffect, useState } from 'react';
import { Download, Play } from 'lucide-react';
import { ViewHeader } from '@renderer/components/layout/ViewHeader';
import { MilestoneBar, type MilestoneStep } from './dashboard/MilestoneBar';
import { AnalyticsDropdown } from './dashboard/AnalyticsDropdown';
import { KpiRow, type KpiCardData } from './dashboard/KpiRow';
import { RunningSimStream } from './dashboard/RunningSimStream';
import { CoverageRingPanel } from './dashboard/CoverageRingPanel';
import { AgentActivityPanel } from './dashboard/AgentActivityPanel';
import { FailureFocusPanel } from './dashboard/FailureFocusPanel';
import { useProjectStore } from '@renderer/stores/project';
import { useDashboardStore } from '@renderer/stores/dashboard';
import { useCoverageStore } from '@renderer/stores/coverage';
import { useUiStore } from '@renderer/stores/ui';
import { useWorkbenchStore } from '@renderer/stores/workbench';
import { computeMilestoneStatuses, type MilestoneNode } from '@shared/types/milestone';
import { cn } from '@renderer/lib/utils';

/** 失败自动重跑 pill（本地开关，动作接线后续切片补） */
function AutoRerunPill() {
  const [on, setOn] = useState(false);
  return (
    <button
      className={cn(
        'flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors',
        on
          ? 'border-primary/40 text-primary'
          : 'border-border text-muted-foreground hover:text-foreground',
      )}
      aria-pressed={on}
      data-testid="auto-rerun-pill"
      onClick={() => setOn((v) => !v)}
    >
      <span
        className={cn(
          'size-1.5 rounded-full',
          on ? 'animate-pulse bg-primary' : 'bg-muted-foreground/50',
        )}
      />
      失败自动重跑
    </button>
  );
}

/** 由 7 日趋势序列计算 KPI delta / sparkline（无数据返回 null，调用方降级隐藏） */
function trendSeries(trend7d: { date: string; pass: number; fail: number; error: number }[] | undefined) {
  if (!trend7d || trend7d.length < 2) {
    return { passDelta: null, failDelta: null, passSpark: null, failSpark: null };
  }
  const rate = trend7d.map((d) => {
    const total = d.pass + d.fail + d.error;
    return total > 0 ? (d.pass / total) * 100 : null;
  });
  const validRate = rate.filter((v): v is number => v !== null);
  const last = trend7d[trend7d.length - 1];
  const prev = trend7d[trend7d.length - 2];
  const lastRate = rate[rate.length - 1];
  const prevRate = rate[rate.length - 2];
  return {
    passDelta:
      lastRate !== null && prevRate !== null
        ? lastRate - prevRate
        : null,
    failDelta: last.fail - prev.fail,
    passSpark: validRate.length >= 2 ? validRate : null,
    failSpark: trend7d.map((d) => d.fail),
  };
}

export function DashboardView() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const projects = useProjectStore((s) => s.projects);
  const projectName = projects.find((p) => p.id === currentProjectId)?.name;

  const summary = useDashboardStore((s) => s.summary);
  const tabLoaded = useDashboardStore((s) => s.tabLoaded);
  const loadTabData = useDashboardStore((s) => s.loadTabData);
  const milestoneNodes = useDashboardStore((s) => s.milestones);
  const loadMilestones = useDashboardStore((s) => s.loadMilestones);

  const coverageOverview = useCoverageStore((s) => s.overview);
  const coverageLoading = useCoverageStore((s) => s.loading);
  const loadSessions = useCoverageStore((s) => s.loadSessions);
  const loadTree = useCoverageStore((s) => s.loadTree);
  const openExportDialog = useCoverageStore((s) => s.openExportDialog);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const openSubsystemCases = useUiStore((s) => s.openSubsystemCases);
  const openWorkbench = useWorkbenchStore((s) => s.open);

  // ─── 数据加载：overview 汇总 + 失败列表（dashboard store 现有查询） ───
  useEffect(() => {
    if (!currentProjectId) return;
    if (!tabLoaded.overview) void loadTabData('overview', currentProjectId);
    if (!tabLoaded.failures) void loadTabData('failures', currentProjectId);
    void loadMilestones(currentProjectId);
  }, [currentProjectId, tabLoaded.overview, tabLoaded.failures, loadTabData, loadMilestones]);

  // ─── 覆盖率汇总（coverage store 现有查询，已加载则跳过；每项目只请求一次，
  //     失败靠 coverage store 的 toast 报错，此处不无限重试） ───
  const [covRequestedFor, setCovRequestedFor] = useState<string | null>(null);
  useEffect(() => {
    if (!currentProjectId) return;
    if (coverageOverview !== null || coverageLoading) return;
    if (covRequestedFor === currentProjectId) return;
    setCovRequestedFor(currentProjectId);
    void loadSessions(currentProjectId).then(() => loadTree(currentProjectId));
  }, [currentProjectId, coverageOverview, coverageLoading, covRequestedFor, loadSessions, loadTree]);

  // ─── 仿真完成时刷新里程碑（冒烟测试/功能验证节点依赖仿真终态） ───
  useEffect(() => {
    if (!window.eventBridge || !currentProjectId) return;
    const unsubscribe = window.eventBridge.onSimulationEvent(({ type }) => {
      if (type === 'completed' || type === 'aborted') {
        void loadMilestones(currentProjectId);
        // 强制刷新汇总与失败列表（重置 loaded 标记后重新拉取）
        useDashboardStore.setState((s) => ({
          tabLoaded: { ...s.tabLoaded, overview: false, failures: false },
        }));
        void loadTabData('overview', currentProjectId);
        void loadTabData('failures', currentProjectId);
      }
    });
    return unsubscribe;
  }, [currentProjectId, loadMilestones, loadTabData]);

  const { passDelta, failDelta, passSpark, failSpark } = trendSeries(summary?.trend7d);

  const kpiCards: KpiCardData[] = [
    {
      id: 'functional-coverage',
      label: '功能覆盖率',
      value: coverageOverview ? coverageOverview.functional : null,
      unit: '%',
    },
    {
      id: 'code-coverage',
      label: '代码覆盖率',
      value: coverageOverview ? coverageOverview.line : null,
      unit: '%',
    },
    {
      id: 'pass-rate',
      label: '用例通过率',
      value: summary ? summary.passRate : null,
      unit: '%',
      delta: passDelta,
      spark: passSpark,
    },
    {
      id: 'active-failures',
      label: '活跃失败',
      value: summary ? summary.failCount : null,
      delta: failDelta,
      deltaGoodWhenUp: false,
      spark: failSpark,
    },
  ];

  // ─── 里程碑：服务端真实数据 + 覆盖率实时覆盖 + 动作绑定 ───
  const finalMilestones: MilestoneStep[] = computeMilestoneStatuses(
    (milestoneNodes ?? []).map((node: MilestoneNode) => {
      // 覆盖率收敛节点：用 coverage store 已加载的实时 overview 覆盖 done / hint
      if (node.id === 'coverage' && coverageOverview) {
        const functional = coverageOverview.functional;
        return {
          ...node,
          done: functional >= 90,
          hint: `功能覆盖 ${functional.toFixed(1)}% · 目标 ≥ 90%`,
        };
      }
      return node;
    }),
  ).map((node) => ({
    label: node.label,
    status: node.status,
    hint: node.hint,
    onClick: node.id === 'env-gen'
      ? () => openWorkbench({ type: 'sysbase-env-gen' })
      : undefined,
    actions: node.id === 'post-sim'
      ? [
          {
            label: '后仿用例调试',
            onClick: () => {
              useProjectStore.getState().setCaseStatusFilter('postSim');
              openSubsystemCases();
            },
            testId: 'milestone-postsim-cases',
          },
          {
            label: '时序用例分析',
            onClick: () => openWorkbench({ type: 'timing-violation' }),
            testId: 'milestone-timing-analysis',
          },
        ]
      : undefined,
  }));

  return (
    <div className="flex-1 overflow-y-auto p-5" data-testid="dashboard-view">
      <ViewHeader title="验证总览" subtitle={projectName}>
        <AutoRerunPill />
        <AnalyticsDropdown />
        <button
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-border/80 hover:bg-card hover:text-foreground"
          onClick={openExportDialog}
        >
          <Download className="size-3" />
          导出报告
        </button>
        <button
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3.5 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:opacity-90"
          title="前往回归视图选择回归列表启动"
          onClick={() => setActiveView('regression')}
          data-testid="launch-regression-btn"
        >
          <Play className="size-2.5" fill="currentColor" />
          启动回归
        </button>
      </ViewHeader>

      <MilestoneBar steps={finalMilestones} />

      <KpiRow cards={kpiCards} />

      <div className="mb-3 grid grid-cols-[1.6fr_1fr] gap-3">
        <RunningSimStream />
        <CoverageRingPanel />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <AgentActivityPanel />
        <FailureFocusPanel />
      </div>
    </div>
  );
}
