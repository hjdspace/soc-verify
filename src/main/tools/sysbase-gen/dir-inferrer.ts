/**
 * Directory inferrer for sysbase-gen — RAL and CLK directory auto-detection.
 *
 * Provides:
 *   - inferRalDirs: scan spec/ and rtl/ root dirs for directories containing
 *     both `for_de` and `for_dv` subdirectories (recursive, max depth 5)
 *   - inferClkDirs: scan rtl/ for files with `clk_max_cfg` in the filename,
 *     return the containing directory paths
 */

import { readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveProjRtl } from './path-scanner';

/** Maximum recursion depth for directory scanning. */
const MAX_DEPTH = 5;

/** Keyword to match in filenames when scanning for CLK config files. */
const CLK_KEYWORD = 'clk_max_cfg';

/**
 * Recursively scan a directory and collect all subdirectory paths.
 *
 * @param dir     Root directory to scan
 * @param depth   Current depth (0 = root)
 * @param maxDepth Maximum depth to descend
 * @returns Array of directory paths (including root itself at depth 0)
 */
function collectDirs(dir: string, depth: number, maxDepth: number): string[] {
  if (!existsSync(dir)) return [];
  const stat = statSync(dir);
  if (!stat.isDirectory()) return [];

  const result: string[] = [dir];

  if (depth >= maxDepth) return result;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return result;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    try {
      const entryStat = statSync(fullPath);
      if (entryStat.isDirectory()) {
        result.push(...collectDirs(fullPath, depth + 1, maxDepth));
      }
    } catch {
      // Skip entries we can't stat (permission errors, etc.)
    }
  }

  return result;
}

/**
 * Check if a directory contains both `for_de` and `for_dv` subdirectories.
 */
function hasForDeAndForDv(dir: string): boolean {
  return existsSync(join(dir, 'for_de')) && existsSync(join(dir, 'for_dv'));
}

/**
 * Infer RAL directories by scanning two root directories.
 *
 * Scans `$PROJ_RTL/<subsys>/design/spec/` and `$PROJ_RTL/<subsys>/design/rtl/`
 * recursively (max depth 5), returning directories that contain both `for_de`
 * and `for_dv` subdirectories.
 *
 * @param subsys    Subsystem name
 * @param projectDir Optional project root for .socverify/env.json fallback
 * @returns Array of directory paths containing both for_de and for_dv
 * @throws Error if $PROJ_RTL is not set
 */
export function inferRalDirs(subsys: string, projectDir?: string): string[] {
  const projRtl = resolveProjRtl(projectDir);
  if (!projRtl) {
    throw new Error('$PROJ_RTL 环境变量未设置，请在环境变量管理中配置 PROJ_RTL');
  }

  const designDir = join(projRtl, subsys, 'design');
  const roots = [join(designDir, 'spec'), join(designDir, 'rtl')];

  const result: string[] = [];

  for (const root of roots) {
    if (!existsSync(root)) continue;
    const allDirs = collectDirs(root, 0, MAX_DEPTH);
    for (const dir of allDirs) {
      if (hasForDeAndForDv(dir) && !result.includes(dir)) {
        result.push(dir);
      }
    }
  }

  return result.sort();
}

/**
 * Infer CLK directories by scanning the RTL directory for files containing
 * `clk_max_cfg` in their filename.
 *
 * Scans `$PROJ_RTL/<subsys>/design/rtl/` recursively (max depth 5),
 * returning the directory paths of files whose names contain `clk_max_cfg`.
 *
 * @param subsys    Subsystem name
 * @param projectDir Optional project root for .socverify/env.json fallback
 * @returns Array of directory paths containing clk_max_cfg files
 * @throws Error if $PROJ_RTL is not set
 */
export function inferClkDirs(subsys: string, projectDir?: string): string[] {
  const projRtl = resolveProjRtl(projectDir);
  if (!projRtl) {
    throw new Error('$PROJ_RTL 环境变量未设置，请在环境变量管理中配置 PROJ_RTL');
  }

  const rtlDir = join(projRtl, subsys, 'design', 'rtl');
  if (!existsSync(rtlDir)) return [];

  const allDirs = collectDirs(rtlDir, 0, MAX_DEPTH);
  const result: string[] = [];

  for (const dir of allDirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    const hasClkFile = entries.some(
      (name) => statSync(join(dir, name)).isFile() && name.includes(CLK_KEYWORD),
    );

    if (hasClkFile && !result.includes(dir)) {
      result.push(dir);
    }
  }

  return result.sort();
}
