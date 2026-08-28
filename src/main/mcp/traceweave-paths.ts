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
 * back to python3, then python. Python itself and its pip dependencies
 * (mcp, pyyaml) are user-machine prerequisites (EDA environments ship
 * Python); `diagnoseTraceweave()` reports structured readiness so the UI
 * can guide the user when a prerequisite is missing.
 *
 * EDA tool environment variables (VERDI_HOME, NOVAS_HOME, VCS_HOME, etc.)
 * are passed through from the current process.env so users can set them
 * globally and TraceWeave inherits them.
 */

import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { McpServerConfig, TraceweaveDiagnostic } from '@shared/types';

export type { TraceweaveDiagnostic };
import { findAllInPath } from '../agent/paths';

const __dirname = dirname(fileURLToPath(import.meta.url));
const lazyRequire = createRequire(import.meta.url);

/** Server name used in the MCP config (matches omp's mcpServers key). */
export const TRACEWEAVE_SERVER_NAME = 'TraceWeave';

/** Vendored TraceWeave release version (see package.json traceweaveVersion). */
export const TRACEWEAVE_VERSION = 'v2.0.0';

/** Upstream commit the vendored tree was taken from. */
export const TRACEWEAVE_UPSTREAM_COMMIT = 'ca32e38f97d886c289b013709f8234b1cb3fdf34';

/** Minimum Python minor version required by TraceWeave (3.11+). */
const PYTHON_MIN_MINOR = 11;

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
  'XCELIUM_HOME',
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

  // XLM_ROOT fallback: if XLM_ROOT is not set but XCELIUM_HOME is,
  // use XCELIUM_HOME as XLM_ROOT so TraceWeave can locate Xcelium.
  // Many installations set XCELIUM_HOME (the standard variable name)
  // rather than XLM_ROOT (which TraceWeave specifically reads).
  if (!env.XLM_ROOT && env.XCELIUM_HOME) {
    env.XLM_ROOT = env.XCELIUM_HOME;
  }

  // Always include PATH (even if not in process.env, TraceWeave needs it
  // to find vericom/elabcom and other EDA tools).
  if (!env.PATH) {
    env.PATH = process.env.PATH ?? '';
  }

  // Note: TraceWeave v2.0 self-locates via __file__ (REPO_ROOT in config.py);
  // no TRACEWEAVE_HOME env var is needed or read anymore.

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

// ── 结构化诊断 ────────────────────────────────────────────
//
// TraceWeave 的运行前置（Python 3.11+、pip 依赖）由用户机器提供而非随包
// 分发（ADR 0020）。诊断在设置页展示三级状态并给出可复制的修复命令，
// 让"缺什么"从 stderr traceback 变成用户可操作的信息。

/** Result of a single python subprocess probe. */
export type PythonProbeResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
};

/** Spawn a short-lived python probe, never rejecting (errors → ok:false). */
export function runPythonProbe(pythonBin: string, args: string[], timeoutMs = 10_000): Promise<PythonProbeResult> {
  return new Promise((resolveProbe) => {
    try {
      execFile(
        pythonBin,
        args,
        { timeout: timeoutMs, windowsHide: true },
        (err, stdout, stderr) => {
          resolveProbe({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        },
      );
    } catch (err) {
      resolveProbe({
        ok: false,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/** Parse "Python 3.12.4" from stdout/stderr (older pythons print to stderr). */
function parsePythonVersion(out: PythonProbeResult): string | null {
  const text = `${out.stdout}\n${out.stderr}`;
  const match = text.match(/Python\s+(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

function isVersionAtLeast3_11(version: string | null): boolean | null {
  if (!version) return null;
  const parts = version.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length < 2 || parts.some((n) => Number.isNaN(n))) return null;
  const [major, minor] = parts;
  return major > 3 || (major === 3 && minor >= PYTHON_MIN_MINOR);
}

/** Extract module names from "ModuleNotFoundError: No module named 'x'" lines. */
function parseMissingDeps(stderr: string): string[] {
  const found = new Set<string>();
  for (const match of stderr.matchAll(/No module named '([^']+)'/g)) {
    // mcp imports pull pydantic transitively; report the top-level name only
    found.add(match[1].split('.')[0]);
  }
  return [...found];
}

/** Read the pinned mcp version from upstream requirements (fallback: unpinned). */
function readMcpVersionPin(traceweaveDir: string): string {
  try {
    const reqPath = join(traceweaveDir, 'requirements-source-graph.txt');
    if (existsSync(reqPath)) {
      const content = readFileSync(reqPath, 'utf-8');
      const line = content
        .split('\n')
        .map((l) => l.trim())
        .find((l) => /^mcp==/.test(l));
      if (line) return line;
    }
  } catch {
    // fall through to unpinned
  }
  return 'mcp';
}

/** Build a user-runnable install command quoting the resolved python path. */
function buildInstallCommand(pythonBin: string, traceweaveDir: string): string {
  const mcpPin = readMcpVersionPin(traceweaveDir);
  return `"${pythonBin}" -m pip install ${mcpPin} pyyaml`;
}

/** FSDB blockers for the current platform/environment (empty = available). */
export function getFsdbBlockers(traceweaveDir: string | null): string[] {
  if (process.platform !== 'linux') {
    return ['FSDB 解析仅在 Linux 上可用（Verdi 运行库无 Windows/macOS 版本），VCD 波形不受影响'];
  }
  if (!traceweaveDir || !existsSync(join(traceweaveDir, 'libfsdb_wrapper.so'))) {
    return ['libfsdb_wrapper.so 未随包提供（需在装有 VERDI_HOME 的构建机上打包预编译）'];
  }
  if (!process.env.VERDI_HOME && !process.env.NOVAS_HOME) {
    return ['未检测到 VERDI_HOME 环境变量，无法加载 FSDB 运行库（libnsys/libnffr）'];
  }
  return [];
}

/**
 * Run the full TraceWeave readiness diagnostic.
 *
 * Probes (in order): source dir → python presence → python version →
 * pip deps import. Never throws; every probe failure degrades the
 * corresponding field so the UI can render a complete status card.
 */
export async function diagnoseTraceweave(): Promise<TraceweaveDiagnostic> {
  const traceweaveDir = resolveTraceweaveDir();
  const pythonBin = resolvePythonBin();

  let pythonVersion: string | null = null;
  let pythonVersionOk: boolean | null = null;
  let depsInstalled: boolean | null = null;
  let missingDeps: string[] = [];

  if (pythonBin) {
    const versionProbe = await runPythonProbe(pythonBin, ['--version']);
    pythonVersion = parsePythonVersion(versionProbe);
    pythonVersionOk = isVersionAtLeast3_11(pythonVersion);

    const depsProbe = await runPythonProbe(pythonBin, ['-c', 'import mcp, yaml']);
    depsInstalled = depsProbe.ok;
    if (!depsProbe.ok) {
      missingDeps = parseMissingDeps(depsProbe.stderr);
    }
  }

  const fsdbBlockers = getFsdbBlockers(traceweaveDir);

  return {
    version: TRACEWEAVE_VERSION,
    upstreamCommit: TRACEWEAVE_UPSTREAM_COMMIT,
    sourceDirFound: traceweaveDir !== null,
    pythonFound: pythonBin !== null,
    pythonPath: pythonBin,
    pythonVersion,
    pythonVersionOk,
    depsInstalled,
    missingDeps,
    fsdbAvailable: fsdbBlockers.length === 0,
    fsdbBlockers,
    installCommand: pythonBin ? buildInstallCommand(pythonBin, traceweaveDir ?? '') : null,
    ready: traceweaveDir !== null && pythonBin !== null && pythonVersionOk !== false && depsInstalled === true,
  };
}

/**
 * Build a short user-facing reason for why the TraceWeave registration was
 * skipped, or null when there is nothing worth surfacing. Registration only
 * fails when the source tree is missing (not bundled → not an error) or
 * when no Python binary is found (user-machine prerequisite missing).
 */
export function describeTraceweaveUnavailability(): string | null {
  if (!resolveTraceweaveDir()) return null; // not bundled → not an error worth surfacing
  if (!resolvePythonBin()) {
    return '未找到 Python。TraceWeave 仿真调试工具需要用户机器安装 Python 3.11+ 并将其加入 PATH。';
  }
  return null; // registration should have succeeded; nothing to report
}
