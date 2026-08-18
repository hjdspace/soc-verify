/**
 * Directory inferrer for sysbase-gen — RAL and CLK directory auto-detection.
 *
 * Provides:
 *   - inferRalDirs: scan spec/ and rtl/ root dirs for directories containing
 *     both `for_de` and `for_dv` subdirectories (recursive, max depth 5).
 *     For each matched directory, take its parent (the "reg 总目录") and
 *     collect into a Set for deduplication. The sysbase_gen.py -ral flag
 *     expects the parent directory that contains the reg blocks.
 *   - inferClkDirs: scan rtl/ for files with `clk_max_cfg` in the filename,
 *     return the containing directory paths
 */

import { readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
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
 * Collect RAL parent directories from matched dirs.
 *
 * Per the -ral spec: "由DE提供的所有reg目录所在的总目录".
 * Each matched dir (containing for_de + for_dv) represents a reg block.
 * The -ral flag expects the parent directory of these reg blocks.
 *
 * Algorithm:
 * 1. For each matched dir, take its parent directory (dirname).
 * 2. Add the parent to a Set (deduplication).
 *
 * Example:
 *   reg/reg_a_rf/sub1/for_de + for_dv → parent = reg/reg_a_rf
 *   reg/reg_a_rf/sub2/for_de + for_dv → parent = reg/reg_a_rf (dup, Set dedup)
 *   reg/reg_b_rf/sub3/for_de + for_dv → parent = reg/reg_b_rf
 *   Result: { reg/reg_a_rf, reg/reg_b_rf }
 *
 * So the -ral output is: -ral reg/reg_a_rf reg/reg_b_rf
 *
 * @param dirs Array of directories that contain for_de + for_dv
 * @returns Deduplicated array of parent directories
 */
function collectRalParentDirs(dirs: string[]): string[] {
  const parentSet = new Set<string>();
  for (const dir of dirs) {
    parentSet.add(dirname(dir));
  }
  return [...parentSet].sort();
}

/**
 * Infer RAL directories by scanning two root directories.
 *
 * Scans `$PROJ_RTL/<subsys>/design/spec/` and `$PROJ_RTL/<subsys>/design/rtl/`
 * recursively (max depth 5), returning directories that contain both `for_de`
 * and `for_dv` subdirectories.
 *
 * Results are transformed by taking the parent directory of each matched dir
 * and deduplicating via a Set. The -ral flag expects the parent directory
 * ("总目录") that contains the reg blocks, not the individual reg dirs.
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

  // Take parent directory of each matched dir and deduplicate via Set.
  // E.g., reg/reg_a_rf/for_de+for_dv + reg/reg_b_rf/for_de+for_dv
  // → parents: { reg/reg_a_rf, reg/reg_b_rf }
  // → -ral reg/reg_a_rf reg/reg_b_rf
  return collectRalParentDirs(result);
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
