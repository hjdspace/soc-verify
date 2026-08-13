/**
 * Gen runner for sysbase-gen — executes the sysbase_gen.py command.
 *
 * Spawns the command via shell and streams stdout/stderr in real-time,
 * following the same pattern as mod-io-runner and coverage-merger.
 *
 * The command string is built by `buildSysbaseCommand` (command-builder.ts)
 * and executed in the specified working directory.
 */

import { spawn } from 'node:child_process';

/** Real-time event emitted during sysbase_gen.py execution. */
export type RunGenEvent =
  | { type: 'start'; command: string; lines: string[] }
  | { type: 'output'; line: string }
  | { type: 'end'; success: boolean; lines: string[] };

/** Callback for real-time log streaming. */
export type RunGenEventCallback = (event: RunGenEvent) => void;

/** Result of sysbase_gen.py execution. */
export type RunGenResult = {
  success: boolean;
  logs: string[];
  exitCode: number | null;
};

/**
 * Execute a sysbase_gen.py command with streaming output.
 *
 * Spawns the command via `shell -c` and collects stdout/stderr lines,
 * emitting real-time events via `onEvent`.
 *
 * @param command  The full command string (python3 <script> gen -rtl ...)
 * @param cwd      Working directory for the process
 * @param onEvent  Optional callback for real-time event streaming
 * @returns Result with success status and collected logs
 */
export async function executeGen(
  command: string,
  cwd: string,
  onEvent?: RunGenEventCallback,
): Promise<RunGenResult> {
  const logs: string[] = [];

  const startLines = [
    '开始执行 sysbase_gen.py...',
    '执行命令：',
    command,
  ];
  logs.push(...startLines);
  onEvent?.({ type: 'start', command, lines: startLines });

  const result = await new Promise<RunGenResult>((resolvePromise) => {
    const proc = spawn(command, {
      cwd,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        const trimmed = line.trim();
        if (trimmed) {
          logs.push(trimmed);
          onEvent?.({ type: 'output', line: trimmed });
        }
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        const trimmed = line.trim();
        if (trimmed) {
          logs.push(trimmed);
          onEvent?.({ type: 'output', line: trimmed });
        }
      }
    });

    proc.on('exit', (code) => {
      const success = code === 0;
      const endLines: string[] = [];
      if (success) {
        endLines.push('sysbase_gen.py 执行成功!');
      } else {
        endLines.push(`sysbase_gen.py 执行失败 (退出码: ${code})`);
      }
      logs.push(...endLines);
      onEvent?.({ type: 'end', success, lines: endLines });
      resolvePromise({ success, logs, exitCode: code });
    });

    proc.on('error', (err) => {
      const errorLine = `执行错误: ${err.message}`;
      logs.push(errorLine);
      onEvent?.({ type: 'end', success: false, lines: [errorLine] });
      resolvePromise({ success: false, logs, exitCode: null });
    });
  });

  return result;
}
