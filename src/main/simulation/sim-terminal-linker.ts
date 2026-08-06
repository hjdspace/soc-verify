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
 *
 * Log-mode enhancement: when node-pty is unavailable and the terminal runs in
 * log-mode, the shell process exits directly (no marker). In this case, the
 * linker scans the full output buffer for simulation pass/fail patterns
 * (similar to the Python GUI's `check_simulation_status_from_log_content`).
 * If no patterns are found, the exit code is used but the status is set to
 * 'unknown' rather than 'pass' to avoid false positives.
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
  /** Whether the run uses log-mode (true) or PTY mode (false). */
  logMode: boolean;
}

/** Marker pattern echoed after runsim finishes: __SIM_DONE__<exitCode>__ */
const SIM_DONE_MARKER_RE = /__SIM_DONE__(True|False|\d+)__/;
/** Max buffer length for marker scanning (keep last 256 chars) */
const MARKER_BUFFER_MAX = 256;

// ── Simulation pass/fail pattern detection ──────────────────────────────
// Patterns are based on the Python GUI's check_simulation_status_from_log_content()
// and common EDA tool output formats (xrun, VCS, ncsim, runsim).

/** Patterns that indicate simulation PASS. */
const PASS_PATTERNS: readonly string[] = [
  'SPRD_PASSED',
  'TEST PASSED',
  'PASSED',
  'Simulation completed successfully',
  'SUCCESS',
  'simulation finished',
  'Simulation PASSED',
  'Test completed successfully',
  'sprd_log_pass',
];

/** Patterns that indicate simulation FAIL. */
const FAIL_PATTERNS: readonly string[] = [
  'SPRD_FAILED',
  'TEST FAILED',
  'FAILED',
  'Simulation FAILED',
  'SIMULATION FAILED',
  'simulation failed',
  'Test failed',
  'sprd_log_fail',
  'FATAL',
  'ABORT',
];

/** Patterns that indicate an error (but not necessarily a fail). */
const ERROR_PATTERNS: readonly RegExp[] = [
  /\bERROR\b/i,
  /\bError:\s/,
  /\bCompile\s+error\b/i,
  /\bCompilation\s+failed\b/i,
];

/**
 * Scan simulation output text for pass/fail status indicators.
 *
 * Only the last ~200 lines are scanned to avoid false positives from early
 * output and to match the Python GUI's approach (last 100 lines).
 *
 * @returns 'pass' | 'fail' | null (null = no pattern found)
 */
function detectSimStatusFromOutput(output: string): 'pass' | 'fail' | null {
  if (!output || output.length === 0) return null;

  // Get the last ~200 lines for pattern matching
  const lines = output.split('\n');
  const lastLines = lines.slice(-200).join('\n');

  // Check fail patterns first (fail has priority over pass — if both appear,
  // the simulation likely failed after an initial pass indication)
  for (const pattern of FAIL_PATTERNS) {
    if (lastLines.includes(pattern)) return 'fail';
  }

  // Check error patterns
  for (const pattern of ERROR_PATTERNS) {
    if (pattern.test(lastLines)) return 'fail';
  }

  // Check pass patterns
  for (const pattern of PASS_PATTERNS) {
    if (lastLines.includes(pattern)) return 'pass';
  }

  return null;
}

/**
 * Check if the output contains any simulation-related content.
 * Used to distinguish between "process exited with 0 but no sim output"
 * (e.g., LSF submission success) and "process exited with 0 after sim output".
 */
function hasSimulationOutput(output: string): boolean {
  if (!output || output.length === 0) return false;
  const simKeywords = [
    'xrun', 'irun', 'ncsim', 'vcs', 'simv', 'runsim',
    'compiling', 'elaborating', 'simulating',
    'compile', 'elaborate', 'simulate',
    '$finish', '$stop',
  ];
  const lowerOutput = output.toLowerCase();
  return simKeywords.some((kw) => lowerOutput.includes(kw));
}

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
    logMode: boolean,
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
      logMode,
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

    // Skip marker scanning in log-mode (no marker is emitted)
    if (run.logMode) return;

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
   * Fallback: handle terminal exit (e.g., user manually closes the terminal,
   * or log-mode process completes).
   *
   * In log-mode, the shell process exits directly. Instead of blindly trusting
   * the exit code, we scan the full output buffer for simulation pass/fail
   * patterns (like the Python GUI's check_simulation_status_from_log_content).
   * If patterns are found, they take precedence over the exit code.
   * If no patterns are found and the exit code is 0, we check whether any
   * simulation output was seen — if not, the status is set to 'unknown'
   * rather than 'pass' to avoid false positives (e.g., LSF submission success).
   */
  private handleTerminalExit(terminalId: string, exitCode: number): void {
    const runId = this.terminalToRun.get(terminalId);
    if (!runId) return;

    const run = this.runs.get(runId);
    if (!run) return;

    // Only update if still in a non-terminal state
    if (run.status === 'pass' || run.status === 'fail' || run.status === 'aborted') return;

    run.exitCode = exitCode;
    run.endTime = Date.now();

    if (run.logMode) {
      // Log-mode: scan output for pass/fail patterns
      const output = terminalManager.getOutputContent(terminalId);
      const detectedStatus = detectSimStatusFromOutput(output);

      if (detectedStatus === 'pass') {
        run.status = 'pass';
      } else if (detectedStatus === 'fail') {
        run.status = 'fail';
      } else {
        // No pattern found — fall back to exit code, but be conservative.
        // If exit code is 0 but no simulation output was seen, the process
        // likely exited before the simulation started (e.g., LSF submission).
        // In that case, mark as 'unknown' to avoid false PASS.
        if (exitCode === 0 && !hasSimulationOutput(output)) {
          console.warn(
            `[simTerminalLinker] Process exited with code 0 but no simulation output detected. ` +
            `Marking as 'error' to avoid false PASS. Command: ${run.command.slice(0, 80)}`
          );
          run.status = 'error';
        } else {
          run.status = exitCode === 0 ? 'pass' : 'fail';
        }
      }
    } else {
      // PTY mode: use exit code directly (marker scanning is the primary mechanism)
      run.status = exitCode === 0 ? 'pass' : 'fail';
    }

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
