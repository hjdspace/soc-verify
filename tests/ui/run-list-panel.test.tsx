// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SimulationRunRecord } from '@renderer/stores/simulation';

/**
 * RunListPanel（Issue #4）测试：分段筛选器计数 / 关键字过滤 /
 * 表格行渲染（状态点、seed、进度条、耗时、ETA）/ 行点击路由 /
 * 停止全部 / 骨架屏 / 空状态 / 无匹配清空。
 *
 * Mock 策略与 simulation-view.test.tsx 一致：
 * - simulation store: activeRuns / loadingActiveRuns / stopAllRuns
 * - workbench store: 真实 zustand（open → simulation-detail Tab）
 */

const mocks = vi.hoisted(() => ({
  sim: {
    activeRuns: [] as SimulationRunRecord[],
    loadingActiveRuns: false,
    stopAllRuns: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    project: {
      getSubsystems: { query: vi.fn().mockResolvedValue([]) },
      getCases: { query: vi.fn().mockResolvedValue([]) },
      searchCases: { query: vi.fn().mockResolvedValue([]) },
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
  useSimulationStore: (selector: (s: typeof mocks.sim) => unknown) => selector(mocks.sim),
}));

import { RunListPanel } from '@renderer/components/simulation/RunListPanel';
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
  mocks.sim.stopAllRuns.mockClear();
  useWorkbenchStore.setState({ tabs: [], activeTabId: null });
});

describe('RunListPanel 分段筛选器', () => {
  it('各段计数正确：全部/运行中/失败/通过/队列/已停止', () => {
    mocks.sim.activeRuns = seedAllStatuses();
    render(<RunListPanel />);

    expect(screen.getByTestId('sim-seg-all').textContent).toContain('7');
    expect(screen.getByTestId('sim-seg-running').textContent).toContain('2');
    expect(screen.getByTestId('sim-seg-fail').textContent).toContain('2');
    expect(screen.getByTestId('sim-seg-pass').textContent).toContain('1');
    expect(screen.getByTestId('sim-seg-queued').textContent).toContain('1');
    expect(screen.getByTestId('sim-seg-stopped').textContent).toContain('1');
  });

  it('点击段过滤表格：失败段包含 fail 与 error，全部段恢复', () => {
    mocks.sim.activeRuns = seedAllStatuses();
    render(<RunListPanel />);

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
    render(<RunListPanel />);

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

describe('RunListPanel 关键字过滤', () => {
  it('按用例名匹配，且与状态筛选可叠加', () => {
    mocks.sim.activeRuns = seedAllStatuses();
    render(<RunListPanel />);

    fireEvent.change(screen.getByTestId('sim-filter-input'), { target: { value: 'dma' } });
    expect(screen.getAllByTestId(/^sim-row-/)).toHaveLength(1);
    expect(screen.getAllByTestId(/^sim-row-/)[0].textContent).toContain('dma_burst_xfer_64b');

    // 叠加状态筛选：失败段中无 dma 用例 → 无匹配
    fireEvent.click(screen.getByTestId('sim-seg-fail'));
    expect(screen.getByTestId('sim-view-no-match')).toBeInTheDocument();
  });

  it('按 seed 匹配', () => {
    mocks.sim.activeRuns = seedAllStatuses();
    render(<RunListPanel />);

    fireEvent.change(screen.getByTestId('sim-filter-input'), { target: { value: '0x52D1' } });
    const rows = screen.getAllByTestId(/^sim-row-/);
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('i2c_arbitration_lost');
  });
});

describe('RunListPanel 表格行', () => {
  it('列头完整：用例/子系统/进度/耗时/ETA；行含状态点、seed、进度条、耗时', () => {
    mocks.sim.activeRuns = seedAllStatuses();
    render(<RunListPanel />);

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
    render(<RunListPanel />);

    const row = screen.getByTestId('sim-row-r-live');
    expect(row.textContent).toMatch(/\d+s/);
    expect(row.textContent).toContain('—');
  });
});

describe('RunListPanel 行点击路由', () => {
  it('行点击打开仿真详情 Tab', () => {
    mocks.sim.activeRuns = [makeRun({ runId: 'r-1', caseName: 'dma_burst_xfer_64b' })];
    render(<RunListPanel />);

    fireEvent.click(screen.getByTestId('sim-row-r-1'));
    const tabs = useWorkbenchStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    const dest = tabs[0].destination;
    expect(dest.type).toBe('simulation-detail');
    if (dest.type === 'simulation-detail') {
      expect(dest.runId).toBe('r-1');
    }
  });

  it('重复点击同一行不重复开 Tab', () => {
    mocks.sim.activeRuns = [makeRun({ runId: 'r-1' })];
    render(<RunListPanel />);

    fireEvent.click(screen.getByTestId('sim-row-r-1'));
    fireEvent.click(screen.getByTestId('sim-row-r-1'));
    expect(useWorkbenchStore.getState().tabs).toHaveLength(1);
  });
});

describe('RunListPanel 停止全部', () => {
  it('点击停止全部调用 stopAllRuns', () => {
    mocks.sim.activeRuns = [
      makeRun({ runId: 'r-term', status: 'running', terminalId: 'term-1' }),
      makeRun({ runId: 'r-plugin', status: 'running' }),
    ];
    render(<RunListPanel />);

    fireEvent.click(screen.getByTestId('sim-stop-all'));
    expect(mocks.sim.stopAllRuns).toHaveBeenCalledTimes(1);
  });

  it('无运行中仿真时停止全部禁用', () => {
    mocks.sim.activeRuns = [makeRun({ runId: 'r-done', status: 'pass', endTime: Date.now() })];
    render(<RunListPanel />);

    expect(screen.getByTestId('sim-stop-all')).toBeDisabled();
  });
});

describe('RunListPanel 空状态', () => {
  it('无运行时显示空状态引导文案', () => {
    render(<RunListPanel />);
    expect(screen.getByTestId('sim-view-empty')).toBeInTheDocument();
    expect(screen.getByText('暂无仿真运行')).toBeInTheDocument();
  });

  it('筛选无匹配时空状态含清空筛选按钮，点击后恢复', () => {
    mocks.sim.activeRuns = seedAllStatuses();
    render(<RunListPanel />);

    fireEvent.change(screen.getByTestId('sim-filter-input'), { target: { value: '不存在的用例' } });
    expect(screen.getByTestId('sim-view-no-match')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('sim-clear-filters'));
    expect(screen.getAllByTestId(/^sim-row-/)).toHaveLength(7);
    expect(screen.getByTestId('sim-filter-input')).toHaveValue('');
  });

  it('状态段无匹配也走无匹配空状态并可清空', () => {
    mocks.sim.activeRuns = [makeRun({ runId: 'r-1', status: 'running' })];
    render(<RunListPanel />);

    fireEvent.click(screen.getByTestId('sim-seg-stopped'));
    expect(screen.getByTestId('sim-view-no-match')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('sim-clear-filters'));
    expect(screen.getAllByTestId(/^sim-row-/)).toHaveLength(1);
    // 清空后回到全部段
    expect(screen.getByTestId('sim-seg-all')).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('RunListPanel 骨架屏', () => {
  it('加载中显示骨架屏', () => {
    mocks.sim.loadingActiveRuns = true;
    render(<RunListPanel />);
    expect(screen.getByTestId('sim-view-skeleton')).toBeInTheDocument();
  });
});

describe('RunListPanel 排序', () => {
  it('运行中优先 → 失败 → 通过，同组内按开始时间倒序', () => {
    const now = Date.now();
    mocks.sim.activeRuns = [
      makeRun({ runId: 'r-pass', caseName: 'pass_case', status: 'pass', startTime: now - 100, endTime: now }),
      makeRun({ runId: 'r-fail', caseName: 'fail_case', status: 'fail', startTime: now - 200, endTime: now }),
      makeRun({ runId: 'r-run-a', caseName: 'run_a', status: 'running', startTime: now - 50 }),
      makeRun({ runId: 'r-run-b', caseName: 'run_b', status: 'running', startTime: now - 10 }),
    ];
    render(<RunListPanel />);

    const rows = screen.getAllByTestId(/^sim-row-/);
    // 运行中优先（最新先）：run_b → run_a
    expect(rows[0].textContent).toContain('run_b');
    expect(rows[1].textContent).toContain('run_a');
    // 失败次之
    expect(rows[2].textContent).toContain('fail_case');
    // 通过最后
    expect(rows[3].textContent).toContain('pass_case');
  });
});
