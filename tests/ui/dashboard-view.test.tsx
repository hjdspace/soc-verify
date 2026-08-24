// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SimulationRunRecord } from '@renderer/stores/simulation';
import type { ChatMessage, SessionEntry } from '@renderer/stores/session-types';
import type { CoverageSummary } from '@shared/types/coverage';
import type { SummaryData, RecentFailuresData } from '@renderer/stores/dashboard';

/**
 * 总览视图（Issue #3）测试：KPI 渲染 / sparkline 降级 / 里程碑 /
 * 运行中仿真流 / 覆盖率环 / AI 活动流 / 失败面板 pill / 空数据态。
 * 数据依赖的 store 全部 mock（selector 直读可变状态）；
 * ui / workbench 为纯 zustand，使用真实 store。
 */

const mocks = vi.hoisted(() => ({
  sim: {
    activeRuns: [] as SimulationRunRecord[],
    loadActiveRuns: vi.fn().mockResolvedValue(undefined),
  },
  cov: {
    overview: null as CoverageSummary | null,
    loading: false,
    loadSessions: vi.fn().mockResolvedValue(undefined),
    loadTree: vi.fn().mockResolvedValue(undefined),
    openExportDialog: vi.fn(),
  },
  dash: {
    summary: null as SummaryData | null,
    recentFailures: null as RecentFailuresData | null,
    loadingTab: null as string | null,
    tabLoaded: {} as Record<string, boolean | undefined>,
    milestones: null as import('@shared/types/milestone').MilestoneNode[] | null,
    loadTabData: vi.fn().mockResolvedValue(undefined),
    loadMilestones: vi.fn().mockResolvedValue(undefined),
  },
  sess: {
    sessions: [] as SessionEntry[],
    currentSessionId: null as string | null,
  },
  proj: {
    currentProjectId: 'proj-1' as string | null,
    projects: [
      { id: 'proj-1', name: 'neckar-dv', rootPath: '/proj/neckar-dv', createdAt: 0, lastOpenedAt: 0 },
    ],
  },
}));

vi.mock('@renderer/stores/simulation', () => ({
  useSimulationStore: (selector: (s: typeof mocks.sim) => unknown) => selector(mocks.sim),
}));

vi.mock('@renderer/stores/coverage', () => ({
  useCoverageStore: (selector: (s: typeof mocks.cov) => unknown) => selector(mocks.cov),
}));

vi.mock('@renderer/stores/dashboard', () => ({
  useDashboardStore: (selector: (s: typeof mocks.dash) => unknown) => selector(mocks.dash),
}));

vi.mock('@renderer/stores/session', () => ({
  useSessionStore: (selector: (s: typeof mocks.sess) => unknown) => selector(mocks.sess),
}));

vi.mock('@renderer/stores/project', () => ({
  useProjectStore: (selector: (s: typeof mocks.proj) => unknown) => selector(mocks.proj),
}));

import { DashboardView } from '@renderer/components/views/DashboardView';
import { useUiStore } from '@renderer/stores/ui';
import { useWorkbenchStore } from '@renderer/stores/workbench';

function makeCoverageSummary(): CoverageSummary {
  return {
    overall: 85.7, line: 92.1, branch: 84.6, toggle: 80, condition: 82,
    fsm_state: 78, fsm_transition: 76, functional: 87.3, assertion: 78.9,
  };
}

function makeRun(partial: Partial<SimulationRunRecord> & { runId: string }): SimulationRunRecord {
  const { runId, ...rest } = partial;
  return {
    runId,
    projectId: 'proj-1',
    caseId: `case-${runId}`,
    caseName: `case-${runId}`,
    subsys: 'alu',
    status: 'running',
    startTime: Date.now(),
    ...rest,
  };
}

function makeSession(partial: Partial<SessionEntry> & { id: string }): SessionEntry {
  const { id, ...rest } = partial;
  return {
    id,
    projectId: 'proj-1',
    name: '验证 Agent',
    status: 'idle',
    messages: [],
    composer: { inputMessage: '', selectedSkills: [], contextFiles: [] },
    createdAt: Date.now() - 60000,
    ...rest,
  };
}

beforeEach(() => {
  mocks.sim.activeRuns = [];
  mocks.sim.loadActiveRuns.mockClear();
  mocks.cov.overview = null;
  mocks.cov.loading = false;
  mocks.cov.loadSessions.mockClear();
  mocks.cov.loadTree.mockClear();
  mocks.cov.openExportDialog.mockClear();
  mocks.dash.summary = null;
  mocks.dash.recentFailures = null;
  mocks.dash.loadingTab = null;
  mocks.dash.tabLoaded = {};
  mocks.dash.milestones = null;
  mocks.dash.loadTabData.mockClear();
  mocks.dash.loadMilestones.mockClear();
  mocks.sess.sessions = [];
  mocks.sess.currentSessionId = null;
  mocks.proj.currentProjectId = 'proj-1';
  useUiStore.setState({ activeView: 'dashboard' });
  useWorkbenchStore.setState({ tabs: [], activeTabId: null });
});

describe('DashboardView KPI 行', () => {
  it('渲染 4 张 KPI 卡数值、delta 与 sparkline', () => {
    mocks.dash.summary = {
      subsysCount: 5,
      caseCount: 480,
      passRate: 89.6,
      failCount: 12,
      trend7d: [
        { date: '08-20', pass: 90, fail: 8, error: 2 },
        { date: '08-21', pass: 92, fail: 6, error: 2 },
      ],
    };
    mocks.cov.overview = makeCoverageSummary();
    render(<DashboardView />);

    expect(screen.getByTestId('kpi-functional-coverage').textContent).toContain('87.3');
    expect(screen.getByTestId('kpi-code-coverage').textContent).toContain('92.1');
    expect(screen.getByTestId('kpi-pass-rate').textContent).toContain('89.6');
    expect(screen.getByTestId('kpi-active-failures').textContent).toContain('12');

    // delta：通过率 +2（90%→92%），活跃失败 -2（8→6）
    expect(screen.getByTestId('kpi-pass-rate-delta').textContent).toContain('+2');
    expect(screen.getByTestId('kpi-active-failures-delta').textContent).toContain('-2');

    // 通过率/失败卡有 sparkline，覆盖率卡降级隐藏且不渲染空 svg
    expect(document.querySelector('[data-testid="kpi-pass-rate"] svg polyline')).not.toBeNull();
    expect(document.querySelector('[data-testid="kpi-active-failures"] svg polyline')).not.toBeNull();
    expect(document.querySelector('[data-testid="kpi-functional-coverage"] svg')).toBeNull();
    expect(screen.getByTestId('kpi-functional-coverage').textContent).toContain('暂无趋势数据');
  });

  it('无 7 日序列时 delta/sparkline 全部降级隐藏（不留破图）', () => {
    mocks.dash.summary = { subsysCount: 1, caseCount: 10, passRate: 80, failCount: 2, trend7d: [] };
    render(<DashboardView />);

    expect(screen.queryByTestId('kpi-pass-rate-delta')).toBeNull();
    expect(screen.getByTestId('kpi-pass-rate').textContent).toContain('暂无趋势数据');
    expect(document.querySelector('[data-testid="kpi-pass-rate"] svg')).toBeNull();
  });

  it('无数据时 KPI 值显示 —', () => {
    render(<DashboardView />);
    expect(screen.getByTestId('kpi-pass-rate').textContent).toContain('—');
    expect(screen.getByTestId('kpi-functional-coverage').textContent).toContain('—');
  });
});

describe('DashboardView 里程碑', () => {
  it('渲染 8 步里程碑（真实数据驱动，含环境生成与后仿验证）', () => {
    mocks.dash.milestones = [
      { id: 'requirement-import', label: '需求导入', done: true, hint: '5 子系统 · 480 用例' },
      { id: 'env-gen', label: '环境生成', done: true, hint: '已成功生成 1 次' },
      { id: 'case-dev', label: '用例开发', done: true, hint: '480 条用例' },
      { id: 'smoke', label: '冒烟测试', done: true, hint: '首通 dma_burst_xfer_64b' },
      { id: 'functional', label: '功能验证', done: false, hint: '已调通 320/480 · 66.7%' },
      { id: 'coverage', label: '覆盖率收敛', done: false, hint: '目标 ≥ 90%' },
      { id: 'post-sim', label: '后仿验证', done: false, hint: '待挑选后仿用例' },
      { id: 'signoff', label: '回归签核', done: false, hint: 'TO 清单未开始' },
    ];
    render(<DashboardView />);

    for (const label of ['需求导入', '环境生成', '用例开发', '冒烟测试', '功能验证', '覆盖率收敛', '后仿验证', '回归签核']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // 真实统计提示（不再伪造百分比）
    expect(screen.getByText('已调通 320/480 · 66.7%')).toBeInTheDocument();
    expect(screen.getByText('目标 ≥ 90%')).toBeInTheDocument();
  });

  it('环境生成节点可点击打开环境生成向导', () => {
    mocks.dash.milestones = [
      { id: 'requirement-import', label: '需求导入', done: true, hint: '' },
      { id: 'env-gen', label: '环境生成', done: false, hint: '待生成' },
      { id: 'case-dev', label: '用例开发', done: false, hint: '' },
      { id: 'smoke', label: '冒烟测试', done: false, hint: '' },
      { id: 'functional', label: '功能验证', done: false, hint: '' },
      { id: 'coverage', label: '覆盖率收敛', done: false, hint: '目标 ≥ 90%' },
      { id: 'post-sim', label: '后仿验证', done: false, hint: '' },
      { id: 'signoff', label: '回归签核', done: false, hint: '' },
    ];
    render(<DashboardView />);

    fireEvent.click(screen.getByTestId('milestone-icon-1'));
    // 打开环境生成向导后应切换到 workspace 视图并创建 sysbase-env-gen Tab
    expect(useUiStore.getState().activeView).toBe('workspace');
    expect(useWorkbenchStore.getState().tabs.some((t) => t.destination.type === 'sysbase-env-gen')).toBe(true);
  });

  it('后仿验证节点提供后仿用例调试与时序用例分析两个动作', () => {
    mocks.dash.milestones = [
      { id: 'requirement-import', label: '需求导入', done: true, hint: '' },
      { id: 'env-gen', label: '环境生成', done: true, hint: '' },
      { id: 'case-dev', label: '用例开发', done: true, hint: '' },
      { id: 'smoke', label: '冒烟测试', done: true, hint: '' },
      { id: 'functional', label: '功能验证', done: true, hint: '' },
      { id: 'coverage', label: '覆盖率收敛', done: true, hint: '' },
      { id: 'post-sim', label: '后仿验证', done: false, hint: '待挑选后仿用例' },
      { id: 'signoff', label: '回归签核', done: false, hint: '' },
    ];
    render(<DashboardView />);

    // 时序用例分析：点击后打开 timing-violation Tab
    fireEvent.click(screen.getByTestId('milestone-timing-analysis'));
    expect(useWorkbenchStore.getState().tabs.some((t) => t.destination.type === 'timing-violation')).toBe(true);
  });

  it('覆盖率收敛用实时功能覆盖率覆盖完成态', () => {
    mocks.cov.overview = makeCoverageSummary(); // functional = 87.3（未达标）
    mocks.dash.milestones = [
      { id: 'requirement-import', label: '需求导入', done: true, hint: '' },
      { id: 'env-gen', label: '环境生成', done: true, hint: '' },
      { id: 'case-dev', label: '用例开发', done: true, hint: '' },
      { id: 'smoke', label: '冒烟测试', done: true, hint: '' },
      { id: 'functional', label: '功能验证', done: true, hint: '' },
      { id: 'coverage', label: '覆盖率收敛', done: false, hint: '目标 ≥ 90%' },
      { id: 'post-sim', label: '后仿验证', done: false, hint: '' },
      { id: 'signoff', label: '回归签核', done: false, hint: '' },
    ];
    render(<DashboardView />);

    // 未达标 → 覆盖率收敛成为 current（第一个未完成节点），hint 显示真实覆盖率
    expect(screen.getByText('功能覆盖 87.3% · 目标 ≥ 90%')).toBeInTheDocument();
  });
});

describe('DashboardView 运行中仿真流', () => {
  it('展示 activeRuns：运行数 badge、用例名、子系统、失败耗时', () => {
    const now = Date.now();
    mocks.sim.activeRuns = [
      makeRun({ runId: 'run-1', caseName: 'dma_burst_xfer_64b', subsys: 'AXI-DMA', status: 'running', startTime: now - 60000 }),
      makeRun({ runId: 'run-2', caseName: 'i2c_arbitration_lost', subsys: 'I2C', status: 'fail', startTime: now - 120000, endTime: now - 60000 }),
    ];
    render(<DashboardView />);

    const row1 = screen.getByTestId('run-row-run-1');
    expect(row1.textContent).toContain('dma_burst_xfer_64b');
    expect(row1.textContent).toContain('AXI-DMA');
    expect(screen.getByTestId('run-row-run-2').textContent).toContain('失败 · 1m');
  });

  it('行点击下钻仿真详情 Tab 并切换 workspace 视图', () => {
    mocks.sim.activeRuns = [makeRun({ runId: 'run-1' })];
    render(<DashboardView />);

    fireEvent.click(screen.getByTestId('run-row-run-1'));
    expect(useUiStore.getState().activeView).toBe('workspace');
    expect(useWorkbenchStore.getState().tabs).toHaveLength(1);
  });

  it('无运行时空状态', () => {
    render(<DashboardView />);
    expect(screen.getByTestId('run-stream-empty')).toBeInTheDocument();
  });

  it('列表区有固定高度容器（max-h + overflow），防止撑高挤压下方面板', () => {
    const now = Date.now();
    mocks.sim.activeRuns = Array.from({ length: 10 }, (_, i) =>
      makeRun({ runId: `run-${i}`, caseName: `case-${i}`, startTime: now - i * 1000 }),
    );
    render(<DashboardView />);

    const list = screen.getByTestId('run-stream-list');
    expect(list.className).toContain('max-h-');
    expect(list.className).toContain('overflow-y-auto');
  });
});

describe('DashboardView 覆盖率环', () => {
  it('渲染总环数值与四类图例', () => {
    mocks.cov.overview = makeCoverageSummary();
    render(<DashboardView />);

    expect(screen.getByTestId('cov-legend-functional').textContent).toContain('87.3');
    expect(screen.getByTestId('cov-legend-line').textContent).toContain('92.1');
    expect(screen.getByTestId('cov-legend-branch').textContent).toContain('84.6');
    expect(screen.getByTestId('cov-legend-assertion').textContent).toContain('78.9');
    expect(screen.getByTestId('cov-ring-arc')).toBeInTheDocument();
  });

  it('加载中显示骨架屏，无数据显示空状态', () => {
    const { rerender } = render(<DashboardView />);
    expect(screen.getByTestId('cov-panel-empty')).toBeInTheDocument();

    mocks.cov.loading = true;
    rerender(<DashboardView />);
    expect(screen.getByTestId('cov-panel-skeleton')).toBeInTheDocument();
  });
});

describe('DashboardView AI 活动流', () => {
  it('展示最近主代理消息与运行中子代理', () => {
    const msg = (id: string, content: string): ChatMessage => ({
      id, role: 'assistant', content, timestamp: 1724243000000,
    });
    mocks.sess.sessions = [
      makeSession({
        id: 's1',
        name: '验证 Agent',
        messages: [msg('m1', '回归 #142 已调度至 farm-03'), msg('m2', '正在拉取波形对比上次通过版本')],
        subagents: {
          sub1: {
            id: 'sub1', index: 0, agent: 'coverage-analyzer', description: '分析覆盖率缺口',
            status: 'running', recentOutput: [], toolCount: 2, tokens: 100, requests: 1,
            tokenHistory: [], startedAt: 1724242900000,
          },
        },
      }),
    ];
    mocks.sess.currentSessionId = 's1';
    render(<DashboardView />);

    expect(screen.getAllByText('验证 Agent')).toHaveLength(2);
    expect(screen.getByText('回归 #142 已调度至 farm-03')).toBeInTheDocument();
    expect(screen.getByText('coverage-analyzer · 子代理')).toBeInTheDocument();
    expect(screen.getByText('分析覆盖率缺口')).toBeInTheDocument();
  });

  it('无会话时空状态', () => {
    render(<DashboardView />);
    expect(screen.getByTestId('agent-panel-empty')).toBeInTheDocument();
  });
});

describe('DashboardView 失败聚焦', () => {
  it('按用例聚合失败次数 pill，RCA 状态映射错误分析会话', () => {
    const base: RecentFailuresData = [
      { caseName: 'i2c_arbitration_lost', subsys: 'I2C', status: 'fail', startTime: '2026-08-21T14:00:00Z', durationMs: 1000 },
      { caseName: 'i2c_arbitration_lost', subsys: 'I2C', status: 'fail', startTime: '2026-08-21T15:00:00Z', durationMs: 1000 },
      { caseName: 'uart_parity_inject', subsys: 'UART', status: 'fail', startTime: '2026-08-21T16:00:00Z', durationMs: null },
    ];
    mocks.dash.recentFailures = base;
    mocks.sess.sessions = [makeSession({ id: 'ea1', name: '[仿真分析] i2c_arbitration_lost', status: 'streaming' })];
    render(<DashboardView />);

    const row = screen.getByTestId('fail-row-i2c_arbitration_lost');
    expect(row.textContent).toContain('×2');
    expect(screen.getByTestId('rca-pill-i2c_arbitration_lost').textContent).toBe('AI 分析中');
    // 无错误分析会话的用例不显示 RCA pill（降级隐藏，不造假）
    expect(screen.queryByTestId('rca-pill-uart_parity_inject')).toBeNull();
  });

  it('RCA 会话结束（idle）显示已分析；失败列表加载中显示骨架', () => {
    mocks.dash.recentFailures = [
      { caseName: 'dma_sg_chain_wrap', subsys: 'DMA', status: 'fail', startTime: '2026-08-21T14:00:00Z', durationMs: null },
    ];
    mocks.sess.sessions = [makeSession({ id: 'ea1', name: '[仿真分析] dma_sg_chain_wrap', status: 'idle' })];
    const { rerender } = render(<DashboardView />);
    expect(screen.getByTestId('rca-pill-dma_sg_chain_wrap').textContent).toBe('已分析');

    mocks.dash.loadingTab = 'failures';
    mocks.dash.tabLoaded = {};
    rerender(<DashboardView />);
    expect(screen.getByTestId('failure-panel-skeleton')).toBeInTheDocument();
  });

  it('无失败时空状态', () => {
    mocks.dash.recentFailures = [];
    render(<DashboardView />);
    expect(screen.getByTestId('failure-panel-empty')).toBeInTheDocument();
  });
});

describe('DashboardView 分析面板入口', () => {
  it('点击分析面板下拉菜单项打开对应 Tab', () => {
    render(<DashboardView />);

    fireEvent.click(screen.getByTestId('analytics-dropdown-trigger'));
    fireEvent.click(screen.getByTestId('analytics-item-trend'));

    expect(useUiStore.getState().activeView).toBe('workspace');
    expect(useWorkbenchStore.getState().tabs.some((t) => t.destination.type === 'dashboard-tab')).toBe(true);
  });

  it('分析面板下拉菜单包含 8 个分析维度', () => {
    render(<DashboardView />);

    fireEvent.click(screen.getByTestId('analytics-dropdown-trigger'));

    for (const tab of ['trend', 'subsys', 'failures', 'regression', 'duration', 'unstable', 'phase', 'debug']) {
      expect(screen.getByTestId(`analytics-item-${tab}`)).toBeInTheDocument();
    }
  });
});

describe('DashboardView 视图头与数据加载', () => {
  it('标题/副标题/动作区：导出打开对话框、启动回归跳回归视图', () => {
    render(<DashboardView />);

    expect(screen.getByText('验证总览')).toBeInTheDocument();
    expect(screen.getByText('neckar-dv')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /导出报告/ }));
    expect(mocks.cov.openExportDialog).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('launch-regression-btn'));
    expect(useUiStore.getState().activeView).toBe('regression');
  });

  it('mount 时加载 overview/failures 汇总与覆盖率数据', async () => {
    render(<DashboardView />);

    expect(mocks.dash.loadTabData).toHaveBeenCalledWith('overview', 'proj-1');
    expect(mocks.dash.loadTabData).toHaveBeenCalledWith('failures', 'proj-1');
    expect(mocks.cov.loadSessions).toHaveBeenCalledWith('proj-1');
    // loadTree 在 loadSessions 的 promise 链中，等待微任务刷新
    await vi.waitFor(() => expect(mocks.cov.loadTree).toHaveBeenCalledWith('proj-1'));
  });

  it('mount 时加载活跃仿真运行（loadActiveRuns），避免首次进入总览时运行中仿真列表为空', () => {
    render(<DashboardView />);
    expect(mocks.sim.loadActiveRuns).toHaveBeenCalledWith('proj-1');
  });

  it('覆盖率已有数据时不重复加载', () => {
    mocks.cov.overview = makeCoverageSummary();
    render(<DashboardView />);

    expect(mocks.cov.loadSessions).not.toHaveBeenCalled();
    expect(mocks.cov.loadTree).not.toHaveBeenCalled();
  });
});
