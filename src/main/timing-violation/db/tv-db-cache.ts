/**
 * TV DB Cache — 共享数据库实例缓存
 *
 * violation-router 和 confirmation-router 共用同一缓存，
 * 避免对同一个 projectId 创建多个数据库连接。
 */

import { loadTvConfig, getDbPath } from '../tv-config';
// getDbPath now takes dataDir (not dbPath) — same import, different semantics
import { initDatabase, type TvDatabase } from './tv-database';
import { projectManager } from '../../project/project-manager';

const dbCache = new Map<string, TvDatabase>();

/**
 * 获取（或创建并缓存）指定 projectId 的数据库实例。
 * 内部通过 projectManager 解析 projectId → rootPath，
 * 再从 rootPath 加载配置和定位数据库文件。
 */
export function getTvDb(projectId: string): TvDatabase {
  let db = dbCache.get(projectId);
  if (!db) {
    const project = projectManager.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const config = loadTvConfig(project.rootPath);
    const dbPath = getDbPath(project.rootPath, config.dataDir);
    db = initDatabase(dbPath);
    dbCache.set(projectId, db);
  }
  return db;
}

/**
 * 清除指定 projectId 的缓存实例（配置变更后需要重建连接）。
 */
export function evictTvDb(projectId: string): void {
  dbCache.delete(projectId);
}
