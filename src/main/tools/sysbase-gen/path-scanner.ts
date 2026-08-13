/**
 * Path scanner for sysbase-gen — pure filesystem operations.
 *
 * Provides:
 *   - resolveProjRtl: resolve $PROJ_RTL from process.env or .socverify/env.json
 *   - inferInstanceName: derive instance name from subsys name (pure string transform)
 *   - listRtlFiles: scan $PROJ_RTL/<subsys>/design/rtl/top/ for .v files
 *   - extractModuleName: regex extract `module <name>` from .v file content
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SOCVERIFY_DIR = '.socverify';
const ENV_CONFIG_FILE = 'env.json';

/**
 * Resolve $PROJ_RTL from process.env, falling back to .socverify/env.json.
 * Returns null if not found in either location.
 */
export function resolveProjRtl(projectDir?: string): string | null {
  const envVal = process.env.PROJ_RTL;
  if (envVal && envVal.trim()) return envVal.trim();

  if (projectDir) {
    try {
      const configPath = join(projectDir, SOCVERIFY_DIR, ENV_CONFIG_FILE);
      if (!existsSync(configPath)) return null;
      const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
        envVars?: Record<string, string>;
      };
      const configured = config?.envVars?.PROJ_RTL;
      if (typeof configured === 'string' && configured.trim()) {
        return configured.trim();
      }
    } catch {
      // Config file not found or invalid
    }
  }

  return null;
}

/**
 * Infer the instance name from a subsys name.
 *
 * Rule: strip the `_sys` suffix, then prepend `u_sys_`.
 *   apcpu_sys → u_sys_apcpu
 *   aon_sys   → u_sys_aon
 *   custom    → u_sys_custom (no _sys suffix, use full name)
 *
 * @param subsys Subsystem name, e.g. `apcpu_sys`
 * @returns Inferred instance name, e.g. `u_sys_apcpu`
 */
export function inferInstanceName(subsys: string): string {
  const prefix = subsys.endsWith('_sys')
    ? subsys.slice(0, -'_sys'.length)
    : subsys;
  return `u_sys_${prefix}`;
}

/** RTL file entry returned by listRtlFiles. */
export type RtlFileEntry = {
  /** File name, e.g. `apcpu_top.v` */
  name: string;
  /** Full path to the file */
  path: string;
};

/**
 * List all `.v` files in `$PROJ_RTL/<subsys>/design/rtl/top/`.
 *
 * @param subsys    Subsystem name
 * @param projectDir Optional project root for .socverify/env.json fallback
 * @returns Array of { name, path } entries, or empty array if dir doesn't exist
 * @throws Error if $PROJ_RTL is not set
 */
export function listRtlFiles(subsys: string, projectDir?: string): RtlFileEntry[] {
  const projRtl = resolveProjRtl(projectDir);
  if (!projRtl) {
    throw new Error('$PROJ_RTL 环境变量未设置，请在环境变量管理中配置 PROJ_RTL');
  }

  const topDir = join(projRtl, subsys, 'design', 'rtl', 'top');
  if (!existsSync(topDir)) {
    return [];
  }

  const stat = statSync(topDir);
  if (!stat.isDirectory()) {
    return [];
  }

  const entries = readdirSync(topDir);
  return entries
    .filter((name) => name.endsWith('.v'))
    .map((name) => ({
      name,
      path: join(topDir, name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Extract the module name from a Verilog file.
 *
 * Reads the file and uses regex to find the first `module <name>` declaration.
 *
 * @param filePath Path to the .v file
 * @returns Module name string, or null if no module declaration found
 * @throws Error if the file does not exist or cannot be read
 */
export function extractModuleName(filePath: string): string | null {
  if (!existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }

  const content = readFileSync(filePath, 'utf-8');
  // Match `module <name>` allowing leading whitespace, supporting
  // both `module name (` and `module name(` patterns.
  const match = content.match(/^\s*module\s+(\w+)/m);
  return match ? match[1] : null;
}
