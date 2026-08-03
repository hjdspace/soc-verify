/**
 * 时序违例配置管理
 *
 * 配置文件路径：.socverify/timing-violation/config.json
 * 参考文档：docs/timing-violation-handoff.md §4.5
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { TvConfig } from './types';
import { DEFAULT_CORNERS, DEFAULT_SUBSYS_PATTERNS } from './parser/case-info-parser';

/** 默认配置 */
export const DEFAULT_TV_CONFIG: TvConfig = {
  dbPath: '.socverify/timing-violation/tv.db',
  corners: [...DEFAULT_CORNERS],
  subsysPatterns: [...DEFAULT_SUBSYS_PATTERNS],
  defaultResetTimeNs: 1000,
  autoBackup: true,
  backupInterval: 100,
};

/**
 * 获取配置文件路径（相对于项目根目录）。
 */
export function getConfigPath(projectRoot: string): string {
  return join(projectRoot, '.socverify', 'timing-violation', 'config.json');
}

/**
 * 获取数据库文件路径（相对于项目根目录）。
 */
export function getDbPath(projectRoot: string, dbPath?: string): string {
  const path = dbPath ?? DEFAULT_TV_CONFIG.dbPath;
  return resolve(projectRoot, path);
}

/**
 * 加载配置文件。如果不存在则返回默认配置。
 */
export function loadTvConfig(projectRoot: string): TvConfig {
  const configPath = getConfigPath(projectRoot);
  if (!existsSync(configPath)) {
    return { ...DEFAULT_TV_CONFIG };
  }
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TvConfig>;
    return { ...DEFAULT_TV_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_TV_CONFIG };
  }
}

/**
 * 保存配置文件。
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
