/**
 * 时序违例配置管理
 *
 * 配置文件路径：<dataDir>/config.json
 * 数据库路径：<dataDir>/tv.db
 * 导出目录：<dataDir>/exports/
 * 备份目录：<dataDir>/backups/
 *
 * 参考文档：docs/timing-violation-handoff.md §4.5
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { TvConfig } from './types';
import { DEFAULT_CORNERS, DEFAULT_SUBSYS_PATTERNS } from './parser/case-info-parser';

/** 默认数据根目录（相对于项目根目录） */
const DEFAULT_DATA_DIR = '.socverify/timing-violation';

/** 默认配置 */
export const DEFAULT_TV_CONFIG: TvConfig = {
  dataDir: DEFAULT_DATA_DIR,
  corners: [...DEFAULT_CORNERS],
  subsysPatterns: [...DEFAULT_SUBSYS_PATTERNS],
  defaultResetTimeNs: 1000,
  resetIntervalStartNs: null,
  resetIntervalEndNs: null,
  autoBackup: true,
  backupInterval: 100,
};

/**
 * 获取配置文件路径（相对于项目根目录）。
 * 配置文件位于数据根目录下。
 */
export function getConfigPath(projectRoot: string, dataDir?: string): string {
  const dir = dataDir ?? DEFAULT_DATA_DIR;
  return resolve(projectRoot, dir, 'config.json');
}

/**
 * 获取数据根目录的完整路径。
 */
export function getDataDir(projectRoot: string, dataDir?: string): string {
  const dir = dataDir ?? DEFAULT_DATA_DIR;
  return resolve(projectRoot, dir);
}

/**
 * 获取数据库文件路径（位于数据根目录下）。
 */
export function getDbPath(projectRoot: string, dataDir?: string): string {
  const dir = dataDir ?? DEFAULT_DATA_DIR;
  return resolve(projectRoot, dir, 'tv.db');
}

/**
 * 获取导出目录路径（位于数据根目录下的 exports/ 子目录）。
 */
export function getExportDir(projectRoot: string, dataDir?: string): string {
  const dir = dataDir ?? DEFAULT_DATA_DIR;
  return resolve(projectRoot, dir, 'exports');
}

/**
 * 获取备份目录路径（位于数据根目录下的 backups/ 子目录）。
 */
export function getBackupDir(projectRoot: string, dataDir?: string): string {
  const dir = dataDir ?? DEFAULT_DATA_DIR;
  return resolve(projectRoot, dir, 'backups');
}

/**
 * 加载配置文件。如果不存在则返回默认配置。
 *
 * 向后兼容：如果旧配置中有 dbPath 但没有 dataDir，
 * 从 dbPath 的目录路径推导 dataDir。
 */
export function loadTvConfig(projectRoot: string): TvConfig {
  // 先尝试从默认 dataDir 位置加载配置
  const configPath = getConfigPath(projectRoot);
  if (!existsSync(configPath)) {
    return { ...DEFAULT_TV_CONFIG };
  }
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // 向后兼容：旧配置中有 dbPath 但没有 dataDir
    let dataDir: string;
    if (typeof parsed.dataDir === 'string') {
      dataDir = parsed.dataDir;
    } else if (typeof parsed.dbPath === 'string') {
      // 从 dbPath 推导 dataDir：去掉末尾的 tv.db
      // 例如 .socverify/timing-violation/tv.db → .socverify/timing-violation
      dataDir = dirname(parsed.dbPath);
    } else {
      dataDir = DEFAULT_DATA_DIR;
    }

    return {
      dataDir,
      corners: Array.isArray(parsed.corners) ? (parsed.corners as string[]) : [...DEFAULT_CORNERS],
      subsysPatterns: Array.isArray(parsed.subsysPatterns) ? (parsed.subsysPatterns as string[]) : [...DEFAULT_SUBSYS_PATTERNS],
      defaultResetTimeNs: typeof parsed.defaultResetTimeNs === 'number' ? parsed.defaultResetTimeNs : 1000,
      resetIntervalStartNs: typeof parsed.resetIntervalStartNs === 'number' ? parsed.resetIntervalStartNs : null,
      resetIntervalEndNs: typeof parsed.resetIntervalEndNs === 'number' ? parsed.resetIntervalEndNs : null,
      autoBackup: typeof parsed.autoBackup === 'boolean' ? parsed.autoBackup : true,
      backupInterval: typeof parsed.backupInterval === 'number' ? parsed.backupInterval : 100,
    };
  } catch {
    return { ...DEFAULT_TV_CONFIG };
  }
}

/**
 * 保存配置文件。
 *
 * 配置文件始终保存在默认位置（.socverify/timing-violation/config.json），
 * 以便 loadTvConfig 能可靠地找到它。
 * config.dataDir 字段仅决定 DB/exports/backups 的存储位置。
 */
export function saveTvConfig(projectRoot: string, config: TvConfig): void {
  const configPath = getConfigPath(projectRoot);
  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * 确保数据库目录存在。
 */
export function ensureDbDir(dbFullPath: string): void {
  const dir = dirname(dbFullPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * 确保导出目录存在。
 */
export function ensureExportDir(projectRoot: string, dataDir?: string): string {
  const exportDir = getExportDir(projectRoot, dataDir);
  if (!existsSync(exportDir)) {
    mkdirSync(exportDir, { recursive: true });
  }
  return exportDir;
}

/**
 * 确保备份目录存在。
 */
export function ensureBackupDir(projectRoot: string, dataDir?: string): string {
  const backupDir = getBackupDir(projectRoot, dataDir);
  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }
  return backupDir;
}
