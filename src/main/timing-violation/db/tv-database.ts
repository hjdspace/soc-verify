/**
 * 数据库管理 — 初始化、PRAGMA、关闭
 *
 * 参考 docs/adr/0012-better-sqlite3-for-timing-violation.md
 */

import Database from 'better-sqlite3';
import { SCHEMA_SQL, PRAGMA_SQL } from './tv-schema';
import { ensureDbDir } from '../tv-config';

export type TvDatabase = Database.Database;

/**
 * 初始化数据库（创建文件、执行 PRAGMA、创建表和索引）。
 *
 * @param dbFullPath 数据库文件完整路径
 * @returns better-sqlite3 Database 实例
 */
export function initDatabase(dbFullPath: string): TvDatabase {
  ensureDbDir(dbFullPath);
  const db = new Database(dbFullPath);

  // PRAGMA 优化
  db.exec(PRAGMA_SQL);

  // 创建表和索引
  db.exec(SCHEMA_SQL);

  return db;
}

/**
 * 关闭数据库连接。
 */
export function closeDatabase(db: TvDatabase): void {
  if (db.open) {
    db.close();
  }
}

/**
 * 创建内存数据库（用于测试）。
 */
export function createMemoryDatabase(): TvDatabase {
  const db = new Database(':memory:');
  db.exec(PRAGMA_SQL);
  db.exec(SCHEMA_SQL);
  return db;
}
