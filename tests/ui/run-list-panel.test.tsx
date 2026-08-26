// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SimulationRunRecord } from '@renderer/stores/simulation';

/**
 * RunListPanel（Issue #4）测试：分段筛选器计数 / 关键字过滤 /
 * 表格行渲染（状态点、seed、进度条、耗时、ETA）/ 行点击路由 /
 * 停止全部 / 骨架屏 / 空状态 / 无匹配清空。
 *
 * 行内 Debug 按钮（UI 方案 C，移植 Python 执行日志页快捷按钮）：
 * hover 浮现图标组（Verdi/Verisium/编译日志/仿真日志/反汇编）+ ⋮ 菜单
 *（内置编辑器 / gvim 打开方式、打开用例目录）；产物缺失时禁用。
 *
 * Mock 策略与 simulation-view.test.tsx 一致：
 * - simulation store: activeRuns / loadingActiveRuns / stopAllRuns
 * - trpc: resolveDebugArtifacts / launchVerdi / launchVerisium / openInSystem
 * - workbench store: 真实 zustand（open → file / simulation-detail Tab）
 * - toast store: mock（无 IPC 依赖）
 */

const mocks = vi.hoisted(() => ({
  sim: {
    activeRuns: [] as SimulationRunRecord[],
    loadingActiveRuns: false,
    stopAllRuns: vi.fn().mockResolvedValue(undefined),
  },
  debug: {
    resolveArtifacts: vi.fn(),
    launchVerdi: vi.fn(),
    launchVerisium: vi.fn(),
    openInSystem: vi.fn().mockResolvedValue(undefined),
  },
  toast: {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    project: {
      getSubsystems: { query: vi.fn().mockResolvedValue([]) },
      getCases: { query: vi.fn().mockResolvedValue([]) },
      searchCases: { query: vi.fn().mockResolvedValue([]) },
      openInSystem: { mutate: mocks.debug.openInSystem },
    },
    simulation: {
      listActiveRuns: { query: vi.fn().mockResolvedValue([]) },
      runInTerminal: { mutate: vi.fn().mockResolvedValue({ runId: 'run-1', terminalId: 'term-1', command: '', cwd: '' }) },
      abortTerminalRun: { mutate: vi.fn().mockResolvedValue(undefined) },
      abort: { mutate: vi.fn().mockResolvedValue(undefined) },
      resolveDebugArtifacts: { query: mocks.debug.resolveArtifacts },
      launchVerdi: { mutate: mocks.debug.launchVerdi },
      launchVerisium: { mutate: mocks.debug.launchVerisium },
    },
  },
}));

vi.mock('@renderer/stores/simulation', () => ({
  useSimulationStore: (selector: (s: typeof mocks.sim) => unknown) => selector(mocks.sim),
}));

vi.mock('@renderer/stores/toast', () => ({
  useToastStore: {
    getState: () => ({
      info: mocks.toast.info,
      warning: mocks.toast.warning,
      error: mocks.toast.error,
      success: mocks.toast.success,
    }),
  },
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
  mocks.debug.resolveArtifacts.mockReset().mockResolvedValue({
    caseDir: null,
    simLogPath: null,
    compileLogPath: null,
    asmFiles: [],
    verdiMode: null,
    matchedCaseDirs: [],
  });
  mocks.debug.launchVerdi.mockReset().mockResolvedValue({
    caseDir: '/work/alu_add',
    command: 'run_verdi comp_load',
    logPath: '/work/alu_add/verdi_launch.log',
    mode: 'xrun',
  });
  mocks.debug.launchVerisium.mockReset().mockResolvedValue({
    caseDir: '/work/alu_add',
    command: 'run_vdb',
    logPath: '/work/alu_add/verisium_launch.log',
  });
  mocks.debug.openInSystem.mockClear();
  mocks.toast.info.mockClear();
  mocks.toast.warning.mockClear();
  mocks.toast.error.mockClear();
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

    fireEvent.click(screen.getByTestId('run-list-stop-all'));
    expect(mocks.sim.stopAllRuns).toHaveBeenCalledTimes(1);
  });

  it('无运行中仿真时停止全部禁用', () => {
    mocks.sim.activeRuns = [makeRun({ runId: 'r-done', status: 'pass', endTime: Date.now() })];
    render(<RunListPanel />);

    expect(screen.getByTestId('run-list-stop-all')).toBeDisabled();
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

describe('RunListPanel 虚拟滚动', () => {
  /**
   * 当 activeRuns 包含大量用例（如 500 条）时，虚拟化应限制实际渲染的行数，
   * 避免一次性渲染全部 DOM 节点导致卡顿。
   *
   * 在 jsdom 中，scrollElement 的 clientHeight 为 0，虚拟化器会 fallback
   * 为渲染全部行（因为没有有效视口高度），所以这里验证的是：
   * 1. 大量数据时组件仍能正常渲染和交互
   * 2. 行的 data-testid 保持 sim-row-{runId} 不变
   * 3. 点击行仍能正确路由
   * 4. 虚拟化容器存在（通过 data-testid="run-list-virtual-scroll"）
   */
  it('500 条运行记录时仍能正常渲染和交互', () => {
    const runs: SimulationRunRecord[] = Array.from({ length: 500 }, (_, i) =>
      makeRun({
        runId: `r-batch-${i}`,
        caseName: `case_batch_${i}`,
        status: i % 3 === 0 ? 'running' : i % 3 === 1 ? 'pass' : 'fail',
        startTime: Date.now() - i * 1000,
        endTime: i % 3 === 0 ? undefined : Date.now() - i * 1000 + 500,
      }),
    );
    mocks.sim.activeRuns = runs;
    render(<RunListPanel />);

    // 虚拟滚动容器存在
    expect(screen.getByTestId('run-list-virtual-scroll')).toBeInTheDocument();

    // 至少渲染了部分行（具体数量取决于虚拟化器，但不应为 0）
    const renderedRows = screen.getAllByTestId(/^sim-row-/);
    expect(renderedRows.length).toBeGreaterThan(0);

    // 第一个运行中行的 caseName 应该在渲染的行中
    // 排序后运行中优先，r-batch-0 是第一个 running（startTime 最晚的 running）
    const firstRunningRow = renderedRows.find((r) => r.textContent?.includes('case_batch_0'));
    expect(firstRunningRow).toBeTruthy();
  });

  it('虚拟滚动下行点击仍能正确路由到仿真详情', () => {
    mocks.sim.activeRuns = [
      makeRun({ runId: 'r-virt-1', caseName: 'virt_case_1' }),
      makeRun({ runId: 'r-virt-2', caseName: 'virt_case_2' }),
    ];
    render(<RunListPanel />);

    const rows = screen.getAllByTestId(/^sim-row-/);
    fireEvent.click(rows[0]);

    const tabs = useWorkbenchStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].destination.type).toBe('simulation-detail');
  });
});

// ═══════════════════════════════════════════════════════════
// 行内 Debug 按钮（UI 方案 C — hover 浮现图标组 + ⋮ 菜单）
// ═══════════════════════════════════════════════════════════

const DEBUG_ARTIFACTS = {
  caseDir: '/work/alu_add',
  simLogPath: '/work/alu_add/log/irun_sim.log',
  compileLogPath: '/work/alu_add/log/irun_compile.log',
  asmFiles: ['/work/alu_add/sw_build/alu.asm'],
  verdiMode: 'xrun' as const,
  matchedCaseDirs: ['/work/alu_add'],
};

function seedDebuggableRun(): void {
  const now = Date.now();
  mocks.sim.activeRuns = [
    makeRun({
      runId: 'r-dbg-1',
      caseName: 'alu_add',
      status: 'fail',
      startTime: now - 60000,
      endTime: now - 30000,
      command: 'runsim -case alu_add',
      cwd: '/env/project',
    }),
  ];
}

describe('RunListPanel 行内 Debug 按钮（方案 C）', () => {
  it('行内渲染五个 Debug 图标按钮（Verdi/Verisium/编译日志/仿真日志/反汇编）', async () => {
    mocks.debug.resolveArtifacts.mockResolvedValue(DEBUG_ARTIFACTS);
    seedDebuggableRun();
    render(<RunListPanel />);

    expect(await screen.findByTestId('sim-rowdbg-r-dbg-1-btn-verdi')).toBeInTheDocument();
    expect(screen.getByTestId('sim-rowdbg-r-dbg-1-btn-verisium')).toBeInTheDocument();
    expect(screen.getByTestId('sim-rowdbg-r-dbg-1-btn-compile-log')).toBeInTheDocument();
    expect(screen.getByTestId('sim-rowdbg-r-dbg-1-btn-sim-log')).toBeInTheDocument();
    expect(screen.getByTestId('sim-rowdbg-r-dbg-1-btn-asm')).toBeInTheDocument();
  });

  it('按行记录解析产物（cwd / command / caseName）', async () => {
    mocks.debug.resolveArtifacts.mockResolvedValue(DEBUG_ARTIFACTS);
    seedDebuggableRun();
    render(<RunListPanel />);

    await screen.findByTestId('sim-rowdbg-r-dbg-1-btn-verdi');
    expect(mocks.debug.resolveArtifacts).toHaveBeenCalledWith({
      cwd: '/env/project',
      caseName: 'alu_add',
      command: 'runsim -case alu_add',
    });
  });

  it('点击 Verdi 图标以隐藏子进程启动（携带该行的 cwd/命令）', async () => {
    mocks.debug.resolveArtifacts.mockResolvedValue(DEBUG_ARTIFACTS);
    seedDebuggableRun();
    render(<RunListPanel />);

    fireEvent.click(await screen.findByTestId('sim-rowdbg-r-dbg-1-btn-verdi'));

    await waitFor(() => {
      expect(mocks.debug.launchVerdi).toHaveBeenCalledWith({
        cwd: '/env/project',
        caseName: 'alu_add',
        command: 'runsim -case alu_add',
      });
    });
  });

  it('点击编译日志/仿真日志图标以内置编辑器打开', async () => {
    mocks.debug.resolveArtifacts.mockResolvedValue(DEBUG_ARTIFACTS);
    seedDebuggableRun();
    render(<RunListPanel />);

    fireEvent.click(await screen.findByTestId('sim-rowdbg-r-dbg-1-btn-compile-log'));

    let tabs = useWorkbenchStore.getState().tabs;
    expect(tabs.some((t) => t.destination.type === 'file'
      && t.destination.path === '/work/alu_add/log/irun_compile.log')).toBe(true);

    fireEvent.click(screen.getByTestId('sim-rowdbg-r-dbg-1-btn-sim-log'));
    tabs = useWorkbenchStore.getState().tabs;
    expect(tabs.some((t) => t.destination.type === 'file'
      && t.destination.path === '/work/alu_add/log/irun_sim.log')).toBe(true);
  });

  it('点击反汇编图标直接打开（单文件）', async () => {
    mocks.debug.resolveArtifacts.mockResolvedValue(DEBUG_ARTIFACTS);
    seedDebuggableRun();
    render(<RunListPanel />);

    fireEvent.click(await screen.findByTestId('sim-rowdbg-r-dbg-1-btn-asm'));

    const tabs = useWorkbenchStore.getState().tabs;
    expect(tabs.some((t) => t.destination.type === 'file'
      && t.destination.path === '/work/alu_add/sw_build/alu.asm')).toBe(true);
  });

  it('产物缺失时图标禁用', async () => {
    mocks.debug.resolveArtifacts.mockResolvedValue({
      caseDir: null,
      simLogPath: null,
      compileLogPath: null,
      asmFiles: [],
      verdiMode: null,
      matchedCaseDirs: [],
    });
    seedDebuggableRun();
    render(<RunListPanel />);

    const verdi = await screen.findByTestId('sim-rowdbg-r-dbg-1-btn-verdi');
    await waitFor(() => expect(verdi).toBeDisabled());
    expect(screen.getByTestId('sim-rowdbg-r-dbg-1-btn-compile-log')).toBeDisabled();
    expect(screen.getByTestId('sim-rowdbg-r-dbg-1-btn-sim-log')).toBeDisabled();
    expect(screen.getByTestId('sim-rowdbg-r-dbg-1-btn-asm')).toBeDisabled();
  });

  it('⋮ 菜单提供 gvim 打开方式与用例目录入口', async () => {
    mocks.debug.resolveArtifacts.mockResolvedValue(DEBUG_ARTIFACTS);
    seedDebuggableRun();
    render(<RunListPanel />);

    fireEvent.click(await screen.findByTestId('sim-rowdbg-r-dbg-1-btn-more'));

    // gvim 打开编译日志
    fireEvent.click(await screen.findByTestId('sim-rowdbg-r-dbg-1-menu-compile-log-gvim'));
    await waitFor(() => {
      expect(mocks.debug.openInSystem).toHaveBeenCalledWith({
        path: '/work/alu_add/log/irun_compile.log',
        type: 'file',
      });
    });

    // 在文件管理器中打开用例目录
    fireEvent.click(screen.getByTestId('sim-rowdbg-r-dbg-1-btn-more'));
    fireEvent.click(await screen.findByTestId('sim-rowdbg-r-dbg-1-menu-open-casedir'));
    await waitFor(() => {
      expect(mocks.debug.openInSystem).toHaveBeenCalledWith({
        path: '/work/alu_add',
        type: 'directory',
      });
    });
  });

  it('点击 Debug 图标不触发行点击路由（详情 Tab 不打开）', async () => {
    mocks.debug.resolveArtifacts.mockResolvedValue(DEBUG_ARTIFACTS);
    seedDebuggableRun();
    render(<RunListPanel />);

    fireEvent.click(await screen.findByTestId('sim-rowdbg-r-dbg-1-btn-verdi'));

    await waitFor(() => {
      expect(mocks.debug.launchVerdi).toHaveBeenCalled();
    });
    const tabs = useWorkbenchStore.getState().tabs;
    expect(tabs.filter((t) => t.destination.type === 'simulation-detail')).toHaveLength(0);
  });

  it('⋮ 菜单提供打开 Verdi / Verisium（对齐原型 run_verdi / run_verisium）', async () => {
    mocks.debug.resolveArtifacts.mockResolvedValue(DEBUG_ARTIFACTS);
    seedDebuggableRun();
    render(<RunListPanel />);

    fireEvent.click(await screen.findByTestId('sim-rowdbg-r-dbg-1-btn-more'));
    fireEvent.click(await screen.findByTestId('sim-rowdbg-r-dbg-1-menu-verdi'));
    await waitFor(() => {
      expect(mocks.debug.launchVerdi).toHaveBeenCalledWith({
        cwd: '/env/project',
        caseName: 'alu_add',
        command: 'runsim -case alu_add',
      });
    });

    fireEvent.click(screen.getByTestId('sim-rowdbg-r-dbg-1-btn-more'));
    fireEvent.click(await screen.findByTestId('sim-rowdbg-r-dbg-1-menu-verisium'));
    await waitFor(() => {
      expect(mocks.debug.launchVerisium).toHaveBeenCalledWith({
        cwd: '/env/project',
        caseName: 'alu_add',
        command: 'runsim -case alu_add',
      });
    });
  });

  it('⋮ 菜单提供内置编辑器打开方式（仿真日志）', async () => {
    mocks.debug.resolveArtifacts.mockResolvedValue(DEBUG_ARTIFACTS);
    seedDebuggableRun();
    render(<RunListPanel />);

    fireEvent.click(await screen.findByTestId('sim-rowdbg-r-dbg-1-btn-more'));
    fireEvent.click(await screen.findByTestId('sim-rowdbg-r-dbg-1-menu-sim-log-builtin'));

    await waitFor(() => {
      const tabs = useWorkbenchStore.getState().tabs;
      expect(tabs.some((t) => t.destination.type === 'file'
        && t.destination.path === '/work/alu_add/log/irun_sim.log')).toBe(true);
    });
    expect(mocks.debug.openInSystem).not.toHaveBeenCalled();
  });

  it('产物缺失时 ⋮ 菜单仍可展开且各项禁用（保留提示）', async () => {
    mocks.debug.resolveArtifacts.mockResolvedValue({
      caseDir: null,
      simLogPath: null,
      compileLogPath: null,
      asmFiles: [],
      verdiMode: null,
      matchedCaseDirs: [],
    });
    seedDebuggableRun();
    render(<RunListPanel />);

    fireEvent.click(await screen.findByTestId('sim-rowdbg-r-dbg-1-btn-more'));

    expect(await screen.findByTestId('sim-rowdbg-r-dbg-1-menu')).toBeInTheDocument();
    expect(screen.getByTestId('sim-rowdbg-r-dbg-1-menu-verdi')).toBeDisabled();
    expect(screen.getByTestId('sim-rowdbg-r-dbg-1-menu-verisium')).toBeDisabled();
    expect(screen.getByTestId('sim-rowdbg-r-dbg-1-menu-compile-log-builtin')).toBeDisabled();
    expect(screen.getByTestId('sim-rowdbg-r-dbg-1-menu-sim-log-gvim')).toBeDisabled();
    expect(screen.getByTestId('sim-rowdbg-r-dbg-1-menu-asm-builtin')).toBeDisabled();
    expect(screen.getByTestId('sim-rowdbg-r-dbg-1-menu-open-casedir')).toBeDisabled();
  });
});
