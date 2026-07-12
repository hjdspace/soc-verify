import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EdaToolInfo, EnvConfig } from '@shared/types';

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

/** Default env vars that EDA tools commonly need */
const KNOWN_ENV_VARS = [
  'LICENSE_FILE',
  'LM_LICENSE_FILE',
  'SNPSLMD_LICENSE_FILE',
  'CDS_LIC_FILE',
  'MGLS_LICENSE_FILE',
];

/**
 * Detect EDA tools available on the system PATH.
 * Returns a list of all known tools with their detection status.
 */
export async function detectEdaTools(): Promise<EdaToolInfo[]> {
  const results: EdaToolInfo[] = [];

  for (const tool of EDA_TOOLS) {
    try {
      const { stdout } = await execFileAsync('where', [tool.command], {
        timeout: 5000,
        shell: true,
      });
      const path = stdout.trim().split('\n')[0].trim();
      if (path) {
        let version: string | undefined;
        try {
          const { stdout: verOut } = await execFileAsync(tool.command, tool.versionArgs, {
            timeout: 10000,
            shell: true,
          });
          // Extract version from first few lines
          version = verOut.split('\n').slice(0, 3).join(' ').trim();
          if (version.length > 200) version = version.slice(0, 200);
        } catch {
          // Version detection failed, still report as detected
        }
        results.push({ name: tool.name, version, path, detected: true });
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
  return [...KNOWN_ENV_VARS];
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
