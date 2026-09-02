/**
 * Token Monitor Registry — per-project DB 单例管理。
 *
 * 镜像 src/main/case/case-stats-registry.ts 模式：
 * 项目打开时 getOrCreateDb(rootPath) → 初始化 .socverify/token-monitor.db。
 * 项目关闭时 closeDb(rootPath) → 关闭连接。
 *
 * Issue #5: 首个项目 DB 创建时启动 ScanScheduler 5 分钟定时扫描外部日志。
 * 应用退出时 closeAllDbs() 停止定时扫描。
 */

import { join } from 'node:path';
import { initDatabase, closeDatabase, type TokenMonitorDb } from './token-monitor-db';
import { ScanScheduler } from './scan-scheduler';

const DEFAULT_DATA_DIR = '.socverify';
const DB_FILENAME = 'token-monitor.db';

/** per-project DB 实例缓存 */
const dbCache = new Map<string, TokenMonitorDb>();

/** 全局定时扫描调度器（单例，绑定首个创建的项目 DB） */
let scanScheduler: ScanScheduler | null = null;

/**
 * 获取数据库文件路径（位于项目 .socverify/ 目录下）。
 */
export function getDbPath(projectRoot: string): string {
  return join(projectRoot, DEFAULT_DATA_DIR, DB_FILENAME);
}

/**
 * 获取或创建项目的 Token Monitor DB。
 * 首次调用时初始化数据库（创建文件、执行 PRAGMA、创建表和索引）。
 *
 * 同时启动 ScanScheduler 定时扫描外部日志（Issue #5：5 分钟间隔）。
 * 定时扫描绑定到首个创建的 DB，后续项目复用同一调度器实例。
 */
export function getOrCreateDb(projectRoot: string): TokenMonitorDb {
  let db = dbCache.get(projectRoot);
  if (!db) {
    const dbPath = getDbPath(projectRoot);
    db = initDatabase(dbPath);
    dbCache.set(projectRoot, db);

    // 启动定时扫描（仅首次创建 DB 时启动一次）
    if (!scanScheduler) {
      scanScheduler = new ScanScheduler(db);
      scanScheduler.start();
      console.log('[token-monitor] ScanScheduler started — 5 min interval');
    }
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
 * 同时停止 ScanScheduler 定时扫描。
 */
export function closeAllDbs(): void {
  if (scanScheduler) {
    scanScheduler.stop();
    scanScheduler = null;
  }
  for (const [root, db] of dbCache) {
    closeDatabase(db);
    dbCache.delete(root);
  }
}

// ─── Export for re-use ─────────────────────────────────────

export const tokenMonitorRegistry = {
  getOrCreateDb,
  closeDb,
  closeAllDbs,
};
