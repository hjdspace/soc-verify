import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EdaToolInfo, EnvConfig, EnvVarDefinition, EnvVarGroup, SystemEnvVars } from '@shared/types';

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
 * Catalog of known SoC / EDA environment variables, grouped by category.
 *
 * Categories:
 *  - soc:       Project structure paths (PROJ_ENV, PROJ_RTL, …)
 *  - synopsys:  Synopsys tool home dirs and license
 *  - cadence:   Cadence tool home dirs and license
 *  - license:   Generic license variables
 *  - system:    System-level paths (LD_LIBRARY_PATH, PATH)
 */
const ENV_VAR_CATALOG: EnvVarDefinition[] = [
  // ── SOC 项目环境 ──────────────────────────────────
  { name: 'PROJ_ENV', category: 'soc', description: '验证环境目录 (dv)', isPath: true },
  { name: 'PROJ_RTL', category: 'soc', description: '设计源码目录 (de)', isPath: true },
  { name: 'PROJ_WORK', category: 'soc', description: '仿真工作目录', isPath: true },
  { name: 'SPRD_TOOL_DIR', category: 'soc', description: '工具目录', isPath: true },

  // ── Synopsys 工具 ────────────────────────────────
  { name: 'VERDI_HOME', category: 'synopsys', description: 'Verdi 安装路径', isPath: true },
  { name: 'NOVAS_HOME', category: 'synopsys', description: 'Novas 安装路径', isPath: true },
  { name: 'VCS_HOME', category: 'synopsys', description: 'VCS 安装路径', isPath: true },
  { name: 'SNPSLMD_LICENSE_FILE', category: 'synopsys', description: 'Synopsys License 文件' },

  // ── Cadence 工具 ─────────────────────────────────
  { name: 'XLM_ROOT', category: 'cadence', description: 'Xcelium 安装路径', isPath: true },
  { name: 'CDS_INST_DIR', category: 'cadence', description: 'Cadence 安装路径', isPath: true },
  { name: 'CDS_LICENSE_FILE', category: 'cadence', description: 'Cadence License 文件' },

  // ── License 通用 ─────────────────────────────────
  { name: 'LM_LICENSE_FILE', category: 'license', description: 'FlexLM License 文件' },
  { name: 'CDS_LIC_FILE', category: 'license', description: 'Cadence License 文件 (别名)' },
  { name: 'MGLS_LICENSE_FILE', category: 'license', description: 'Mentor Graphics License 文件' },
  { name: 'LICENSE_FILE', category: 'license', description: '通用 License 文件' },

  // ── 系统环境 ─────────────────────────────────────
  { name: 'LD_LIBRARY_PATH', category: 'system', description: '动态链接库搜索路径' },
  { name: 'PATH', category: 'system', description: '可执行文件搜索路径' },
];

/** Display labels and descriptions for each category. */
const CATEGORY_META: Record<EnvVarDefinition['category'], { label: string; description: string }> = {
  soc: { label: 'SOC 项目环境', description: '项目结构与仿真工作目录' },
  synopsys: { label: 'Synopsys 工具', description: 'VCS / Verdi / Novas 等工具环境' },
  cadence: { label: 'Cadence 工具', description: 'Xcelium / Cadence 工具环境' },
  license: { label: 'License 配置', description: 'EDA 工具许可证配置' },
  system: { label: '系统环境', description: '系统路径与库搜索路径' },
};

/** Category display order. */
const CATEGORY_ORDER: EnvVarDefinition['category'][] = ['soc', 'synopsys', 'cadence', 'license', 'system'];

/** Flat list of known env var names (derived from catalog). */
const KNOWN_ENV_VARS = ENV_VAR_CATALOG.map((v) => v.name);

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
 * Get the env var catalog grouped by category, in display order.
 */
export function getEnvVarCatalog(): EnvVarGroup[] {
  return CATEGORY_ORDER.map((category) => ({
    category,
    label: CATEGORY_META[category].label,
    description: CATEGORY_META[category].description,
    vars: ENV_VAR_CATALOG.filter((v) => v.category === category),
  }));
}

/**
 * Detect current system (terminal) environment variables for all known env var names.
 *
 * Reads `process.env` and returns the values for any known env var that is
 * currently set.  This allows the UI to pre-fill fields from the user's
 * shell environment.
 */
export function detectSystemEnvVars(): SystemEnvVars {
  const result: SystemEnvVars = {};
  for (const name of KNOWN_ENV_VARS) {
    const value = process.env[name];
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
 */
export function mergeSystemEnvVars(current: Record<string, string>): Record<string, string> {
  const system = detectSystemEnvVars();
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
