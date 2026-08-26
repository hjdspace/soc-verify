/**
 * simulation Debug 快捷按钮后端 procedures 测试（UI 方案 B+C 共享后端）。
 *
 * 测试缝：tRPC server-side caller（router.createCaller）。
 * - resolveDebugArtifacts：解析用例目录 / 仿真日志 / 编译日志 / 反汇编 / Verdi 模式
 * - launchVerdi：隐藏子进程启动 Verdi（VCS 产物 → run_verdi_vcs，否则 run_verdi comp_load）
 * - launchVerisium：隐藏子进程启动 Verisium（run_vdb）
 *
 * 对应 Python runsim_r3p0 执行日志页快捷按钮（execution_controller.py
 * open_verdi / open_verisium），但改为隐藏子进程（不占终端 Tab），
 * 启动输出重定向到用例目录下的 verdi_launch.log / verisium_launch.log。
 *
 * 先例：tests/simulation/get-seed-from-log.test.ts
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Mocks（与 simulation-router.test.ts 相同的模块替换）──────

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
  getSimulationManager: vi.fn(() => ({ getActiveRuns: vi.fn(() => []) })),
}));

vi.mock('../../src/main/simulation/sim-terminal-linker', () => ({
  simTerminalLinker: { getRun: vi.fn(), getActiveRuns: vi.fn(() => []) },
}));

vi.mock('../../src/main/case/case-stats-registry', () => ({
  caseStatsRegistry: {
    getOrCreateDb: vi.fn(() => null),
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

// Verdi/Verisium 以隐藏子进程启动：mock spawn 捕获调用参数
const { fakeChild, spawnMock } = vi.hoisted(() => ({
  fakeChild: { unref: vi.fn() },
  spawnMock: vi.fn(() => ({})) as unknown as ReturnType<typeof vi.fn>,
}));
spawnMock.mockReturnValue(fakeChild);
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

// ─── Imports (after mocks) ──────────────────────────────────

import { simulationRouter } from '../../src/main/ipc/routers/simulation-router';

const caller = simulationRouter.createCaller({});

// ─── 临时目录工具 ───────────────────────────────────────────

const tmpRoot = mkdtempSync(join(tmpdir(), 'sim-debug-test-'));

/** 构造一个 XRUN 用例目录（INCA_libs + 仿真/编译日志 + 反汇编） */
function makeXrunCase(rel: string, opts?: { asm?: boolean }): string {
  const caseDir = join(tmpRoot, rel);
  mkdirSync(join(caseDir, 'log'), { recursive: true });
  mkdirSync(join(caseDir, 'INCA_libs'), { recursive: true });
  writeFileSync(join(caseDir, 'log', 'irun_sim.log'), '[CMD] -seed 42\n');
  writeFileSync(join(caseDir, 'log', 'irun_compile.log'), 'compile ok\n');
  if (opts?.asm !== false) {
    mkdirSync(join(caseDir, 'cpu_sw_build'), { recursive: true });
    writeFileSync(join(caseDir, 'cpu_sw_build', 'cpu.asm'), 'nop\n');
    mkdirSync(join(caseDir, 'cpu_sw_build', 'nested'));
    writeFileSync(join(caseDir, 'cpu_sw_build', 'nested', 'extra.asm'), 'ret\n');
  }
  return caseDir;
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  spawnMock.mockClear();
  fakeChild.unref.mockClear();
});

// ─── resolveDebugArtifacts ─────────────────────────────────

describe('simulation.resolveDebugArtifacts', () => {
  it('解析 XRUN 用例的全部产物（目录/日志/反汇编/模式）', async () => {
    const caseDir = makeXrunCase('xrun-case/foo');

    const result = await caller.resolveDebugArtifacts({
      cwd: join(tmpRoot, 'xrun-case'),
      caseName: 'foo',
      command: 'runsim -case foo',
    });

    expect(result.caseDir).toBe(caseDir);
    expect(result.simLogPath).toBe(join(caseDir, 'log', 'irun_sim.log'));
    expect(result.compileLogPath).toBe(join(caseDir, 'log', 'irun_compile.log'));
    expect(result.asmFiles).toHaveLength(2);
    expect(result.asmFiles.some((p) => p.endsWith('cpu.asm'))).toBe(true);
    expect(result.asmFiles.some((p) => p.endsWith('extra.asm'))).toBe(true);
    expect(result.verdiMode).toBe('xrun');
    expect(result.matchedCaseDirs).toContain(caseDir);
  });

  it('检测 VCS 产物目录（simv.daidir）→ verdiMode vcs', async () => {
    const caseDir = makeXrunCase('vcs-case/foo', { asm: false });
    mkdirSync(join(caseDir, 'simv.daidir'), { recursive: true });

    const result = await caller.resolveDebugArtifacts({
      cwd: join(tmpRoot, 'vcs-case'),
      caseName: 'foo',
      command: 'runsim -case foo',
    });

    expect(result.caseDir).toBe(caseDir);
    expect(result.verdiMode).toBe('vcs');
  });

  it('找不到用例目录时全部为 null', async () => {
    mkdirSync(join(tmpRoot, 'nothing'), { recursive: true });

    const result = await caller.resolveDebugArtifacts({
      cwd: join(tmpRoot, 'nothing'),
      caseName: 'ghost',
      command: 'runsim -case ghost',
    });

    expect(result.caseDir).toBeNull();
    expect(result.simLogPath).toBeNull();
    expect(result.compileLogPath).toBeNull();
    expect(result.asmFiles).toEqual([]);
    expect(result.verdiMode).toBeNull();
  });
});

// ─── launchVerdi / launchVerisium ──────────────────────────

describe('simulation.launchVerdi', () => {
  it('以隐藏子进程在用例目录启动 Verdi（XRUN → run_verdi comp_load）', async () => {
    const caseDir = makeXrunCase('verdi-xrun/foo');

    const result = await caller.launchVerdi({
      cwd: join(tmpRoot, 'verdi-xrun'),
      caseName: 'foo',
      command: 'runsim -case foo',
    });

    expect(result.caseDir).toBe(caseDir);
    expect(result.mode).toBe('xrun');
    expect(result.command).toBe('run_verdi comp_load');
    // 隐藏子进程：detached + unref，不占终端 Tab
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [shell, args, options] = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      { detached?: boolean },
    ];
    expect(shell).toBe('/bin/bash');
    expect(args.join(' ')).toContain('run_verdi comp_load');
    expect(args.join(' ')).toContain(caseDir);
    expect(options.detached).toBe(true);
    expect(fakeChild.unref).toHaveBeenCalled();
    // 启动输出重定向到用例目录下的日志文件
    expect(result.logPath).toBe(join(caseDir, 'verdi_launch.log'));
    expect(existsSync(result.logPath)).toBe(true);
  });

  it('VCS 产物 → run_verdi_vcs', async () => {
    const caseDir = makeXrunCase('verdi-vcs/foo', { asm: false });
    mkdirSync(join(caseDir, 'simv.daidir'), { recursive: true });

    const result = await caller.launchVerdi({
      cwd: join(tmpRoot, 'verdi-vcs'),
      caseName: 'foo',
      command: 'runsim -case foo',
    });

    expect(result.mode).toBe('vcs');
    expect(result.command).toBe('run_verdi_vcs');
  });

  it('找不到用例目录时抛出 NOT_FOUND', async () => {
    mkdirSync(join(tmpRoot, 'verdi-empty'), { recursive: true });

    await expect(
      caller.launchVerdi({
        cwd: join(tmpRoot, 'verdi-empty'),
        caseName: 'ghost',
        command: 'runsim -case ghost',
      }),
    ).rejects.toThrow('找不到仿真用例目录');
  });
});

describe('simulation.launchVerisium', () => {
  it('以隐藏子进程在用例目录启动 Verisium（run_vdb）', async () => {
    const caseDir = makeXrunCase('verisium/foo', { asm: false });

    const result = await caller.launchVerisium({
      cwd: join(tmpRoot, 'verisium'),
      caseName: 'foo',
      command: 'runsim -case foo',
    });

    expect(result.caseDir).toBe(caseDir);
    expect(result.command).toBe('run_vdb');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args, options] = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      { detached?: boolean },
    ];
    expect(args.join(' ')).toContain('run_vdb');
    expect(args.join(' ')).toContain(caseDir);
    expect(options.detached).toBe(true);
    expect(result.logPath).toBe(join(caseDir, 'verisium_launch.log'));
    expect(existsSync(result.logPath)).toBe(true);
  });

  it('找不到用例目录时抛出 NOT_FOUND', async () => {
    mkdirSync(join(tmpRoot, 'verisium-empty'), { recursive: true });

    await expect(
      caller.launchVerisium({
        cwd: join(tmpRoot, 'verisium-empty'),
        caseName: 'ghost',
        command: 'runsim -case ghost',
      }),
    ).rejects.toThrow('找不到仿真用例目录');
  });
});
