/**
 * Token Monitor Registry — per-project DB 单例管理。
 *
 * 镜像 src/main/case/case-stats-registry.ts 模式：
 * 项目打开时 getOrCreateDb(rootPath) → 初始化 .socverify/token-monitor.db。
 * 项目关闭时 closeDb(rootPath) → 关闭连接。
 */

import { join } from 'node:path';
import { initDatabase, closeDatabase, type TokenMonitorDb } from './token-monitor-db';

const DEFAULT_DATA_DIR = '.socverify';
const DB_FILENAME = 'token-monitor.db';

/** per-project DB 实例缓存 */
const dbCache = new Map<string, TokenMonitorDb>();

/**
 * 获取数据库文件路径（位于项目 .socverify/ 目录下）。
 */
export function getDbPath(projectRoot: string): string {
  return join(projectRoot, DEFAULT_DATA_DIR, DB_FILENAME);
}

/**
 * 获取或创建项目的 Token Monitor DB。
 * 首次调用时初始化数据库（创建文件、执行 PRAGMA、创建表和索引）。
 */
export function getOrCreateDb(projectRoot: string): TokenMonitorDb {
  let db = dbCache.get(projectRoot);
  if (!db) {
    const dbPath = getDbPath(projectRoot);
    db = initDatabase(dbPath);
    dbCache.set(projectRoot, db);
  }
  return db;
}

/**
 * 关闭指定项目的 DB 连接。
 */
export function closeDb(projectRoot: string): void {
  const db = dbCache.get(projectRoot);
  if (db) {
    closeDatabase(db);
    dbCache.delete(projectRoot);
  }
}

/**
 * 关闭所有项目的 DB 连接（应用退出时调用）。
 */
export function closeAllDbs(): void {
  for (const [root, db] of dbCache) {
    closeDatabase(db);
    dbCache.delete(root);
  }
}

// ─── Export for re-use ─────────────────────────────────────

export { recordUsage, getSummary, getTrends, getEngineBreakdown } from './token-monitor-db';

export const tokenMonitorRegistry = {
  getOrCreateDb,
  closeDb,
  closeAllDbs,
};
