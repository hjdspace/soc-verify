/**
 * 回归目录扫描器 — 递归扫描 + 路径解析 + 分组 + 批量处理
 *
 * 参考 Python regression_scanner.py 中 `RegressionDirectoryScanner` 和
 * `regression_batch_manager.py` 中 `process_selected_files`。
 *
 * 两种扫描模式：
 * 1. 标准模式：./regression/<subsys>/.../<case>_<corner>/<case>_<seed>/log/vio_summary.log
 * 2. 通用模式：./regression/任意/<case>_<seed>/log/vio_summary.log
 */

import { existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { RegressionFileInfo, ScanOptions } from './path-parser';
import {
  parseStandardStructure,
  parseFlexibleStructure,
} from './path-parser';
import { loadTvConfig } from '../tv-config';
import type { ParsedViolation } from '../types';
import { parseLogFile } from '../parser/vio-parser';
import { getTvDb } from '../db/tv-db-cache';
import { insertViolations, ensureConfirmationRecords } from '../db/tv-repository';

/** 扫描结果 */
export type RegressionScanResult = {
  totalFiles: number;
  validFiles: RegressionFileInfo[];
  invalidPaths: string[];
  scanTime: number;
  subsysGroups: Record<string, RegressionFileInfo[]>;
  cornerGroups: Record<string, RegressionFileInfo[]>;
  caseGroups: Record<string, RegressionFileInfo[]>;
  statusGroups: Record<string, RegressionFileInfo[]>;
};

/** 批量处理结果 */
export type BatchProcessResult = {
  totalInserted: number;
  totalSkipped: number;
  totalErrors: string[];
  processedCount: number;
};

/**
 * 递归扫描回归目录，发现所有 vio_summary.log 文件。
 *
 * @param regressionRoot 回归根目录
 * @param useStandardStructure 是否使用标准模式（true）或通用模式（false）
 * @param projectRoot 项目根目录（用于读取配置）
 * @returns 扫描结果
 */
export function scanRegressionDirectory(
  regressionRoot: string,
  useStandardStructure: boolean,
  projectRoot?: string,
): RegressionScanResult {
  const startTime = Date.now();

  if (!existsSync(regressionRoot)) {
    throw new Error(`回归目录不存在: ${regressionRoot}`);
  }

  // 从配置读取 corners 和 subsysPatterns
  let options: ScanOptions = { useStandardStructure };
  if (projectRoot) {
    const config = loadTvConfig(projectRoot);
    options = {
      useStandardStructure,
      corners: config.corners,
      subsysPatterns: config.subsysPatterns,
    };
  }

  const validFiles: RegressionFileInfo[] = [];
  const invalidPaths: string[] = [];

  recursiveScan(regressionRoot, regressionRoot, options, validFiles, invalidPaths);

  const scanTime = (Date.now() - startTime) / 1000;

  return {
    totalFiles: validFiles.length + invalidPaths.length,
    validFiles,
    invalidPaths,
    scanTime,
    subsysGroups: groupBy(validFiles, (f) => f.subsys),
    cornerGroups: groupBy(validFiles, (f) => f.cornerName),
    caseGroups: groupBy(validFiles, (f) => f.caseName),
    statusGroups: groupBy(validFiles, (f) => f.caseStatus),
  };
}

/**
 * 递归扫描目录。
 */
function recursiveScan(
  currentPath: string,
  regressionRoot: string,
  options: ScanOptions,
  validFiles: RegressionFileInfo[],
  invalidPaths: string[],
): void {
  let entries: string[];
  try {
    entries = readdirSync(currentPath);
  } catch {
    invalidPaths.push(currentPath);
    return;
  }

  for (const entry of entries) {
    const entryPath = join(currentPath, entry);

    let stat;
    try {
      stat = statSync(entryPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      recursiveScan(entryPath, regressionRoot, options, validFiles, invalidPaths);
    } else if (entry === 'vio_summary.log') {
      // 解析文件路径
      const fileInfo = options.useStandardStructure
        ? parseStandardStructure(entryPath, regressionRoot, options)
        : parseFlexibleStructure(entryPath, regressionRoot, options);

      if (fileInfo) {
        // 填充文件大小、修改时间和用例状态
        fileInfo.fileSize = stat.size;
        fileInfo.modifiedTime = stat.mtime.toISOString();
        fileInfo.caseStatus = detectCaseStatus(entryPath);
        validFiles.push(fileInfo);
      } else {
        invalidPaths.push(entryPath);
      }
    }
  }
}

/**
 * 检测用例状态（PASS/FAIL）。
 * 检查同目录下是否存在 sprd_log_pass.log 文件。
 */
function detectCaseStatus(filePath: string): 'PASS' | 'FAIL' {
  const logDir = dirname(filePath);
  const passLogPath = join(logDir, 'sprd_log_pass.log');
  return existsSync(passLogPath) ? 'PASS' : 'FAIL';
}

/**
 * 批量处理选中的文件。
 * 逐个解析并导入数据库。
 *
 * @param filePaths 文件路径列表
 * @param projectRoot 项目根目录（用于读取配置）
 * @param onProgress 进度回调
 * @returns 批量处理结果
 */
export async function batchProcessFiles(
  filePaths: string[],
  projectRoot: string,
  onProgress?: (current: number, total: number, inserted: number) => void,
): Promise<BatchProcessResult> {
  const config = loadTvConfig(projectRoot);
  let totalInserted = 0;
  let totalSkipped = 0;
  const totalErrors: string[] = [];
  let processedCount = 0;

  const db = getTvDb(projectRoot);

  for (const filePath of filePaths) {
    try {
      const result = await parseLogFile(filePath, {
        corners: config.corners,
        subsysPatterns: config.subsysPatterns,
      });

      const { inserted, skipped } = insertViolations(db, result.violations);
      ensureConfirmationRecords(db);

      totalInserted += inserted;
      totalSkipped += skipped;
      if (result.errors.length > 0) {
        totalErrors.push(...result.errors);
      }
    } catch (err) {
      totalErrors.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }

    processedCount++;
    onProgress?.(processedCount, filePaths.length, totalInserted);
  }

  return {
    totalInserted,
    totalSkipped,
    totalErrors,
    processedCount,
  };
}

// ─── 内部辅助 ─────────────────────────────────────────────────

/**
 * 通用分组函数。
 */
function groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) {
    const key = keyFn(item);
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return groups;
}
