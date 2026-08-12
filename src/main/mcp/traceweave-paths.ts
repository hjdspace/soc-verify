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
import { findAllInPath } from '../agent/paths';

const __dirname = dirname(fileURLToPath(import.meta.url));
const lazyRequire = createRequire(import.meta.url);

/** Server name used in the MCP config (matches omp's mcpServers key). */
export const TRACEWEAVE_SERVER_NAME = 'TraceWeave';

/** Python binary candidate names in priority order (Unix). */
const PYTHON_CANDIDATES_UNIX = ['python3.11', 'python3', 'python'];

/**
 * Python binary candidate names in priority order (Windows).
 *
 * On Windows, real Python installations register as `python.exe` (not
 * `python3.exe`), so `python` is tried first. The `py` launcher (installed
 * with Python from python.org) is tried last as a fallback.
 */
const PYTHON_CANDIDATES_WIN = ['python', 'python3', 'python3.11', 'py'];

/**
 * Check if a binary path is a Windows Store app execution alias stub.
 *
 * Windows creates 0-byte stub executables in
 * `C:\Users\<user>\AppData\Local\Microsoft\WindowsApps\` for `python3.exe`
 * and `python.exe`. These stubs either redirect to the Microsoft Store or
 * exit with code 9009. They must be filtered out when resolving Python.
 */
function isWindowsStoreStub(binPath: string): boolean {
  return process.platform === 'win32' && binPath.toLowerCase().includes('windowsapps');
}

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
 * On Unix, tries python3.11 → python3 → python in order using `which`.
 * On Windows, tries python → python3 → python3.11 → py in order using
 * `where`, filtering out Windows Store app execution alias stubs (which
 * exit with code 9009 when invoked).
 *
 * @returns Absolute path to the Python binary, or null if none found.
 */
export function resolvePythonBin(): string | null {
  const candidates = process.platform === 'win32' ? PYTHON_CANDIDATES_WIN : PYTHON_CANDIDATES_UNIX;
  for (const candidate of candidates) {
    const allPaths = findAllInPath(candidate);
    for (const p of allPaths) {
      // Skip Windows Store stubs (0-byte alias executables that exit with
      // code 9009). Real Python installations live elsewhere.
      if (!isWindowsStoreStub(p)) {
        return p;
      }
    }
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
