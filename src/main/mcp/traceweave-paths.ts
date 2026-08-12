/**
 * TraceWeave MCP server path resolution and default MCP config.
 *
 * TraceWeave is a Python-based MCP server for simulation-failure debugging
 * through log parsing and waveform (FSDB/VCD) analysis. This module resolves
 * the TraceWeave source directory and Python binary, then builds the MCP server
 * configuration that the omp engine's MCPManager uses to spawn the server.
 *
 * Path resolution follows the same pattern as officecli/binary.ts:
 *   1. Packaged (production): `process.resourcesPath/traceweave/`
 *   2. Dev (development): `engine/traceweave/` relative to the project root
 *
 * Python binary resolution uses `which`/`where` to find python3.11, falling
 * back to python3, then python.
 *
 * EDA tool environment variables (VERDI_HOME, NOVAS_HOME, VCS_HOME, etc.)
 * are passed through from the current process.env so users can set them
 * globally and TraceWeave inherits them.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { McpServerConfig } from '@shared/types';
import { findInPath } from '../agent/paths';

const __dirname = dirname(fileURLToPath(import.meta.url));
const lazyRequire = createRequire(import.meta.url);

/** Server name used in the MCP config (matches omp's mcpServers key). */
export const TRACEWEAVE_SERVER_NAME = 'TraceWeave';

/** Python binary candidate names in priority order. */
const PYTHON_CANDIDATES = ['python3.11', 'python3', 'python'];

/**
 * Resolve the TraceWeave source directory.
 *
 * Priority:
 * 1. Packaged: `process.resourcesPath/traceweave/` (contains server.py)
 * 2. Dev: `engine/traceweave/` relative to the source tree
 *
 * @returns Absolute path to the TraceWeave directory, or null if not found.
 */
export function resolveTraceweaveDir(): string | null {
  // 1. Packaged mode
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? '';
  if (resourcesPath) {
    const packagedDir = join(resourcesPath, 'traceweave');
    if (existsSync(join(packagedDir, 'server.py'))) {
      return packagedDir;
    }
  }

  // 2. Dev mode: from out/main/index.cjs → ../../engine/traceweave
  //    or from src/main/mcp/ → ../../../engine/traceweave
  const devCandidates = [
    resolve(__dirname, '../../engine/traceweave'),
    resolve(__dirname, '../../../engine/traceweave'),
    resolve(__dirname, '../../../../engine/traceweave'),
  ];
  for (const candidate of devCandidates) {
    if (existsSync(join(candidate, 'server.py'))) {
      return candidate;
    }
  }

  return null;
}

/**
 * Resolve the Python binary path.
 *
 * Tries python3.11 → python3 → python in order, using `which`/`where`.
 *
 * @returns Absolute path to the Python binary, or null if none found.
 */
export function resolvePythonBin(): string | null {
  for (const candidate of PYTHON_CANDIDATES) {
    const found = findInPath(candidate);
    if (found) return found;
  }
  return null;
}

/**
 * Check whether TraceWeave is available (source directory + python binary).
 *
 * @returns true if both the TraceWeave source and a Python binary are found.
 */
export function isTraceweaveAvailable(): boolean {
  return resolveTraceweaveDir() !== null && resolvePythonBin() !== null;
}

/**
 * Determine whether we are in development mode (not packaged).
 */
function isDevMode(): boolean {
  try {
    const electron = lazyRequire('electron') as unknown;
    if (typeof electron === 'object' && electron !== null && 'app' in electron) {
      const app = (electron as { app: { isPackaged: boolean } }).app;
      return !app.isPackaged;
    }
    return true;
  } catch {
    return true;
  }
}

/** EDA tool environment variables that TraceWeave reads. */
const EDA_ENV_VARS = [
  'VERDI_HOME',
  'NOVAS_HOME',
  'VCS_HOME',
  'XLM_ROOT',
  'CDS_INST_DIR',
  'SNPSLMD_LICENSE_FILE',
  'LM_LICENSE_FILE',
  'CDS_LICENSE_FILE',
  'LD_LIBRARY_PATH',
  'PATH',
] as const;

/**
 * Build the MCP server configuration for TraceWeave.
 *
 * The configuration uses stdio transport: the omp engine spawns the Python
 * process running `server.py` and communicates via JSON-RPC over stdin/stdout.
 *
 * EDA tool environment variables are passed through from the current
 * `process.env` so that TraceWeave can locate Verdi, VCS, Xcelium, and
 * license servers configured on the user's system.
 *
 * @returns McpServerConfig for TraceWeave, or null if unavailable.
 */
export function buildTraceweaveMcpConfig(): McpServerConfig | null {
  const traceweaveDir = resolveTraceweaveDir();
  if (!traceweaveDir) return null;

  const pythonBin = resolvePythonBin();
  if (!pythonBin) return null;

  const serverPath = join(traceweaveDir, 'server.py');

  // Pass through EDA tool env vars from process.env.
  // Only include vars that are actually set (non-empty).
  const env: Record<string, string> = {};
  for (const key of EDA_ENV_VARS) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }

  // Always include PATH (even if not in process.env, TraceWeave needs it
  // to find vericom/elabcom and other EDA tools).
  if (!env.PATH) {
    env.PATH = process.env.PATH ?? '';
  }

  // Set TRACEWEAVE_HOME so TraceWeave knows its own root
  env.TRACEWEAVE_HOME = traceweaveDir;

  return {
    type: 'stdio',
    command: pythonBin,
    args: [serverPath],
    cwd: traceweaveDir,
    env,
    enabled: true,
    timeout: 30_000,
  };
}

/** Result of ensuring TraceWeave is registered as a default MCP server. */
export type TraceweaveMcpRegistration = {
  name: string;
  config: McpServerConfig;
};

/**
 * Ensure TraceWeave is available and return its MCP server registration.
 *
 * Called during session creation to inject TraceWeave as a built-in MCP
 * server. If TraceWeave or Python is not available, returns null (graceful
 * degradation — the app continues without TraceWeave tools).
 *
 * @returns Registration with server name and config, or null if unavailable.
 */
export function ensureTraceweaveDefaultMcp(): TraceweaveMcpRegistration | null {
  const config = buildTraceweaveMcpConfig();
  if (!config) {
    if (isDevMode()) {
      console.warn('[traceweave] Not available — TraceWeave MCP tools will not be loaded');
    }
    return null;
  }

  return {
    name: TRACEWEAVE_SERVER_NAME,
    config,
  };
}
