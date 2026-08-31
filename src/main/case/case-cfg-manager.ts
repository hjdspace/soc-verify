/**
 * Case Cfg Manager — 自定义用例 cfg 文件管理（解析环境、加载、删除、刷新）。
 *
 * 参考 Python `case_controller.py` 的环境解析和用例管理逻辑，
 * 在桌面端实现类似的 cfg 文件解析功能。
 *
 * 核心功能：
 * - scanSubsystems: 扫描 $PROJ_ENV 下的子系统目录（_sys 结尾或 top）
 * - discoverCaseCfgFiles: 为选中的子系统发现 .cfg 文件路径
 * - parseCaseCfgFile: 解析单个 cfg 文件，返回用例树结构（root nodes + child cases）
 *
 * 与 `tools/regression-list-gen.ts` 的 `parseCaseCfg` 不同：
 * - parseCaseCfg 过滤掉 base cases（模板用例），只返回可执行的 case 列表
 * - parseCaseCfgFile 保留完整的树结构信息（root nodes + child cases with base reference）
 *   用于 UI 树形展示
 */

import { readdir, stat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
import { parseBaseBlockFromPath } from '../tools/regression-list-gen';

// ── Types ──────────────────────────────────────────────────────────

export type SubsysInfo = {
  name: string;
  path: string;
};

export type ChildCaseRef = {
  case: string;
  base: string;
};

export type CaseFileData = {
  /** 文件名（basename） */
  name: string;
  /** 完整路径 */
  fullPath: string;
  /** 根用例名列表（无 :base 引用） */
  nodes: string[];
  /** 子用例列表（有 :base 引用） */
  childCases: ChildCaseRef[];
  /** 从路径推断的 -base 参数 */
  base: string;
  /** 从路径推断的 -block 参数 */
  block: string;
};

// ── scanSubsystems ──────────────────────────────────────────────────

/**
 * 扫描验证环境目录（$PROJ_ENV），返回所有子系统目录。
 *
 * 子系统目录的判定标准：
 * - 目录名以 `_sys` 结尾
 * - 或目录名为 `top`
 *
 * 参考Python `case_controller.py` 的 `show_env_parse_dialog` 中的扫描逻辑：
 *   for item in os.listdir(proj_env):
 *       if os.path.isdir(full_path) and (item.endswith('_sys') or item == 'top'):
 *           subsystems.append(item)
 */
export async function scanSubsystems(projEnv: string): Promise<SubsysInfo[]> {
  const subsystems: SubsysInfo[] = [];

  let entries: string[];
  try {
    entries = await readdir(projEnv);
  } catch {
    return [];
  }

  for (const item of entries) {
    const fullPath = join(projEnv, item);
    let isDirectory = false;
    try {
      const stats = await stat(fullPath);
      isDirectory = stats.isDirectory();
    } catch {
      continue;
    }

    if (isDirectory && (item.endsWith('_sys') || item === 'top')) {
      subsystems.push({ name: item, path: fullPath });
    }
  }

  return subsystems;
}

// ── Types: UDTB ───────────────────────────────────────────────────

export type UdtbDirInfo = {
  /** 相对路径（相对于 udtb/{subsys}），用于 UI 显示 */
  relPath: string;
  /** 完整路径 */
  fullPath: string;
};

// ── discoverCaseCfgFiles ────────────────────────────────────────────

/**
 * 为选中的子系统发现标准 .cfg 文件路径。
 *
 * 搜索路径：
 * - {projEnv}/{subsys}/bin/case_cfg/*.cfg
 *
 * 参考Python `parse_selected_subsystems` 中的逻辑：
 *   subsys_cfg_path = os.path.join(proj_env, subsys, 'bin', 'case_cfg')
 *   for cfg in os.listdir(subsys_cfg_path):
 *       if cfg.endswith('.cfg'):
 *           cfg_path = os.path.join(subsys_cfg_path, cfg)
 */
export async function discoverCaseCfgFiles(
  projEnv: string,
  selectedSubsystems: string[],
): Promise<string[]> {
  const cfgFiles: string[] = [];

  for (const subsys of selectedSubsystems) {
    const caseCfgDir = join(projEnv, subsys, 'bin', 'case_cfg');
    if (!existsSync(caseCfgDir)) continue;

    let entries: string[];
    try {
      entries = await readdir(caseCfgDir);
    } catch {
      continue;
    }

    for (const file of entries) {
      if (file.endsWith('.cfg')) {
        cfgFiles.push(join(caseCfgDir, file));
      }
    }
  }

  return cfgFiles;
}

// ── discoverUdtbDirs ────────────────────────────────────────────────

/**
 * 扫描 udtb/{subsys} 目录下所有包含 bin/ 的直接子目录。
 *
 * 这些子目录对应不同的 ip2soc/block 配置环境，
 * 用户在二级弹窗中选择后，从选中目录的 bin/ 下发现 .cfg 文件。
 *
 * 标准目录结构为 `udtb/{subsys}/{block}/bin/`，因此只需扫描一级子目录
 * （即 `udtb/{subsys}/` 下的直接子目录），无需递归深层遍历。
 * 这将扫描时间从 O(n^depth) 降低到 O(n)，在大规模 UDTB 目录下显著加速。
 *
 * 如果 udtb/{subsys} 目录不存在，返回空数组（前端跳过二级弹窗）。
 */
export async function discoverUdtbDirs(
  projEnv: string,
  subsys: string,
): Promise<UdtbDirInfo[]> {
  const udtbRoot = join(projEnv, 'udtb', subsys);
  if (!existsSync(udtbRoot)) return [];

  const dirs: UdtbDirInfo[] = [];

  let entries: string[];
  try {
    entries = await readdir(udtbRoot);
  } catch {
    return [];
  }

  // 只扫描一级子目录，检查是否包含 bin/ 子目录
  for (const entry of entries) {
    const entryPath = join(udtbRoot, entry);
    let isDirectory = false;
    try {
      const stats = await stat(entryPath);
      isDirectory = stats.isDirectory();
    } catch {
      continue;
    }

    if (!isDirectory) continue;

    // 检查该子目录是否包含 bin/ 子目录
    const binDir = join(entryPath, 'bin');
    if (existsSync(binDir)) {
      const rel = relative(udtbRoot, entryPath);
      dirs.push({ relPath: rel, fullPath: entryPath });
    }
  }

  return dirs;
}

// ── discoverUdtbCfgFiles ────────────────────────────────────────────

/**
 * 从用户选中的 udtb 子目录中发现 .cfg 文件。
 *
 * 搜索路径：
 * - {udtbDir}/bin/*.cfg
 *
 * 参考Python `parse_selected_subsystems` 中的 UDTB 处理：
 *   bin_dir = os.path.join(udtb_dir, 'bin')
 *   if os.path.exists(bin_dir):
 *       for file in os.listdir(bin_dir):
 *           if file.endswith('.cfg'):
 *               cfg_path = os.path.join(bin_dir, file)
 */
export async function discoverUdtbCfgFiles(
  udtbDirs: string[],
): Promise<string[]> {
  const cfgFiles: string[] = [];

  for (const udtbDir of udtbDirs) {
    const binDir = join(udtbDir, 'bin');
    if (!existsSync(binDir)) continue;

    let entries: string[];
    try {
      entries = await readdir(binDir);
    } catch {
      continue;
    }

    for (const file of entries) {
      if (file.endsWith('.cfg')) {
        cfgFiles.push(join(binDir, file));
      }
    }
  }

  return cfgFiles;
}

// ── parseCaseCfgFile ────────────────────────────────────────────────

/**
 * 解析单个 cfg 文件，返回用例树结构。
 *
 * cfg 文件格式：
 *   [case case_name]                  — 根用例（无 base 引用）
 *   [case child_name : base_name]    — 子用例（引用 base 用例）
 *
 * 参考Python `case_parser.py` 的 `parse_single_file`：
 *   pattern = r'\[case\s+([\w_]+)(?:\s*:\s*([\w_]+))?'
 *   for line in read_large_file(case_file):
 *       if match := re.match(pattern, line.strip()):
 *           case, base = match.groups()
 *           if base:
 *               file_data['child_cases'].append((case, base))
 *           else:
 *               file_data['nodes'][case] = []
 *
 * 同时通过 `parseBaseBlockFromPath` 推断 -base/-block 参数，
 * 用于选中用例后自动填充仿真选项。
 */
export async function parseCaseCfgFile(filePath: string): Promise<CaseFileData> {
  const content = await readFile(filePath, 'utf-8');
  const { base, block } = parseBaseBlockFromPath(filePath);

  const nodes: string[] = [];
  const childCases: ChildCaseRef[] = [];

  // Match [case case_name] or [case case_name : base_name]
  const pattern = /\[case\s+([\w_]+)(?:\s*:\s*([\w_]+))?/;
  for (const line of content.split('\n')) {
    const match = pattern.exec(line.trim());
    if (!match) continue;

    const caseName = match[1];
    const baseName = match[2];

    if (baseName) {
      childCases.push({ case: caseName, base: baseName });
    } else {
      nodes.push(caseName);
    }
  }

  return {
    name: basename(filePath),
    fullPath: filePath,
    nodes,
    childCases,
    base,
    block,
  };
}
