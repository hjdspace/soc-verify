import { StringDecoder } from 'node:string_decoder';
import { EventEmitter } from 'node:events';
import { spawn, ChildProcess, execSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { userInfo } from 'node:os';
import type * as NodePty from 'node-pty';
import { resolveStarshipPath } from './starship-binary';

/** Which PTY backend a terminal session is using. */
export type TerminalBackend = 'node-pty' | 'fallback' | 'log-mode';

export interface TerminalSession {
  id: string;
  pid: number;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  /** Which backend is powering this session. */
  backend: TerminalBackend;
  /** Human-readable warning when running in fallback mode (null when node-pty is active). */
  warning: string | null;
}

export interface TerminalCreateOptions {
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  /** Override the shell binary path (e.g. '/bin/csh' for EDA environments). */
  shell?: string;
  /**
   * Enable Enhanced Terminal mode: zsh + Starship + zsh-autosuggestions
   * + Shell Integration (OSC 133 sequences) on Linux/macOS,
   * or PowerShell + Starship + OSC 133 on Windows.
   *
   * Simulation terminals should NOT set this (keep csh, no beautification).
   */
  enhanced?: boolean;
}

/** Options for {@link TerminalManager.runCommand} — log-mode execution. */
export interface TerminalRunCommandOptions {
  /** The shell command to execute (e.g. `cd /work && runsim -case foo`). */
  command: string;
  /** Working directory for the command. */
  cwd?: string;
  /** Additional environment variables to merge into `process.env`. */
  env?: Record<string, string>;
  /** Override the shell binary path (e.g. '/bin/csh' for EDA environments). */
  shell?: string;
  /**
   * Override the session warning message. Callers should set this when
   * log-mode was chosen deliberately (user setting) rather than as a
   * node-pty fallback, so the UI shows the actual reason.
   */
  warning?: string;
}

export interface PtyLoadResult {
  module: typeof NodePty | null;
  /** The captured error when node-pty fails to load (null on success or before first attempt). */
  error: Error | null;
}

/** Merge terminal-specific environment values without discarding login-shell PATH entries. */
export function mergeTerminalEnvs(
  base: Record<string, string>,
  overrides?: Record<string, string>,
): Record<string, string> {
  if (!overrides) return { ...base };

  const merged = { ...base, ...overrides };
  const pathSeparator = process.platform === 'win32' ? ';' : ':';
  for (const key of ['PATH', 'LD_LIBRARY_PATH']) {
    const overrideValue = overrides[key];
    const baseValue = base[key];
    if (!overrideValue || !baseValue) continue;

    const seen = new Set<string>();
    merged[key] = [...overrideValue.split(pathSeparator), ...baseValue.split(pathSeparator)]
      .filter((entry) => entry.length > 0 && !seen.has(entry) && seen.add(entry))
      .join(pathSeparator);
  }
  return merged;
}

let ptyLoadResult: PtyLoadResult = { module: null, error: null };
let ptyLoadAttempted = false;

/**
 * Find a usable shell binary from the account configuration and known paths.
 *
 * On Linux AppImage, `$SHELL` may be missing when launched from the desktop.
 * The account login shell is therefore authoritative for interactive terminals.
 *
 * @param preferred - Optional list of preferred shell paths to check first
 *                    (e.g. `['/bin/csh', '/usr/bin/csh']` for EDA environments).
 */
export function resolveInteractiveShell(
  platform: NodeJS.Platform,
  inheritedShell: string | undefined,
  accountShell: string | null,
  pathExists: (path: string) => boolean = existsSync,
): string {
  if (platform === 'win32') return 'powershell.exe';

  if (accountShell && pathExists(accountShell)) return accountShell;
  if (inheritedShell && pathExists(inheritedShell)) return inheritedShell;

  const candidates = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/bin/sh', '/usr/bin/sh'];
  return candidates.find(pathExists) ?? 'bash';
}

function getAccountLoginShell(): string | null {
  if (process.platform === 'win32') return null;
  try {
    return userInfo().shell;
  } catch {
    return null;
  }
}

function findShell(preferred?: string[]): string {
  if (process.platform === 'win32') return 'powershell.exe';

  // Check preferred shells first (e.g. csh for EDA/simulation environments)
  if (preferred && preferred.length > 0) {
    for (const c of preferred) {
      if (existsSync(c)) return c;
    }
  }

  return resolveInteractiveShell(
    process.platform,
    process.env.SHELL,
    getAccountLoginShell(),
  );
}

function resolveBashRcPath(): string {
  const packagedPath = process.resourcesPath
    ? join(process.resourcesPath, 'terminal', 'bashrc')
    : '';
  if (packagedPath && existsSync(packagedPath)) return packagedPath;
  return join(process.cwd(), 'resources', 'terminal', 'bashrc');
}

/**
 * Resolve the ZDOTDIR path for Enhanced Terminal (zsh config directory).
 *
 * In packaged mode: process.resourcesPath/terminal/zsh/
 * In dev mode: <project>/resources/terminal/zsh/
 */
export function resolveZdotdirPath(): string {
  const packagedPath = process.resourcesPath
    ? join(process.resourcesPath, 'terminal', 'zsh')
    : '';
  if (packagedPath && existsSync(packagedPath)) return packagedPath;
  return join(process.cwd(), 'resources', 'terminal', 'zsh');
}

/**
 * Resolve the Starship config path for Enhanced Terminal.
 *
 * Points to the packaged starship.toml inside the zsh config directory.
 */
export function resolveStarshipConfigPath(): string {
  return join(resolveZdotdirPath(), 'starship.toml');
}

/**
 * Resolve the OSC 133 PowerShell script path for Enhanced Terminal (Windows).
 *
 * Points to osc133.ps1 inside the zsh config directory.
 */
export function resolveOsc133Ps1Path(): string {
  return join(resolveZdotdirPath(), 'osc133.ps1');
}

/**
 * Shell preferences for Enhanced Terminal on different platforms.
 *
 * On Linux/macOS: prefer zsh → bash (NOT csh, which is for simulation).
 * On Windows: PowerShell.
 */
const ENHANCED_SHELL_PREFERENCES: string[] =
  process.platform === 'win32'
    ? []
    : ['/bin/zsh', '/usr/bin/zsh', '/usr/local/bin/zsh'];

/**
 * Find a shell suitable for Enhanced Terminal.
 *
 * On Linux/macOS: prefers zsh → bash (unlike findSimShell which prefers csh).
 * On Windows: PowerShell.
 *
 * Reuses findShell() with zsh-first preferred list.
 */
export function findEnhancedShell(): string {
  return findShell(ENHANCED_SHELL_PREFERENCES);
}

/**
 * Build shell args for Enhanced Terminal.
 *
 * On Linux/macOS with zsh: use ['-l', '-i'] so zsh sources .zshrc from ZDOTDIR.
 * On Windows with PowerShell: use ['-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', <osc133.ps1>].
 * Falls back to getInteractiveShellArgs() for other shells.
 */
export function getEnhancedShellArgs(shell: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') {
    const osc133Path = resolveOsc133Ps1Path();
    if (existsSync(osc133Path)) {
      // -NoExit is required: without it, PowerShell exits as soon as the
      // -File script finishes, killing the interactive session instantly.
      return ['-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', osc133Path];
    }
    // Fallback: no osc133 script, just start PowerShell
    return ['-NoProfile'];
  }

  const isZsh = shell === 'zsh' || shell.endsWith('/zsh');
  if (isZsh) return ['-l', '-i'];

  // Fallback for bash or other shells
  return getInteractiveShellArgs(shell, platform);
}

/**
 * Build the environment for Enhanced Terminal.
 *
 * Sets ZDOTDIR (zsh config directory), STARSHIP_CONFIG (starship.toml path),
 * and merges any caller-provided env overrides.
 *
 * If Starship binary is not found, the env vars are still set (harmless),
 * and the .zshrc/osc133.ps1 will skip starship init gracefully.
 */
export function buildEnhancedEnv(
  base: Record<string, string>,
  overrides?: Record<string, string>,
): Record<string, string> {
  const zdotdir = resolveZdotdirPath();
  const starshipConfig = resolveStarshipConfigPath();
  const starshipPath = resolveStarshipPath();

  const enhanced: Record<string, string> = {
    ZDOTDIR: zdotdir,
    STARSHIP_CONFIG: starshipConfig,
  };

  // Linux/macOS: Electron 从桌面启动（AppImage/.desktop）时 GUI 进程没有 TERM，
  // PTY 内 zsh 的 zle_highlight（zsh-autosuggestions 通过 region_highlight 的
  // fg=N 上色）依赖 terminfo——TERM 缺失时颜色序列全部失效，命令预测文本会
  // 以默认前景色渲染，与用户输入同色。仅在缺失/为空/为 dumb 时注入，
  // 不覆盖用户已有 TERM（tmux/screen 等场景），调用方 opts.env 的覆盖仍最高优先。
  if (process.platform !== 'win32' && (!base.TERM || base.TERM === 'dumb')) {
    enhanced.TERM = 'xterm-256color';
  }

  // Add Starship to PATH if found (ensures `starship` command is available)
  if (starshipPath) {
    const starshipDir = dirname(starshipPath);
    const pathSeparator = process.platform === 'win32' ? ';' : ':';
    enhanced.PATH = `${starshipDir}${pathSeparator}${base.PATH ?? ''}`;
  }

  return mergeTerminalEnvs(
    mergeTerminalEnvs(base, enhanced),
    overrides,
  );
}

export function getInteractiveShellArgs(
  shell: string,
  platform: NodeJS.Platform = process.platform,
  bashRcPath: string = resolveBashRcPath(),
): string[] {
  if (platform !== 'linux') return [];
  const isBash = shell === 'bash' || shell.endsWith('/bash');
  const isZsh = shell === 'zsh' || shell.endsWith('/zsh');
  const isCsh = shell === 'csh' || shell.endsWith('/csh') || shell === 'tcsh' || shell.endsWith('/tcsh');

  // Bash: use --rcfile to source the app's bashrc (which in turn sources ~/.bashrc)
  if (isBash) return ['--rcfile', bashRcPath, '-i'];

  // Zsh: start as a login + interactive shell so .zprofile and .zshrc are sourced
  if (isZsh) return ['-l', '-i'];

  // Csh/tcsh: -l must be the only option and loads .cshrc plus .login.
  if (isCsh) return ['-l'];

  return [];
}

/**
 * Build shell args for log-mode command execution (`shell <args>`).
 *
 * Mirrors the Python reference GUI (`process_manager.py`), which runs
 * simulations via `QProcess.start('/bin/csh', ['-c', command])`:
 * - csh/tcsh: `-c` only. csh's `-l` must be the ONLY option (combining it
 *   with `-c` fails with `Unknown option -l`), and `.cshrc` — where EDA
 *   environments initialize — is sourced automatically without it.
 * - bash/zsh: `-l -c` so login startup files are sourced.
 * - Windows (PowerShell): `-NoProfile -Command`.
 */
export function getLogModeShellArgs(
  shell: string,
  command: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === 'win32') return ['-NoProfile', '-Command', command];
  const isCsh = shell === 'csh' || shell.endsWith('/csh') || shell === 'tcsh' || shell.endsWith('/tcsh');
  return isCsh ? ['-c', command] : ['-l', '-c', command];
}

/**
 * Create a chunk normalizer for log-mode (pipe) output.
 *
 * Programs writing to a pipe emit bare `\n` line endings. xterm.js treats a
 * bare LF as "move down one row, keep the column", which renders log-mode
 * output as a diagonal staircase — unlike a PTY, whose kernel line discipline
 * (ONLCR) rewrites LF to CRLF before xterm.js ever sees it. The Python
 * reference GUI never hits this because its Qt log widget treats `\n` as a
 * full line break (column reset) and QProcess MergedChannels keeps
 * stdout/stderr write order.
 *
 * The returned function rewrites every bare `\n` to `\r\n` (existing `\r\n`
 * pairs and lone `\r` are preserved) so the renderer's xterm.js instance
 * displays log-mode output left-aligned, mirroring PTY rendering.
 *
 * Chunk boundaries are handled safely:
 * - multi-byte UTF-8 sequences split across chunks are buffered via
 *   StringDecoder instead of the lossy `data.toString()`;
 * - a `\r\n` pair split across two chunks is not doubled (tracks the last
 *   character of the previous chunk).
 */
export function createLogModeChunkNormalizer(): (chunk: Buffer) => string {
  const decoder = new StringDecoder('utf8');
  let lastChar = '\n';
  return (chunk: Buffer): string => {
    const text = decoder.write(chunk);
    if (text.length === 0) return '';
    let out: string;
    if (text.charCodeAt(0) === 10 /* \n */) {
      // Leading LF: resolve it against the previous chunk's last character
      // first (previous \r completes a CRLF pair; otherwise this bare LF
      // becomes one), then process the remainder with the plain regex.
      const head = lastChar === '\r' ? '\n' : '\r\n';
      out = head + text.slice(1).replace(/\r?\n/g, '\r\n');
    } else {
      out = text.replace(/\r?\n/g, '\r\n');
    }
    lastChar = text[text.length - 1];
    return out;
  };
}

/**
 * Environment variables carrying Environment Modules runtime state.
 *
 * When the Electron app itself is launched from a shell with EDA modules
 * loaded, these leak into a log-mode `csh -c` child. Re-sourcing `.cshrc`
 * then hits module conflicts ("cannot be loaded due to a conflict", "list
 * element in quotes followed by ':' instead of space"), module init aborts
 * partway, and tools that `.cshrc` puts on PATH fall back to system
 * binaries — notably /usr/bin/python (Python 2), which crashes runsim with
 * `TypeError: 'encoding' is an invalid keyword argument for this function`.
 * The Python reference GUI avoids this because runsim_gui.sh pre-loads its
 * own python3 module into the env that QProcess passes down.
 */
const MODULE_STATE_ENV_KEYS: readonly string[] = [
  'LOADEDMODULES',
  '_LMFILES_',
  'MODULE_VERSION',
  'MODULE_VERSION_STACK',
];

/**
 * Strip inherited Environment Modules runtime state from an environment.
 *
 * A log-mode `csh -c` re-sources `.cshrc`, which (re)loads the EDA module
 * environment. Preset module state from the app's parent shell breaks that
 * initialization, so the child shell must start from a clean module slate —
 * exactly like a fresh login shell. MODULEPATH/MODULESHOME are deliberately
 * kept: system startup files (/etc/csh.cshrc) own their setup and modulecmd
 * needs them to function at all.
 */
export function sanitizeModuleEnvForChild(
  env: Record<string, string>,
): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (MODULE_STATE_ENV_KEYS.includes(key)) continue;
    // `_ModuleTable<NN>_...` — chunked serialized module state variables.
    if (key.startsWith('_ModuleTable')) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

/**
 * Shell preferences for simulation commands on different platforms.
 *
 * On Linux, EDA tools (runsim, xrun, vcs, etc.) typically require csh/tcsh
 * because their environment setup scripts are written in csh syntax.
 * On Windows, PowerShell is used.
 */
const SIM_SHELL_PREFERENCES: string[] =
  process.platform === 'win32'
    ? []
    : ['/bin/csh', '/usr/bin/csh', '/bin/tcsh', '/usr/bin/tcsh'];

/**
 * Find a shell suitable for running simulation (runsim) commands.
 *
 * On Linux, prefers csh/tcsh (EDA environments require it) and falls back
 * to bash/sh. On Windows, always uses PowerShell.
 */
export function findSimShell(): string {
  return findShell(SIM_SHELL_PREFERENCES);
}

/**
 * Validate that a directory exists and is accessible. If not, fall back to
 * `process.cwd()` (or `/tmp` as a last resort) and return the effective path.
 *
 * This prevents `spawn ENOENT` errors caused by non-existent cwd paths,
 * which is a common issue when running in AppImage where the project path
 * might not be accessible or might be a Windows-style path.
 */
function validateCwd(cwd: string): { effective: string; fallback: boolean } {
  if (existsSync(cwd) && statSync(cwd).isDirectory()) {
    return { effective: cwd, fallback: false };
  }
  console.warn(`[terminal] cwd '${cwd}' does not exist or is not a directory, falling back to process.cwd()`);
  const fallback = process.cwd();
  if (existsSync(fallback) && statSync(fallback).isDirectory()) {
    return { effective: fallback, fallback: true };
  }
  // Absolute last resort
  return { effective: '/tmp', fallback: true };
}

/**
 * Detect an available external terminal emulator on Linux.
 *
 * Returns the command and args to launch a terminal, or null if none found.
 * Used as a last-resort fallback when neither node-pty nor log-mode work.
 */
function findExternalTerminal(): { cmd: string; args: string[] } | null {
  if (process.platform !== 'linux') return null;
  const terminals: Array<{ cmd: string; args: string[] }> = [
    { cmd: 'gnome-terminal', args: ['--', 'bash', '-c'] },
    { cmd: 'konsole', args: ['-e', 'bash', '-c'] },
    { cmd: 'xterm', args: ['-e', 'bash', '-c'] },
    { cmd: 'xfce4-terminal', args: ['-x', 'bash', '-c'] },
    { cmd: 'mate-terminal', args: ['-e', 'bash', '-c'] },
  ];
  for (const t of terminals) {
    try {
      const which = execSync(`which ${t.cmd} 2>/dev/null`, { encoding: 'utf-8' }).trim();
      if (which && existsSync(which)) {
        return t;
      }
    } catch {
      // continue searching
    }
  }
  return null;
}

/**
 * Attempt to find the node-pty native binary on disk so we can give a more
 * specific error message ("binary exists but failed to load — likely ABI
 * mismatch" vs "binary not found at all").
 *
 * Checks both the directory existence AND the actual pty.node file, because
 * node-pty 1.1.0 ships prebuilds for darwin/win32 but NOT for Linux — the
 * prebuilds/linux-x64/ directory may not exist at all.
 */
interface BinarySearchResult {
  /** Directories that exist (may or may not contain pty.node). */
  dirs: string[];
  /** Paths where pty.node actually exists on disk. */
  files: string[];
}

function findNodePtyBinaryPaths(): BinarySearchResult {
  const dirs: string[] = [];
  const files: string[] = [];

  // node-pty's loadNativeModule() checks these locations (relative to lib/):
  //   ../build/Release/pty.node, ../build/Debug/pty.node,
  //   ../prebuilds/<platform>-<arch>/pty.node
  const platformTag = `${process.platform}-${process.arch}`;
  const subDirs = [
    'build/Release',
    'build/Debug',
    `prebuilds/${platformTag}`,
  ];

  // Check relative to process.cwd() (dev mode)
  const ptyRoot = join(process.cwd(), 'node_modules', 'node-pty');
  for (const sub of subDirs) {
    const dir = join(ptyRoot, sub);
    if (existsSync(dir)) {
      dirs.push(dir);
      const ptyFile = join(dir, 'pty.node');
      if (existsSync(ptyFile)) files.push(ptyFile);
    }
  }

  // Also check the app's resource path (AppImage / packaged app)
  if (process.resourcesPath) {
    const unpacked = join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'node-pty');
    for (const sub of subDirs) {
      const dir = join(unpacked, sub);
      if (existsSync(dir)) {
        dirs.push(dir);
        const ptyFile = join(dir, 'pty.node');
        if (existsSync(ptyFile)) files.push(ptyFile);
      }
    }
  }

  return { dirs, files };
}

/**
 * Build a detailed diagnostic message explaining why node-pty failed to load.
 * This is logged to the console AND surfaced to the user via the session.warning field.
 */
function buildDiagnosticMessage(err: unknown): string {
  const errObj = err instanceof Error ? err : new Error(String(err));
  const errStr = errObj.message || String(errObj);
  const platform = `${process.platform}-${process.arch}`;
  const nodeVersion = process.versions.node;
  const electronVersion = process.versions.electron ?? 'unknown';
  // process.versions.modules is the NODE_MODULE_VERSION (ABI) number
  const abi = process.versions.modules ?? 'unknown';

  const { dirs: binaryDirs, files: binaryFiles } = findNodePtyBinaryPaths();
  const binaryFound = binaryFiles.length > 0;
  const dirsExist = binaryDirs.length > 0;

  // Classify the error
  let category: string;
  let hint: string;

  if (errStr.includes('GLIBC_') || errStr.includes('GLIBCXX_') || errStr.includes('CXXABI_')) {
    category = 'Native binary requires a newer Linux system runtime';
    hint = 'The packaged node-pty binary was built against a newer glibc or libstdc++ than this system provides. ' +
      'Rebuild the Linux package with `npm run package:linux`; its pinned Rocky Linux 8 build rejects pty.node ' +
      'artifacts that are incompatible with CentOS 8.';
  } else if (errStr.includes('Module did not self-register') || errStr.includes('NODE_MODULE_VERSION')) {
    category = 'ABI mismatch (native module compiled for a different Node/Electron version)';
    hint = 'The node-pty binary was compiled against a different ABI than the current Electron runtime. ' +
      'Run `npx @electron/rebuild -f -w node-pty` to recompile for Electron.';
  } else if (errStr.includes('Cannot find module') || errStr.includes('MODULE_NOT_FOUND')) {
    if (binaryFound) {
      category = 'Native binary exists but node-pty obscured the loader error';
      hint = 'The binary is present, so installing libutil without an `ldd` error is not justified. ' +
        'Repackage after running `npm run patch:native`; patch v2 preserves the actual native loader error.';
    } else if (dirsExist && process.platform === 'linux') {
      // Directory exists but pty.node is missing — typical for Linux where node-pty
      // doesn't ship prebuilds. This is the most common packaging issue.
      category = 'Native binary not found for this platform (node-pty has no Linux prebuilds)';
      hint = 'node-pty 1.1.0 does not ship Linux prebuilds. The build/Release or prebuilds/linux-x64/ ' +
        'directory exists but pty.node is missing.\n' +
        'To fix: run `npm run build:linux-pty` before packaging, which compiles node-pty for Linux ' +
        'using Docker (or directly on Linux).\n' +
        'Alternatively, build the AppImage on a Linux machine with build-essential installed.';
    } else {
      category = 'Native binary not found (node-pty was not installed/rebuilt for this platform)';
      hint = 'node-pty was not found in node_modules. Run `npm install` and `npx @electron/rebuild -f -w node-pty`. ' +
        'If packaging for Linux, run `npm run build:linux-pty` to compile the Linux binary.';
    }
  } else if (errStr.includes('libutil.so') || errStr.includes('libuv.so') || errStr.includes('cannot open shared object file')) {
    category = 'Missing shared library on this system';
    hint = 'A system shared library required by node-pty is missing. ' +
      'Run `ldd` on the packaged pty.node to identify the exact missing library, then install its CentOS/RHEL package.';
  } else {
    category = 'Unknown error';
    hint = 'See the full error message above for details. ' +
      'Try `npx @electron/rebuild -f -w node-pty` to recompile the native module.';
  }

  const lines = [
    `[terminal] ── node-pty load failure ──`,
    `  Platform:      ${platform}`,
    `  Electron:      ${electronVersion}`,
    `  Node ABI:      ${abi} (Node ${nodeVersion})`,
    `  Binary found:  ${binaryFound ? `yes (${binaryFiles.join(', ')})` : dirsExist ? `no (dirs exist but pty.node missing: ${binaryDirs.join(', ')})` : 'no'}`,
    `  Error:        ${errStr}`,
    `  Category:     ${category}`,
    `  Hint:         ${hint}`,
    `[terminal] Falling back to child_process.spawn (limited functionality: no PTY, no resize, non-interactive shell).`,
  ];

  return lines.join('\n');
}

/**
 * Dynamically load node-pty. Falls back to null if not available
 * (e.g., native module not compiled for current platform).
 *
 * On failure, captures the full error and logs a detailed diagnostic
 * message to help debug why node-pty is unavailable.
 */
/**
 * Dynamically load node-pty using CJS require().
 *
 * The main process source is ESM but compiled to CJS by electron-vite. Using
 * ESM dynamic import() for a native CJS module like node-pty can fail in
 * Electron's CJS context (the native .node binary is not properly
 * initialized). Using createRequire(import.meta.url) gives us a real CJS
 * require() that correctly loads native modules.
 */
async function loadNodePty(): Promise<PtyLoadResult> {
  if (ptyLoadAttempted) return ptyLoadResult;
  ptyLoadAttempted = true;
  try {
    // createRequire gives us a CJS require that works in the ESM source
    // and is correctly transpiled by electron-vite to CJS output.
    const require = createRequire(import.meta.url);
    nodePtyModule = require('node-pty') as typeof NodePty;
    ptyLoadResult = { module: nodePtyModule, error: null };
    console.log('[terminal] node-pty loaded successfully — using real PTY backend.');
    return ptyLoadResult;
  } catch (err) {
    const diagnostic = buildDiagnosticMessage(err);
    console.warn(diagnostic);
    ptyLoadResult = { module: null, error: err instanceof Error ? err : new Error(String(err)) };
    return ptyLoadResult;
  }
}

let nodePtyModule: typeof NodePty | null = null;

// ── Data batching constants ─────────────────────────────────
/**
 * Max batch size in bytes before flushing (64KB).
 * Prevents unbounded buffer growth during massive output bursts.
 */
const BATCH_MAX_BYTES = 64 * 1024;
/**
 * Flush interval in ms (~60fps). Batches high-frequency PTY data
 * into fewer IPC messages to avoid overwhelming the renderer.
 */
const BATCH_FLUSH_MS = 16;
/**
 * Max number of output buffer chunks retained for session restore.
 */
const OUTPUT_BUFFER_MAX = 5000;
/**
 * Grace period between the initial SIGTERM and the SIGKILL escalation when
 * destroying a log-mode process group (mirrors the Python reference GUI's
 * `terminate()` → `kill()` fallback).
 */
const LOG_MODE_KILL_GRACE_MS = 1500;

interface SessionEntry {
  pty: NodePty.IPty | ChildProcess | null;
  session: TerminalSession;
  outputBuffer: string[];
  /** Pending data chunks waiting to be flushed via IPC */
  pendingChunks: string[];
  /** Combined size of pending chunks (bytes) */
  pendingSize: number;
  /** Flush timer handle */
  flushTimer: NodeJS.Timeout | null;
  /** Exit code from the 'exit' event (null until exit fires). */
  exitCode: number | null;
  /** Whether the child process 'exit' event has fired. */
  exited: boolean;
  /**
   * Whether the child was spawned `detached` (own process group on POSIX).
   * Log-mode sessions spawn detached so abort/destroy can signal the whole
   * simulation process tree (`runsim` → `xrun`/`irun`), not just the shell.
   */
  detached: boolean;
}

interface CompletedSession {
  session: TerminalSession;
  outputBuffer: string[];
}

/**
 * Manages PTY sessions for terminal integration.
 *
 * Uses node-pty when available for a real PTY experience.
 * Falls back to child_process.spawn when node-pty is not compiled.
 *
 * Performance: data events are batched (every 16ms or 64KB) to reduce
 * IPC message count during high-volume simulation output (百万行日志).
 */
export class TerminalManager extends EventEmitter {
  private sessions = new Map<string, SessionEntry>();
  /** Completed sessions remain readable so remounted terminal tabs can restore their output. */
  private completedSessions = new Map<string, CompletedSession>();
  private idCounter = 0;

  private retainCompletedSession(id: string, entry: SessionEntry): void {
    entry.pty = null;
    this.completedSessions.set(id, {
      session: entry.session,
      outputBuffer: entry.outputBuffer,
    });
    this.sessions.delete(id);
  }

  private completeSession(id: string, exitCode: number): void {
    this.flushPending(id);
    const completed = this.sessions.get(id);
    if (completed) this.retainCompletedSession(id, completed);
    this.emit('exit', { id, exitCode });
  }

  /**
   * Create a new terminal session.
   */
  async create(opts: TerminalCreateOptions = {}): Promise<TerminalSession> {
    const id = `term_${++this.idCounter}_${Date.now()}`;
    // Validate cwd — prevent spawn ENOENT from non-existent working directory
    const cwdResult = validateCwd(opts.cwd ?? process.cwd());
    const cwd = cwdResult.effective;
    const cols = opts.cols ?? 80;
    const rows = opts.rows ?? 24;
    // Let the PTY shell initialize itself exactly once. Pre-capturing a login
    // shell with getLoginShellEnv() and passing that result into another csh
    // would carry LOADEDMODULES/MODULEPATH into the second .cshrc, causing
    // module conflicts and falling back to system tools such as /bin/python.
    // Project values are supplied by opts.env; shell startup owns PATH setup.
    const isEnhanced = opts.enhanced === true;
    // Enhanced mode: prefer zsh → bash (NOT csh); build ZDOTDIR + STARSHIP_CONFIG env.
    // Non-enhanced mode: use caller-specified shell or default shell discovery.
    const shell = opts.shell ?? (isEnhanced ? findEnhancedShell() : findShell());
    const env = isEnhanced
      ? buildEnhancedEnv(process.env as Record<string, string>, opts.env)
      : mergeTerminalEnvs(process.env as Record<string, string>, opts.env);
    // Enhanced mode: use enhanced shell args (zsh -l -i / PowerShell -File osc133.ps1).
    // Non-enhanced mode: use standard interactive shell args.
    const shellArgs = isEnhanced
      ? getEnhancedShellArgs(shell)
      : getInteractiveShellArgs(shell);

    const session: TerminalSession = {
      id,
      pid: 0,
      cwd,
      cols,
      rows,
      createdAt: Date.now(),
      backend: 'node-pty',
      warning: null,
    };

    const outputBuffer: string[] = [];
    const entry: SessionEntry = {
      pty: null,
      session,
      outputBuffer,
      pendingChunks: [],
      pendingSize: 0,
      flushTimer: null,
      exitCode: null,
      exited: false,
      detached: false,
    };

    const ptyResult = await loadNodePty();
    const ptyModule = ptyResult.module;

    // Helper: enqueue data for batched flush
    const enqueueData = (data: string): void => {
      // Store in output buffer for session restore
      outputBuffer.push(data);
      if (outputBuffer.length > OUTPUT_BUFFER_MAX) outputBuffer.shift();

      // Enqueue for batched IPC flush
      entry.pendingChunks.push(data);
      entry.pendingSize += data.length;

      // Flush immediately if batch exceeds size limit
      if (entry.pendingSize >= BATCH_MAX_BYTES) {
        this.flushPending(id);
      } else if (entry.flushTimer === null) {
        // Schedule a flush on next tick
        entry.flushTimer = setTimeout(() => {
          this.flushPending(id);
        }, BATCH_FLUSH_MS);
        entry.flushTimer.unref();
      }
    };

    // Try to spawn a real PTY; if spawn fails (e.g. "Cannot launch conpty"
    // on Windows when no console is attached), fall through to the
    // child_process fallback so the terminal still works in degraded mode.
    let pty: NodePty.IPty | null = null;
    let spawnError: Error | null = null;
    if (ptyModule) {
      try {
        pty = ptyModule.spawn(shell, shellArgs, {
          name: 'xterm-color',
          cols,
          rows,
          cwd,
          env,
        });
      } catch (err) {
        pty = null;
        spawnError = err instanceof Error ? err : new Error(String(err));
      }
    }

    if (pty) {
      // Use real node-pty
      session.pid = pty.pid;
      entry.pty = pty;

      pty.onData((data: string) => {
        enqueueData(data);
      });

      pty.onExit(({ exitCode }: { exitCode: number }) => {
        this.completeSession(id, exitCode);
      });

      this.sessions.set(id, entry);
    } else {
      // Fallback: use child_process.spawn (no real PTY)
      //
      // This is a degraded mode: the shell runs non-interactively (no
      // $TERM, no ANSI capabilities, no resize support). Many CLI tools
      // (vim, top, htop, interactive menus) will not work correctly.
      let child: ChildProcess;
      try {
        child = spawn(shell, shellArgs, {
          cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (spawnErr) {
        // spawn() can throw synchronously in rare cases
        const errMsg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
        session.backend = 'fallback';
        session.pid = 0;
        session.warning = `Failed to spawn shell '${shell}': ${errMsg}`;
        const errBanner = `\r\n\x1b[31m[terminal] Failed to spawn shell '${shell}': ${errMsg}\x1b[0m\r\n`;
        outputBuffer.push(errBanner);
        entry.pendingChunks.push(errBanner);
        entry.pendingSize += errBanner.length;
        entry.pty = null;
        this.sessions.set(id, entry);
        this.flushPending(id);
        return session;
      }

      // Mark session as fallback and attach a user-facing warning
      session.backend = 'fallback';
      const errDetail = spawnError?.message ?? ptyResult.error?.message ?? 'unknown error';
      session.warning =
        `Terminal is running in limited mode (child_process fallback). ` +
        `node-pty could not be loaded: ${errDetail}. ` +
        `Interactive features (resize, colors, TUI apps) may not work. ` +
        `See the main process console for full diagnostics.`;

      session.pid = child.pid ?? 0;
      entry.pty = child;

      // Write a visible warning banner to the terminal so the user sees it
      const banner =
        `\r\n\x1b[33m┌───────────────────────────────────────────────────────────┐\r\n` +
        `│  ⚠  Terminal running in limited mode (fallback)            │\r\n` +
        `│  node-pty could not be loaded.                              │\r\n` +
        `│  Interactive features (resize, TUI apps) may not work.      │\r\n` +
        `│  Reason: ${errDetail.slice(0, 45).padEnd(45)}│\r\n` +
        `└───────────────────────────────────────────────────────────┘\x1b[0m\r\n\r\n`;
      outputBuffer.push(banner);
      entry.pendingChunks.push(banner);
      entry.pendingSize += banner.length;

      child.stdout?.on('data', (data: Buffer) => {
        enqueueData(data.toString());
      });

      child.stderr?.on('data', (data: Buffer) => {
        enqueueData(data.toString());
      });

      child.on('error', (err: Error) => {
        // spawn() can emit 'error' if the shell binary doesn't exist
        const errMsg = `\r\n\x1b[31m[terminal] Failed to spawn shell '${shell}': ${err.message}\x1b[0m\r\n`;
        enqueueData(errMsg);
        // Also emit an exit event so the simTerminalLinker can handle it
        entry.exited = true;
        entry.exitCode = 1;
        this.completeSession(id, 1);
      });

      child.on('exit', (exitCode: number | null) => {
        // Skip if already handled by 'error' event (spawn failure case)
        if (!this.sessions.has(id)) return;
        // Record exit code but DON'T complete the session yet — wait for
        // the 'close' event to ensure all buffered stdout/stderr data is
        // captured. In Node.js, 'exit' fires when the process terminates,
        // but stdio streams may still have pending data. 'close' fires
        // after all streams are fully closed.
        entry.exited = true;
        entry.exitCode = exitCode ?? 1;
      });

      // 'close' is emitted after all stdio streams are closed, ensuring
      // no data is lost. This is the reliable point to complete the session.
      child.on('close', () => {
        if (!this.sessions.has(id)) return;
        const effectiveExitCode = entry.exitCode ?? 1;
        this.completeSession(id, effectiveExitCode);
      });

      this.sessions.set(id, entry);

      // Flush the warning banner immediately so the user sees it right away
      this.flushPending(id);
    }

    return session;
  }

  /**
   * Flush pending data chunks for a terminal session.
   * Combines all pending chunks into a single 'data' event.
   */
  private flushPending(id: string): void {
    const entry = this.sessions.get(id);
    if (!entry || entry.pendingChunks.length === 0) return;

    // Cancel pending timer
    if (entry.flushTimer !== null) {
      clearTimeout(entry.flushTimer);
      entry.flushTimer = null;
    }

    // Combine chunks and emit
    const combined = entry.pendingChunks.join('');
    entry.pendingChunks = [];
    entry.pendingSize = 0;

    if (combined.length > 0) {
      this.emit('data', { id, data: combined });
    }
  }

  /**
   * Write data to a terminal's input.
   */
  write(id: string, data: string): void {
    const entry = this.sessions.get(id);
    if (!entry || !entry.pty) return;

    // node-pty IPty has a write method
    if (typeof (entry.pty as NodePty.IPty).write === 'function') {
      (entry.pty as NodePty.IPty).write(data);
    } else {
      // child_process fallback
      const child = entry.pty as ChildProcess;
      child.stdin?.write(data);
    }
  }

  /**
   * Resize a terminal.
   */
  resize(id: string, cols: number, rows: number): void {
    const entry = this.sessions.get(id);
    if (!entry) return;

    entry.session.cols = cols;
    entry.session.rows = rows;

    if (entry.pty && 'resize' in entry.pty) {
      // node-pty
      (entry.pty as NodePty.IPty).resize(cols, rows);
    }
    // child_process doesn't support resize
  }

  /**
   * Terminate a log-mode child process together with its whole process tree.
   *
   * Log-mode children are spawned `detached` (own process group on POSIX), so
   * the `runsim` → `xrun`/`irun` descendants can be signaled as a group —
   * mirroring the Python reference GUI, which sends SIGTERM first and
   * escalates to SIGKILL when the process is still running afterwards.
   */
  private killChildProcessTree(child: ChildProcess, entry: SessionEntry): void {
    if (!entry.detached || process.platform === 'win32' || !child.pid) {
      child.kill();
      return;
    }

    const pid = child.pid;
    // Graceful: SIGTERM the whole process group (like Python's terminate()).
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      // Process group already gone.
    }
    child.kill('SIGTERM');

    // Escalate: SIGKILL the group if it is still alive after the grace period.
    const timer = setTimeout(() => {
      try {
        process.kill(-pid, 0); // Throws ESRCH when the group no longer exists.
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // Already gone between the liveness check and the kill.
        }
      } catch {
        // Group already gone — nothing to escalate.
      }
    }, LOG_MODE_KILL_GRACE_MS);
    timer.unref();
  }

  /**
   * Destroy a terminal session.
   */
  destroy(id: string): void {
    const entry = this.sessions.get(id);
    if (!entry) {
      if (this.completedSessions.delete(id)) this.emit('destroyed', { id });
      return;
    }

    // Flush any remaining data
    this.flushPending(id);

    if (entry.pty) {
      if (entry.pty instanceof ChildProcess) {
        // child_process session (log-mode or fallback): kill the process tree
        // when the child owns a process group, otherwise just the shell.
        this.killChildProcessTree(entry.pty, entry);
      } else {
        // node-pty IPty
        (entry.pty as NodePty.IPty).kill();
      }
    }

    this.sessions.delete(id);
    this.completedSessions.delete(id);
    this.emit('destroyed', { id });
  }

  /**
   * List all active terminal sessions.
   */
  list(): TerminalSession[] {
    return Array.from(this.sessions.values()).map((e) => e.session);
  }

  /**
   * Get a specific terminal session.
   */
  get(id: string): TerminalSession | undefined {
    return this.sessions.get(id)?.session ?? this.completedSessions.get(id)?.session;
  }

  /**
   * Get buffered output for a terminal (for session restore).
   */
  getOutputBuffer(id: string): string[] {
    return this.sessions.get(id)?.outputBuffer ?? this.completedSessions.get(id)?.outputBuffer ?? [];
  }

  /**
   * Get the full output content as a single string.
   *
   * Used by simTerminalLinker to scan for simulation pass/fail markers
   * after a log-mode session exits.
   */
  getOutputContent(id: string): string {
    return this.getOutputBuffer(id).join('');
  }

  /**
   * Get the exit code of a completed or exiting session.
   *
   * Returns null if the session hasn't exited yet or doesn't exist.
   */
  getExitCode(id: string): number | null {
    const active = this.sessions.get(id);
    if (active) return active.exitCode;
    return null;
  }

  /**
   * Destroy all terminal sessions.
   */
  destroyAll(): void {
    for (const id of Array.from(this.sessions.keys())) {
      this.destroy(id);
    }
    for (const id of Array.from(this.completedSessions.keys())) {
      this.destroy(id);
    }
  }

  /**
   * Get the current PTY backend status (for diagnostics / UI indicators).
   * Returns info about whether node-pty loaded successfully and if not, why.
   */
  getBackendStatus(): { backend: TerminalBackend; error: string | null } {
    if (ptyLoadResult.module) {
      return { backend: 'node-pty', error: null };
    }
    return {
      backend: 'fallback',
      error: ptyLoadResult.error?.message ?? 'node-pty not available (load not attempted yet)',
    };
  }

  /**
   * Check whether node-pty is available (i.e., the real PTY backend loaded).
   *
   * When this returns `false`, callers should use {@link runCommand} instead
   * of {@link create} + {@link write} to avoid spawning an interactive shell
   * that may fail with ENOENT.
   */
  isPtyAvailable(): boolean {
    return ptyLoadResult.module !== null;
  }

  /** Load node-pty before a caller makes a backend decision. */
  async ensurePtyAvailable(): Promise<boolean> {
    const result = await loadNodePty();
    return result.module !== null;
  }

  /**
   * Run a shell command in log-mode (no interactive PTY).
   *
   * This is the fallback path when node-pty is unavailable (e.g., AppImage
   * without rebuilt native modules). Instead of spawning an interactive
   * shell and writing commands to its stdin, this method spawns the command
   * directly via `shell -c "command"` and streams stdout/stderr to the
   * renderer via the same `data` / `exit` events used by PTY sessions.
   *
   * The renderer's xterm.js instance can display the output as-is — it's
   * just text, no interactive input is expected.
   *
   * This mirrors the approach of `log_panel.py` (PyQt reference): the
   * process runs in the background and the UI shows a read-only log view.
   */
  async runCommand(opts: TerminalRunCommandOptions): Promise<TerminalSession> {
    const id = `term_${++this.idCounter}_${Date.now()}`;
    // Validate cwd — prevent spawn ENOENT from non-existent working directory
    const cwdResult = validateCwd(opts.cwd ?? process.cwd());
    const cwd = cwdResult.effective;
    // Do not pre-capture and reuse a login shell environment here. For csh,
    // that would initialize modules once during capture and again when this
    // command shell sources .cshrc. Let the login shell initialize once.
    const shell = opts.shell ?? findSimShell();
    // Strip inherited Environment Modules state (LOADEDMODULES, _ModuleTable*,
    // ...) before spawning `csh -c`. A polluted parent env breaks .cshrc module
    // init (conflict warnings + csh eval errors), which leaves the child PATH
    // without python3 — runsim then executes under system python2 and dies
    // with `TypeError: 'encoding' is an invalid keyword argument`.
    const env = sanitizeModuleEnvForChild(
      mergeTerminalEnvs(process.env as Record<string, string>, opts.env),
    );

    const session: TerminalSession = {
      id,
      pid: 0,
      cwd,
      cols: 80,
      rows: 24,
      createdAt: Date.now(),
      backend: 'log-mode',
      warning: opts.warning ?? 'Running in log mode (node-pty unavailable). Output is read-only.',
    };

    const outputBuffer: string[] = [];
    // Log-mode children run `shell -l -c "runsim ..."`; runsim/xrun/irun are
    // descendants of that shell. Spawning detached (POSIX) puts the shell and
    // all its descendants into their own process group so destroy()/abort can
    // signal the whole tree — the same mechanism the Python reference GUI
    // relies on (os.killpg with SIGTERM → SIGKILL escalation).
    const detached = process.platform !== 'win32';
    const entry: SessionEntry = {
      pty: null,
      session,
      outputBuffer,
      pendingChunks: [],
      pendingSize: 0,
      flushTimer: null,
      exitCode: null,
      exited: false,
      detached,
    };

    // Helper: enqueue data for batched flush (same as create())
    const enqueueData = (data: string): void => {
      outputBuffer.push(data);
      if (outputBuffer.length > OUTPUT_BUFFER_MAX) outputBuffer.shift();
      entry.pendingChunks.push(data);
      entry.pendingSize += data.length;
      if (entry.pendingSize >= BATCH_MAX_BYTES) {
        this.flushPending(id);
      } else if (entry.flushTimer === null) {
        entry.flushTimer = setTimeout(() => {
          this.flushPending(id);
        }, BATCH_FLUSH_MS);
        entry.flushTimer.unref();
      }
    };

    // Log-mode output arrives via pipes (no PTY line discipline), so bare `\n`
    // must be rewritten to `\r\n` for xterm.js to left-align each line.
    const normalizeChunk = createLogModeChunkNormalizer();

    // Write a banner so the user knows they're in log mode
    const banner =
      `\r\n\x1b[33m┌───────────────────────────────────────────────────────────┐\r\n` +
      `│  ⚠  Log mode (node-pty unavailable)                        │\r\n` +
      `│  Simulation output is read-only.                            │\r\n` +
      `│  Interactive terminal features are disabled.                │\r\n` +
      `└───────────────────────────────────────────────────────────┘\x1b[0m\r\n\r\n`;
    outputBuffer.push(banner);
    entry.pendingChunks.push(banner);
    entry.pendingSize += banner.length;

    // Echo the command so the user can see what is being executed.
    // In PTY mode the shell echoes typed commands; in log mode the command
    // is passed directly to spawn() so we must echo it ourselves.
    const cmdEcho = `\x1b[36m$ ${opts.command}\x1b[0m\r\n`;
    outputBuffer.push(cmdEcho);
    entry.pendingChunks.push(cmdEcho);
    entry.pendingSize += cmdEcho.length;

    // Use caller-specified shell, or find one suitable for simulation (csh on Linux)
    // On Windows, use `powershell -NoProfile -Command "..."`; on Unix the args
    // depend on the shell family (see getLogModeShellArgs): csh/tcsh reject
    // `csh -l -c` with `Unknown option -l`, so they run plain `csh -c` — the
    // same invocation the Python reference GUI uses for log-mode runs.
    const shellArgs = getLogModeShellArgs(shell, opts.command);

    let child: ChildProcess;
    try {
      child = spawn(shell, shellArgs, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // POSIX only: put the shell in its own process group so abort/destroy
        // can kill the entire simulation tree. On Windows, detached would
        // fully detach the child from the parent lifecycle, so it is skipped.
        detached,
      });
    } catch (spawnErr) {
      const errMsg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
      const errBanner = `\r\n\x1b[31m[terminal] Failed to spawn shell '${shell}' for command: ${errMsg}\x1b[0m\r\n`;
      enqueueData(errBanner);
      session.warning = `Failed to spawn shell: ${errMsg}`;
      entry.pty = null;
      this.sessions.set(id, entry);
      // Emit a synthetic exit so simTerminalLinker can handle it
      this.completeSession(id, 1);
      return session;
    }

    session.pid = child.pid ?? 0;
    entry.pty = child;

    // Stream stdout and stderr to the renderer. Both pipes share one
    // normalizer so UTF-8 decoding and `\r\n` boundary tracking stay
    // consistent across interleaved chunks.
    child.stdout?.on('data', (data: Buffer) => {
      enqueueData(normalizeChunk(data));
    });

    child.stderr?.on('data', (data: Buffer) => {
      enqueueData(normalizeChunk(data));
    });

    child.on('error', (err: Error) => {
      const errMsg = `\r\n\x1b[31m[terminal] Process error: ${err.message}\x1b[0m\r\n`;
      enqueueData(errMsg);
      entry.exited = true;
      entry.exitCode = 1;
      this.completeSession(id, 1);
    });

    child.on('exit', (exitCode: number | null) => {
      // Skip if already handled by 'error' event (spawn failure case).
      if (!this.sessions.has(id)) return;
      // Record exit code but wait for 'close' to ensure all data is captured.
      entry.exited = true;
      entry.exitCode = exitCode ?? 1;
    });

    // 'close' fires after all stdio streams are closed — this is the
    // reliable point to complete the session and emit the exit event.
    child.on('close', () => {
      if (!this.sessions.has(id)) return;
      const effectiveExitCode = entry.exitCode ?? 1;
      this.completeSession(id, effectiveExitCode);
    });

    this.sessions.set(id, entry);

    // Flush the banner immediately
    this.flushPending(id);

    return session;
  }

  /**
   * Launch a command in the system's external terminal emulator.
   *
   * This is a last-resort fallback when neither node-pty nor log-mode work
   * (e.g., on a locked-down Linux system where the AppImage environment
   * prevents spawning shells inside the app).
   *
   * Limitations:
   *   - Output is NOT streamed back to the app (the terminal runs externally)
   *   - Pass/fail detection relies on the user manually checking the terminal
   *   - The session appears as 'completed' immediately in the app UI
   *
   * @returns true if the external terminal was launched, false if none found
   */
  async runInExternalTerminal(opts: TerminalRunCommandOptions): Promise<boolean> {
    const extTerm = findExternalTerminal();
    if (!extTerm) {
      console.warn('[terminal] No external terminal emulator found (tried: gnome-terminal, konsole, xterm, xfce4-terminal, mate-terminal)');
      return false;
    }

    // Validate cwd
    const cwdResult = validateCwd(opts.cwd ?? process.cwd());
    const cwd = cwdResult.effective;
    // The external terminal performs its own login initialization. Passing a
    // pre-captured csh environment here would repeat module setup as well.
    const env = mergeTerminalEnvs(process.env as Record<string, string>, opts.env);

    // Build the full command: cd to cwd && run the command && keep terminal open
    // The `; exec bash` keeps the terminal open after the command finishes
    // so the user can read the output.
    const fullCommand = `cd '${cwd}' && ${opts.command}; echo ''; echo '[Process finished with exit code $?]'; exec bash`;

    try {
      const child = spawn(extTerm.cmd, [...extTerm.args, fullCommand], {
        cwd,
        env,
        stdio: 'ignore',
        detached: true,
      });
      child.unref();
      console.log(`[terminal] Launched external terminal: ${extTerm.cmd} (pid=${child.pid})`);
      return true;
    } catch (err) {
      console.error(`[terminal] Failed to launch external terminal '${extTerm.cmd}': ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Check if an external terminal emulator is available on this system.
   */
  hasExternalTerminal(): boolean {
    return findExternalTerminal() !== null;
  }
}

/**
 * Singleton terminal manager instance.
 */
export const terminalManager = new TerminalManager();
