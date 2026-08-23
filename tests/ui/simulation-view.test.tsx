// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SimulationRunRecord } from '@renderer/stores/simulation';

/**
 * 仿真视图（Issue #4）测试：分段筛选器 / 关键字过滤 / 表格列 /
 * 行点击路由 / 空状态切换 / 骨架屏 / 停止全部与新建仿真动作。
 * 数据依赖的 store 全部 mock（selector 直读可变状态）；
 * ui / workbench 为纯 zustand，使用真实 store。
 */

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
    projects: [
      { id: 'proj-1', name: 'neckar-dv', rootPath: '/proj/neckar-dv', createdAt: 0, lastOpenedAt: 0 },
    ],
  },
}));

vi.mock('@renderer/stores/simulation', () => ({
  useSimulationStore: (selector: (s: typeof mocks.sim) => unknown) => selector(mocks.sim),
}));

vi.mock('@renderer/stores/project', () => ({
  useProjectStore: (selector: (s: typeof mocks.proj) => unknown) => selector(mocks.proj),
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
  useUiStore.setState({ activeView: 'simulation' });
  useWorkbenchStore.setState({ tabs: [], activeTabId: null });
});

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
    // 运行中优先，同组内最新在前（uart 比 dma 晚启动）
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

    // 叠加状态筛选：失败段中无 dma 用例 → 无匹配
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
    // 终态耗时固定：startTime → endTime = 60s
    expect(failRow.textContent).toContain('1m');
    // 终态 ETA 列显示状态文案而非伪造的 ETA
    expect(failRow.textContent).toContain('失败');

    // 进度条轨道存在（全部行）
    expect(screen.getAllByTestId('sim-progress-track').length).toBe(7);
  });

  it('运行中行显示实时耗时与占位 ETA（无 ETA 数据源，不伪造）', () => {
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
  it('行点击打开仿真详情 Tab 并切换到 workspace 视图', () => {
    mocks.sim.activeRuns = [makeRun({ runId: 'r-1', caseName: 'dma_burst_xfer_64b' })];
    render(<SimulationView />);

    fireEvent.click(screen.getByTestId('sim-row-r-1'));
    expect(useUiStore.getState().activeView).toBe('workspace');
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
    // 清空后回到全部段
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

describe('SimulationView 顶栏动作', () => {
  it('停止全部委托 simulation store 的 stopAllRuns（终端/插件分派在 store 层实现）', () => {
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

  it('新建仿真切换到 workspace 视图（用例列表所在处）', () => {
    render(<SimulationView />);

    fireEvent.click(screen.getByTestId('sim-new-btn'));
    expect(useUiStore.getState().activeView).toBe('workspace');
  });
});

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
