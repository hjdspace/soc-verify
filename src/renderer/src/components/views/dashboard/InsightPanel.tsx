/**
 * InsightPanel — 总览页洞察轮播宿主（issues #9）。
 *
 * 把 dashboard store 已有查询映射为 InsightCards 的三页洞察：
 * - getTrend → 双系列对比折线（通过 / 失败，近 14 个点）；
 * - getUnstableCases → 异常检测柱状（失败率 / 失败次数 metric 切换，50% 阈值线）；
 * - getRecentFailures → 占比分段条（失败按子系统占比，点选驱动大数字）。
 * 数据缺失的页自动省略（诚实呈现），全空时整块隐藏。
 * trend/unstable 两个标签页数据在本面板挂载时按需拉取（tabLoaded 防重复）。
 *
 * 追问 pill 点击：打开 AI 面板（drawer 模式开抽屉 / docked 模式展开右栏），
 * 无活跃会话先 createSession，再经 session-messages.sendMessage 走现有发送链路。
 */

import { useEffect, useMemo, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import {
  InsightCards,
  type InsightPage,
  type InsightMetricDef,
} from '@renderer/components/ui/InsightCards';
import {
  useDashboardStore,
  type RecentFailuresData,
  type TrendData,
  type UnstableCasesData,
} from '@renderer/stores/dashboard';
import { useProjectStore } from '@renderer/stores/project';
import { useSessionCoreStore } from '@renderer/stores/session-core';
import { useSessionMessagesStore } from '@renderer/stores/session-messages';
import { useUiStore } from '@renderer/stores/ui';
import { cn } from '@renderer/lib/utils';

/** 对比折线展示的点数上限（趋势序列可能覆盖全部历史） */
const TREND_WINDOW = 14;
/** 异常检测柱状展示的不稳定用例数上限 */
const UNSTABLE_TOP = 6;
/** 失败占比分段条展示的子系统数上限（其余合并为「其他」） */
const ALLOCATION_TOP = 3;
/** 失败率异常阈值（%）：超过半数失败即视为异常 */
const FAIL_RATE_THRESHOLD = 50;

/** 行内着色数值（页首叙述用：次数/百分比等待强调的事实值） */
function Num({ children, tone }: { children: ReactNode; tone?: 'pass' | 'fail' }) {
  return (
    <span
      className={cn(
        'font-medium tabular-nums',
        tone === 'pass' && 'text-status-pass',
        tone === 'fail' && 'text-status-fail',
      )}
    >
      {children}
    </span>
  );
}

/** 行内强调（用例名等非数值事实） */
function Name({ children }: { children: ReactNode }) {
  return <span className="font-medium">{children}</span>;
}

/** 用例名截断（柱状/图例空间有限） */
function shortName(name: string, max = 12): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * store 数据 → 洞察页序列（纯函数）。三页分别依赖 trend / unstableCases /
 * recentFailures，缺数的页省略；顺序固定：趋势对比 → 异常检测 → 失败占比。
 * trend 的粒度（daily/weekly）决定叙述单位（天/周）与悬停标签格式。
 */
export function buildInsightPages(data: {
  trend: TrendData | null;
  trendGranularity: 'daily' | 'weekly';
  unstableCases: UnstableCasesData | null;
  recentFailures: RecentFailuresData | null;
}): InsightPage[] {
  const pages: InsightPage[] = [];
  const { trend, trendGranularity, unstableCases, recentFailures } = data;
  const weekly = trendGranularity === 'weekly';

  // ── 页 1：通过 / 失败双系列对比折线 ──
  if (trend && trend.length >= 2) {
    const recent = trend.slice(-TREND_WINDOW);
    // daily 取 'MM-DD'；weekly（'YYYY-WW'）整串保留年份避免歧义
    const labels = recent.map((d) => (weekly ? d.date : d.date.slice(5)));
    const last = recent.at(-1);
    const prev = recent.at(-2);
    const totalPass = recent.reduce((sum, d) => sum + d.pass, 0);
    const totalFail = recent.reduce((sum, d) => sum + d.fail, 0);
    const lastTotal = last ? last.pass + last.fail + last.error : 0;
    const passRate = last && lastTotal > 0 ? round1((last.pass / lastTotal) * 100) : null;
    const failDelta = last && prev ? last.fail - prev.fail : null;

    pages.push({
      key: 'trend',
      prose: (
        <>
          最近 {recent.length} 个{weekly ? '周' : '天'}通过 <Num tone="pass">{totalPass}</Num> 次、
          失败 <Num tone="fail">{totalFail}</Num> 次
          {passRate !== null && (
            <>
              ，最新通过率 <Num tone={passRate >= 80 ? 'pass' : 'fail'}>{passRate}%</Num>
            </>
          )}
          。
        </>
      ),
      pill: '帮我分析近期通过率趋势',
      card: {
        kind: 'compare',
        caption: weekly ? '通过 / 失败按周趋势' : '通过 / 失败按日趋势',
        badge: '趋势',
        labels,
        series: [
          {
            name: '通过',
            values: recent.map((d) => d.pass),
            colorVar: '--status-pass',
            tone: 'pass',
            format: (v) => `${Math.round(v)} 次`,
            sub: passRate !== null ? `通过率 ${passRate}%` : undefined,
            subTone: 'pass',
          },
          {
            name: '失败',
            values: recent.map((d) => d.fail),
            colorVar: '--status-fail',
            tone: 'fail',
            format: (v) => `${Math.round(v)} 次`,
            sub: failDelta !== null ? `较前日 ${failDelta >= 0 ? '+' : ''}${failDelta}` : undefined,
            subTone: failDelta !== null && failDelta > 0 ? 'fail' : 'pass',
          },
        ],
      },
    });
  }

  // ── 页 2：不稳定用例异常检测（失败率 / 失败次数 metric 切换） ──
  if (unstableCases && unstableCases.length > 0) {
    const top = unstableCases.slice(0, UNSTABLE_TOP);
    const topCase = unstableCases[0];
    const rateMetric: InsightMetricDef = {
      key: 'rate',
      label: '失败率',
      values: top.map((c) => c.failRate),
      labels: top.map((c) => shortName(c.caseName)),
      headerLabel: `失败率 ≥ ${FAIL_RATE_THRESHOLD}% 阈值`,
      threshold: FAIL_RATE_THRESHOLD,
      format: (v) => `${round1(v)}%`,
    };
    const countMetric: InsightMetricDef = {
      key: 'count',
      label: '失败次数',
      values: top.map((c) => c.failCount),
      labels: top.map((c) => shortName(c.caseName)),
      headerLabel: `共 ${unstableCases.length} 个不稳定用例`,
      format: (v) => `${Math.round(v)} 次`,
    };

    pages.push({
      key: 'unstable',
      prose: (
        <>
          最不稳定用例 <Name>{shortName(topCase.caseName)}</Name> 失败率{' '}
          <Num tone="fail">{topCase.failRate}%</Num>（失败 {topCase.failCount} 次）。
        </>
      ),
      pill: '给出不稳定用例的排查建议',
      card: {
        kind: 'anomaly',
        title: (
          <>
            <TriangleAlert className="size-3 text-status-fail" />
            不稳定用例 Top {top.length}
          </>
        ),
        metrics: [rateMetric, countMetric],
        footer: {
          value: `${unstableCases.length} 个`,
          note: '筛选范围内通过且失败过的用例',
        },
      },
    });
  }

  // ── 页 3：近期失败按子系统占比（点选驱动大数字） ──
  if (recentFailures && recentFailures.length > 0) {
    const bySubsys = new Map<string, number>();
    for (const f of recentFailures) {
      bySubsys.set(f.subsys, (bySubsys.get(f.subsys) ?? 0) + 1);
    }
    const entries = [...bySubsys.entries()].sort((a, b) => b[1] - a[1]);
    const total = recentFailures.length;
    const segColors = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)'];
    const top = entries.slice(0, ALLOCATION_TOP);
    const restCount = entries.slice(ALLOCATION_TOP).reduce((sum, [, n]) => sum + n, 0);

    const segments = top.map(([subsys, count], i) => ({
      key: subsys,
      label: subsys,
      pct: round1((count / total) * 100),
      value: `${count} 次`,
      color: segColors[i] ?? 'var(--muted-foreground)',
      detail: `${subsys} 占近期失败的 ${round1((count / total) * 100)}%（${count} / ${total} 次）。`,
    }));
    if (restCount > 0) {
      const topPct = segments.reduce((sum, s) => sum + s.pct, 0);
      segments.push({
        key: '__rest__',
        label: '其他',
        pct: round1(Math.max(0, 100 - topPct)),
        value: `${restCount} 次`,
        color: 'var(--muted-foreground)',
        detail: `其余 ${entries.length - top.length} 个子系统合计 ${restCount} 次失败。`,
      });
    }
    const [topSubsys, topCount] = top[0];

    pages.push({
      key: 'allocation',
      prose: (
        <>
          近期失败集中在 <Name>{topSubsys}</Name>（占{' '}
          <Num tone="fail">{round1((topCount / total) * 100)}%</Num>）。
        </>
      ),
      pill: '如何降低该子系统的失败占比',
      card: {
        kind: 'allocation',
        title: <>近期失败子系统占比</>,
        segments,
      },
    });
  }

  return pages;
}

/** 打开 AI 面板（两种呈现模式都覆盖），确保有活跃会话后发送消息 */
async function askFollowUp(text: string): Promise<void> {
  const ui = useUiStore.getState();
  if (ui.aiPanelMode === 'drawer') {
    if (!ui.rightDrawerOpen) useUiStore.setState({ rightDrawerOpen: true });
  } else if (ui.rightPanelCollapsed) {
    ui.toggleRightPanel();
  }

  const core = useSessionCoreStore.getState();
  if (!core.currentSessionId) {
    const { currentProjectId, projects } = useProjectStore.getState();
    const project = projects.find((p) => p.id === currentProjectId);
    if (!currentProjectId || !project) return;
    await core.createSession(currentProjectId, project.rootPath);
  }
  await useSessionMessagesStore.getState().sendMessage(text);
}

export function InsightPanel() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const trend = useDashboardStore((s) => s.trend) ?? null;
  const trendGranularity = useDashboardStore((s) => s.trendGranularity);
  const unstableCases = useDashboardStore((s) => s.unstableCases) ?? null;
  const recentFailures = useDashboardStore((s) => s.recentFailures) ?? null;
  const tabLoaded = useDashboardStore((s) => s.tabLoaded);
  const loadTabData = useDashboardStore((s) => s.loadTabData);

  // 趋势 / 不稳定数据按需拉取（失败列表由 DashboardView 统一加载）
  useEffect(() => {
    if (!currentProjectId) return;
    if (!tabLoaded.trend) void loadTabData('trend', currentProjectId);
    if (!tabLoaded.unstable) void loadTabData('unstable', currentProjectId);
  }, [currentProjectId, tabLoaded.trend, tabLoaded.unstable, loadTabData]);

  const pages = useMemo(
    () => buildInsightPages({ trend, trendGranularity, unstableCases, recentFailures }),
    [trend, trendGranularity, unstableCases, recentFailures],
  );

  if (pages.length === 0) return null;

  return (
    <section className="mb-3 max-w-md">
      <InsightCards
        pages={pages}
        title="验证洞察"
        testId="insight-panel"
        onAskPill={(pill) => void askFollowUp(pill)}
      />
    </section>
  );
}
