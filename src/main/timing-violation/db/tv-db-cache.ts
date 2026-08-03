/**
 * TV DB Cache — 共享数据库实例缓存
 *
 * violation-router 和 confirmation-router 共用同一缓存，
 * 避免对同一个 projectId 创建多个数据库连接。
 */

import { loadTvConfig, getDbPath } from '../tv-config';
import { initDatabase, type TvDatabase } from './tv-database';

const dbCache = new Map<string, TvDatabase>();

/**
 * 获取（或创建并缓存）指定 projectRoot 的数据库实例。
 */
export function getTvDb(projectRoot: string): TvDatabase {
  let db = dbCache.get(projectRoot);
  if (!db) {
    const config = loadTvConfig(projectRoot);
    const dbPath = getDbPath(projectRoot, config.dbPath);
    db = initDatabase(dbPath);
    dbCache.set(projectRoot, db);
  }
  return db;
}
