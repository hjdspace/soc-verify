// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  RegressionDiscoveryResult,
  RegressionGroup,
  RegressionHistoryEntry,
  RegressionList,
} from '@shared/types';

/**
 * 回归视图（Issue #6）测试：套件卡片（状态色 / 通过率占位 / meta）、
 * 历史趋势表（列渲染 + 缺失字段占位）、行点击路由（regression-detail →
 * workspace 视图）、失败聚类「待分类」占位、骨架屏 / 空状态、数据加载。
 * 数据依赖的 store 全部 mock（selector 直读可变状态）；
 * ui / workbench 为纯 zustand，使用真实 store。
 */

const mocks = vi.hoisted(() => ({
  reg: {
    discovery: [] as RegressionDiscoveryResult,
    discoveryLoading: false,
    discoveryError: null as string | null,
    history: [] as RegressionHistoryEntry[],
    historyLoading: false,
    discover: vi.fn().mockResolvedValue(undefined),
    loadHistory: vi.fn().mockResolvedValue(undefined),
  },
  proj: {
    currentProjectId: 'proj-1' as string | null,
  },
}));

vi.mock('@renderer/stores/regression', () => ({
  useRegressionStore: (selector: (s: typeof mocks.reg) => unknown) => selector(mocks.reg),
}));

vi.mock('@renderer/stores/project', () => ({
  useProjectStore: (selector: (s: typeof mocks.proj) => unknown) => selector(mocks.proj),
}));

import { RegressionView } from '@renderer/components/views/RegressionView';
import { useUiStore } from '@renderer/stores/ui';
import { useWorkbenchStore } from '@renderer/stores/workbench';

function makeList(subsys: string, onCount: number): RegressionList {
  return {
    type: 'list',
    filePath: `/env/${subsys}/regression/${subsys}_mini.lst`,
    subsys,
    block: '',
    entries: [],
    tagSet: [],
    onCount,
    offCount: 0,
  };
}

function makeGroup(subsys: string): RegressionGroup {
  return {
    type: 'group',
    filePath: `/env/${subsys}/regression/${subsys}.grp`,
    subsys,
    block: '',
    refPaths: [],
  };
}

function makeHistory(partial: Partial<RegressionHistoryEntry> & { runId: string }): RegressionHistoryEntry {
  const { runId, ...rest } = partial;
  return {
    runId,
    filePath: '/env/alu/regression/alu_mini.lst',
    subsys: 'alu',
    command: 'runsim -regr',
    options: {},
    submittedAt: Date.now(),
    status: 'completed',
    exitCode: 0,
    stdoutTail: '',
    ...rest,
  };
}

beforeEach(() => {
  mocks.reg.discovery = [];
  mocks.reg.discoveryLoading = false;
  mocks.reg.discoveryError = null;
  mocks.reg.history = [];
  mocks.reg.historyLoading = false;
  mocks.reg.discover.mockClear();
  mocks.reg.loadHistory.mockClear();
  mocks.proj.currentProjectId = 'proj-1';
  useUiStore.setState({ activeView: 'regression' });
  useWorkbenchStore.setState({ tabs: [], activeTabId: null });
});

describe('RegressionView 套件卡片', () => {
  it('按 discovery 子系统渲染卡片：名称、列表/组计数、ON 用例数与最近运行时间', () => {
    mocks.reg.discovery = [
      { subsys: 'alu', items: [makeList('alu', 10), makeGroup('alu')] },
      { subsys: 'uart', items: [makeList('uart', 5)] },
    ];
    mocks.reg.history = [makeHistory({ runId: 'run-000001', subsys: 'alu', status: 'running' })];
    render(<RegressionView />);

    expect(screen.getByTestId('reg-suite-card-alu')).toBeInTheDocument();
    expect(screen.getByTestId('reg-suite-card-uart')).toBeInTheDocument();
    expect(screen.getByTestId('reg-suite-card-alu').textContent).toContain('1 list · 1 grp · 10 ON 用例');
    expect(screen.getByTestId('reg-suite-card-alu').textContent).toContain('最近运行 今天');
    expect(screen.getByTestId('reg-suite-card-uart').textContent).toContain('1 list · 5 ON 用例');
    expect(screen.getByTestId('reg-suite-card-uart').textContent).toContain('尚未运行');
  });

  it('状态色随该子系统最近一次运行状态：运行中/通过/失败/已停止', () => {
    mocks.reg.discovery = [
      { subsys: 's-run', items: [makeList('s-run', 1)] },
      { subsys: 's-pass', items: [makeList('s-pass', 1)] },
      { subsys: 's-fail', items: [makeList('s-fail', 1)] },
      { subsys: 's-abort', items: [makeList('s-abort', 1)] },
    ];
    mocks.reg.history = [
      makeHistory({ runId: 'run-000001', subsys: 's-run', status: 'running' }),
      makeHistory({ runId: 'run-000002', subsys: 's-pass', status: 'completed' }),
      makeHistory({ runId: 'run-000003', subsys: 's-fail', status: 'failed' }),
      makeHistory({ runId: 'run-000004', subsys: 's-abort', status: 'aborted' }),
    ];
    render(<RegressionView />);

    expect(screen.getByTestId('reg-suite-state-s-run')).toHaveTextContent('运行中');
    expect(screen.getByTestId('reg-suite-state-s-run')).toHaveClass('text-status-running-foreground');
    expect(screen.getByTestId('reg-suite-state-s-pass')).toHaveTextContent('通过');
    expect(screen.getByTestId('reg-suite-state-s-pass')).toHaveClass('text-status-pass-foreground');
    expect(screen.getByTestId('reg-suite-state-s-fail')).toHaveTextContent('失败');
    expect(screen.getByTestId('reg-suite-state-s-fail')).toHaveClass('text-status-fail-foreground');
    expect(screen.getByTestId('reg-suite-state-s-abort')).toHaveTextContent('已停止');
    expect(screen.getByTestId('reg-suite-state-s-abort')).toHaveClass('text-status-aborted-foreground');
  });

  it('通过率无数据源时占位显示「—」，不渲染假百分比', () => {
    mocks.reg.discovery = [{ subsys: 'alu', items: [makeList('alu', 10)] }];
    mocks.reg.history = [makeHistory({ runId: 'run-000001', subsys: 'alu' })];
    render(<RegressionView />);

    expect(screen.getByTestId('reg-suite-rate-alu').textContent).toBe('—');
    expect(screen.getByTestId('reg-suite-card-alu').textContent).not.toContain('%');
  });

  it('未发现回归列表时显示空状态', () => {
    render(<RegressionView />);
    expect(screen.getByTestId('reg-suite-empty')).toBeInTheDocument();
    expect(screen.queryByTestId(/^reg-suite-card-/)).not.toBeInTheDocument();
  });

  it('discovery 首次加载显示骨架屏且不渲染卡片', () => {
    mocks.reg.discoveryLoading = true;
    render(<RegressionView />);
    expect(screen.getByTestId('reg-suite-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId(/^reg-suite-card-/)).not.toBeInTheDocument();
  });

  it('discovery 失败显示错误态，重新扫描按钮触发强制刷新', () => {
    mocks.reg.discoveryError = 'PROJ_ENV 未配置';
    render(<RegressionView />);

    expect(screen.getByTestId('reg-discovery-error').textContent).toContain('PROJ_ENV 未配置');
    fireEvent.click(screen.getByTestId('reg-retry-btn'));
    expect(mocks.reg.discover).toHaveBeenCalledWith('proj-1', true);
  });

  it('已有数据时重新加载不闪骨架，卡片保持显示', () => {
    mocks.reg.discovery = [{ subsys: 'alu', items: [makeList('alu', 10)] }];
    mocks.reg.discoveryLoading = true;
    render(<RegressionView />);

    expect(screen.getByTestId('reg-suite-card-alu')).toBeInTheDocument();
    expect(screen.queryByTestId('reg-suite-skeleton')).not.toBeInTheDocument();
  });
});

describe('RegressionView 历史趋势表', () => {
  it('列头完整：# / 时间 / 通过·失败 / 通过率 / 时长 / Δ', () => {
    mocks.reg.history = [makeHistory({ runId: 'run-000001' })];
    render(<RegressionView />);

    for (const label of ['#', '时间', '通过·失败', '通过率', '时长', 'Δ']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('行渲染真实字段（#id 取 runId 尾部、提交时间），缺失字段占位「—」不造假', () => {
    mocks.reg.history = [
      makeHistory({ runId: 'run-000001', submittedAt: Date.now() - 60_000, status: 'completed' }),
    ];
    render(<RegressionView />);

    const row = screen.getByTestId('reg-hist-row-run-000001');
    expect(row.textContent).toContain('#000001');
    expect(row.textContent).toContain('今天');
    // 通过·失败数 / 通过率 / 时长 / Δ 四列无数据源 → 4 个占位符
    expect(row.textContent?.match(/—/g)).toHaveLength(4);
    expect(row.textContent).not.toContain('%');
  });

  it('运行中行时长列显示「进行中」且状态点脉冲', () => {
    mocks.reg.history = [makeHistory({ runId: 'run-000001', status: 'running' })];
    render(<RegressionView />);

    const row = screen.getByTestId('reg-hist-row-run-000001');
    expect(row.textContent).toContain('进行中');
    expect(row.querySelectorAll('.animate-pulse')).toHaveLength(1);
    // 时长列为「进行中」，仅其余 3 列占位
    expect(row.textContent?.match(/—/g)).toHaveLength(3);
  });

  it('历史按提交时间降序，最近一次在最前', () => {
    const now = Date.now();
    mocks.reg.history = [
      makeHistory({ runId: 'run-000003', submittedAt: now - 3000 }),
      makeHistory({ runId: 'run-000001', submittedAt: now - 1000 }),
      makeHistory({ runId: 'run-000002', submittedAt: now - 2000 }),
    ];
    render(<RegressionView />);

    expect(screen.getAllByTestId(/^reg-hist-row-/).map((r) => r.getAttribute('data-testid'))).toEqual([
      'reg-hist-row-run-000001',
      'reg-hist-row-run-000002',
      'reg-hist-row-run-000003',
    ]);
  });

  it('点击行打开回归详情 Tab 并切换到 workspace 视图', () => {
    mocks.reg.history = [makeHistory({ runId: 'run-000001' })];
    render(<RegressionView />);

    fireEvent.click(screen.getByTestId('reg-hist-row-run-000001'));
    expect(useUiStore.getState().activeView).toBe('workspace');
    const tabs = useWorkbenchStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].destination.type).toBe('regression-detail');
  });

  it('重复点击同一行不重复开 Tab', () => {
    mocks.reg.history = [makeHistory({ runId: 'run-000001' })];
    render(<RegressionView />);

    fireEvent.click(screen.getByTestId('reg-hist-row-run-000001'));
    fireEvent.click(screen.getByTestId('reg-hist-row-run-000001'));
    expect(useWorkbenchStore.getState().tabs).toHaveLength(1);
  });

  it('historyLoading 首次加载显示骨架屏', () => {
    mocks.reg.historyLoading = true;
    render(<RegressionView />);
    expect(screen.getByTestId('reg-hist-skeleton')).toBeInTheDocument();
  });

  it('无历史记录显示空状态', () => {
    render(<RegressionView />);
    expect(screen.getByTestId('reg-hist-empty')).toBeInTheDocument();
  });
});

describe('RegressionView 失败聚类', () => {
  it('渲染「待分类」占位，无聚类假数据', () => {
    render(<RegressionView />);

    expect(screen.getByTestId('reg-cluster-placeholder')).toBeInTheDocument();
    expect(screen.getByTestId('reg-cluster-badge').textContent).toContain('待分类');
    expect(screen.queryByTestId(/^reg-cluster-chip/)).not.toBeInTheDocument();
  });
});

describe('RegressionView 数据加载', () => {
  it('mount 时以当前项目触发 discover 与 loadHistory', () => {
    render(<RegressionView />);
    expect(mocks.reg.discover).toHaveBeenCalledWith('proj-1');
    expect(mocks.reg.loadHistory).toHaveBeenCalledWith('proj-1');
  });

  it('无当前项目时不加载', () => {
    mocks.proj.currentProjectId = null;
    render(<RegressionView />);
    expect(mocks.reg.discover).not.toHaveBeenCalled();
    expect(mocks.reg.loadHistory).not.toHaveBeenCalled();
  });

  it('刷新按钮触发强制重扫描与历史重载', () => {
    render(<RegressionView />);

    fireEvent.click(screen.getByTestId('reg-refresh-btn'));
    expect(mocks.reg.discover).toHaveBeenCalledWith('proj-1', true);
    expect(mocks.reg.loadHistory).toHaveBeenCalledTimes(2);
  });
});
