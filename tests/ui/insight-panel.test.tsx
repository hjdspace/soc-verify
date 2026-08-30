// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { RecentFailuresData, TrendData, UnstableCasesData } from '@renderer/stores/dashboard';

/**
 * 洞察面板宿主（issues #9）：store 数据 → 三页洞察的映射（缺数页省略、全空隐藏）、
 * trend/unstable 按需拉取、追问 pill 打开 AI 抽屉并走 sendMessage 现有链路。
 * dashboard store 用 selector 直读 mock；session-core/messages 只用到 getState，
 * 以对象 stub；ui / project 为纯 zustand，使用真实 store。
 */

const mocks = vi.hoisted(() => ({
  dash: {
    trend: null as TrendData | null,
    trendGranularity: 'daily' as 'daily' | 'weekly',
    unstableCases: null as UnstableCasesData | null,
    recentFailures: null as RecentFailuresData | null,
    tabLoaded: {} as Record<string, boolean | undefined>,
    loadTabData: vi.fn().mockResolvedValue(undefined),
  },
  currentSessionId: null as string | null,
  createSession: vi.fn().mockResolvedValue('s-new'),
  sendMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@renderer/stores/dashboard', () => ({
  useDashboardStore: (selector: (s: typeof mocks.dash) => unknown) => selector(mocks.dash),
}));

vi.mock('@renderer/stores/session-core', () => ({
  useSessionCoreStore: {
    getState: () => ({ currentSessionId: mocks.currentSessionId, createSession: mocks.createSession }),
  },
}));

vi.mock('@renderer/stores/session-messages', () => ({
  useSessionMessagesStore: {
    getState: () => ({ sendMessage: mocks.sendMessage }),
  },
}));

// InsightPanel 会渲染 recharts 图表，jsdom 下量不到尺寸——共享透传 stub（见 recharts-stub.tsx）
vi.mock('recharts', async () => {
  const { rechartsStubFactory } = await import('./recharts-stub');
  return rechartsStubFactory();
});

import { buildInsightPages, InsightPanel } from '@renderer/components/views/dashboard/InsightPanel';
import { useProjectStore } from '@renderer/stores/project';
import { useUiStore } from '@renderer/stores/ui';

const TREND: TrendData = [
  { date: '2026-08-20', pass: 90, fail: 8, error: 2 },
  { date: '2026-08-21', pass: 92, fail: 6, error: 1 },
  { date: '2026-08-22', pass: 88, fail: 10, error: 2 },
];

const UNSTABLE: UnstableCasesData = [
  { caseName: 'i2c_arbitration_lost', subsys: 'I2C', passCount: 5, failCount: 10, totalCount: 15, failRate: 66.7, lastStatus: 'fail' },
  { caseName: 'uart_parity_inject', subsys: 'UART', passCount: 10, failCount: 6, totalCount: 16, failRate: 37.5, lastStatus: 'pass' },
];

const FAILURES: RecentFailuresData = [
  { caseName: 'i2c_arbitration_lost', subsys: 'I2C', status: 'fail', startTime: '2026-08-21T14:00:00Z', durationMs: 1000 },
  { caseName: 'i2c_arbitration_lost', subsys: 'I2C', status: 'fail', startTime: '2026-08-21T15:00:00Z', durationMs: 1000 },
  { caseName: 'uart_parity_inject', subsys: 'UART', status: 'fail', startTime: '2026-08-21T16:00:00Z', durationMs: null },
];

beforeEach(() => {
  mocks.dash.trend = null;
  mocks.dash.trendGranularity = 'daily';
  mocks.dash.unstableCases = null;
  mocks.dash.recentFailures = null;
  mocks.dash.tabLoaded = {};
  mocks.dash.loadTabData.mockClear();
  mocks.currentSessionId = 's1';
  mocks.createSession.mockClear();
  mocks.sendMessage.mockClear();
  useProjectStore.setState({
    currentProjectId: 'proj-1',
    projects: [{ id: 'proj-1', name: 'neckar-dv', rootPath: '/proj/neckar-dv', createdAt: 0, lastOpenedAt: 0 }],
  });
  useUiStore.setState({ aiPanelMode: 'drawer', rightDrawerOpen: false });
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('buildInsightPages（数据 → 页映射）', () => {
  it('全量数据映射为三页：趋势对比 → 异常检测 → 失败占比', () => {
    const pages = buildInsightPages({ trend: TREND, trendGranularity: 'daily', unstableCases: UNSTABLE, recentFailures: FAILURES });
    expect(pages.map((p) => p.key)).toEqual(['trend', 'unstable', 'allocation']);
    expect(pages[0]?.card.kind).toBe('compare');
    expect(pages[1]?.card.kind).toBe('anomaly');
    expect(pages[2]?.card.kind).toBe('allocation');
  });

  it('缺数的页自动省略（诚实呈现）', () => {
    const onlyFailures = buildInsightPages({ trend: null, trendGranularity: 'daily', unstableCases: null, recentFailures: FAILURES });
    expect(onlyFailures).toHaveLength(1);
    expect(onlyFailures[0]?.card.kind).toBe('allocation');
  });

  it('趋势不足 2 点不出对比页（无法成线）', () => {
    const pages = buildInsightPages({ trend: TREND.slice(0, 1), trendGranularity: 'daily', unstableCases: null, recentFailures: null });
    expect(pages).toHaveLength(0);
  });

  it('周粒度下叙述单位为「周」、悬停标签保留完整周标识', () => {
    const weeklyTrend: TrendData = [
      { date: '2026-33', pass: 200, fail: 20, error: 5 },
      { date: '2026-34', pass: 210, fail: 15, error: 3 },
    ];
    const pages = buildInsightPages({ trend: weeklyTrend, trendGranularity: 'weekly', unstableCases: null, recentFailures: null });
    expect(pages).toHaveLength(1);
    expect(pages[0]?.prose).toBeTruthy();
    // prose 描述「周」而非「天」：渲染验证在 InsightPanel 用例（prose 是 ReactNode，
    // 这里断言 compare 卡标签保留 '2026-34' 全串）
    const card = pages[0]?.card;
    expect(card?.kind).toBe('compare');
    if (card?.kind !== 'compare') return;
    expect(card.labels).toEqual(['2026-33', '2026-34']);
  });

  it('占比页按子系统聚合计数、降序，超出 Top3 的合并为「其他」并吸收剩余百分比', () => {
    const many: RecentFailuresData = [
      ...Array.from({ length: 5 }, () => ({ caseName: 'a', subsys: 'ALU', status: 'fail', startTime: '2026-08-21T14:00:00Z', durationMs: null })),
      ...Array.from({ length: 3 }, () => ({ caseName: 'b', subsys: 'DMA', status: 'fail', startTime: '2026-08-21T14:00:00Z', durationMs: null })),
      ...Array.from({ length: 2 }, () => ({ caseName: 'c', subsys: 'UART', status: 'fail', startTime: '2026-08-21T14:00:00Z', durationMs: null })),
      ...Array.from({ length: 1 }, () => ({ caseName: 'd', subsys: 'CLK', status: 'fail', startTime: '2026-08-21T14:00:00Z', durationMs: null })),
    ];
    const pages = buildInsightPages({ trend: null, trendGranularity: 'daily', unstableCases: null, recentFailures: many });
    const card = pages[0]?.card;
    expect(card?.kind).toBe('allocation');
    if (card?.kind !== 'allocation') return;
    expect(card.segments.map((s) => s.label)).toEqual(['ALU', 'DMA', 'UART', '其他']);
    expect(card.segments.map((s) => s.value)).toEqual(['5 次', '3 次', '2 次', '1 次']);
    expect(card.segments.reduce((sum, s) => sum + s.pct, 0)).toBe(100);
  });
});

describe('InsightPanel', () => {
  it('全量数据渲染三页轮播，页头计数 3', () => {
    mocks.dash.trend = TREND;
    mocks.dash.unstableCases = UNSTABLE;
    mocks.dash.recentFailures = FAILURES;
    render(<InsightPanel />);

    expect(screen.getByTestId('insight-panel')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByTestId('ins-card-compare')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ins-next'));
    expect(screen.getByTestId('ins-card-anomaly')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ins-next'));
    expect(screen.getByTestId('ins-card-allocation')).toBeInTheDocument();
  });

  it('周粒度趋势叙述单位为「周」（默认 daily 为「天」）', () => {
    mocks.dash.trend = TREND;
    mocks.dash.trendGranularity = 'weekly';
    render(<InsightPanel />);
    expect(screen.getByTestId('insight-panel').textContent).toContain('最近 3 个周');
  });

  it('全空数据整块隐藏（不渲染空面板）', () => {
    const { container } = render(<InsightPanel />);
    expect(screen.queryByTestId('insight-panel')).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it('挂载时按需拉取 trend/unstable（失败列表由 DashboardView 负责）', () => {
    render(<InsightPanel />);
    expect(mocks.dash.loadTabData).toHaveBeenCalledWith('trend', 'proj-1');
    expect(mocks.dash.loadTabData).toHaveBeenCalledWith('unstable', 'proj-1');
    expect(mocks.dash.loadTabData).not.toHaveBeenCalledWith('failures', 'proj-1');
  });

  it('tabLoaded 标记已置位时不重复拉取', () => {
    mocks.dash.tabLoaded = { trend: true, unstable: true };
    render(<InsightPanel />);
    expect(mocks.dash.loadTabData).not.toHaveBeenCalled();
  });

  it('追问 pill 打开 AI 抽屉并经 sendMessage 发送（现有会话直接发送）', () => {
    mocks.dash.recentFailures = FAILURES;
    render(<InsightPanel />);

    fireEvent.click(screen.getByTestId('ins-pill'));
    expect(mocks.sendMessage).toHaveBeenCalledWith('如何降低该子系统的失败占比');
    expect(useUiStore.getState().rightDrawerOpen).toBe(true);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('无活跃会话时先建会话再发送', async () => {
    mocks.currentSessionId = null;
    mocks.dash.recentFailures = FAILURES;
    render(<InsightPanel />);

    fireEvent.click(screen.getByTestId('ins-pill'));
    await vi.waitFor(() => expect(mocks.sendMessage).toHaveBeenCalled());
    expect(mocks.createSession).toHaveBeenCalledWith('proj-1', '/proj/neckar-dv');
  });

  it('docked 模式下追问收起态展开右栏（不开抽屉）', () => {
    useUiStore.setState({ aiPanelMode: 'docked', rightPanelCollapsed: true });
    mocks.dash.recentFailures = FAILURES;
    render(<InsightPanel />);

    fireEvent.click(screen.getByTestId('ins-pill'));
    expect(useUiStore.getState().rightPanelCollapsed).toBe(false);
    expect(useUiStore.getState().rightDrawerOpen).toBe(false);
  });
});
