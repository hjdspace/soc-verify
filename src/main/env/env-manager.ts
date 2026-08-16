import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EdaToolInfo, EnvConfig, SystemEnvVars } from '@shared/types';
import { KNOWN_ENV_VAR_NAMES, getEnvVarCatalog as sharedGetEnvVarCatalog } from '@shared/env-catalog';
import { getLoginShellEnv, refreshLoginShellEnv, findInPathAsync } from './login-shell-env';

const SOCVERIFY_DIR = '.socverify';
const ENV_CONFIG_FILE = 'env.json';

const execFileAsync = promisify(execFile);

/** EDA tool definitions: command name → display name + version flag */
const EDA_TOOLS: Array<{ command: string; name: string; versionArgs: string[] }> = [
  { command: 'vcs', name: 'VCS (Synopsys)', versionArgs: ['-ID'] },
  { command: 'xrun', name: 'Xcelium (Cadence)', versionArgs: ['-version'] },
  { command: 'verilator', name: 'Verilator', versionArgs: ['--version'] },
  { command: 'irun', name: 'irun (Cadence)', versionArgs: ['-version'] },
  { command: 'vlog', name: 'ModelSim/QuestaSim', versionArgs: ['-version'] },
  { command: 'dsim', name: 'DSim (Metrics)', versionArgs: ['-version'] },
  { command: 'xsc', name: 'XSC (Cadence)', versionArgs: ['-version'] },
  { command: 'vcsmx', name: 'VCS MX (Synopsys)', versionArgs: ['-ID'] },
];

/**
 * Detect EDA tools available on the system PATH.
 *
 * Uses the login shell's environment (which includes `.bashrc`/`.profile`/
 * `module init` PATH extensions) rather than the minimal desktop-launch
 * environment.  This ensures EDA tools installed in non-standard directories
 * (e.g. `/tools/synopsys/.../bin`) are detected even when the app is launched
 * from the desktop (AppImage).
 *
 * On Windows, `where` is used; on Linux/macOS, `which` is used.
 *
 * @param refresh - Force a fresh capture of the login shell environment
 *                  before detection (default: `false`, uses cache).
 * @returns a list of all known tools with their detection status.
 */
export async function detectEdaTools(refresh = false): Promise<EdaToolInfo[]> {
  if (refresh) refreshLoginShellEnv();

  const mergedEnv = await getLoginShellEnv();
  const results: EdaToolInfo[] = [];

  for (const tool of EDA_TOOLS) {
    try {
      // Find the tool using the login shell's PATH
      const paths = await findInPathAsync(tool.command, mergedEnv);
      const path = paths[0]?.trim();
      if (path) {
        let version: string | undefined;
        try {
          // Execute the resolved absolute path with the merged env
          // so that VCS_HOME / LD_LIBRARY_PATH etc. are available.
          const { stdout: verOut } = await execFileAsync(path, tool.versionArgs, {
            timeout: 10000,
            env: mergedEnv,
          });
          // Extract version from first few lines
          version = verOut.split('\n').slice(0, 3).join(' ').trim();
          if (version.length > 200) version = version.slice(0, 200);
        } catch {
          // Version detection failed, still report as detected
        }
        results.push({ name: tool.name, version, path, detected: true });
      } else {
        results.push({ name: tool.name, path: '', detected: false });
      }
    } catch {
      results.push({ name: tool.name, path: '', detected: false });
    }
  }

  return results;
}

/**
 * Load env config from .socverify/env.json for a project.
 */
export async function loadEnvConfig(projectRoot: string): Promise<EnvConfig | null> {
  const configPath = join(projectRoot, SOCVERIFY_DIR, ENV_CONFIG_FILE);
  try {
    const data = await readFile(configPath, 'utf-8');
    return JSON.parse(data) as EnvConfig;
  } catch {
    return null;
  }
}

/**
 * Save env config to .socverify/env.json for a project.
 */
export async function saveEnvConfig(projectRoot: string, config: EnvConfig): Promise<void> {
  const configDir = join(projectRoot, SOCVERIFY_DIR);
  await mkdir(configDir, { recursive: true });
  const configPath = join(configDir, ENV_CONFIG_FILE);
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Get the list of known EDA env var names.
 */
export function getKnownEnvVarNames(): string[] {
  return [...KNOWN_ENV_VAR_NAMES];
}

/**
 * Get the env var catalog grouped by category, in display order.
 * Delegates to the shared catalog module.
 */
export function getEnvVarCatalog() {
  return sharedGetEnvVarCatalog();
}

/**
 * Detect current system (terminal) environment variables for all known env var names.
 *
 * Uses the login shell environment (which includes `.bashrc`/`.profile`/
 * `module init` variables) rather than the minimal desktop-launch environment.
 * This ensures `VCS_HOME`, `LM_LICENSE_FILE` etc. are detected even when the
 * app is launched from the desktop (AppImage).
 *
 * @param refresh - Force a fresh capture of the login shell environment.
 */
export async function detectSystemEnvVars(refresh = false): Promise<SystemEnvVars> {
  if (refresh) refreshLoginShellEnv();

  const env = await getLoginShellEnv();
  const result: SystemEnvVars = {};
  for (const name of KNOWN_ENV_VAR_NAMES) {
    const value = env[name];
    if (value !== undefined && value !== '') {
      result[name] = value;
    }
  }
  return result;
}

/**
 * Merge system-detected env vars into an existing envVars map.
 *
 * For each known env var that exists in the system environment but is not
 * yet set in `current`, the system value is filled in.  Existing user-set
 * values are never overwritten.
 *
 * @param refresh - Force a fresh capture of the login shell environment.
 */
export async function mergeSystemEnvVars(
  current: Record<string, string>,
  refresh = false,
): Promise<Record<string, string>> {
  const system = await detectSystemEnvVars(refresh);
  const merged: Record<string, string> = { ...current };
  for (const [name, value] of Object.entries(system)) {
    if (merged[name] === undefined || merged[name] === '') {
      merged[name] = value;
    }
  }
  return merged;
}

/**
 * Build an env var map from an EnvConfig, merging tool paths into PATH.
 */
export function buildEnvFromConfig(config: EnvConfig): Record<string, string> {
  const env: Record<string, string> = { ...config.envVars };

  // Add detected tool directories to PATH
  const toolDirs: string[] = [];
  for (const tool of config.tools) {
    if (tool.detected && tool.path) {
      const dir = tool.path.replace(/[/\\][^/\\]+$/, '');
      if (dir && !toolDirs.includes(dir)) {
        toolDirs.push(dir);
      }
    }
  }

  if (toolDirs.length > 0) {
    const existingPath = env.PATH || process.env.PATH || '';
    env.PATH = [...toolDirs, existingPath].join(process.platform === 'win32' ? ';' : ':');
  }

  return env;
}
