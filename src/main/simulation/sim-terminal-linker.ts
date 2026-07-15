/**
 * SimTerminalLinker — Links terminal sessions to simulation runs.
 *
 * When a simulation is started via `simulation.runInTerminal`, a terminal PTY
 * session is created and the runsim command is written to it. This class tracks
 * the association between terminalId ↔ runId, and detects simulation completion
 * via a **marker-based approach** (no `exit` command — the shell stays alive).
 *
 * Completion detection: after the runsim command, a marker `echo "__SIM_DONE__$?__"`
 * is appended. The simTerminalLinker listens to terminal 'data' events, buffers
 * incoming data, and scans for the marker pattern. When found, it extracts the
 * exit code and emits the completion event — **without closing the terminal**.
 *
 * Fallback: if the terminal is manually closed (shell exit), the 'exit' event
 * is used as a fallback to determine pass/fail from the shell's exit code.
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

/** Marker pattern echoed after runsim finishes: __SIM_DONE__<exitCode>__ */
const SIM_DONE_MARKER_RE = /__SIM_DONE__(True|False|\d+)__/;
/** Max buffer length for marker scanning (keep last 256 chars) */
const MARKER_BUFFER_MAX = 256;

class SimTerminalLinkerImpl extends EventEmitter {
  private runs = new Map<string, TerminalSimRun>(); // runId → run
  private terminalToRun = new Map<string, string>(); // terminalId → runId
  /** Per-terminal data buffer for marker scanning */
  private dataBuffers = new Map<string, string>();
  private exitListenerRegistered = false;
  private dataListenerRegistered = false;

  constructor() {
    super();
    this.ensureExitListener();
    this.ensureDataListener();
  }

  private ensureExitListener(): void {
    if (this.exitListenerRegistered) return;
    this.exitListenerRegistered = true;
    // Fallback: if terminal is manually closed, use shell exit code
    terminalManager.on('exit', ({ id, exitCode }) => {
      this.handleTerminalExit(id, exitCode);
    });
  }

  private ensureDataListener(): void {
    if (this.dataListenerRegistered) return;
    this.dataListenerRegistered = true;
    // Primary: scan terminal output for completion marker
    terminalManager.on('data', ({ id, data }) => {
      this.handleTerminalData(id, data);
    });
  }

  /**
   * Register a new terminal-based simulation run.
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
   * Scan terminal output for the completion marker.
   * The marker `__SIM_DONE__<exitCode>__` is echoed after runsim finishes.
   * This approach keeps the shell alive — the user can still interact with
   * the terminal after the simulation completes.
   */
  private handleTerminalData(terminalId: string, data: string): void {
    const runId = this.terminalToRun.get(terminalId);
    if (!runId) return;

    const run = this.runs.get(runId);
    if (!run) return;

    // Skip if already completed
    if (run.status !== 'running') return;

    // Append to buffer and scan for marker
    let buffer = this.dataBuffers.get(terminalId) ?? '';
    buffer += data;

    const match = buffer.match(SIM_DONE_MARKER_RE);
    if (match) {
      const value = match[1];
      // bash: $? → numeric exit code; PowerShell: $? → True/False
      const exitCode =
        value === 'True' ? 0 :
        value === 'False' ? 1 :
        parseInt(value, 10);

      run.exitCode = exitCode;
      run.status = exitCode === 0 ? 'pass' : 'fail';
      run.endTime = Date.now();

      this.emit('run:completed', run);
      this.dataBuffers.delete(terminalId);

      // Clean up after a delay (allow UI to read final state)
      const cleanupDelay = 60_000;
      setTimeout(() => {
        this.runs.delete(runId);
        this.terminalToRun.delete(terminalId);
      }, cleanupDelay).unref();
      return;
    }

    // Truncate buffer to prevent unbounded growth
    if (buffer.length > MARKER_BUFFER_MAX) {
      buffer = buffer.slice(-MARKER_BUFFER_MAX);
    }
    this.dataBuffers.set(terminalId, buffer);
  }

  /**
   * Fallback: handle terminal exit (e.g., user manually closes the terminal).
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
    this.dataBuffers.delete(terminalId);

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
    this.dataBuffers.delete(terminalId);

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
