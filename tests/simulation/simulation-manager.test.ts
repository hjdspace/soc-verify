import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SimulationManager } from '../../src/main/simulation/simulation-manager';
import type { PluginBackedSimulation } from '../../src/main/plugin-adapters';
import type { SimulationRunHandle, SimulationRunStatus, CompileError } from '../../src/shared/plugin-types';

function createMockAdapter(overrides: Partial<PluginBackedSimulation> = {}): PluginBackedSimulation {
  const runs = new Map<string, SimulationRunStatus>();
  return {
    hasRunner: overrides.hasRunner ?? (() => true),
    run: overrides.run ?? (async (opts) => {
      const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      runs.set(runId, { runId, status: 'running', startTime: Date.now() });
      return { runId } as SimulationRunHandle;
    }),
    getStatus: overrides.getStatus ?? (async (runId) => {
      return runs.get(runId) ?? { runId, status: 'pending' };
    }),
    getCompileErrors: overrides.getCompileErrors ?? (async () => []),
    abort: overrides.abort ?? (async (runId) => {
      runs.set(runId, { runId, status: 'aborted', endTime: Date.now() });
    }),
  } as PluginBackedSimulation;
}

describe('SimulationManager', () => {
  let manager: SimulationManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = require('node:os').tmpdir() + `/sv-test-${Date.now()}`;
    require('node:fs').mkdirSync(tmpDir, { recursive: true });
    require('node:fs').mkdirSync(tmpDir + '/.socverify', { recursive: true });
  });

  afterEach(() => {
    manager?.destroy();
    require('node:fs').rmSync(tmpDir, { recursive: true, force: true });
  });

  it('starts a simulation run and returns a handle', async () => {
    const adapter = createMockAdapter();
    manager = new SimulationManager({
      projectRoot: tmpDir,
      projectId: 'proj_test',
      simulationAdapter: adapter,
    });

    const handle = await manager.run({
      caseId: 'test_case_1',
      caseName: 'Test Case 1',
      subsys: 'subsys_a',
    });

    expect(handle.runId).toMatch(/^run_/);
    expect(manager.getActiveRuns()).toHaveLength(1);
    expect(manager.getActiveRuns()[0].options.caseId).toBe('test_case_1');
  });

  it('emits run:started event when a run begins', async () => {
    const adapter = createMockAdapter();
    manager = new SimulationManager({
      projectRoot: tmpDir,
      projectId: 'proj_test',
      simulationAdapter: adapter,
    });

    const startedSpy = vi.fn();
    manager.on('run:started', startedSpy);

    await manager.run({ caseId: 'case_1', subsys: 'sub_a' });

    expect(startedSpy).toHaveBeenCalledOnce();
    expect(startedSpy.mock.calls[0][0].options.caseId).toBe('case_1');
  });

  it('throws when no simulation-runner plugin is loaded', async () => {
    const adapter = createMockAdapter({ hasRunner: () => false });
    manager = new SimulationManager({
      projectRoot: tmpDir,
      projectId: 'proj_test',
      simulationAdapter: adapter,
    });

    await expect(
      manager.run({ caseId: 'case_1', subsys: 'sub_a' }),
    ).rejects.toThrow('No simulation-runner plugin loaded');
  });

  it('aborts a running simulation', async () => {
    const abortSpy = vi.fn();
    const adapter = createMockAdapter({ abort: abortSpy });
    manager = new SimulationManager({
      projectRoot: tmpDir,
      projectId: 'proj_test',
      simulationAdapter: adapter,
    });

    const handle = await manager.run({ caseId: 'case_1', subsys: 'sub_a' });
    await manager.abort(handle.runId);

    expect(abortSpy).toHaveBeenCalledWith(handle.runId);
    expect(manager.getActiveRuns()).toHaveLength(0);
  });

  it('records history when a run completes', async () => {
    const errors: CompileError[] = [
      { file: 'test.sv', line: 42, severity: 'error', message: 'syntax error' },
    ];
    const adapter = createMockAdapter({
      getStatus: async (runId) => ({ runId, status: 'fail', startTime: Date.now(), endTime: Date.now() }),
      getCompileErrors: async () => errors,
    });
    manager = new SimulationManager({
      projectRoot: tmpDir,
      projectId: 'proj_test',
      simulationAdapter: adapter,
    });

    const handle = await manager.run({ caseId: 'case_1', subsys: 'sub_a' });

    // Wait for polling to detect completion (poll interval is 2s)
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const history = manager.getHistory();
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0].caseId).toBe('case_1');
    expect(history[0].status).toBe('fail');
    expect(history[0].compileErrors).toEqual(errors);
  });

  it('compares two runs and returns differences', async () => {
    const adapter = createMockAdapter();
    manager = new SimulationManager({
      projectRoot: tmpDir,
      projectId: 'proj_test',
      simulationAdapter: adapter,
    });

    // Manually add history entries
    (manager as unknown as { history: unknown[] }).history = [
      {
        runId: 'run_a',
        caseId: 'case_1',
        caseName: 'Case 1',
        subsys: 'sub_a',
        options: { seed: 1 },
        status: 'pass',
        startTime: 1000,
        endTime: 2000,
        duration: 1000,
      },
      {
        runId: 'run_b',
        caseId: 'case_1',
        caseName: 'Case 1',
        subsys: 'sub_a',
        options: { seed: 2 },
        status: 'fail',
        startTime: 3000,
        endTime: 4000,
        duration: 1000,
      },
    ];

    const result = manager.compareRuns('run_a', 'run_b');
    expect(result.runA).not.toBeNull();
    expect(result.runB).not.toBeNull();
    expect(result.differences.length).toBeGreaterThanOrEqual(2); // status + options
  });

  it('loads and saves history to .socverify/sim-history.json', async () => {
    const adapter = createMockAdapter();
    manager = new SimulationManager({
      projectRoot: tmpDir,
      projectId: 'proj_test',
      simulationAdapter: adapter,
    });

    // Add a history entry manually
    (manager as unknown as { history: unknown[] }).history = [
      {
        runId: 'run_x',
        caseId: 'case_x',
        caseName: 'Case X',
        subsys: 'sub_x',
        options: {},
        status: 'pass',
        startTime: 1000,
        endTime: 2000,
        duration: 1000,
      },
    ];

    await manager.saveHistory();

    // Create a new manager and load history
    const manager2 = new SimulationManager({
      projectRoot: tmpDir,
      projectId: 'proj_test',
      simulationAdapter: adapter,
    });
    await manager2.loadHistory();

    expect(manager2.getHistory()).toHaveLength(1);
    expect(manager2.getHistory()[0].runId).toBe('run_x');
    manager2.destroy();
  });
});
