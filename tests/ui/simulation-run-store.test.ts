// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runInTerminal: vi.fn(),
  abort: vi.fn(),
  abortTerminalRun: vi.fn(),
  listActiveRuns: vi.fn(),
  getRunDetail: vi.fn(),
  rerunWithCommand: vi.fn(),
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    simulation: {
      runInTerminal: { mutate: mocks.runInTerminal },
      abort: { mutate: mocks.abort },
      abortTerminalRun: { mutate: mocks.abortTerminalRun },
      listActiveRuns: { query: mocks.listActiveRuns },
      getRunDetail: { query: mocks.getRunDetail },
      rerunWithCommand: { mutate: mocks.rerunWithCommand },
    },
  },
}));

vi.mock('@renderer/stores/toast', () => ({
  useToastStore: {
    getState: () => ({ info: vi.fn(), error: vi.fn(), warning: vi.fn() }),
  },
}));

import { useSimulationStore } from '@renderer/stores/simulation';
import { useTerminalStore } from '@renderer/stores/terminal';
import { useWorkbenchStore } from '@renderer/stores/workbench';

describe('Terminal Simulation Run launch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSimulationStore.setState({ activeRuns: [], simOptions: { seed: '7', post: true } });
    useTerminalStore.setState({ tabs: [], activeTabId: null });
    useWorkbenchStore.setState({ tabs: [], activeTabId: null });
    mocks.runInTerminal.mockResolvedValue({
      runId: 'run-1',
      terminalId: 'terminal-1',
      command: 'runsim core_smoke -seed 7',
      cwd: 'D:/project/sim',
    });
  });

  it('launches a case as one workflow and focuses the running simulations destination', async () => {
    const runId = await useSimulationStore.getState().startCaseRun('project-1', {
      name: 'core_smoke',
      subsys: 'core',
      base: 'base_a',
      block: 'core_top',
    });

    expect(runId).toBe('run-1');
    expect(mocks.runInTerminal).toHaveBeenCalledWith({
      projectId: 'project-1',
      options: {
        caseId: 'core_smoke',
        caseName: 'core_smoke',
        subsys: 'core',
        options: {
          seed: '7',
          post: true,
          base: 'base_a',
          block: 'core_top',
          case: 'core_smoke',
        },
      },
    });
    expect(useSimulationStore.getState().activeRuns).toEqual([
      expect.objectContaining({ runId: 'run-1', terminalId: 'terminal-1', status: 'running' }),
    ]);
    expect(useSimulationStore.getState().simOptions).toEqual({
      seed: '7', post: true, base: 'base_a', block: 'core_top', case: 'core_smoke',
    });
    expect(useTerminalStore.getState().tabs).toEqual([
      expect.objectContaining({ terminalId: 'terminal-1', title: 'sim: core_smoke' }),
    ]);
    const workbench = useWorkbenchStore.getState();
    expect(workbench.tabs.find((tab) => tab.destination.type === 'terminal')).toBeDefined();
    // After launching a simulation, the terminal tab should be the active
    // view so the user can see the command and output (especially in
    // log-mode where node-pty is unavailable).
    expect(workbench.tabs.find((tab) => tab.id === workbench.activeTabId)?.destination.type)
      .toBe('terminal');
  });

  it('applies Case selection option policy inside the Simulation Run module', () => {
    useSimulationStore.setState({
      simOptions: {
        base: 'old_base',
        block: 'old_block',
        case: 'old_case',
        post: true,
        bq: 'queue-a',
        seed: '7',
        rundir: 'run-7',
        waves: true,
      },
    });

    useSimulationStore.getState().selectCase({
      name: 'core_smoke',
      subsys: 'core',
      base: 'base_a',
      block: 'core_top',
    });

    expect(useSimulationStore.getState().simOptions).toEqual({
      base: 'base_a',
      block: 'core_top',
      case: 'core_smoke',
      post: true,
      bq: 'queue-a',
      seed: '',
      rundir: '',
      waves: false,
    });
  });

  it('reuses the same launch workflow for a batch of Cases', async () => {
    mocks.runInTerminal
      .mockResolvedValueOnce({
        runId: 'run-1', terminalId: 'terminal-1', command: 'runsim case_a', cwd: 'D:/project/sim',
      })
      .mockResolvedValueOnce({
        runId: 'run-2', terminalId: 'terminal-2', command: 'runsim case_b', cwd: 'D:/project/sim',
      });

    const runIds = await useSimulationStore.getState().startCaseRuns('project-1', [
      { name: 'case_a', subsys: 'core', base: 'base_a', block: 'core_top' },
      { name: 'case_b', subsys: 'core', base: 'base_b', block: 'core_top' },
    ]);

    expect(runIds).toEqual(['run-1', 'run-2']);
    expect(mocks.runInTerminal).toHaveBeenCalledTimes(2);
    expect(useTerminalStore.getState().tabs.map((tab) => tab.terminalId)).toEqual([
      'terminal-1',
      'terminal-2',
    ]);
    expect(useSimulationStore.getState().simOptions).toEqual({
      seed: '7', post: true, base: 'base_b', block: 'core_top', case: 'case_b',
    });
  });

  it('loadActiveRuns：后端 byCase 去重后只返回最新记录，前端应替换旧终态记录而非叠加', async () => {
    // 场景：同一用例 test_top_ap_mini 先 FAIL（runId=old-run），
    // 重新仿真后 PASS（runId=new-run）。后端 listActiveRuns 按 case
    // 去重后只返回最新的 pass 记录。前端不应保留旧的 fail 记录。
    const now = Date.now();
    useSimulationStore.setState({
      activeRuns: [
        {
          runId: 'old-run',
          projectId: 'project-1',
          caseId: 'test_top_ap_mini',
          caseName: 'test_top_ap_mini',
          subsys: 'ap',
          status: 'fail' as const,
          startTime: now - 10_000,
          endTime: now - 5_000,
          terminalId: 'term-old',
        },
      ],
    });

    mocks.listActiveRuns.mockResolvedValue([
      {
        runId: 'new-run',
        projectId: 'project-1',
        options: {
          caseId: 'test_top_ap_mini',
          caseName: 'test_top_ap_mini',
          subsys: 'ap',
          options: {},
        },
        status: { runId: 'new-run', status: 'pass', startTime: now, endTime: now + 1000 },
        startTime: now,
        endTime: now + 1000,
        compileErrors: undefined,
      },
    ]);

    await useSimulationStore.getState().loadActiveRuns('project-1');

    const runs = useSimulationStore.getState().activeRuns;
    // 旧的 fail 记录应被移除，只保留新的 pass 记录
    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe('new-run');
    expect(runs[0].status).toBe('pass');
  });

  it('loadActiveRuns：保留本地 running/pending 但后端尚未返回的记录', async () => {
    // 场景：刚通过 IPC started 事件添加了一条 running 记录，
    // 但后端 listActiveRuns 尚未轮询到该记录。前端应保留该记录。
    const now = Date.now();
    useSimulationStore.setState({
      activeRuns: [
        {
          runId: 'local-running',
          projectId: 'project-1',
          caseId: 'case_x',
          caseName: 'case_x',
          subsys: 'core',
          status: 'running' as const,
          startTime: now,
          terminalId: 'term-1',
        },
      ],
    });

    // 后端返回不同的记录
    mocks.listActiveRuns.mockResolvedValue([
      {
        runId: 'backend-run',
        projectId: 'project-1',
        options: {
          caseId: 'case_y',
          caseName: 'case_y',
          subsys: 'core',
          options: {},
        },
        status: { runId: 'backend-run', status: 'pass', startTime: now - 1000, endTime: now },
        startTime: now - 1000,
        endTime: now,
        compileErrors: undefined,
      },
    ]);

    await useSimulationStore.getState().loadActiveRuns('project-1');

    const runs = useSimulationStore.getState().activeRuns;
    // 本地 running 记录应被保留，后端记录也应存在
    expect(runs).toHaveLength(2);
    const runIds = runs.map((r) => r.runId);
    expect(runIds).toContain('local-running');
    expect(runIds).toContain('backend-run');
  });

  it('loadActiveRuns：丢弃本地已终态且后端不再返回的记录', async () => {
    // 场景：本地有一条旧的 pass 记录（已终态），后端不再返回该 runId，
    // 前端应丢弃该记录。
    const now = Date.now();
    useSimulationStore.setState({
      activeRuns: [
        {
          runId: 'stale-pass',
          projectId: 'project-1',
          caseId: 'case_a',
          caseName: 'case_a',
          subsys: 'core',
          status: 'pass' as const,
          startTime: now - 10_000,
          endTime: now - 5_000,
        },
      ],
    });

    // 后端返回空列表
    mocks.listActiveRuns.mockResolvedValue([]);

    await useSimulationStore.getState().loadActiveRuns('project-1');

    const runs = useSimulationStore.getState().activeRuns;
    expect(runs).toHaveLength(0);
  });

  it('rerunRun：重新仿真时移除同 caseId×subsys 的旧终态记录，避免重复显示', async () => {
    // 场景：同一用例 test_top_ap_mini 先 FAIL（runId=old-run），
    // 点击重新仿真后后端返回新 runId=new-run（status=running）。
    // 前端应移除旧 fail 记录，只保留新 running 记录。
    const now = Date.now();
    const oldRun = {
      runId: 'old-run',
      projectId: 'project-1',
      caseId: 'test_top_ap_mini',
      caseName: 'test_top_ap_mini',
      subsys: 'ap',
      status: 'fail' as const,
      startTime: now - 10_000,
      endTime: now - 5_000,
      terminalId: 'term-old',
      command: 'runsim test_top_ap_mini',
      cwd: 'D:/project/sim',
    };
    useSimulationStore.setState({ activeRuns: [oldRun] });

    mocks.rerunWithCommand.mockResolvedValue({
      runId: 'new-run',
      terminalId: 'term-new',
      command: 'runsim test_top_ap_mini',
      cwd: 'D:/project/sim',
    });

    await useSimulationStore.getState().rerunRun(oldRun);

    const runs = useSimulationStore.getState().activeRuns;
    // 旧的 fail 记录应被移除，只保留新的 running 记录
    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe('new-run');
    expect(runs[0].status).toBe('running');
  });

  it('rerunRun：不同用例的记录不受影响', async () => {
    // 场景：两个不同用例，rerun 其中一个，另一个应保留
    const now = Date.now();
    const failRun = {
      runId: 'r-fail',
      projectId: 'project-1',
      caseId: 'case_fail',
      caseName: 'case_fail',
      subsys: 'core',
      status: 'fail' as const,
      startTime: now - 10_000,
      endTime: now - 5_000,
      command: 'runsim case_fail',
      cwd: 'D:/project/sim',
    };
    const passRun = {
      runId: 'r-pass',
      projectId: 'project-1',
      caseId: 'case_pass',
      caseName: 'case_pass',
      subsys: 'core',
      status: 'pass' as const,
      startTime: now - 8_000,
      endTime: now - 3_000,
      command: 'runsim case_pass',
      cwd: 'D:/project/sim',
    };
    useSimulationStore.setState({ activeRuns: [failRun, passRun] });

    mocks.rerunWithCommand.mockResolvedValue({
      runId: 'r-new',
      terminalId: 'term-new',
      command: 'runsim case_fail',
      cwd: 'D:/project/sim',
    });

    await useSimulationStore.getState().rerunRun(failRun);

    const runs = useSimulationStore.getState().activeRuns;
    // 旧 fail 记录被移除，新 running 记录添加，pass 记录保留
    expect(runs).toHaveLength(2);
    const runIds = runs.map((r) => r.runId);
    expect(runIds).toContain('r-new');
    expect(runIds).toContain('r-pass');
    expect(runIds).not.toContain('r-fail');
  });

  it('stopAllRuns：终端运行走 abortTerminalRun，插件运行走 abort，跳过已结束运行（Issue #9）', async () => {
    const now = Date.now();
    useSimulationStore.setState({
      activeRuns: [
        { runId: 'r-term', projectId: 'project-1', caseId: 'c1', subsys: 'core', status: 'running', startTime: now, terminalId: 'term-1' },
        { runId: 'r-plugin', projectId: 'project-1', caseId: 'c2', subsys: 'core', status: 'running', startTime: now },
        { runId: 'r-queued', projectId: 'project-1', caseId: 'c3', subsys: 'core', status: 'pending', startTime: now, terminalId: 'term-3' },
        { runId: 'r-done', projectId: 'project-1', caseId: 'c4', subsys: 'core', status: 'pass', startTime: now, endTime: now, terminalId: 'term-2' },
      ],
    });
    mocks.abort.mockResolvedValue(undefined);
    mocks.abortTerminalRun.mockResolvedValue(undefined);

    await useSimulationStore.getState().stopAllRuns();

    // 终端运行（含队列中）走 abortTerminalRun，插件运行走 abort mutation，已结束的跳过
    expect(mocks.abortTerminalRun).toHaveBeenCalledTimes(2);
    expect(mocks.abortTerminalRun).toHaveBeenCalledWith({ terminalId: 'term-1' });
    expect(mocks.abortTerminalRun).toHaveBeenCalledWith({ terminalId: 'term-3' });
    expect(mocks.abort).toHaveBeenCalledTimes(1);
    expect(mocks.abort).toHaveBeenCalledWith({ projectId: 'project-1', runId: 'r-plugin' });
  });
});
