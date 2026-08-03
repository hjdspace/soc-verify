/**
 * 用例信息解析器 — 从文件路径推断 case_name / corner / seed。
 *
 * 参考 Python parser.py 中 CaseInfoParser.parse_directory_name。
 *
 * 目录结构约定（来自 handoff §2.4.5）：
 *   标准模式: ./regression/<subsys>/.../<case_name>_<corner>/<case_name>_<seed>/log/vio_summary.log
 *   通用模式: ./regression/任意/<case_name>_<seed>/log/vio_summary.log
 *
 * 单文件解析时：
 *   1. filePath 的父目录（log 的父目录）→ `<case_name>_<seed>` → 提取 seed
 *   2. 再上一级目录 → `<case_name>_<corner>` → 提取 corner
 *   3. 如果用户显式传入 caseName / corner，优先使用
 */

import { basename, dirname, sep } from 'node:path';

/** Unisoc 默认 Corner 列表 */
export const DEFAULT_CORNERS = [
  'npg_f1_ssg', 'npg_f2_ssg', 'npg_f3_ssg', 'npg_f4_ssg', 'npg_f5_ssg', 'npg_f6_ssg', 'npg_f7_ssg',
  'npg_f1_ffg', 'npg_f2_ffg', 'npg_f3_ffg', 'npg_f4_ffg', 'npg_f5_ffg', 'npg_f6_ffg', 'npg_f7_ffg',
  'npg_f1_tt', 'npg_f2_tt', 'npg_f3_tt',
];

/** 子系统识别规则（目录名匹配这些模式的认为是子系统） */
export const DEFAULT_SUBSYS_PATTERNS = ['*_sys$', '^top$', '*_subsys$'];

export type CaseInfo = {
  caseName: string;
  corner: string | null;
  seed: string | null;
  subsys: string | null;
};

/**
 * 从目录名中提取 corner。
 * 按 corner 列表从长到短优先匹配，避免短 corner 被长 corner 包含的问题。
 *
 * 支持两种格式：
 *   1. {case_name}_{corner}           — 如 test_case_npg_f1_ssg
 *   2. {case_name}_{corner}_xxx       — 如 test_case_npg_f1_ffg_cloud
 */
export function parseCornerFromDirName(
  dirName: string,
  corners: string[] = DEFAULT_CORNERS,
): { caseName: string; corner: string | null } {
  // 按长度降序排列，优先匹配长 corner
  const sortedCorners = [...corners].sort((a, b) => b.length - a.length);

  for (const corner of sortedCorners) {
    // 格式 1: 以 _{corner} 结尾
    const suffix = `_${corner}`;
    if (dirName.endsWith(suffix)) {
      return { caseName: dirName.slice(0, -suffix.length), corner };
    }

    // 格式 2: 包含 _{corner}_
    const infix = `_${corner}_`;
    const pos = dirName.indexOf(infix);
    if (pos !== -1) {
      return { caseName: dirName.slice(0, pos), corner };
    }
  }

  return { caseName: dirName, corner: null };
}

/**
 * 从目录名中提取 seed。
 * 格式：{case_name}_{seed_number} — 如 test_case_1, test_case_123
 *
 * seed 是目录名最后一段 `_` 后面的数字。
 */
export function parseSeedFromDirName(dirName: string): { caseName: string; seed: string | null } {
  const lastUnderscore = dirName.lastIndexOf('_');
  if (lastUnderscore !== -1) {
    const possibleSeed = dirName.slice(lastUnderscore + 1);
    if (/^\d+$/.test(possibleSeed)) {
      return {
        caseName: dirName.slice(0, lastUnderscore),
        seed: possibleSeed,
      };
    }
  }
  return { caseName: dirName, seed: null };
}

/**
 * 检测目录名是否为子系统。
 */
export function isSubsysDirName(
  dirName: string,
  patterns: string[] = DEFAULT_SUBSYS_PATTERNS,
): boolean {
  return patterns.some((pattern) => matchPattern(dirName, pattern));
}

/**
 * 简单的 glob 模式匹配（支持 * 和 ^ $）。
 * *xxx → endsWith
 * xxx* → startsWith
 * *xxx* → includes
 * ^xxx$ → exact match
 * xxx → includes (默认)
 */
function matchPattern(str: string, pattern: string): boolean {
  // Handle ^pattern$ (exact match)
  if (pattern.startsWith('^') && pattern.endsWith('$')) {
    return str === pattern.slice(1, -1);
  }
  // Strip trailing $ (end anchor for glob patterns like *_sys$)
  const p = pattern.endsWith('$') ? pattern.slice(0, -1) : pattern;
  if (p.startsWith('*') && p.endsWith('*')) {
    return str.includes(p.slice(1, -1));
  }
  if (p.startsWith('*')) {
    return str.endsWith(p.slice(1));
  }
  if (p.endsWith('*')) {
    return str.startsWith(p.slice(0, -1));
  }
  return str.includes(p);
}

/**
 * 从 vio_summary.log 文件路径推断 case_name / corner / seed / subsys。
 *
 * 路径示例：
 *   /regression/dsp_sys/test_case_npg_f1_ssg/test_case_1/log/vio_summary.log
 *   → caseName=test_case, corner=npg_f1_ssg, seed=1, subsys=dsp_sys
 *
 * 如果用户传入显式 caseName / corner，优先使用。
 */
export function parseCaseInfoFromPath(
  filePath: string,
  options?: { caseName?: string; corner?: string; corners?: string[]; subsysPatterns?: string[] },
): CaseInfo {
  const corners = options?.corners ?? DEFAULT_CORNERS;
  const subsysPatterns = options?.subsysPatterns ?? DEFAULT_SUBSYS_PATTERNS;

  // log 目录的父目录 → <case_name>_<seed>
  const logDir = dirname(filePath);       // .../<case>_<corner>/<case>_<seed>/log
  const seedDir = dirname(logDir);          // .../<case>_<corner>/<case>_<seed>
  const seedDirName = basename(seedDir);

  // 再上一级 → <case_name>_<corner>
  const cornerDir = dirname(seedDir);       // .../<case>_<corner>
  const cornerDirName = basename(cornerDir);

  // 提取 seed
  const seedInfo = parseSeedFromDirName(seedDirName);

  // 提取 corner（从 corner 目录名）
  const cornerInfo = parseCornerFromDirName(cornerDirName, corners);

  // 确定 caseName：用户显式传入 > 从 corner 目录推断 > 从 seed 目录推断
  const caseName = options?.caseName ?? cornerInfo.caseName ?? seedInfo.caseName;

  // 确定 corner：用户显式传入 > 从 corner 目录推断
  const corner = options?.corner ?? cornerInfo.corner;

  // 确定 seed：从 seed 目录推断
  const seed = seedInfo.seed;

  // 检测子系统（从路径中向上查找匹配 subsysPattern 的目录名）
  let subsys: string | null = null;
  let currentDir = cornerDir;
  for (let i = 0; i < 20; i++) {
    const dirName = basename(currentDir);
    if (isSubsysDirName(dirName, subsysPatterns)) {
      subsys = dirName;
      break;
    }
    const parent = dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }

  return { caseName, corner, seed, subsys };
}
