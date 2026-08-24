/**
 * simulation-router 端到端测试。
 *
 * 测试缝：tRPC server-side caller（router.createCaller）。
 * mock requireProject / getSimulationManager / caseStatsRegistry / simTerminalLinker。
 * 使用内存 DB 验证 getRunDetail 多源查找逻辑。
 *
 * 先例：tests/dashboard-router.test.ts
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import type Database from 'better-sqlite3';

// ─── Hoisted mock state ─────────────────────────────────────

const { mockSimTerminalLinker, mockSimulationManager } = vi.hoisted(() => ({
  mockSimTerminalLinker: {
    getRun: vi.fn(),
    getActiveRuns: vi.fn(() => []),
  },
  mockSimulationManager: {
    getRunDetail: vi.fn(),
    getActiveRuns: vi.fn(() => []),
    hasRunner: vi.fn(() => true),
  },
}));

const dbRef: { current: Database.Database | null } = { current: null };

// ─── Mocks ──────────────────────────────────────────────────

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
}));

vi.mock('../../src/main/services/project-service', () => ({
  requireProject: vi.fn(() => ({
    id: 'test-project-id',
    rootPath: '/tmp/test-project',
    name: 'Test Project',
  })),
  ensurePluginsLoaded: vi.fn(),
}));

vi.mock('../../src/main/services/simulation-service', () => ({
  getSimulationManager: vi.fn(() => mockSimulationManager),
}));

vi.mock('../../src/main/simulation/sim-terminal-linker', () => ({
  simTerminalLinker: mockSimTerminalLinker,
}));

vi.mock('../../src/main/case/case-stats-registry', () => ({
  caseStatsRegistry: {
    getOrCreateDb: vi.fn(() => dbRef.current),
    ensureTerminalListener: vi.fn(),
  },
}));

vi.mock('../../src/main/plugins/loader', () => ({
  pluginLoader: {
    getRegistry: vi.fn(() => ({ simulationRunners: [] })),
    getLoadResults: vi.fn(() => []),
  },
}));

vi.mock('../../src/main/terminal/terminal-manager', () => ({
  terminalManager: {
    ensurePtyAvailable: vi.fn(async () => false),
    create: vi.fn(),
    runCommand: vi.fn(),
    write: vi.fn(),
    getOutputContent: vi.fn(() => ''),
    on: vi.fn(),
  },
  findSimShell: vi.fn(() => '/bin/bash'),
}));

// ─── Imports (after mocks) ──────────────────────────────────

import { createMemoryDatabase, closeDatabase } from '../../src/main/case/db/case-database';
import { insertSimulationRun } from '../../src/main/case/db/case-repository';
import { simulationRouter } from '../../src/main/ipc/routers/simulation-router';

// Create in-memory DB and wire it into the mock
dbRef.current = createMemoryDatabase();
const memDb = dbRef.current;

const caller = simulationRouter.createCaller({});

// ─── Test Suite ─────────────────────────────────────────────

describe('simulation-router getRunDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock returns
    mockSimulationManager.getRunDetail.mockReturnValue(null);
    mockSimTerminalLinker.getRun.mockReturnValue(undefined);
    // Clean DB
    memDb.exec('DELETE FROM simulation_runs');
  });

  afterAll(() => {
    closeDatabase(memDb);
  });

  it('从 SimulationManager.history 查找到 run 详情时直接返回', async () => {
    const historyEntry = {
      runId: 'history-run-1',
      caseId: 'case_a',
      caseName: 'case_a',
      subsys: 'core',
      options: { seed: '42' },
      status: 'pass' as const,
      startTime: 1000,
      endTime: 2000,
      duration: 1000,
    };
    mockSimulationManager.getRunDetail.mockReturnValue(historyEntry);

    const result = await caller.getRunDetail({
      projectId: 'test-project-id',
      runId: 'history-run-1',
    });

    expect(result).toEqual(historyEntry);
    expect(mockSimulationManager.getRunDetail).toHaveBeenCalledWith('history-run-1');
    expect(mockSimTerminalLinker.getRun).not.toHaveBeenCalled();
  });

  it('从 simTerminalLinker 查找到活跃终端仿真记录时返回', async () => {
    // History miss
    mockSimulationManager.getRunDetail.mockReturnValue(null);

    // simTerminalLinker hit
    const terminalRun = {
      runId: 'terminal-run-1',
      projectId: 'test-project-id',
      terminalId: 'term-1',
      command: 'runsim case_b',
      cwd: '/tmp/work',
      caseId: 'case_b',
      caseName: 'case_b',
      subsys: 'core',
      options: { seed: '99' },
      status: 'pass' as const,
      startTime: 5000,
      endTime: 6000,
      exitCode: 0,
      logMode: false,
    };
    mockSimTerminalLinker.getRun.mockReturnValue(terminalRun);

    const result = await caller.getRunDetail({
      projectId: 'test-project-id',
      runId: 'terminal-run-1',
    });

    expect(result.runId).toBe('terminal-run-1');
    expect(result.caseId).toBe('case_b');
    expect(result.status).toBe('pass');
    expect(result.duration).toBe(1000);
  });

  it('从 DB simulation_runs 表查找到已持久化的终端仿真记录', async () => {
    // History miss, simTerminalLinker miss
    mockSimulationManager.getRunDetail.mockReturnValue(null);
    mockSimTerminalLinker.getRun.mockReturnValue(undefined);

    // Insert a record into DB
    const runId = 'db-run-uuid-1234';
    insertSimulationRun(memDb, {
      runId,
      caseName: 'test_top_ap_mini',
      subsys: 'ap',
      status: 'pass',
      startTime: new Date(2000).toISOString(),
      endTime: new Date(3000).toISOString(),
      durationMs: 1000,
      optionsJson: JSON.stringify({ seed: '7' }),
    });

    const result = await caller.getRunDetail({
      projectId: 'test-project-id',
      runId,
    });

    expect(result.runId).toBe(runId);
    expect(result.caseId).toBe('test_top_ap_mini');
    expect(result.caseName).toBe('test_top_ap_mini');
    expect(result.subsys).toBe('ap');
    expect(result.status).toBe('pass');
    expect(result.startTime).toBe(2000);
    expect(result.endTime).toBe(3000);
    expect(result.duration).toBe(1000);
    expect(result.options).toEqual({ seed: '7' });
  });

  it('三个来源都查不到时抛出 NOT_FOUND', async () => {
    mockSimulationManager.getRunDetail.mockReturnValue(null);
    mockSimTerminalLinker.getRun.mockReturnValue(undefined);

    await expect(
      caller.getRunDetail({
        projectId: 'test-project-id',
        runId: 'nonexistent-run-id',
      }),
    ).rejects.toThrow('Run not found: nonexistent-run-id');
  });
});
