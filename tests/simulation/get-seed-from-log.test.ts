/**
 * simulation.getSeedFromLog 端到端测试（种子号获取修复）。
 *
 * 测试缝：tRPC server-side caller（router.createCaller）。
 * 使用真实临时目录构造仿真日志文件结构，验证多级优先级路径解析：
 *
 *   基准目录（仿真执行目录，≠ 验证环境项目目录 cwd）：
 *     1. 命令 `cd "<dir>" &&` 前缀（runInTerminal 构建命令时嵌入 $PROJ_WORK）
 *     2. $PROJ_WORK 环境变量
 *     3. cwd（向后兼容）
 *
 *   用例目录（对应 Python config_controller.py get_seed() 三级优先级）：
 *     1. -rundir → <base>/<rundir> → <base>/work/<rundir>
 *     2. -case  → <base>/<case>   → <base>/work/<case>
 *     3. work 目录搜索 <case>_<seed> 命名目录，按日志 mtime 取最新
 *
 * 先例：tests/simulation/simulation-router.test.ts
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
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

// ─── Imports (after mocks) ──────────────────────────────────

import { simulationRouter } from '../../src/main/ipc/routers/simulation-router';

const caller = simulationRouter.createCaller({});

// ─── 临时目录工具 ───────────────────────────────────────────

const tmpRoot = mkdtempSync(join(tmpdir(), 'sim-seed-test-'));

/** 创建用例日志：`<root>/<rel>/log/<logName>`，内容包含 -seed <seed> */
function makeLog(rel: string, logName: string, seed: string | null, mtime?: Date): string {
  const dir = join(tmpRoot, rel, 'log');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, logName);
  const content = seed
    ? `[INFO] Simulation started\n[CMD] irun ... -seed ${seed} ...\n[INFO] done\n`
    : `[INFO] Simulation started\n[INFO] no seed here\n`;
  writeFileSync(file, content);
  if (mtime) utimesSync(file, mtime, mtime);
  return file;
}

// 保存/恢复 PROJ_WORK，避免测试间串扰
const prevProjWork = process.env.PROJ_WORK;

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (prevProjWork === undefined) delete process.env.PROJ_WORK;
  else process.env.PROJ_WORK = prevProjWork;
});

beforeEach(() => {
  delete process.env.PROJ_WORK;
});

// ─── Test Suite ─────────────────────────────────────────────

describe('simulation.getSeedFromLog', () => {
  it('命令 cd 前缀（$PROJ_WORK）优先于 cwd 作为日志基准目录', async () => {
    // cwd 是验证环境项目目录，仿真日志实际在 $PROJ_WORK 下
    makeLog('proj-work/foo', 'irun_sim.log', '111');
    makeLog('env-dir/foo', 'irun_sim.log', '222');

    const result = await caller.getSeedFromLog({
      cwd: join(tmpRoot, 'env-dir'),
      caseName: 'foo',
      command: `cd "${join(tmpRoot, 'proj-work')}" && runsim -case foo`,
    });

    expect(result.seed).toBe('111');
    expect(result.logPath).toContain('proj-work');
  });

  it('无 cd 前缀时使用 $PROJ_WORK 环境变量作为基准目录', async () => {
    makeLog('proj-work-env/foo', 'irun_sim.log', '333');
    process.env.PROJ_WORK = join(tmpRoot, 'proj-work-env');

    const result = await caller.getSeedFromLog({
      cwd: join(tmpRoot, 'env-dir'),
      caseName: 'foo',
      command: 'runsim -case foo',
    });

    expect(result.seed).toBe('333');
  });

  it('-rundir 指定的用例目录优先于 case 目录', async () => {
    makeLog('base/mydir', 'irun_sim.log', '901');
    makeLog('base/work/foo', 'irun_sim.log', '902');

    const result = await caller.getSeedFromLog({
      cwd: join(tmpRoot, 'base'),
      command: 'runsim -rundir mydir -case foo',
    });

    expect(result.seed).toBe('901');
  });

  it('-rundir 支持 {case_name} 占位符替换', async () => {
    makeLog('placeholder/foo', 'irun_sim.log', '42');

    const result = await caller.getSeedFromLog({
      cwd: join(tmpRoot, 'placeholder'),
      command: 'runsim -rundir {case_name} -case foo',
    });

    expect(result.seed).toBe('42');
  });

  it('rundir 位于 work/ 子目录时也能找到（runsim 将产物放在 work 下）', async () => {
    makeLog('work-rundir/work/mydir', 'irun_sim.log', '903');

    const result = await caller.getSeedFromLog({
      cwd: join(tmpRoot, 'work-rundir'),
      command: 'runsim -rundir mydir -case foo',
    });

    expect(result.seed).toBe('903');
  });

  it('无 rundir 时使用 work/<case> 默认路径', async () => {
    makeLog('default-case/work/foo', 'irun_sim.log', '904');

    const result = await caller.getSeedFromLog({
      cwd: join(tmpRoot, 'default-case'),
      command: 'runsim -case foo',
    });

    expect(result.seed).toBe('904');
  });

  it('work 目录搜索 <case>_<seed> 目录并取 mtime 最新的日志', async () => {
    const now = new Date();
    makeLog('search/work/foo_123', 'irun_sim.log', '123', new Date(now.getTime() - 2 * 3600_000));
    makeLog('search/work/foo_456', 'irun_sim.log', '456', now);

    const result = await caller.getSeedFromLog({
      cwd: join(tmpRoot, 'search'),
      command: 'runsim -case foo',
    });

    expect(result.seed).toBe('456');
  });

  it('irun_sim.log 不存在时回退到 vcs_sim.log', async () => {
    makeLog('vcs/foo', 'vcs_sim.log', '777');

    const result = await caller.getSeedFromLog({
      cwd: join(tmpRoot, 'vcs'),
      caseName: 'foo',
      command: 'runsim -case foo',
    });

    expect(result.seed).toBe('777');
  });

  it('找不到日志文件时返回 seed null 与 logPath null', async () => {
    mkdirSync(join(tmpRoot, 'empty'), { recursive: true });

    const result = await caller.getSeedFromLog({
      cwd: join(tmpRoot, 'empty'),
      caseName: 'nonexistent',
      command: 'runsim -case nonexistent',
    });

    expect(result.seed).toBeNull();
    expect(result.logPath).toBeNull();
  });

  it('日志存在但无种子号时返回 seed null 与实际日志路径', async () => {
    makeLog('noseed/foo', 'irun_sim.log', null);

    const result = await caller.getSeedFromLog({
      cwd: join(tmpRoot, 'noseed'),
      caseName: 'foo',
      command: 'runsim -case foo',
    });

    expect(result.seed).toBeNull();
    expect(result.logPath).toContain('irun_sim.log');
  });

  it('支持 seed=<number> 模式（VCS 风格日志）', async () => {
    const dir = join(tmpRoot, 'eqseed', 'foo', 'log');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'vcs_sim.log'), 'Random seed=20260116 generated\n');

    const result = await caller.getSeedFromLog({
      cwd: join(tmpRoot, 'eqseed'),
      caseName: 'foo',
      command: 'runsim -case foo',
    });

    expect(result.seed).toBe('20260116');
  });
});
