/**
 * Config persistence for sysbase-gen — save/load wizard configs.
 *
 * Saves wizard configuration to `<projectDir>/.socverify/sysbase-gen/<subsys>.json`
 * and the script path to `<projectDir>/.socverify/sysbase-gen/config.json`.
 *
 * All functions are pure filesystem operations — no side effects beyond disk I/O.
 */

import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SysbaseGenConfig } from '../../../shared/types/sysbase-gen';
import { DEFAULT_SYSBASE_SCRIPT } from '../../../shared/types/sysbase-gen';

const SOCVERIFY_DIR = '.socverify';
const SYSGEN_DIR = 'sysbase-gen';
const SCRIPT_CONFIG_FILE = 'config.json';

/**
 * Resolve the sysbase-gen config directory for a project.
 *
 * @param projectDir Project root directory
 * @returns Path to `<projectDir>/.socverify/sysbase-gen/`
 */
export function resolveSysgenDir(projectDir: string): string {
  return join(projectDir, SOCVERIFY_DIR, SYSGEN_DIR);
}

/**
 * Save wizard config to `<subsys>.json` and script path to `config.json`.
 *
 * @param config     Wizard configuration (must have non-empty `subsys`)
 * @param scriptPath Path to sysbase_gen.py
 * @param projectDir Project root directory
 */
export async function saveSysgenConfig(
  config: SysbaseGenConfig,
  scriptPath: string,
  projectDir: string,
): Promise<void> {
  const dir = resolveSysgenDir(projectDir);
  await mkdir(dir, { recursive: true });

  // Save per-subsys config
  const configPath = join(dir, `${config.subsys}.json`);
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');

  // Save script path to config.json (shared across all subsys)
  const scriptConfigPath = join(dir, SCRIPT_CONFIG_FILE);
  await writeFile(
    scriptConfigPath,
    JSON.stringify({ scriptPath }, null, 2),
    'utf-8',
  );
}

/**
 * Load a saved config for a given subsys.
 *
 * @param subsys     Subsystem name
 * @param projectDir Project root directory
 * @returns The saved config, or null if not found
 */
export async function loadSysgenConfig(
  subsys: string,
  projectDir: string,
): Promise<SysbaseGenConfig | null> {
  const configPath = join(resolveSysgenDir(projectDir), `${subsys}.json`);
  if (!existsSync(configPath)) return null;

  try {
    const content = await readFile(configPath, 'utf-8');
    return JSON.parse(content) as SysbaseGenConfig;
  } catch {
    return null;
  }
}

/**
 * Load the persisted script path from `config.json`.
 *
 * @param projectDir Project root directory
 * @returns The saved script path, or the default if not found
 */
export async function loadScriptPath(projectDir: string): Promise<string> {
  const scriptConfigPath = join(resolveSysgenDir(projectDir), SCRIPT_CONFIG_FILE);
  if (!existsSync(scriptConfigPath)) return DEFAULT_SYSBASE_SCRIPT;

  try {
    const content = await readFile(scriptConfigPath, 'utf-8');
    const data = JSON.parse(content) as { scriptPath?: string };
    if (typeof data.scriptPath === 'string' && data.scriptPath.trim()) {
      return data.scriptPath;
    }
  } catch {
    // Config file invalid — fall back to default
  }

  return DEFAULT_SYSBASE_SCRIPT;
}

/** A saved config entry as returned by listSavedConfigs. */
export type SavedConfigEntry = {
  subsys: string;
  config: SysbaseGenConfig;
};

/**
 * List all saved configs (excluding `config.json`).
 *
 * @param projectDir Project root directory
 * @returns Array of saved config entries, each with subsys name and full config
 */
export async function listSavedConfigs(projectDir: string): Promise<SavedConfigEntry[]> {
  const dir = resolveSysgenDir(projectDir);
  if (!existsSync(dir)) return [];

  try {
    const files = await readdir(dir);
    const entries: SavedConfigEntry[] = [];

    for (const file of files) {
      // Skip non-JSON files and the script config file
      if (!file.endsWith('.json')) continue;
      if (file === SCRIPT_CONFIG_FILE) continue;

      const subsys = file.slice(0, -5); // strip .json
      const config = await loadSysgenConfig(subsys, projectDir);
      if (config) {
        entries.push({ subsys, config });
      }
    }

    return entries;
  } catch {
    return [];
  }
}
