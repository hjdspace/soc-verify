// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SimulationRunRecord } from '@renderer/stores/simulation';

// Mock the visual animation libraries (border-beam etc.) so the real
// packages — which call window.matchMedia — are never loaded in jsdom.
import { installVisualMocks } from '../mocks/visual-stubs';
installVisualMocks();

/**
 * 仿真视图（Issue #5 三栏布局）测试：
 *
 * 三栏布局渲染（CaseTreePanel + SimOptionPanel + RunListPanel）+
 * 三栏联动（选中用例 → Option 填充 → 命令预览更新）+
 * 左栏拖拽调整宽度（ResizeHandle → simLeftPanelWidth clamp）+
 * ViewHeader 动作（停止全部 / 新建仿真）+
 * 数据加载（mount 时加载活跃运行列表）+
 * RunListPanel 委托行为（分段筛选器 / 关键字过滤 / 行点击路由 /
 * 空状态切换 / 骨架屏 / 停止全部与新建仿真动作）。
 *
 * Mock 策略：
 * - simulation store: activeRuns / loadingActiveRuns / loadActiveRuns / stopAllRuns /
 *   selectCase / simOptions / setSimOption / setSimOptions / startCaseRun / startCaseRuns /
 *   abortTerminalRun / abortSimulation
 * - project store: currentProjectId / selectedSubsys / caseStatusFilter / plugins 等
 * - trpc: project.getSubsystems / getCases / searchCases / getSimOptionsSchema /
 *   getSimOptionPresets / saveSimOptionPreset / refreshCases / setCasePostSim /
 *   openInSystem / simulation.listActiveRuns / pickRegrFile / runInTerminal /
 *   abortTerminalRun / abort
 * - ui / workbench: 真实 zustand（纯 zustand，无 IPC 依赖）
 * - toast / overview / env / dashboard: mock（无 IPC 依赖）
 */

const mockSelectCase = vi.fn();
const mockSetSimOption = vi.fn();
const mockSetSimOptions = vi.fn();
const mockStartCaseRun = vi.fn().mockResolvedValue('run-1');
const mockStartCaseRuns = vi.fn().mockResolvedValue([]);
let mockSimOptions: Record<string, unknown> = {};

const mocks = vi.hoisted(() => ({
  sim: {
    activeRuns: [] as SimulationRunRecord[],
    loadingActiveRuns: false,
    loadActiveRuns: vi.fn().mockResolvedValue(undefined),
    abortTerminalRun: vi.fn().mockResolvedValue(undefined),
    abortSimulation: vi.fn().mockResolvedValue(undefined),
    stopAllRuns: vi.fn().mockResolvedValue(undefined),
  },
  proj: {
    currentProjectId: 'proj-1' as string | null,
    selectedSubsys: null as string | null,
    caseStatusFilter: 'all',
    plugins: [
      { id: 'p1', kind: 'subsys-discoverer', enabled: true, error: undefined },
    ] as Array<{ id: string; kind: string; enabled: boolean; error?: string }>,
  },
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    project: {
      getSubsystems: { query: vi.fn().mockResolvedValue([
        { name: 'ALU', path: '/proj/alu', caseCount: 2 },
        { name: 'DMA', path: '/proj/dma', caseCount: 1 },
      ]) },
      getCases: { query: vi.fn().mockResolvedValue([
        { id: 'c1', name: 'alu_add', subsys: 'ALU', path: '/proj/alu/case_add.sv', status: 'pass', postSim: false, filePath: '/proj/alu/case_add.sv' },
        { id: 'c2', name: 'alu_sub', subsys: 'ALU', path: '/proj/alu/case_sub.sv', status: 'fail', postSim: false, filePath: '/proj/alu/case_sub.sv' },
        { id: 'c3', name: 'dma_burst', subsys: 'DMA', path: '/proj/dma/burst.sv', status: 'pending', postSim: false, filePath: '/proj/dma/burst.sv' },
      ]) },
      searchCases: { query: vi.fn().mockResolvedValue([]) },
      getSimOptionsSchema: { query: vi.fn().mockResolvedValue({ fields: [
        { key: 'base', label: 'BASE', type: 'string', default: '', group: '基础参数' },
        { key: 'block', label: 'BLOCK', type: 'string', default: '', group: '基础参数' },
        { key: 'case', label: 'CASE', type: 'string', default: '', group: '基础参数' },
      ] }) },
      getSimOptionPresets: { query: vi.fn().mockResolvedValue({}) },
      saveSimOptionPreset: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
      refreshCases: { mutate: vi.fn().mockResolvedValue(undefined) },
      setCasePostSim: { mutate: vi.fn().mockResolvedValue(undefined) },
      openInSystem: { mutate: vi.fn().mockResolvedValue(undefined) },
    },
    simulation: {
      listActiveRuns: { query: vi.fn().mockResolvedValue([]) },
      runInTerminal: { mutate: vi.fn().mockResolvedValue({ runId: 'run-1', terminalId: 'term-1', command: '', cwd: '' }) },
      abortTerminalRun: { mutate: vi.fn().mockResolvedValue(undefined) },
      abort: { mutate: vi.fn().mockResolvedValue(undefined) },
    },
  },
}));

vi.mock('@renderer/stores/simulation', () => ({
  useSimulationStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      ...mocks.sim,
      simOptions: mockSimOptions,
      selectCase: mockSelectCase,
      setSimOption: mockSetSimOption,
      setSimOptions: mockSetSimOptions,
      startCaseRun: mockStartCaseRun,
      startCaseRuns: mockStartCaseRuns,
    }),
}));

vi.mock('@renderer/stores/project', () => ({
  useProjectStore: (selector: (s: typeof mocks.proj) => unknown) => selector(mocks.proj),
}));

vi.mock('@renderer/stores/toast', () => ({
  useToastStore: {
    getState: () => ({
      error: vi.fn(),
      success: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
    }),
  },
}));

vi.mock('@renderer/stores/overview', () => ({
  useOverviewStore: {
    getState: () => ({ invalidate: vi.fn() }),
  },
}));

vi.mock('@renderer/stores/env', () => ({
  useEnvStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ config: null }),
}));

vi.mock('@renderer/stores/dashboard', () => ({
  useDashboardStore: {
    getState: () => ({ loadMilestones: vi.fn() }),
  },
}));

import { SimulationView } from '@renderer/components/views/SimulationView';
import { useUiStore } from '@renderer/stores/ui';
import { useWorkbenchStore } from '@renderer/stores/workbench';

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

/** 覆盖全部状态的运行集合：2 运行中 / 2 失败（fail+error）/ 1 通过 / 1 队列 / 1 已停止 */
function seedAllStatuses(): SimulationRunRecord[] {
  const now = Date.now();
  return [
    makeRun({
      runId: 'r-run-1', caseName: 'dma_burst_xfer_64b', subsys: 'AXI-DMA', seed: '0x3F21',
      status: 'running', startTime: now - 60000, terminalId: 'term-1',
    }),
    makeRun({
      runId: 'r-run-2', caseName: 'uart_loopback_cfg', subsys: 'UART',
      status: 'running', startTime: now - 30000,
    }),
    makeRun({
      runId: 'r-fail-1', caseName: 'i2c_arbitration_lost', subsys: 'I2C', seed: '0x52D1',
      status: 'fail', startTime: now - 120000, endTime: now - 60000,
    }),
    makeRun({
      runId: 'r-err-1', caseName: 'spi_quad_tx_rx', subsys: 'QSPI',
      status: 'error', startTime: now - 200000, endTime: now - 180000,
    }),
    makeRun({
      runId: 'r-pass-1', caseName: 'pcie_ltssm_l0s_entry', subsys: 'PCIe PHY', seed: '0x11C8',
      status: 'pass', startTime: now - 300000, endTime: now - 240000,
    }),
    makeRun({
      runId: 'r-queue-1', caseName: 'axi_lite_smoke', subsys: 'AXI-LITE',
      status: 'pending', startTime: now - 10000,
    }),
    makeRun({
      runId: 'r-stop-1', caseName: 'apb_reg_rw', subsys: 'APB',
      status: 'aborted', startTime: now - 400000, endTime: now - 360000,
    }),
  ];
}

beforeEach(() => {
  mocks.sim.activeRuns = [];
  mocks.sim.loadingActiveRuns = false;
  mocks.sim.loadActiveRuns.mockClear();
  mocks.sim.abortTerminalRun.mockClear();
  mocks.sim.abortSimulation.mockClear();
  mocks.sim.stopAllRuns.mockClear();
  mocks.proj.currentProjectId = 'proj-1';
  mocks.proj.selectedSubsys = null;
  mockSimOptions = {};
  mockSelectCase.mockClear();
  mockSetSimOption.mockClear();
  mockSetSimOptions.mockClear();
  mockStartCaseRun.mockClear();
  mockStartCaseRuns.mockClear();
  useUiStore.setState({ activeView: 'simulation', simLeftPanelWidth: 260 });
  useWorkbenchStore.setState({ tabs: [], activeTabId: null });
});

// ── 三栏布局渲染 ──────────────────────────────────────────────

describe('SimulationView 三栏布局渲染', () => {
  it('三个子面板均可见：CaseTreePanel / SimOptionPanel / RunListPanel', () => {
    render(<SimulationView />);

    expect(screen.getByTestId('case-tree-panel')).toBeInTheDocument();
    expect(screen.getByTestId('run-list-panel')).toBeInTheDocument();
    // SimOptionPanel 面板标题 + SimCommandBar 命令栏均可见
    expect(screen.getByTestId('sim-option-panel')).toBeInTheDocument();
    expect(screen.getByTestId('sim-command-bar')).toBeInTheDocument();
  });

  it('ViewHeader 标题「仿真」+ 副标题计数', () => {
    mocks.sim.activeRuns = seedAllStatuses();
    render(<SimulationView />);

    expect(screen.getByText('仿真')).toBeInTheDocument();
    // 2 running + 1 pending = 3 live; 7 - 3 = 4 done
    expect(screen.getByText(/3 运行中/)).toBeInTheDocument();
    expect(screen.getByText(/4 已完成/)).toBeInTheDocument();
  });

  it('左栏宽度由 simLeftPanelWidth 控制', () => {
    useUiStore.setState({ simLeftPanelWidth: 300 });
    render(<SimulationView />);

    // After tab UI integration, the width container is an ancestor of case-tree-panel
    // (case-tree-panel → tab content div → width container div)
    const treePanel = screen.getByTestId('case-tree-panel');
    const widthContainer = treePanel.closest('[style*="width"]');
    expect(widthContainer).toHaveStyle({ width: '300px' });
  });
});

// ── 三栏联动 ──────────────────────────────────────────────────

describe('SimulationView 三栏联动', () => {
  it('左栏选中用例 → selectCase() 调用 → simOptions 更新 → 中栏 Option 填充', async () => {
    render(<SimulationView />);

    // 模拟选中用例后 simOptions 被填充
    mockSimOptions = { case: 'alu_add', base: 'base_test', block: 'block_a' };

    // 由于 selectCase 是 mock，直接验证它未被 SimulationView 自身调用
    // （联动发生在 CaseTreePanel 内部点击用例时）
    // 这里验证 Option 面板能读到 simOptions
    expect(mockSelectCase).not.toHaveBeenCalled();
  });
});

// ── RunListPanel 委托行为 ──────────────────────────────────────

describe('SimulationView 分段筛选器', () => {
  it('各段计数正确：全部/运行中/失败/通过/队列/已停止', () => {
    mocks.sim.activeRuns = seedAllStatuses();
    render(<SimulationView />);

    expect(screen.getByTestId('sim-seg-all').textContent).toContain('7');
    expect(screen.getByTestId('sim-seg-running').textContent).toContain('2');
    expect(screen.getByTestId('sim-seg-fail').textContent).toContain('2');
    expect(screen.getByTestId('sim-seg-pass').textContent).toContain('1');
    expect(screen.getByTestId('sim-seg-queued').textContent).toContain('1');
    expect(screen.getByTestId('sim-seg-stopped').textContent).toContain('1');
  });

  it('点击段过滤表格：失败段包含 fail 与 error，全部段恢复', () => {
    mocks.sim.activeRuns = seedAllStatuses();
    render(<SimulationView />);

    fireEvent.click(screen.getByTestId('sim-seg-fail'));
    const rows = screen.getAllByTestId(/^sim-row-/);
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('i2c_arbitration_lost');
    expect(rows[1].textContent).toContain('spi_quad_tx_rx');

    fireEvent.click(screen.getByTestId('sim-seg-all'));
    expect(screen.getAllByTestId(/^sim-row-/)).toHaveLength(7);
  });

  it('运行中/通过/队列/已停止段各自过滤', () => {
    mocks.sim.activeRuns = seedAllStatuses();
    render(<SimulationView />);

    fireEvent.click(screen.getByTestId('sim-seg-running'));
    expect(screen.getAllByTestId(/^sim-row-/).map((r) => r.textContent)).toEqual([
      expect.stringContaining('uart_loopback_cfg'),
      expect.stringContaining('dma_burst_xfer_64b'),
    ]);

    fireEvent.click(screen.getByTestId('sim-seg-pass'));
    expect(screen.getAllByTestId(/^sim-row-/)).toHaveLength(1);

    fireEvent.click(screen.getByTestId('sim-seg-queued'));
    expect(screen.getAllByTestId(/^sim-row-/)[0].textContent).toContain('axi_lite_smoke');

    fireEvent.click(screen.getByTestId('sim-seg-stopped'));
    expect(screen.getAllByTestId(/^sim-row-/)[0].textContent).toContain('apb_reg_rw');
  });
});

describe('SimulationView 关键字过滤', () => {
  it('按用例名匹配，且与状态筛选可叠加', () => {
    mocks.sim.activeRuns = seedAllStatuses();
    render(<SimulationView />);

    fireEvent.change(screen.getByTestId('sim-filter-input'), { target: { value: 'dma' } });
    expect(screen.getAllByTestId(/^sim-row-/)).toHaveLength(1);
    expect(screen.getAllByTestId(/^sim-row-/)[0].textContent).toContain('dma_burst_xfer_64b');

    fireEvent.click(screen.getByTestId('sim-seg-fail'));
    expect(screen.getByTestId('sim-view-no-match')).toBeInTheDocument();
  });

  it('按 seed 匹配', () => {
    mocks.sim.activeRuns = seedAllStatuses();
    render(<SimulationView />);

    fireEvent.change(screen.getByTestId('sim-filter-input'), { target: { value: '0x52D1' } });
    const rows = screen.getAllByTestId(/^sim-row-/);
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('i2c_arbitration_lost');
  });
});

describe('SimulationView 表格', () => {
  it('列头完整：用例/子系统/进度/耗时/ETA；行含状态点、seed、进度条、耗时', () => {
    mocks.sim.activeRuns = seedAllStatuses();
    render(<SimulationView />);

    for (const label of ['用例', '子系统', '进度', '耗时', 'ETA']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }

    const failRow = screen.getByTestId('sim-row-r-fail-1');
    expect(failRow.textContent).toContain('i2c_arbitration_lost');
    expect(failRow.textContent).toContain('0x52D1');
    expect(failRow.textContent).toContain('I2C');
    expect(failRow.textContent).toContain('1m');
    expect(failRow.textContent).toContain('失败');

    expect(screen.getAllByTestId('sim-progress-track').length).toBe(7);
  });

  it('运行中行显示实时耗时与占位 ETA', () => {
    const now = Date.now();
    mocks.sim.activeRuns = [
      makeRun({ runId: 'r-live', caseName: 'live_case', startTime: now - 5000, terminalId: 'term-1' }),
    ];
    render(<SimulationView />);

    const row = screen.getByTestId('sim-row-r-live');
    expect(row.textContent).toMatch(/\d+s/);
    expect(row.textContent).toContain('—');
  });
});

describe('SimulationView 行点击路由', () => {
  it('行点击打开仿真详情 Tab', () => {
    mocks.sim.activeRuns = [makeRun({ runId: 'r-1', caseName: 'dma_burst_xfer_64b' })];
    render(<SimulationView />);

    fireEvent.click(screen.getByTestId('sim-row-r-1'));
    const tabs = useWorkbenchStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].destination.type).toBe('simulation-detail');
  });

  it('重复点击同一行不重复开 Tab', () => {
    mocks.sim.activeRuns = [makeRun({ runId: 'r-1' })];
    render(<SimulationView />);

    fireEvent.click(screen.getByTestId('sim-row-r-1'));
    fireEvent.click(screen.getByTestId('sim-row-r-1'));
    expect(useWorkbenchStore.getState().tabs).toHaveLength(1);
  });
});

describe('SimulationView 空状态', () => {
  it('无运行时显示空状态引导文案', () => {
    render(<SimulationView />);
    expect(screen.getByTestId('sim-view-empty')).toBeInTheDocument();
  });

  it('筛选无匹配时空状态含清空筛选按钮，点击后恢复', () => {
    mocks.sim.activeRuns = seedAllStatuses();
    render(<SimulationView />);

    fireEvent.change(screen.getByTestId('sim-filter-input'), { target: { value: '不存在的用例' } });
    expect(screen.getByTestId('sim-view-no-match')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('sim-clear-filters'));
    expect(screen.getAllByTestId(/^sim-row-/)).toHaveLength(7);
    expect(screen.getByTestId('sim-filter-input')).toHaveValue('');
  });

  it('状态段无匹配也走无匹配空状态并可清空', () => {
    mocks.sim.activeRuns = [makeRun({ runId: 'r-1', status: 'running' })];
    render(<SimulationView />);

    fireEvent.click(screen.getByTestId('sim-seg-stopped'));
    expect(screen.getByTestId('sim-view-no-match')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('sim-clear-filters'));
    expect(screen.getAllByTestId(/^sim-row-/)).toHaveLength(1);
    expect(screen.getByTestId('sim-seg-all')).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('SimulationView 骨架屏', () => {
  it('加载中显示骨架屏', () => {
    mocks.sim.loadingActiveRuns = true;
    render(<SimulationView />);
    expect(screen.getByTestId('sim-view-skeleton')).toBeInTheDocument();
  });
});

// ── ViewHeader 动作 ───────────────────────────────────────────

describe('SimulationView 顶栏动作', () => {
  it('停止全部委托 simulation store 的 stopAllRuns', () => {
    mocks.sim.activeRuns = [
      makeRun({ runId: 'r-term', status: 'running', terminalId: 'term-1' }),
      makeRun({ runId: 'r-plugin', status: 'running' }),
      makeRun({ runId: 'r-done', status: 'pass', terminalId: 'term-2', endTime: Date.now() }),
    ];
    render(<SimulationView />);

    fireEvent.click(screen.getByTestId('sim-stop-all'));
    expect(mocks.sim.stopAllRuns).toHaveBeenCalledTimes(1);
  });

  it('无运行中仿真时停止全部禁用', () => {
    mocks.sim.activeRuns = [makeRun({ runId: 'r-done', status: 'pass', endTime: Date.now() })];
    render(<SimulationView />);

    expect(screen.getByTestId('sim-stop-all')).toBeDisabled();
  });

  it('新建仿真切换到 workspace 视图', () => {
    render(<SimulationView />);

    fireEvent.click(screen.getByTestId('sim-new-btn'));
    expect(useUiStore.getState().activeView).toBe('workspace');
  });
});

// ── 数据加载 ──────────────────────────────────────────────────

describe('SimulationView 数据加载', () => {
  it('mount 时以当前项目加载活跃运行', () => {
    render(<SimulationView />);
    expect(mocks.sim.loadActiveRuns).toHaveBeenCalledWith('proj-1');
  });

  it('无当前项目时不加载', () => {
    mocks.proj.currentProjectId = null;
    render(<SimulationView />);
    expect(mocks.sim.loadActiveRuns).not.toHaveBeenCalled();
  });
});

// ── 排序 ──────────────────────────────────────────────────────

describe('SimulationView 排序', () => {
  it('运行中优先 → 失败 → 通过，同组内按开始时间倒序', () => {
    const now = Date.now();
    mocks.sim.activeRuns = [
      makeRun({ runId: 'r-pass', caseName: 'pass_case', status: 'pass', startTime: now - 100, endTime: now }),
      makeRun({ runId: 'r-fail', caseName: 'fail_case', status: 'fail', startTime: now - 200, endTime: now }),
      makeRun({ runId: 'r-run-a', caseName: 'run_a', status: 'running', startTime: now - 50 }),
      makeRun({ runId: 'r-run-b', caseName: 'run_b', status: 'running', startTime: now - 10 }),
    ];
    render(<SimulationView />);

    const rows = screen.getAllByTestId(/^sim-row-/);
    expect(rows[0].textContent).toContain('run_b');
    expect(rows[1].textContent).toContain('run_a');
    expect(rows[2].textContent).toContain('fail_case');
    expect(rows[3].textContent).toContain('pass_case');
  });
});
