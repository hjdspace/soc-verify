/**
 * runsim CLI wrapper — encapsulates `runsim` command execution.
 *
 * This module provides a typed interface for calling the `runsim` CLI tool,
 * which is used by many SoC verification tools for simulation control,
 * regression management, and result analysis.
 *
 * Each method maps to a `runsim -cmd <subcommand>` invocation.
 */

import { spawn, type ChildProcess } from 'node:child_process';

/** Result of a runsim command execution. */
export type RunsimResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

/**
 * Execute a runsim command and return its output.
 *
 * @param args  Command arguments (e.g., ['-cmd', 'regress_list', '-subsys', 'cpu_sys'])
 * @param cwd   Working directory (defaults to project root)
 * @param timeout  Timeout in milliseconds (0 = no timeout)
 * @returns  stdout, stderr, and exit code
 */
export function execRunsim(
  args: string[],
  cwd?: string,
  timeout = 0,
): Promise<RunsimResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn('runsim', args, {
      cwd,
      timeout: timeout || undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to execute runsim: ${err.message}`));
    });

    proc.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

/**
 * Spawn a runsim command as a long-running process (for streaming output).
 *
 * @param args  Command arguments
 * @param cwd   Working directory
 * @param onData  Callback for stdout data
 * @param onError  Callback for stderr data
 * @param onExit  Callback for process exit
 * @returns  The ChildProcess instance (for killing)
 */
export function spawnRunsim(
  args: string[],
  cwd: string,
  onData: (data: string) => void,
  onError: (data: string) => void,
  onExit: (code: number | null) => void,
): ChildProcess {
  const proc = spawn('runsim', args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  proc.stdout.on('data', (data) => onData(data.toString()));
  proc.stderr.on('data', (data) => onError(data.toString()));
  proc.on('exit', (code) => onExit(code));

  return proc;
}

// ── Typed helper methods for common runsim subcommands ──────────────

/** Get regression list for a subsystem. */
export async function getRegressList(
  projectRoot: string,
  subsys: string,
): Promise<string> {
  const result = await execRunsim(
    ['-cmd', 'regress_list', '-subsys', subsys],
    projectRoot,
  );
  return result.stdout;
}

/** Run a simulation case. */
export async function runSimulation(
  projectRoot: string,
  caseName: string,
  subsys?: string,
): Promise<RunsimResult> {
  const args = ['-cmd', 'run', '-case', caseName];
  if (subsys) args.push('-subsys', subsys);
  return execRunsim(args, projectRoot);
}

/** Get simulation run status. */
export async function getRunStatus(
  projectRoot: string,
  runId: string,
): Promise<string> {
  const result = await execRunsim(
    ['-cmd', 'run_status', '-id', runId],
    projectRoot,
  );
  return result.stdout;
}
