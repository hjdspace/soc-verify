// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * SimControlToolbar Debug 快捷按钮组（UI 方案 B — 终端工具栏）测试。
 *
 * 移植 Python runsim_r3p0 执行日志页五个快捷按钮：
 * - Verdi / Verisium：隐藏子进程启动（launchVerdi / launchVerisium mutation）
 * - 编译日志 / 仿真日志：分裂按钮（主点击=内置编辑器，箭头菜单=gvim 打开）
 * - 反汇编：单文件直接打开；多文件下拉选择
 *
 * 另验证种子号修复的前端半边：getSeedFromLog 调用携带完整命令
 * （cd 前缀 / -rundir 用于 $PROJ_WORK 解析）。
 *
 * Mock 策略：
 * - trpc：resolveDebugArtifacts / launchVerdi / launchVerisium / getSeedFromLog /
 *   getRunOutput / rerunWithCommand / project.openInSystem
 * - stores：simulation / terminal / project / toast / workbench（selector mock）
 */

const mocks = vi.hoisted(() => ({
  resolveDebugArtifacts: vi.fn(),
  launchVerdi: vi.fn(),
  launchVerisium: vi.fn(),
  getSeedFromLog: vi.fn(),
  getRunOutput: vi.fn(),
  rerunWithCommand: vi.fn(),
  openInSystem: vi.fn(),
  abortTerminalRun: vi.fn(),
  createTabForSession: vi.fn(),
  setActiveTab: vi.fn(),
  openFile: vi.fn(),
  toastInfo: vi.fn(),
  toastWarning: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    simulation: {
      getSeedFromLog: { query: mocks.getSeedFromLog },
      getRunOutput: { query: mocks.getRunOutput },
      rerunWithCommand: { mutate: mocks.rerunWithCommand },
      resolveDebugArtifacts: { query: mocks.resolveDebugArtifacts },
      launchVerdi: { mutate: mocks.launchVerdi },
      launchVerisium: { mutate: mocks.launchVerisium },
    },
    project: {
      openInSystem: { mutate: mocks.openInSystem },
    },
  },
}));

vi.mock('@renderer/stores/simulation', () => ({
  useSimulationStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({ abortTerminalRun: mocks.abortTerminalRun }),
    { setState: vi.fn() },
  ),
}));

vi.mock('@renderer/stores/terminal', () => ({
  useTerminalStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      createTabForSession: mocks.createTabForSession,
      setActiveTab: mocks.setActiveTab,
    }),
}));

vi.mock('@renderer/stores/project', () => ({
  useProjectStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ currentProjectId: 'proj-1' }),
}));

vi.mock('@renderer/stores/toast', () => ({
  useToastStore: {
    getState: () => ({
      info: mocks.toastInfo,
      warning: mocks.toastWarning,
      error: mocks.toastError,
      success: vi.fn(),
    }),
  },
}));

vi.mock('@renderer/stores/workbench', () => ({
  useWorkbenchStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ open: mocks.openFile }),
}));

import { SimControlToolbar } from '@renderer/components/terminal/SimControlToolbar';

// ─── 工具 ─────────────────────────────────────────────────

const COMMAND = 'runsim -case alu_add';

const FULL_ARTIFACTS = {
  caseDir: '/work/alu_add',
  simLogPath: '/work/alu_add/log/irun_sim.log',
  compileLogPath: '/work/alu_add/log/irun_compile.log',
  asmFiles: ['/work/alu_add/cpu_sw_build/cpu.asm'],
  verdiMode: 'xrun' as const,
  matchedCaseDirs: ['/work/alu_add'],
};

const EMPTY_ARTIFACTS = {
  caseDir: null,
  simLogPath: null,
  compileLogPath: null,
  asmFiles: [],
  verdiMode: null,
  matchedCaseDirs: [],
};

function renderToolbar() {
  return render(
    <SimControlToolbar
      terminalId="term-1"
      command={COMMAND}
      cwd="/env/project"
      caseId="alu_add"
      caseName="alu_add"
      isRunning={false}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveDebugArtifacts.mockResolvedValue(FULL_ARTIFACTS);
  mocks.launchVerdi.mockResolvedValue({
    caseDir: FULL_ARTIFACTS.caseDir,
    command: 'run_verdi comp_load',
    logPath: '/work/alu_add/verdi_launch.log',
    mode: 'xrun',
  });
  mocks.launchVerisium.mockResolvedValue({
    caseDir: FULL_ARTIFACTS.caseDir,
    command: 'run_vdb',
    logPath: '/work/alu_add/verisium_launch.log',
  });
  mocks.getSeedFromLog.mockResolvedValue({ seed: null, logPath: null });
  mocks.getRunOutput.mockResolvedValue({ output: '' });
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

// ─── 渲染与可用性 ─────────────────────────────────────────

describe('SimControlToolbar Debug 按钮组 — 渲染', () => {
  it('渲染五个 Debug 快捷按钮（Verdi/Verisium/编译日志/仿真日志/反汇编）', async () => {
    renderToolbar();

    expect(await screen.findByTestId('sim-debug-verdi')).toBeInTheDocument();
    expect(screen.getByTestId('sim-debug-verisium')).toBeInTheDocument();
    expect(screen.getByTestId('sim-debug-compile-log')).toBeInTheDocument();
    expect(screen.getByTestId('sim-debug-sim-log')).toBeInTheDocument();
    expect(screen.getByTestId('sim-debug-asm')).toBeInTheDocument();
  });

  it('mount 时以 cwd + 命令解析仿真产物', async () => {
    renderToolbar();

    await waitFor(() => {
      expect(mocks.resolveDebugArtifacts).toHaveBeenCalledWith({
        cwd: '/env/project',
        caseName: 'alu_add',
        command: COMMAND,
      });
    });
  });

  it('产物缺失时 Debug 按钮禁用并提示', async () => {
    mocks.resolveDebugArtifacts.mockResolvedValue(EMPTY_ARTIFACTS);
    renderToolbar();

    const verdi = await screen.findByTestId('sim-debug-verdi');
    await waitFor(() => expect(verdi).toBeDisabled());
    expect(screen.getByTestId('sim-debug-verisium')).toBeDisabled();
    expect(screen.getByTestId('sim-debug-compile-log')).toBeDisabled();
    expect(screen.getByTestId('sim-debug-sim-log')).toBeDisabled();
    expect(screen.getByTestId('sim-debug-asm')).toBeDisabled();
  });
});

// ─── Verdi / Verisium ─────────────────────────────────────

describe('SimControlToolbar Debug 按钮组 — Verdi/Verisium 启动', () => {
  it('点击 Verdi 以隐藏子进程启动（携带 cwd/命令/用例名）', async () => {
    renderToolbar();

    fireEvent.click(await screen.findByTestId('sim-debug-verdi'));

    await waitFor(() => {
      expect(mocks.launchVerdi).toHaveBeenCalledWith({
        cwd: '/env/project',
        caseName: 'alu_add',
        command: COMMAND,
      });
    });
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      expect.stringContaining('Verdi'),
      expect.any(String),
    );
  });

  it('点击 Verisium 启动 run_vdb', async () => {
    renderToolbar();

    fireEvent.click(await screen.findByTestId('sim-debug-verisium'));

    await waitFor(() => {
      expect(mocks.launchVerisium).toHaveBeenCalledWith({
        cwd: '/env/project',
        caseName: 'alu_add',
        command: COMMAND,
      });
    });
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      expect.stringContaining('Verisium'),
      expect.any(String),
    );
  });

  it('启动失败时提示错误', async () => {
    mocks.launchVerdi.mockRejectedValue(new Error('找不到仿真用例目录'));
    renderToolbar();

    fireEvent.click(await screen.findByTestId('sim-debug-verdi'));

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(
        expect.stringContaining('Verdi'),
        expect.any(String),
      );
    });
  });
});

// ─── 编译日志 / 仿真日志（分裂按钮）──────────────────────

describe('SimControlToolbar Debug 按钮组 — 日志分裂按钮', () => {
  it('点击编译日志主按钮以内置编辑器打开', async () => {
    renderToolbar();

    fireEvent.click(await screen.findByTestId('sim-debug-compile-log'));

    await waitFor(() => {
      expect(mocks.openFile).toHaveBeenCalledWith({
        type: 'file',
        path: '/work/alu_add/log/irun_compile.log',
        name: 'irun_compile.log',
      });
    });
  });

  it('点击仿真日志主按钮以内置编辑器打开', async () => {
    renderToolbar();

    fireEvent.click(await screen.findByTestId('sim-debug-sim-log'));

    await waitFor(() => {
      expect(mocks.openFile).toHaveBeenCalledWith({
        type: 'file',
        path: '/work/alu_add/log/irun_sim.log',
        name: 'irun_sim.log',
      });
    });
  });

  it('点击编译日志箭头打开菜单，选择 gvim 打开（openInSystem）', async () => {
    renderToolbar();

    fireEvent.click(await screen.findByTestId('sim-debug-compile-log-menu'));

    const gvimItem = await screen.findByTestId('sim-debug-menu-gvim');
    fireEvent.click(gvimItem);

    await waitFor(() => {
      expect(mocks.openInSystem).toHaveBeenCalledWith({
        path: '/work/alu_add/log/irun_compile.log',
        type: 'file',
      });
    });
    expect(mocks.openFile).not.toHaveBeenCalled();
  });

  it('菜单中也可选择内置编辑器打开', async () => {
    renderToolbar();

    fireEvent.click(await screen.findByTestId('sim-debug-sim-log-menu'));

    fireEvent.click(await screen.findByTestId('sim-debug-menu-builtin'));

    await waitFor(() => {
      expect(mocks.openFile).toHaveBeenCalledWith({
        type: 'file',
        path: '/work/alu_add/log/irun_sim.log',
        name: 'irun_sim.log',
      });
    });
  });
});

// ─── 反汇编 ───────────────────────────────────────────────

describe('SimControlToolbar Debug 按钮组 — 反汇编', () => {
  it('单个反汇编文件点击直接以内置编辑器打开', async () => {
    renderToolbar();

    fireEvent.click(await screen.findByTestId('sim-debug-asm'));

    await waitFor(() => {
      expect(mocks.openFile).toHaveBeenCalledWith({
        type: 'file',
        path: '/work/alu_add/cpu_sw_build/cpu.asm',
        name: 'cpu.asm',
      });
    });
  });

  it('多个反汇编文件以下拉选择（按文件名展示）', async () => {
    mocks.resolveDebugArtifacts.mockResolvedValue({
      ...FULL_ARTIFACTS,
      asmFiles: [
        '/work/alu_add/cpu_sw_build/cpu.asm',
        '/work/alu_add/dma_sw_build/dma.asm',
      ],
    });
    renderToolbar();

    fireEvent.click(await screen.findByTestId('sim-debug-asm'));

    // 菜单列出两个文件，点击第二个打开对应文件
    const item = await screen.findByTestId('sim-debug-asm-item-1');
    expect(item).toHaveTextContent('dma.asm');
    fireEvent.click(item);

    await waitFor(() => {
      expect(mocks.openFile).toHaveBeenCalledWith({
        type: 'file',
        path: '/work/alu_add/dma_sw_build/dma.asm',
        name: 'dma.asm',
      });
    });
  });
});

// ─── 种子号修复（前端半边）────────────────────────────────

describe('SimControlToolbar — 获取种子号携带完整命令', () => {
  it('getSeedFromLog 调用包含 command（用于 $PROJ_WORK/rundir 解析）', async () => {
    mocks.getSeedFromLog.mockResolvedValue({
      seed: '42',
      logPath: '/work/alu_add/log/irun_sim.log',
    });
    renderToolbar();

    fireEvent.click(await screen.findByTestId('sim-toolbar-get-seed'));

    await waitFor(() => {
      expect(mocks.getSeedFromLog).toHaveBeenCalledWith(
        expect.objectContaining({ command: COMMAND }),
      );
    });
  });
});
