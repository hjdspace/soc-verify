/**
 * runsim_retry Host Tool（ADR 0003）
 *
 * Defines the `runsim_retry` host tool that the AI Agent can invoke to
 * re-run a simulation after fixing compilation errors.
 *
 * NOTE: This file previously contained a full duplicate of TerminalManager
 * (~800 lines). That duplication caused a critical bug: the AI retry flow
 * used a *separate* TerminalManager instance whose events were never
 * received by simTerminalLinker or forwarded to the renderer. Now we
 * import the shared singleton from ../terminal/terminal-manager.
 */

import { terminalManager } from '../terminal/terminal-manager';

/**
 * runsim_retry 工具定义。注册到 HostToolsRegistry，使 AI Agent 可以在
 * 修复编译错误后自主调用此工具重新执行仿真。
 */
export const runsimRetryToolDefinition = {
  name: 'runsim_retry',
  description:
    'Re-run a simulation after fixing compilation errors. ' +
    'Use this tool after you have edited source files to verify the fix compiles and passes.',
  parameters: {
    type: 'object',
    properties: {
      case: {
        type: 'string',
        description: 'Test case name to re-run',
      },
      command: {
        type: 'string',
        description: 'Shell command to execute (e.g. "runsim -case foo"). If omitted, uses the original command.',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the command. Defaults to the project root.',
      },
      projectId: {
        type: 'string',
        description: 'Project ID for tracking the re-run.',
      },
      mode: {
        type: 'string',
        enum: ['terminal', 'background'],
        description: 'Execution mode: terminal (visible to user) or background (headless). Defaults to terminal.',
      },
    },
    required: ['case'],
    additionalProperties: false,
  },
};

/**
 * runsim_retry 工具执行函数。
 * terminal 模式：通过 terminalManager.runCommand() 在日志模式下执行命令。
 * background 模式：通过 simulationRegistry 在后台执行。
 */
export async function executeRunsimRetry(params: {
  case: string;
  command?: string;
  cwd?: string;
  projectId?: string;
  mode?: 'terminal' | 'background';
}): Promise<{ runId: string; mode: string; status: string; message: string }> {
  const { case: caseName, command, cwd, mode } = params;
  const effectiveMode = mode ?? 'terminal';
  const effectiveCwd = cwd ?? process.cwd();
  const effectiveCommand = command ?? `runsim -case ${caseName}`;

  if (effectiveMode === 'terminal') {
    const session = await terminalManager.runCommand({
      command: effectiveCommand,
      cwd: effectiveCwd,
    });
    return {
      runId: session.id,
      mode: 'terminal',
      status: 'running',
      message: `Re-running "${caseName}" in terminal ${session.id}. Monitor the terminal for results.`,
    };
  }

  // background mode — not yet wired to SimulationManager; fall back to terminal
  const session = await terminalManager.runCommand({
    command: effectiveCommand,
    cwd: effectiveCwd,
  });
  return {
    runId: session.id,
    mode: 'background',
    status: 'pending',
    message: `Re-running "${caseName}" via log-mode terminal ${session.id} (background mode delegates to terminal).`,
  };
}
