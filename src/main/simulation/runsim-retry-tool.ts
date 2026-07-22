/**
 * runsim_retry — Host Tool for AI Agent to re-run simulations.
 *
 * When the AI Agent fixes compilation errors and wants to re-run the
 * simulation, it calls this tool. The tool delegates to either
 * `simulationManager.run()` (background) or `simTerminalLinker.register()`
 * (terminal), depending on the original execution mode.
 *
 * Ported from Python `ai_core/tools/execute_tools.py` → `AIExecuteTools.runsim()`.
 */

import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { terminalManager } from '../terminal/terminal-manager';
import { simTerminalLinker } from './sim-terminal-linker';
import { simulationRegistry } from './simulation-registry';
import { pluginLoader } from '../plugins/loader';
import type { SimulationRunOptions } from '@shared/plugin-types';
import type { RpcHostToolDefinition } from '../host/types';

export interface RunsimRetryArgs {
  case: string;
  command?: string;
  cwd?: string;
  projectId?: string;
  /** 原始执行模式：'terminal' | 'background' */
  mode?: 'terminal' | 'background';
}

export interface RunsimRetryResult {
  runId: string;
  status: 'pending' | 'running';
  message: string;
}

/**
 * Generate a runsim command from the simulation runner plugin.
 *
 * This reuses the same logic as `simulation.runInTerminal` in the router.
 */
async function generateRunsimCommand(
  projectRoot: string,
  opts: SimulationRunOptions,
): Promise<{ command: string; cwd: string } | null> {
  const loadResults = pluginLoader.getLoadResults(projectRoot);
  const simRunnerResult = loadResults.find(
    (r) => r.manifest.kind === 'simulation-runner' && !r.error,
  );
  if (!simRunnerResult) return null;

  const pluginPath =
    simRunnerResult.source === 'local' && !isAbsolute(simRunnerResult.path)
      ? resolve(projectRoot, simRunnerResult.path)
      : simRunnerResult.path;

  const nodeRequire = createRequire(import.meta.url);
  const mod = nodeRequire(pluginPath);

  const command: string | null =
    typeof mod.generateRunsimCommand === 'function'
      ? mod.generateRunsimCommand(opts)
      : null;
  const cwd: string =
    typeof mod.resolveCwd === 'function' ? mod.resolveCwd(opts) : projectRoot;

  if (!command) return null;
  return { command, cwd };
}

/**
 * Execute runsim retry — the core handler for the runsim_retry host tool.
 *
 * Flow:
 * 1. If projectId + case provided, generate the runsim command via plugin
 * 2. If mode === 'terminal', create a new terminal PTY and register with simTerminalLinker
 * 3. If mode === 'background', use simulationManager.run()
 */
export async function executeRunsimRetry(
  args: RunsimRetryArgs,
): Promise<RunsimRetryResult> {
  const { case: caseName, projectId, mode = 'terminal' } = args;

  if (!caseName) {
    return { runId: '', status: 'pending', message: 'Error: case name is required' };
  }

  // Resolve project root from projectId
  let projectRoot: string | undefined;
  if (projectId) {
    // Lazy import to avoid circular dependency
    const { projectManager } = await import('../project/project-manager');
    const project = projectManager.getProject(projectId);
    if (project) {
      projectRoot = project.rootPath;
    }
  }

  if (!projectRoot) {
    return { runId: '', status: 'pending', message: 'Error: project not found' };
  }

  // Ensure plugins are loaded
  const loadResults = pluginLoader.getLoadResults(projectRoot);
  if (loadResults.length === 0) {
    await pluginLoader.loadPlugins(projectRoot);
  }

  // Generate runsim command if not provided
  let command = args.command;
  let cwd = args.cwd ?? projectRoot;

  if (!command) {
    const opts: SimulationRunOptions = {
      caseId: caseName,
      caseName,
      subsys: '',
      projectRoot,
    };
    const generated = await generateRunsimCommand(projectRoot, opts);
    if (!generated) {
      return { runId: '', status: 'pending', message: 'Error: cannot generate runsim command from plugin' };
    }
    command = generated.command;
    cwd = generated.cwd;
  }

  if (!command) {
    return { runId: '', status: 'pending', message: 'Error: no command to execute' };
  }

  if (mode === 'terminal') {
    // Build displayCommand: if $PROJ_WORK is defined, cd to project work dir first
    const projWork = process.env.PROJ_WORK;
    const cdPrefix = projWork ? `cd "${projWork}" && ` : '';
    const displayCommand = `${cdPrefix}${command}`;

    let session;
    if (terminalManager.isPtyAvailable()) {
      // PTY mode: create interactive terminal session
      session = await terminalManager.create({ cwd });

      // Wait for shell initialization
      await new Promise((r) => setTimeout(r, 500));

      // Write runsim command with completion marker
      const fullCommand = `${displayCommand}; echo "__SIM_DONE__$?__"`;
      terminalManager.write(session.id, `${fullCommand}\n`);
    } else {
      // Log mode: directly execute command, stdout/stderr streamed to terminal view
      console.log('[runsim-retry] node-pty unavailable — using log-mode execution.');
      session = await terminalManager.runCommand({
        command: displayCommand,
        cwd,
      });
    }

    // Register with simTerminalLinker for tracking
    const opts: SimulationRunOptions = {
      caseId: caseName,
      caseName,
      subsys: '',
      projectRoot,
    };
    const run = simTerminalLinker.register(
      projectId ?? '',
      session.id,
      displayCommand,
      cwd,
      opts,
    );

    return {
      runId: run.runId,
      status: 'running',
      message: `Simulation started in terminal. Case: ${caseName}, Command: ${displayCommand}`,
    };
  }

  // Background mode: use simulationManager
  const { PluginBackedSimulation } = await import('../host/plugin-discovery');
  const registry = pluginLoader.getRegistry(projectRoot);
  const adapter = new PluginBackedSimulation(registry);
  const manager = simulationRegistry.getOrCreate(
    projectRoot,
    projectId ?? '',
    adapter,
  );

  const opts: SimulationRunOptions = {
    caseId: caseName,
    caseName,
    subsys: '',
    projectRoot,
  };

  try {
    const handle = await manager.run(opts);
    return {
      runId: handle.runId,
      status: 'pending',
      message: `Simulation started in background. Case: ${caseName}, RunId: ${handle.runId}`,
    };
  } catch (err) {
    return {
      runId: '',
      status: 'pending',
      message: `Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * The runsim_retry host tool definition.
 *
 * This tool is registered with HostToolsRegistry so the omp AI Agent
 * can call it to re-run simulations after fixing code.
 */
export const runsimRetryToolDefinition: RpcHostToolDefinition = {
  name: 'runsim_retry',
  description:
    'Re-run a simulation after fixing code. Use this to verify that compilation errors are resolved. ' +
    'Parameters: case (required) - testcase name; command (optional) - full runsim command; ' +
    'cwd (optional) - working directory; mode (optional, default "terminal") - execution mode.',
  parameters: {
    type: 'object',
    properties: {
      case: { type: 'string', description: 'Testcase name to run' },
      command: { type: 'string', description: 'Full runsim command (if not provided, will be generated from plugin)' },
      cwd: { type: 'string', description: 'Working directory for the simulation' },
      mode: {
        type: 'string',
        enum: ['terminal', 'background'],
        description: 'Execution mode: terminal (visible PTY) or background (hidden subprocess)',
      },
    },
    required: ['case'],
    additionalProperties: false,
  },
};
