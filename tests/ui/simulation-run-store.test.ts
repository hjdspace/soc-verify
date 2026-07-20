// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runInTerminal: vi.fn(),
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    simulation: {
      runInTerminal: { mutate: mocks.runInTerminal },
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
    expect(workbench.tabs.find((tab) => tab.destination.type === 'running-simulations')).toBeDefined();
    expect(workbench.tabs.find((tab) => tab.id === workbench.activeTabId)?.destination.type)
      .toBe('running-simulations');
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
});
