// @vitest-environment jsdom
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SimulationRunRecord } from '@renderer/stores/simulation';
import type { RegressionHistoryEntry } from '@shared/types';

/* ── store / trpc mock（可变状态便于逐用例注入；getState 供命令面板直接调用） ── */
const simState = vi.hoisted(() => ({
  activeRuns: [] as SimulationRunRecord[],
  stopAllRuns: vi.fn(),
  rerunRun: vi.fn(),
}));
const regState = vi.hoisted(() => ({
  history: [] as RegressionHistoryEntry[],
  runRegression: vi.fn(),
  loadHistory: vi.fn(),
}));
const covState = vi.hoisted(() => ({ openExportDialog: vi.fn() }));
const termState = vi.hoisted(() => ({ createTerminal: vi.fn() }));
const toastState = vi.hoisted(() => ({ info: vi.fn(), success: vi.fn(), error: vi.fn() }));
const projState = vi.hoisted(() => ({ currentProjectId: 'proj-1', pushRecentFile: vi.fn() }));
const searchQuery = vi.hoisted(() => vi.fn(() => Promise.resolve([])));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: { search: { global: { query: searchQuery } } },
}));
vi.mock('@renderer/stores/simulation', () => ({
  useSimulationStore: (sel: (s: typeof simState) => unknown) => sel(simState),
}));
vi.mock('@renderer/stores/regression', () => ({
  useRegressionStore: Object.assign(
    (sel: (s: typeof regState) => unknown) => sel(regState),
    { getState: () => regState },
  ),
}));
vi.mock('@renderer/stores/coverage', () => ({
  useCoverageCoreStore: (sel: (s: typeof covState) => unknown) => sel(covState),
  useCoverageGapsStore: (sel: (s: typeof covState) => unknown) => sel(covState),
  useCoverageClosureStore: (sel: (s: typeof covState) => unknown) => sel(covState),
  useCoverageExportStore: (sel: (s: typeof covState) => unknown) => sel(covState),
}));
vi.mock('@renderer/stores/terminal', () => ({
  useTerminalStore: Object.assign(() => undefined, { getState: () => termState }),
}));
vi.mock('@renderer/stores/toast', () => ({
  useToastStore: Object.assign(() => undefined, { getState: () => toastState }),
}));
vi.mock('@renderer/stores/project', () => ({
  useProjectStore: Object.assign(
    (sel: (s: typeof projState) => unknown) => sel(projState),
    { getState: () => projState },
  ),
}));

import { CommandPalette } from '@renderer/components/layout/CommandPalette';
import { useUiStore } from '@renderer/stores/ui';

function makeRun(overrides: Partial<SimulationRunRecord>): SimulationRunRecord {
  return {
    runId: 'run-1',
    projectId: 'proj-1',
    caseId: 'case-1',
    caseName: 'alu_add',
    subsys: 'alu',
    status: 'fail',
    startTime: Date.now(),
    ...overrides,
  };
}

function openPalette() {
  act(() => {
    useUiStore.setState({ commandPaletteOpen: true });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({
    commandPaletteOpen: false,
    activeView: 'dashboard',
    leftDrawerOpen: false,
    rightDrawerOpen: false,
    settingsOpen: false,
  });
  simState.activeRuns = [];
  regState.history = [];
});

describe('命令面板触发键', () => {
  it('Ctrl+K 呼出命令面板', () => {
    render(<CommandPalette />);
    expect(screen.queryByTestId('command-palette')).toBeNull();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.getByTestId('command-palette')).toBeInTheDocument();
  });

  it('Ctrl+P 同样呼出（保留旧键位）', () => {
    render(<CommandPalette />);
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true });
    expect(screen.getByTestId('command-palette')).toBeInTheDocument();
  });

  it('Esc 关闭', () => {
    render(<CommandPalette />);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUiStore.getState().commandPaletteOpen).toBe(false);
  });

  it('backdrop 点击关闭', () => {
    render(<CommandPalette />);
    openPalette();
    fireEvent.click(screen.getByTestId('command-palette-overlay'));
    expect(useUiStore.getState().commandPaletteOpen).toBe(false);
  });
});

describe('命令面板分组与过滤', () => {
  it('渲染导航 / 动作 / 面板三个分组及条目', () => {
    render(<CommandPalette />);
    openPalette();
    for (const group of ['导航', '动作', '面板']) {
      expect(screen.getByText(group)).toBeInTheDocument();
    }
    // 导航五视图 + 动作四项 + 面板六项
    for (const id of [
      'palette-item-nav-dashboard',
      'palette-item-nav-simulation',
      'palette-item-nav-coverage',
      'palette-item-nav-regression',
      'palette-item-nav-workspace',
      'palette-item-action-run-regression',
      'palette-item-action-stop-sims',
      'palette-item-action-rerun-fails',
      'palette-item-action-cov-report',
      'palette-item-panel-terminal',
      'palette-item-panel-file-drawer',
      'palette-item-panel-ai-drawer',
      'palette-item-panel-sysbase-env-gen',
      'palette-item-panel-settings',
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
  });

  it('输入过滤：仅显示 label 匹配的条目', () => {
    render(<CommandPalette />);
    openPalette();
    fireEvent.change(screen.getByTestId('command-palette-input'), {
      target: { value: '覆盖率' },
    });
    expect(screen.getByTestId('palette-item-nav-coverage')).toBeInTheDocument();
    expect(screen.queryByTestId('palette-item-nav-dashboard')).toBeNull();
    expect(screen.queryByTestId('palette-item-action-stop-sims')).toBeNull();
  });

  it('无匹配时显示空结果态', () => {
    render(<CommandPalette />);
    openPalette();
    fireEvent.change(screen.getByTestId('command-palette-input'), {
      target: { value: 'zzz-无匹配' },
    });
    expect(screen.getByTestId('command-palette-empty')).toBeInTheDocument();
    expect(screen.getByTestId('command-palette-empty').textContent).toContain('没有匹配的命令');
  });
});

describe('命令面板键盘导航', () => {
  it('↑↓ 移动选中项，Enter 执行并关闭', () => {
    render(<CommandPalette />);
    openPalette();
    const input = screen.getByTestId('command-palette-input');
    // 默认选中第 0 项（前往 总览）→ ArrowDown 到第 1 项（前往 仿真）
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useUiStore.getState().activeView).toBe('simulation');
    expect(useUiStore.getState().commandPaletteOpen).toBe(false);
  });

  it('↑ 到顶部不再上移，Enter 执行首项', () => {
    render(<CommandPalette />);
    openPalette();
    const input = screen.getByTestId('command-palette-input');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useUiStore.getState().activeView).toBe('dashboard');
  });
});

describe('导航组动作', () => {
  it('点击导航条目切换五视图', () => {
    render(<CommandPalette />);
    openPalette();
    fireEvent.click(screen.getByTestId('palette-item-nav-regression'));
    expect(useUiStore.getState().activeView).toBe('regression');
    expect(useUiStore.getState().commandPaletteOpen).toBe(false);

    openPalette();
    fireEvent.click(screen.getByTestId('palette-item-nav-workspace'));
    expect(useUiStore.getState().activeView).toBe('workspace');
  });
});

describe('动作组接通真实操作', () => {
  it('停止全部仿真调用 simulation store stopAllRuns', () => {
    render(<CommandPalette />);
    openPalette();
    fireEvent.click(screen.getByTestId('palette-item-action-stop-sims'));
    expect(simState.stopAllRuns).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().commandPaletteOpen).toBe(false);
  });

  it('启动回归：无历史时跳回归视图并提示', () => {
    render(<CommandPalette />);
    openPalette();
    fireEvent.click(screen.getByTestId('palette-item-action-run-regression'));
    expect(useUiStore.getState().activeView).toBe('regression');
    expect(regState.runRegression).not.toHaveBeenCalled();
    expect(toastState.info).toHaveBeenCalled();
  });

  it('启动回归：有历史时用最近一次参数重新提交', () => {
    const entry: RegressionHistoryEntry = {
      runId: 'reg-1',
      filePath: '/proj/regression.list',
      subsys: 'alu',
      command: 'runsim -regr',
      options: { failMode: true },
      submittedAt: 1000,
      status: 'completed',
      exitCode: 0,
      stdoutTail: '',
    };
    regState.history = [entry];
    render(<CommandPalette />);
    openPalette();
    fireEvent.click(screen.getByTestId('palette-item-action-run-regression'));
    expect(regState.runRegression).toHaveBeenCalledWith(
      'proj-1',
      entry.filePath,
      entry.subsys,
      entry.options,
    );
  });

  it('重跑失败用例：hint 计数只统计有命令的失败运行，执行时逐个 rerunRun', async () => {
    simState.activeRuns = [
      makeRun({ runId: 'f1', status: 'fail', command: 'runsim case1' }),
      makeRun({ runId: 'f2', status: 'fail' }), // 无命令 → 不计入
      makeRun({ runId: 'p1', status: 'pass', command: 'runsim case3' }),
    ];
    simState.rerunRun.mockResolvedValue('term_tab_1');
    render(<CommandPalette />);
    openPalette();
    expect(screen.getByText('1 个失败')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('palette-item-action-rerun-fails'));
    await act(async () => {});
    expect(simState.rerunRun).toHaveBeenCalledTimes(1);
    expect(simState.rerunRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'f1', command: 'runsim case1' }),
    );
  });

  it('生成覆盖率报告打开导出对话框', () => {
    render(<CommandPalette />);
    openPalette();
    fireEvent.click(screen.getByTestId('palette-item-action-cov-report'));
    expect(covState.openExportDialog).toHaveBeenCalledTimes(1);
  });

  it('停止全部 hint 反映运行数', () => {
    simState.activeRuns = [
      makeRun({ runId: 'r1', status: 'running' }),
      makeRun({ runId: 'r2', status: 'pending' }),
    ];
    render(<CommandPalette />);
    openPalette();
    expect(screen.getByText('2 个运行中')).toBeInTheDocument();
  });
});

describe('面板组动作', () => {
  it('打开验证环境生成器 → 切换工作区并创建对应 Tab', () => {
    render(<CommandPalette />);
    openPalette();
    fireEvent.click(screen.getByTestId('palette-item-panel-sysbase-env-gen'));
    expect(useUiStore.getState().activeView).toBe('workspace');
    expect(useUiStore.getState().commandPaletteOpen).toBe(false);
  });

  it('打开文件树 → leftDrawerOpen', () => {
    render(<CommandPalette />);
    openPalette();
    fireEvent.click(screen.getByTestId('palette-item-panel-file-drawer'));
    expect(useUiStore.getState().leftDrawerOpen).toBe(true);
  });

  it('打开 AI 会话（drawer 模式）→ rightDrawerOpen', () => {
    render(<CommandPalette />);
    openPalette();
    fireEvent.click(screen.getByTestId('palette-item-panel-ai-drawer'));
    expect(useUiStore.getState().rightDrawerOpen).toBe(true);
  });

  it('打开设置 → settingsOpen', () => {
    render(<CommandPalette />);
    openPalette();
    fireEvent.click(screen.getByTestId('palette-item-panel-settings'));
    expect(useUiStore.getState().settingsOpen).toBe(true);
  });

  it('新建终端调用 terminal store', () => {
    render(<CommandPalette />);
    openPalette();
    fireEvent.click(screen.getByTestId('palette-item-panel-terminal'));
    expect(termState.createTerminal).toHaveBeenCalledWith('proj-1');
  });
});
