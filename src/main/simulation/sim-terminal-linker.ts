/**
 * SimTerminalLinker — Links terminal sessions to simulation runs.
 *
 * When a simulation is started via `simulation.runInTerminal`, a terminal PTY
 * session is created and the runsim command is written to it. This class tracks
 * the association between terminalId ↔ runId, listens for terminal exit events,
 * determines pass/fail from the exit code, and emits simulation lifecycle events
 * (run:started / run:completed / run:aborted) that are forwarded to the renderer.
 */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { terminalManager } from '../terminal/terminal-manager';
import type { SimulationRunOptions } from '@shared/plugin-types';
import type { SimulationStatus } from '@shared/types';

export interface TerminalSimRun {
  runId: string;
  projectId: string;
  terminalId: string;
  command: string;
  cwd: string;
  caseId: string;
  caseName?: string;
  subsys: string;
  options: Record<string, unknown>;
  status: SimulationStatus;
  startTime: number;
  endTime?: number;
  exitCode?: number;
}

class SimTerminalLinkerImpl extends EventEmitter {
  private runs = new Map<string, TerminalSimRun>(); // runId → run
  private terminalToRun = new Map<string, string>(); // terminalId → runId
  private exitListenerRegistered = false;

  constructor() {
    super();
    this.ensureExitListener();
  }

  private ensureExitListener(): void {
    if (this.exitListenerRegistered) return;
    this.exitListenerRegistered = true;
    terminalManager.on('exit', ({ id, exitCode }) => {
      this.handleTerminalExit(id, exitCode);
    });
  }

  /**
   * Register a new terminal-based simulation run.
   * Called by the router's `simulation.runInTerminal` procedure after
   * creating the terminal session and writing the command.
   */
  register(
    projectId: string,
    terminalId: string,
    command: string,
    cwd: string,
    opts: SimulationRunOptions,
  ): TerminalSimRun {
    const runId = randomUUID();
    const run: TerminalSimRun = {
      runId,
      projectId,
      terminalId,
      command,
      cwd,
      caseId: opts.caseId,
      caseName: opts.caseName,
      subsys: opts.subsys,
      options: opts.options ?? {},
      status: 'running',
      startTime: Date.now(),
    };

    this.runs.set(runId, run);
    this.terminalToRun.set(terminalId, runId);
    this.emit('run:started', run);

    return run;
  }

  /**
   * Handle terminal exit — determine simulation pass/fail from exit code.
   */
  private handleTerminalExit(terminalId: string, exitCode: number): void {
    const runId = this.terminalToRun.get(terminalId);
    if (!runId) return;

    const run = this.runs.get(runId);
    if (!run) return;

    // Only update if still in a non-terminal state
    if (run.status === 'pass' || run.status === 'fail' || run.status === 'aborted') return;

    run.exitCode = exitCode;
    run.status = exitCode === 0 ? 'pass' : 'fail';
    run.endTime = Date.now();

    this.emit('run:completed', run);

    // Clean up after a delay (allow UI to read final state)
    const cleanupDelay = 60_000;
    setTimeout(() => {
      this.runs.delete(runId);
      this.terminalToRun.delete(terminalId);
    }, cleanupDelay).unref();
  }

  /**
   * Abort a terminal-based simulation run.
   * Destroys the terminal session (kills the PTY process) and marks the run as aborted.
   */
  abort(terminalId: string): void {
    const runId = this.terminalToRun.get(terminalId);
    if (!runId) return;

    const run = this.runs.get(runId);
    if (!run) return;

    if (run.status === 'pass' || run.status === 'fail' || run.status === 'aborted') return;

    run.status = 'aborted';
    run.endTime = Date.now();

    terminalManager.destroy(terminalId);
    this.emit('run:aborted', run);

    const cleanupDelay = 60_000;
    setTimeout(() => {
      this.runs.delete(runId);
      this.terminalToRun.delete(terminalId);
    }, cleanupDelay).unref();
  }

  getRun(runId: string): TerminalSimRun | undefined {
    return this.runs.get(runId);
  }

  getRunByTerminal(terminalId: string): TerminalSimRun | undefined {
    const runId = this.terminalToRun.get(terminalId);
    return runId ? this.runs.get(runId) : undefined;
  }

  getActiveRuns(projectId?: string): TerminalSimRun[] {
    const all = Array.from(this.runs.values());
    return projectId ? all.filter((r) => r.projectId === projectId) : all;
  }
}

export const simTerminalLinker = new SimTerminalLinkerImpl();
