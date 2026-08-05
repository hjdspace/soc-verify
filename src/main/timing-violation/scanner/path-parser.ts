/**
 * 回归目录路径解析器
 *
 * 参考 Python regression_scanner.py 中 `_parse_standard_structure` / `_parse_flexible_structure`。
 *
 * 标准模式: ./regression/<subsys>/.../<case_name>_<corner>/<case_name>_<seed>/log/vio_summary.log
 * 通用模式: ./regression/任意/<case_name>_<seed>/log/vio_summary.log
 */

import { relative, sep } from 'node:path';
import {
  DEFAULT_CORNERS,
  DEFAULT_SUBSYS_PATTERNS,
  isSubsysDirName,
  parseCornerFromDirName,
  parseSeedFromDirName,
} from '../parser/case-info-parser';

/** 回归文件信息 */
export type RegressionFileInfo = {
  filePath: string;
  subsys: string;
  cornerName: string;
  caseName: string;
  seed: string;
  relativePath: string;
  fileSize: number;
  modifiedTime: string;
  caseStatus: 'PASS' | 'FAIL';
};

/** 扫描选项 */
export type ScanOptions = {
  useStandardStructure: boolean;
  corners?: string[];
  subsysPatterns?: string[];
};

/**
 * 解析标准目录结构。
 *
 * 格式: <case_name>_<corner>/<case_name>_<seed>/log/vio_summary.log
 * 路径组件至少需要 4 层。
 */
export function parseStandardStructure(
  filePath: string,
  regressionRoot: string,
  options?: ScanOptions,
): RegressionFileInfo | null {
  const corners = options?.corners ?? DEFAULT_CORNERS;
  const subsysPatterns = options?.subsysPatterns ?? DEFAULT_SUBSYS_PATTERNS;

  const relPath = relative(regressionRoot, filePath);
  const pathParts = relPath.split(sep);

  // 至少需要 4 层：subsys/.../case_corner/case_seed/log/vio_summary.log
  if (pathParts.length < 4) return null;
  if (pathParts[pathParts.length - 1] !== 'vio_summary.log') return null;
  if (pathParts[pathParts.length - 2] !== 'log') return null;

  // 倒数第三个: <case_name>_<seed>
  const caseSeedDir = pathParts[pathParts.length - 3];
  const seedInfo = parseSeedFromDirName(caseSeedDir);
  if (!seedInfo.seed) return null;

  // 倒数第四个: <case_name>_<corner>
  const caseCornerDir = pathParts[pathParts.length - 4];
  const cornerInfo = parseCornerFromDirName(caseCornerDir, corners);
  if (!cornerInfo.corner) return null;

  // 验证 case_name 一致性
  if (seedInfo.caseName !== cornerInfo.caseName) return null;

  // 查找子系统
  const remainingParts = pathParts.slice(0, -4);
  let subsys = findSubsysInPath(remainingParts, subsysPatterns);
  if (!subsys) {
    subsys = remainingParts[0] ?? 'unknown';
  }

  return buildFileInfo(filePath, regressionRoot, subsys, cornerInfo.corner, seedInfo.caseName, seedInfo.seed);
}

/**
 * 解析通用目录结构。
 *
 * 格式: 任意/<case_name>_<seed>/log/vio_summary.log
 * 路径组件至少需要 3 层。
 */
export function parseFlexibleStructure(
  filePath: string,
  regressionRoot: string,
  options?: ScanOptions,
): RegressionFileInfo | null {
  const corners = options?.corners ?? DEFAULT_CORNERS;
  const subsysPatterns = options?.subsysPatterns ?? DEFAULT_SUBSYS_PATTERNS;

  const relPath = relative(regressionRoot, filePath);
  const pathParts = relPath.split(sep);

  // 至少需要 3 层
  if (pathParts.length < 3) return null;
  if (pathParts[pathParts.length - 1] !== 'vio_summary.log') return null;
  if (pathParts[pathParts.length - 2] !== 'log') return null;

  // 倒数第三个: <case_name>_<seed>
  const caseSeedDir = pathParts[pathParts.length - 3];
  const seedInfo = parseSeedFromDirName(caseSeedDir);
  if (!seedInfo.seed) return null;

  // 从路径中查找 corner
  let cornerName = findCornerInPath(pathParts, corners);
  if (!cornerName) cornerName = 'unknown';

  // 从路径中查找 subsystem
  let subsys = findSubsysInPath(pathParts, subsysPatterns);
  if (!subsys) subsys = 'unknown';

  return buildFileInfo(filePath, regressionRoot, subsys, cornerName, seedInfo.caseName, seedInfo.seed);
}

// ─── 内部辅助 ─────────────────────────────────────────────────

/**
 * 在路径组件中查找 corner 名称。
 * 按长度从长到短优先匹配。
 */
function findCornerInPath(pathParts: string[], corners: string[]): string | null {
  const sortedCorners = [...corners].sort((a, b) => b.length - a.length);

  for (const part of pathParts) {
    for (const corner of sortedCorners) {
      const suffix = `_${corner}`;
      if (part.endsWith(suffix) || part === corner || part.includes(`${suffix}_`)) {
        return corner;
      }
    }
  }
  return null;
}

/**
 * 在路径组件中查找子系统名称。
 */
function findSubsysInPath(pathParts: string[], subsysPatterns: string[]): string | null {
  for (const part of pathParts) {
    if (isSubsysDirName(part, subsysPatterns)) {
      return part;
    }
  }
  return null;
}

/**
 * 检测用例状态（PASS/FAIL）。
 * 检查同目录下是否存在 sprd_log_pass.log 文件。
 */
export function detectCaseStatus(_filePath: string): 'PASS' | 'FAIL' {
  // 注：此处依赖 fs，延迟导入避免纯函数测试中引入 fs
  // 实际由 violation-scanner.ts 调用时注入
  return 'FAIL';
}

/**
 * 构建完整的 RegressionFileInfo。
 */
function buildFileInfo(
  filePath: string,
  regressionRoot: string,
  subsys: string,
  cornerName: string,
  caseName: string,
  seed: string,
): RegressionFileInfo {
  // 注意：fileSize 和 modifiedTime 在 scanner 中填充
  return {
    filePath,
    subsys,
    cornerName,
    caseName,
    seed,
    relativePath: relative(regressionRoot, filePath),
    fileSize: 0,
    modifiedTime: '',
    caseStatus: 'FAIL',
  };
}
