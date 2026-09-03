/**
 * SimControlToolbar — Simulation control toolbar for terminal tabs.
 *
 * Ported from the Python GUI's `views/log_panel.py` LogPanel toolbar.
 * Provides quick-access controls for simulation runs:
 * - 重新执行 (Re-run): Re-execute the simulation with the current command
 * - 停止 (Stop): Abort the running simulation
 * - -fsdb checkbox: Toggle waveform output
 * - -R checkbox: Toggle sim-only mode (skip compile)
 * - 获取种子号 (Get seed): Extract seed from simulation log
 * - Debug 快捷按钮组（UI 方案 B，移植 Python 执行日志页）：
 *   - Verdi / Verisium：隐藏子进程启动（不占终端 Tab）
 *   - 编译日志 / 仿真日志：分裂按钮（主点击=内置编辑器，箭头菜单=gvim）
 *   - 反汇编：单文件直接打开，多文件下拉选择（*_sw_build 下的 .asm）
 *
 * 窄窗口自适应：所有按钮 shrink-0 + whitespace-nowrap（文字永不折行），
 * 文字标签按断点隐藏只留图标（控制按钮 <lg、Debug 按钮 <xl），
 * 右侧命令预览 min-w-0 优先收缩截断。
 *
 * The toolbar is displayed above the terminal view when the terminal tab
 * is associated with a simulation run (title starts with "sim:").
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  Square,
  RotateCcw,
  Dices,
  Check,
  Waves,
  Boxes,
  FileCode,
  FileText,
  Binary,
  ChevronDown,
} from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import { useSimulationStore } from '@renderer/stores/simulation';
import { useTerminalStore } from '@renderer/stores/terminal';
import { useToastStore } from '@renderer/stores/toast';
import { useProjectStore } from '@renderer/stores/project';
import { useWorkbenchStore } from '@renderer/stores/workbench';
import {
  hasFsdbOption,
  hasROption,
  modifyCommandOptions,
  updateSeedInCommand,
  parseCaseFromCommand,
  stripCdPrefix,
} from '@renderer/lib/runsim-command';
import { type DebugArtifacts, baseName } from '@renderer/lib/sim-debug';
import { cn } from '@renderer/lib/utils';

interface SimControlToolbarProps {
  /** The terminal session ID associated with the simulation. */
  terminalId: string;
  /** The runsim command string. */
  command: string;
  /** The working directory where the command is executed. */
  cwd: string;
  /** The case ID / case name for the simulation. */
  caseId: string;
  caseName?: string;
  subsys?: string;
  /** Whether the simulation is currently running. */
  isRunning: boolean;
  /** Callback when a re-run is triggered (to update terminal tab). */
  onRerun?: (newTerminalId: string, newCommand: string) => void;
}

/** 分裂按钮 / 反汇编下拉的菜单状态 */
type DebugMenu = 'compile-log' | 'sim-log' | 'asm' | null;

export function SimControlToolbar({
  terminalId,
  command,
  cwd,
  caseId,
  caseName,
  subsys,
  isRunning,
  onRerun,
}: SimControlToolbarProps) {
  const projectId = useProjectStore((s) => s.currentProjectId);
  const abortTerminalRun = useSimulationStore((s) => s.abortTerminalRun);
  const createTabForSession = useTerminalStore((s) => s.createTabForSession);
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);
  const openFile = useWorkbenchStore((s) => s.open);

  // Local state for command (may be modified by checkbox toggles)
  const [currentCommand, setCurrentCommand] = useState(command);
  const [fsdbChecked, setFsdbChecked] = useState(() => hasFsdbOption(command));
  const [rChecked, setRChecked] = useState(() => hasROption(command));
  const [seedCopied, setSeedCopied] = useState(false);
  const [isRerunning, setIsRerunning] = useState(false);
  const [isGettingSeed, setIsGettingSeed] = useState(false);

  // Debug 快捷按钮组状态：产物解析结果 + 菜单
  const [artifacts, setArtifacts] = useState<DebugArtifacts | null>(null);
  const [isLaunchingTool, setIsLaunchingTool] = useState(false);
  const [debugMenu, setDebugMenu] = useState<DebugMenu>(null);

  // Update local state when the command prop changes (e.g., new simulation started)
  const prevCommandRef = useRef(command);
  useEffect(() => {
    if (command !== prevCommandRef.current) {
      prevCommandRef.current = command;
      setCurrentCommand(command);
      setFsdbChecked(hasFsdbOption(command));
      setRChecked(hasROption(command));
    }
  }, [command]);

  // ─── Debug 快捷按钮组：产物解析 ─────────────────────

  // mount / 命令变化（重新执行、checkbox 修改）时重新解析产物
  const loadDebugArtifacts = useCallback(async () => {
    try {
      const result = await trpc.simulation.resolveDebugArtifacts.query({
        cwd,
        caseName: caseName ?? parseCaseFromCommand(currentCommand) ?? undefined,
        command: currentCommand,
      });
      setArtifacts(result);
    } catch {
      setArtifacts(null);
    }
  }, [cwd, caseName, currentCommand]);

  useEffect(() => {
    void loadDebugArtifacts();
  }, [loadDebugArtifacts]);

  // Verdi：隐藏子进程启动（VCS 产物 → run_verdi_vcs；否则 run_verdi comp_load）
  const handleLaunchVerdi = useCallback(async () => {
    setIsLaunchingTool(true);
    try {
      const result = await trpc.simulation.launchVerdi.mutate({
        cwd,
        caseName: caseName ?? parseCaseFromCommand(currentCommand) ?? undefined,
        command: currentCommand,
      });
      useToastStore.getState().info(
        `Verdi 已启动（${result.mode === 'vcs' ? 'VCS' : 'Xcelium'} 波形）`,
        `${result.command} @ ${result.caseDir}，输出见 ${baseName(result.logPath)}`,
      );
    } catch (err) {
      useToastStore.getState().error('启动 Verdi 失败', String(err));
    } finally {
      setIsLaunchingTool(false);
    }
  }, [cwd, caseName, currentCommand]);

  // Verisium：隐藏子进程启动（run_vdb）
  const handleLaunchVerisium = useCallback(async () => {
    setIsLaunchingTool(true);
    try {
      const result = await trpc.simulation.launchVerisium.mutate({
        cwd,
        caseName: caseName ?? parseCaseFromCommand(currentCommand) ?? undefined,
        command: currentCommand,
      });
      useToastStore.getState().info(
        'Verisium 已启动',
        `${result.command} @ ${result.caseDir}，输出见 ${baseName(result.logPath)}`,
      );
    } catch (err) {
      useToastStore.getState().error('启动 Verisium 失败', String(err));
    } finally {
      setIsLaunchingTool(false);
    }
  }, [cwd, caseName, currentCommand]);

  // 日志打开：viaSystem=true 走 gvim（Linux）/ 记事本（Windows）；否则内置编辑器
  const openLogFile = useCallback(
    (path: string, viaSystem: boolean) => {
      setDebugMenu(null);
      if (viaSystem) {
        void trpc.project.openInSystem.mutate({ path, type: 'file' });
      } else {
        openFile({ type: 'file', path, name: baseName(path) });
      }
    },
    [openFile],
  );

  // 反汇编：单文件直接打开；多文件展开下拉
  const handleAsmClick = useCallback(() => {
    if (!artifacts || artifacts.asmFiles.length === 0) return;
    if (artifacts.asmFiles.length === 1) {
      openLogFile(artifacts.asmFiles[0], false);
      return;
    }
    setDebugMenu(debugMenu === 'asm' ? null : 'asm');
  }, [artifacts, debugMenu, openLogFile]);

  // Handle -fsdb checkbox toggle
  const handleFsdbChange = useCallback(
    (checked: boolean) => {
      console.log(`[SimControlToolbar] handleFsdbChange(${checked}) — currentCommand="${currentCommand}"`);
      setFsdbChecked(checked);
      const modified = modifyCommandOptions(currentCommand, { fsdb: checked });
      console.log(`[SimControlToolbar] after modifyCommandOptions — modified="${modified}"`);
      setCurrentCommand(modified);
    },
    [currentCommand],
  );

  // Handle -R checkbox toggle
  const handleRChange = useCallback(
    (checked: boolean) => {
      console.log(`[SimControlToolbar] handleRChange(${checked}) — currentCommand="${currentCommand}"`);
      setRChecked(checked);
      const modified = modifyCommandOptions(currentCommand, { R: checked });
      console.log(`[SimControlToolbar] after modifyCommandOptions — modified="${modified}"`);
      setCurrentCommand(modified);
    },
    [currentCommand],
  );

  // Handle re-run button click
  const handleRerun = useCallback(async () => {
    if (!projectId) return;
    console.log(`[SimControlToolbar] handleRerun called — currentCommand="${currentCommand}"`);
    setIsRerunning(true);
    try {
      const result = await trpc.simulation.rerunWithCommand.mutate({
        projectId,
        command: currentCommand,
        cwd,
        caseId,
        caseName,
        subsys: subsys ?? '',
      });

      console.log(`[SimControlToolbar] rerun result — terminalId="${result.terminalId}", command="${result.command}"`);

      // Create a new terminal tab for the re-run
      const tabId = createTabForSession(
        result.terminalId,
        `sim: ${caseName ?? caseId}`,
        cwd,
        (result as { backend?: string }).backend === 'log-mode',
        (result as { warning?: string | null }).warning ?? null,
      );
      setActiveTab(tabId);

      // Register in the simulation store — use upsert to avoid duplicates
      // (the IPC run:started event may arrive before this mutate returns)
      const displayCommand = result.command ?? currentCommand;
      useSimulationStore.setState((s) => {
        const existing = s.activeRuns.find((r) => r.runId === result.runId);
        if (existing) {
          // Update existing record (from IPC event) with terminal fields
          return {
            activeRuns: s.activeRuns.map((r) =>
              r.runId === result.runId
                ? {
                    ...r,
                    terminalId: r.terminalId ?? result.terminalId,
                    command: r.command ?? displayCommand,
                    cwd: r.cwd ?? cwd,
                    status: 'running' as const,
                    backend: (result as { backend?: string }).backend,
                    warning: (result as { warning?: string | null }).warning,
                  }
                : r,
            ),
          };
        }
        return {
          activeRuns: [
            ...s.activeRuns,
            {
              runId: result.runId,
              projectId,
              caseId,
              caseName,
              subsys: subsys ?? '',
              status: 'running' as const,
              startTime: Date.now(),
              terminalId: result.terminalId,
              command: displayCommand,
              cwd,
              backend: (result as { backend?: string }).backend,
              warning: (result as { warning?: string | null }).warning,
            },
          ],
        };
      });

      onRerun?.(result.terminalId, displayCommand);
      useToastStore.getState().info(`重新执行仿真: ${caseName ?? caseId}`);
    } catch (err) {
      useToastStore.getState().error('重新执行仿真失败', String(err));
    } finally {
      setIsRerunning(false);
    }
  }, [projectId, currentCommand, cwd, caseId, caseName, subsys, createTabForSession, setActiveTab, onRerun]);

  // Handle stop button click
  const handleStop = useCallback(() => {
    void abortTerminalRun(terminalId);
  }, [terminalId, abortTerminalRun]);

  // Handle get seed button click
  const handleGetSeed = useCallback(async () => {
    setIsGettingSeed(true);
    try {
      // First try to get seed from the terminal output (for log-mode)
      let seed: string | null = null;

      // Try getting from log file first — 携带完整命令（cd 前缀 / -rundir
      // 用于主进程解析 $PROJ_WORK 仿真执行目录）
      const result = await trpc.simulation.getSeedFromLog.query({
        cwd,
        caseName: caseName ?? parseCaseFromCommand(currentCommand) ?? undefined,
        command: currentCommand,
      });

      if (result.seed) {
        seed = result.seed;
      } else {
        // Try getting from terminal output
        const outputResult = await trpc.simulation.getRunOutput.query({ terminalId });
        const outputMatch = outputResult.output.match(/-seed\s+(\d+)/);
        if (outputMatch) {
          seed = outputMatch[1];
        }
      }

      if (seed) {
        // Copy to clipboard
        await navigator.clipboard.writeText(seed);
        setSeedCopied(true);
        setTimeout(() => setSeedCopied(false), 2000);

        // Update the command with the seed
        const updatedCommand = updateSeedInCommand(currentCommand, seed);
        setCurrentCommand(updatedCommand);

        useToastStore.getState().info(
          `已获取种子号: ${seed}（已复制到剪贴板并更新命令）`,
        );
      } else {
        useToastStore.getState().warning(
          '未找到种子号',
          result.logPath
            ? `已在日志文件 ${result.logPath} 中搜索，但未找到种子号`
            : '找不到仿真日志文件',
        );
      }
    } catch (err) {
      useToastStore.getState().error('获取种子号失败', String(err));
    } finally {
      setIsGettingSeed(false);
    }
  }, [cwd, caseName, currentCommand, terminalId]);

  const hasVerdi = !!artifacts?.caseDir;
  const hasVerisium = !!artifacts?.caseDir;
  const hasCompileLog = !!artifacts?.compileLogPath;
  const hasSimLog = !!artifacts?.simLogPath;
  const asmCount = artifacts?.asmFiles.length ?? 0;
  const missingHint = '未找到仿真产物（用例目录 / 日志）';

  return (
    <div className="relative flex h-7 shrink-0 items-center gap-2 border-b border-border bg-secondary/30 px-2 text-xs">
      {/* Re-run button */}
      <button
        onClick={handleRerun}
        disabled={isRunning || isRerunning}
        className={cn(
          'flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-2 py-0.5 font-medium transition-colors',
          isRunning || isRerunning
            ? 'cursor-not-allowed bg-muted text-muted-foreground'
            : 'bg-primary/10 text-primary hover:bg-primary/20',
        )}
        title="重新执行仿真"
      >
        <RotateCcw className={cn('h-3 w-3 shrink-0', isRerunning && 'animate-spin')} />
        <span className="hidden lg:inline">重新执行</span>
      </button>

      {/* Stop button */}
      <button
        onClick={handleStop}
        disabled={!isRunning}
        className={cn(
          'flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-2 py-0.5 font-medium transition-colors',
          !isRunning
            ? 'cursor-not-allowed bg-muted text-muted-foreground'
            : 'bg-destructive/10 text-destructive hover:bg-destructive/20',
        )}
        title="停止仿真"
      >
        <Square className="h-3 w-3 shrink-0" fill="currentColor" />
        <span className="hidden lg:inline">停止</span>
      </button>

      {/* Separator */}
      <div className="h-4 w-px shrink-0 bg-border" />

      {/* -fsdb checkbox */}
      <label className="flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap text-foreground" title="启用波形输出选项">
        <input
          type="checkbox"
          checked={fsdbChecked}
          onChange={(e) => handleFsdbChange(e.target.checked)}
          className="h-3 w-3 cursor-pointer accent-primary"
        />
        <span className="font-medium">-fsdb</span>
      </label>

      {/* -R checkbox */}
      <label className="flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap text-foreground" title="跳过编译直接运行仿真">
        <input
          type="checkbox"
          checked={rChecked}
          onChange={(e) => handleRChange(e.target.checked)}
          className="h-3 w-3 cursor-pointer accent-primary"
        />
        <span className="font-medium">-R</span>
      </label>

      {/* Separator */}
      <div className="h-4 w-px shrink-0 bg-border" />

      {/* Get seed button */}
      <button
        onClick={handleGetSeed}
        disabled={isGettingSeed}
        className={cn(
          'flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-2 py-0.5 font-medium transition-colors',
          isGettingSeed
            ? 'cursor-not-allowed bg-muted text-muted-foreground'
            : 'bg-status-pass/10 text-status-pass-foreground hover:bg-status-pass/20',
        )}
        title="从仿真日志中获取随机种子号并更新命令"
        data-testid="sim-toolbar-get-seed"
      >
        {seedCopied ? (
          <Check className="h-3 w-3 shrink-0" />
        ) : isGettingSeed ? (
          <RotateCcw className="h-3 w-3 shrink-0 animate-spin" />
        ) : (
          <Dices className="h-3 w-3 shrink-0" />
        )}
        <span className="hidden lg:inline">获取种子号</span>
      </button>

      {/* ── Debug 快捷按钮组（UI 方案 B）────────────────── */}
      <div className="h-4 w-px bg-border" />

      {/* Verdi：隐藏子进程启动（自动检测 VCS / XRUN 波形） */}
      <button
        onClick={() => void handleLaunchVerdi()}
        disabled={!hasVerdi || isLaunchingTool}
        className={cn(
          'flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-2 py-0.5 font-medium transition-colors',
          hasVerdi && !isLaunchingTool
            ? 'bg-primary/10 text-primary hover:bg-primary/20'
            : 'cursor-not-allowed bg-muted text-muted-foreground',
        )}
        title={hasVerdi ? '在本用例目录以隐藏子进程启动 Verdi（自动检测 VCS / Xcelium）' : missingHint}
        data-testid="sim-debug-verdi"
      >
        <Waves className="h-3 w-3 shrink-0" />
        <span className="hidden xl:inline">Verdi</span>
      </button>

      {/* Verisium：隐藏子进程启动（run_vdb） */}
      <button
        onClick={() => void handleLaunchVerisium()}
        disabled={!hasVerisium || isLaunchingTool}
        className={cn(
          'flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-2 py-0.5 font-medium transition-colors',
          hasVerisium && !isLaunchingTool
            ? 'bg-primary/10 text-primary hover:bg-primary/20'
            : 'cursor-not-allowed bg-muted text-muted-foreground',
        )}
        title={hasVerisium ? '在本用例目录以隐藏子进程启动 Verisium（run_vdb）' : missingHint}
        data-testid="sim-debug-verisium"
      >
        <Boxes className="h-3 w-3 shrink-0" />
        <span className="hidden xl:inline">Verisium</span>
      </button>

      {/* 编译日志：分裂按钮（主点击=内置编辑器，箭头=gvim；hover 绿色调对齐原型） */}
      <div className="relative flex shrink-0 items-stretch">
        <button
          onClick={() => artifacts?.compileLogPath && openLogFile(artifacts.compileLogPath, false)}
          disabled={!hasCompileLog}
          className={cn(
            'flex items-center gap-1 whitespace-nowrap rounded-l px-2 py-0.5 font-medium transition-colors',
            hasCompileLog
              ? 'text-foreground hover:bg-status-pass/15 hover:text-status-pass-foreground'
              : 'cursor-not-allowed text-muted-foreground opacity-40',
          )}
          title={hasCompileLog ? '打开编译日志（内置编辑器；箭头可选 gvim）' : missingHint}
          data-testid="sim-debug-compile-log"
        >
          <FileCode className="h-3 w-3 shrink-0" />
          <span className="hidden xl:inline">编译日志</span>
        </button>
        <button
          onClick={() => setDebugMenu(debugMenu === 'compile-log' ? null : 'compile-log')}
          disabled={!hasCompileLog}
          className={cn(
            'flex shrink-0 items-center rounded-r border-l border-border/50 px-1 transition-colors',
            hasCompileLog
              ? 'text-muted-foreground hover:bg-accent hover:text-foreground'
              : 'cursor-not-allowed text-muted-foreground opacity-40',
          )}
          title="选择打开方式（内置编辑器 / gvim）"
          data-testid="sim-debug-compile-log-menu"
        >
          <ChevronDown className="h-2.5 w-2.5" />
        </button>
        {debugMenu === 'compile-log' && (
          <div
            className="absolute top-full left-0 z-50 mt-1 min-w-52 overflow-hidden rounded-md border border-border bg-background py-1 shadow-lg"
            data-testid="sim-debug-menu-compile-log"
          >
            <button
              className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent"
              onClick={() => artifacts?.compileLogPath && openLogFile(artifacts.compileLogPath, false)}
              data-testid="sim-debug-menu-builtin-compile-log"
            >
              <FileText className="h-3 w-3" />
              内置编辑器打开
            </button>
            <button
              className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent"
              onClick={() => artifacts?.compileLogPath && openLogFile(artifacts.compileLogPath, true)}
              data-testid="sim-debug-menu-gvim-compile-log"
            >
              <FileCode className="h-3 w-3" />
              用 gvim 打开
            </button>
          </div>
        )}
      </div>

      {/* 仿真日志：分裂按钮 */}
      <div className="relative flex shrink-0 items-stretch">
        <button
          onClick={() => artifacts?.simLogPath && openLogFile(artifacts.simLogPath, false)}
          disabled={!hasSimLog}
          className={cn(
            'flex items-center gap-1 whitespace-nowrap rounded-l px-2 py-0.5 font-medium transition-colors',
            hasSimLog
              ? 'text-foreground hover:bg-status-pass/15 hover:text-status-pass-foreground'
              : 'cursor-not-allowed text-muted-foreground opacity-40',
          )}
          title={hasSimLog ? '打开仿真日志（内置编辑器；箭头可选 gvim）' : missingHint}
          data-testid="sim-debug-sim-log"
        >
          <FileText className="h-3 w-3 shrink-0" />
          <span className="hidden xl:inline">仿真日志</span>
        </button>
        <button
          onClick={() => setDebugMenu(debugMenu === 'sim-log' ? null : 'sim-log')}
          disabled={!hasSimLog}
          className={cn(
            'flex shrink-0 items-center rounded-r border-l border-border/50 px-1 transition-colors',
            hasSimLog
              ? 'text-muted-foreground hover:bg-accent hover:text-foreground'
              : 'cursor-not-allowed text-muted-foreground opacity-40',
          )}
          title="选择打开方式（内置编辑器 / gvim）"
          data-testid="sim-debug-sim-log-menu"
        >
          <ChevronDown className="h-2.5 w-2.5" />
        </button>
        {debugMenu === 'sim-log' && (
          <div
            className="absolute top-full left-0 z-50 mt-1 min-w-52 overflow-hidden rounded-md border border-border bg-background py-1 shadow-lg"
            data-testid="sim-debug-menu-sim-log"
          >
            <button
              className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent"
              onClick={() => artifacts?.simLogPath && openLogFile(artifacts.simLogPath, false)}
              data-testid="sim-debug-menu-builtin-sim-log"
            >
              <FileText className="h-3 w-3" />
              内置编辑器打开
            </button>
            <button
              className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent"
              onClick={() => artifacts?.simLogPath && openLogFile(artifacts.simLogPath, true)}
              data-testid="sim-debug-menu-gvim-sim-log"
            >
              <FileCode className="h-3 w-3" />
              用 gvim 打开
            </button>
          </div>
        )}
      </div>

      {/* 反汇编：单文件直接打开；多文件下拉选择（hover 琥珀调对齐原型） */}
      <div className="relative flex shrink-0 items-stretch">
        <button
          onClick={handleAsmClick}
          disabled={asmCount === 0}
          className={cn(
            'flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-2 py-0.5 font-medium transition-colors',
            asmCount > 0
              ? 'text-foreground hover:bg-status-running/15 hover:text-status-running-foreground'
              : 'cursor-not-allowed text-muted-foreground opacity-40',
          )}
          title={
            asmCount > 0
              ? `打开反汇编文件（*_sw_build 下的 .asm，共 ${asmCount} 个）`
              : missingHint
          }
          data-testid="sim-debug-asm"
        >
          <Binary className="h-3 w-3 shrink-0" />
          <span className="hidden xl:inline">反汇编{asmCount > 1 ? ` (${asmCount})` : ''}</span>
        </button>
        {debugMenu === 'asm' && (
          <div
            className="absolute top-full left-0 z-50 mt-1 min-w-52 overflow-hidden rounded-md border border-border bg-background py-1 shadow-lg"
            data-testid="sim-debug-menu-asm"
          >
            {artifacts?.asmFiles.map((asmFile, index) => (
              <button
                key={asmFile}
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left font-mono text-xs text-foreground transition-colors hover:bg-accent"
                onClick={() => openLogFile(asmFile, false)}
                data-testid={`sim-debug-asm-item-${index}`}
              >
                <Binary className="h-3 w-3 shrink-0" />
                <span className="truncate">{baseName(asmFile)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Command preview (truncated) — min-w-0 优先收缩，避免挤压按钮导致文字折行
          显示时去除 cd "$PROJ_WORK" && 前缀，只展示 runsim 命令部分，更加清晰。
          title 保留完整命令供 hover 查看。 */}
      <div className="ml-auto min-w-0 max-w-[40%] shrink truncate font-mono text-[10px] text-muted-foreground" title={currentCommand}>
        {stripCdPrefix(currentCommand)}
      </div>
    </div>
  );
}
