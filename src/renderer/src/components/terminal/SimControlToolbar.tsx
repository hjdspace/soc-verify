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
 *
 * The toolbar is displayed above the terminal view when the terminal tab
 * is associated with a simulation run (title starts with "sim:").
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { Play, Square, RefreshCw, Copy, Check } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import { useSimulationStore } from '@renderer/stores/simulation';
import { useTerminalStore } from '@renderer/stores/terminal';
import { useToastStore } from '@renderer/stores/toast';
import { useProjectStore } from '@renderer/stores/project';
import {
  hasFsdbOption,
  hasROption,
  modifyCommandOptions,
  updateSeedInCommand,
  parseCaseFromCommand,
} from '@renderer/lib/runsim-command';
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

  // Local state for command (may be modified by checkbox toggles)
  const [currentCommand, setCurrentCommand] = useState(command);
  const [fsdbChecked, setFsdbChecked] = useState(() => hasFsdbOption(command));
  const [rChecked, setRChecked] = useState(() => hasROption(command));
  const [seedCopied, setSeedCopied] = useState(false);
  const [isRerunning, setIsRerunning] = useState(false);
  const [isGettingSeed, setIsGettingSeed] = useState(false);

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

      // Try getting from log file first
      const result = await trpc.simulation.getSeedFromLog.query({
        cwd,
        caseName: caseName ?? parseCaseFromCommand(currentCommand) ?? undefined,
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

  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-secondary/30 px-2 text-xs">
      {/* Re-run button */}
      <button
        onClick={handleRerun}
        disabled={isRunning || isRerunning}
        className={cn(
          'flex items-center gap-1 rounded px-2 py-0.5 font-medium transition-colors',
          isRunning || isRerunning
            ? 'cursor-not-allowed bg-muted text-muted-foreground'
            : 'bg-primary/10 text-primary hover:bg-primary/20',
        )}
        title="重新执行仿真"
      >
        <RefreshCw className={cn('h-3 w-3', isRerunning && 'animate-spin')} />
        <span>重新执行</span>
      </button>

      {/* Stop button */}
      <button
        onClick={handleStop}
        disabled={!isRunning}
        className={cn(
          'flex items-center gap-1 rounded px-2 py-0.5 font-medium transition-colors',
          !isRunning
            ? 'cursor-not-allowed bg-muted text-muted-foreground'
            : 'bg-destructive/10 text-destructive hover:bg-destructive/20',
        )}
        title="停止仿真"
      >
        <Square className="h-3 w-3" />
        <span>停止</span>
      </button>

      {/* Separator */}
      <div className="h-4 w-px bg-border" />

      {/* -fsdb checkbox */}
      <label className="flex cursor-pointer items-center gap-1 text-foreground" title="启用波形输出选项">
        <input
          type="checkbox"
          checked={fsdbChecked}
          onChange={(e) => handleFsdbChange(e.target.checked)}
          className="h-3 w-3 cursor-pointer accent-primary"
        />
        <span className="font-medium">-fsdb</span>
      </label>

      {/* -R checkbox */}
      <label className="flex cursor-pointer items-center gap-1 text-foreground" title="跳过编译直接运行仿真">
        <input
          type="checkbox"
          checked={rChecked}
          onChange={(e) => handleRChange(e.target.checked)}
          className="h-3 w-3 cursor-pointer accent-primary"
        />
        <span className="font-medium">-R</span>
      </label>

      {/* Separator */}
      <div className="h-4 w-px bg-border" />

      {/* Get seed button */}
      <button
        onClick={handleGetSeed}
        disabled={isGettingSeed}
        className={cn(
          'flex items-center gap-1 rounded px-2 py-0.5 font-medium transition-colors',
          isGettingSeed
            ? 'cursor-not-allowed bg-muted text-muted-foreground'
            : 'bg-status-pass/10 text-status-pass-foreground hover:bg-status-pass/20',
        )}
        title="从仿真日志中获取种子号并更新命令"
      >
        {seedCopied ? (
          <Check className="h-3 w-3" />
        ) : isGettingSeed ? (
          <RefreshCw className="h-3 w-3 animate-spin" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
        <span>获取种子号</span>
      </button>

      {/* Command preview (truncated) */}
      <div className="ml-auto max-w-[40%] truncate font-mono text-[10px] text-muted-foreground" title={currentCommand}>
        {currentCommand}
      </div>
    </div>
  );
}
