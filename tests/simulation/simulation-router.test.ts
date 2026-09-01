/**
 * simulation-router 端到端测试。
 *
 * 测试缝：tRPC server-side caller（router.createCaller）。
 * mock requireProject / getSimulationManager / caseStatsRegistry / simTerminalLinker。
 * 使用内存 DB 验证 getRunDetail 多源查找逻辑。
 *
 * 先例：tests/dashboard-router.test.ts
 */

import { describe, it, expect, beforeEach, afterAll, beforeAll, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Hoisted mock state ─────────────────────────────────────

const {
  mockSimTerminalLinker,
  mockSimulationManager,
  mockSimulationSettings,
  mockTerminalManager,
  pluginFileRef,
} = vi.hoisted(() => ({
  mockSimTerminalLinker: {
    getRun: vi.fn(),
    getActiveRuns: vi.fn(() => []),
    register: vi.fn(),
  },
  mockSimulationManager: {
    getRunDetail: vi.fn(),
    getActiveRuns: vi.fn(() => []),
    hasRunner: vi.fn(() => true),
  },
  mockSimulationSettings: {
    getPreferLogMode: vi.fn(async () => false),
  },
  mockTerminalManager: {
    ensurePtyAvailable: vi.fn(async () => false),
    create: vi.fn(),
    runCommand: vi.fn(),
    write: vi.fn(),
    getOutputContent: vi.fn(() => ''),
    on: vi.fn(),
  },
  pluginFileRef: { current: null as string | null },
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
    getRegistry: vi.fn(() => ({ simulationRunners: [{ name: 'mock-sim-runner' }] })),
    getLoadResults: vi.fn(() =>
      pluginFileRef.current
        ? [{ manifest: { kind: 'simulation-runner' }, path: pluginFileRef.current, source: 'local', error: null }]
        : [],
    ),
  },
}));

vi.mock('../../src/main/terminal/terminal-manager', () => ({
  terminalManager: mockTerminalManager,
  findSimShell: vi.fn(() => '/bin/bash'),
}));

vi.mock('../../src/main/simulation/simulation-settings', () => ({
  simulationSettings: mockSimulationSettings,
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

// ─── runInTerminal：PTY / log-mode 后端选择 ─────────────────

const pluginDir = mkdtempSync(join(tmpdir(), 'sim-router-plugin-'));
const pluginPath = join(pluginDir, 'mock-sim-runner.cjs');
const pluginWorkDir = mkdtempSync(join(tmpdir(), 'sim-router-work-'));

beforeAll(() => {
  // 仿真 runner 插件 mock：导出 generateRunsimCommand / resolveCwd
  writeFileSync(
    pluginPath,
    [
      'module.exports.generateRunsimCommand = () => "runsim -case mock_case";',
      `module.exports.resolveCwd = () => ${JSON.stringify(pluginWorkDir)};`,
      '',
    ].join('\n'),
    'utf-8',
  );
  pluginFileRef.current = pluginPath;
});

afterAll(() => {
  rmSync(pluginDir, { recursive: true, force: true });
});

describe('simulation-router runInTerminal 后端选择', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 默认值：未启用 log-mode 偏好；node-pty 不可用（回退路径）
    mockSimulationSettings.getPreferLogMode.mockResolvedValue(false);
    mockTerminalManager.ensurePtyAvailable.mockResolvedValue(false);
    mockSimTerminalLinker.register.mockReturnValue({ runId: 'new-run-1' });
    mockTerminalManager.create.mockResolvedValue({ id: 'term-pty', backend: 'node-pty', warning: null });
    mockTerminalManager.runCommand.mockResolvedValue({
      id: 'term-log',
      backend: 'log-mode',
      warning: 'Running in log mode (node-pty unavailable). Output is read-only.',
    });
  });

  const runOptions = {
    caseId: 'case_x',
    caseName: 'case_x',
    subsys: 'ap',
    options: {},
  };

  it('未启用偏好且 node-pty 不可用时回退 log-mode（logMode=true 注册）', async () => {
    const result = await caller.runInTerminal({ projectId: 'test-project-id', options: runOptions });

    expect(mockTerminalManager.ensurePtyAvailable).toHaveBeenCalled();
    expect(mockTerminalManager.create).not.toHaveBeenCalled();
    expect(mockTerminalManager.runCommand).toHaveBeenCalledTimes(1);
    expect(mockTerminalManager.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.stringContaining('runsim -case mock_case'),
        cwd: pluginWorkDir,
        shell: '/bin/bash',
      }),
    );
    // 回退场景：不覆盖 warning（保持"node-pty 不可用"文案）
    expect(mockTerminalManager.runCommand.mock.calls[0][0].warning).toBeUndefined();
    expect(result.backend).toBe('log-mode');
    // log-mode 会话 → linker 以 logMode=true 注册
    expect(mockSimTerminalLinker.register).toHaveBeenCalledWith(
      'test-project-id',
      'term-log',
      expect.any(String),
      pluginWorkDir,
      runOptions,
      true,
    );
  });

  it('未启用偏好且 node-pty 可用时走交互式 PTY（写入 __SIM_DONE__ 标记）', async () => {
    mockTerminalManager.ensurePtyAvailable.mockResolvedValue(true);

    const result = await caller.runInTerminal({ projectId: 'test-project-id', options: runOptions });

    expect(mockTerminalManager.runCommand).not.toHaveBeenCalled();
    expect(mockTerminalManager.create).toHaveBeenCalledWith({ cwd: pluginWorkDir, shell: '/bin/bash' });
    expect(mockTerminalManager.write).toHaveBeenCalledWith(
      'term-pty',
      expect.stringContaining('__SIM_DONE__'),
    );
    expect(result.backend).toBe('node-pty');
    // PTY 会话 → linker 以 logMode=false 注册
    expect(mockSimTerminalLinker.register).toHaveBeenCalledWith(
      'test-project-id',
      'term-pty',
      expect.any(String),
      pluginWorkDir,
      runOptions,
      false,
    );
  });

  it('设置启用 preferLogMode 时直接 log-mode，不探测 node-pty', async () => {
    mockSimulationSettings.getPreferLogMode.mockResolvedValue(true);
    mockTerminalManager.ensurePtyAvailable.mockResolvedValue(true);
    mockTerminalManager.runCommand.mockResolvedValue({
      id: 'term-log-2',
      backend: 'log-mode',
      warning: 'Running in log mode (enabled in settings). Output is read-only.',
    });

    const result = await caller.runInTerminal({ projectId: 'test-project-id', options: runOptions });

    // 即使 node-pty 可用也不应走 PTY
    expect(mockTerminalManager.ensurePtyAvailable).not.toHaveBeenCalled();
    expect(mockTerminalManager.create).not.toHaveBeenCalled();
    expect(mockTerminalManager.runCommand).toHaveBeenCalledTimes(1);
    // 用户主动启用的场景：覆盖 warning 文案
    expect(mockTerminalManager.runCommand.mock.calls[0][0].warning).toBe(
      'Running in log mode (enabled in settings). Output is read-only.',
    );
    expect(result.backend).toBe('log-mode');
    expect(mockSimTerminalLinker.register).toHaveBeenCalledWith(
      'test-project-id',
      'term-log-2',
      expect.any(String),
      pluginWorkDir,
      runOptions,
      true,
    );
  });

  it('rerunWithCommand 同样遵循 preferLogMode 偏好', async () => {
    mockSimulationSettings.getPreferLogMode.mockResolvedValue(true);

    const result = await caller.rerunWithCommand({
      projectId: 'test-project-id',
      command: 'runsim -case rerun_case',
      cwd: pluginWorkDir,
      caseId: 'rerun_case',
      caseName: 'rerun_case',
      subsys: 'ap',
    });

    expect(mockTerminalManager.ensurePtyAvailable).not.toHaveBeenCalled();
    expect(mockTerminalManager.create).not.toHaveBeenCalled();
    expect(mockTerminalManager.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining('runsim -case rerun_case') }),
    );
    expect(result.backend).toBe('log-mode');
    expect(mockSimTerminalLinker.register).toHaveBeenCalledWith(
      'test-project-id',
      'term-log',
      expect.any(String),
      pluginWorkDir,
      expect.objectContaining({ caseId: 'rerun_case' }),
      true,
    );
  });
});
