/**
 * Case Database 管理 — 初始化、PRAGMA、关闭
 *
 * 参考 docs/adr/0017-case-database-architecture.md
 * 镜像 src/main/timing-violation/db/tv-database.ts 模式
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SCHEMA_SQL, PRAGMA_SQL } from './case-schema';

export type CaseDatabase = Database.Database;

/** 默认数据目录（相对于项目根目录） */
const DEFAULT_DATA_DIR = '.socverify';

/**
 * 获取数据库文件路径（位于项目 .socverify/ 目录下）。
 */
export function getDbPath(projectRoot: string): string {
  return resolve(projectRoot, DEFAULT_DATA_DIR, 'cases.db');
}

/**
 * 确保数据库目录存在。
 */
function ensureDbDir(dbFullPath: string): void {
  const dir = dirname(dbFullPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * 初始化数据库（创建文件、执行 PRAGMA、创建表和索引）。
 *
 * @param dbFullPath 数据库文件完整路径
 * @returns better-sqlite3 Database 实例
 */
export function initDatabase(dbFullPath: string): CaseDatabase {
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
export function closeDatabase(db: CaseDatabase): void {
  if (db.open) {
    db.close();
  }
}

/**
 * 创建内存数据库（用于测试）。
 */
export function createMemoryDatabase(): CaseDatabase {
  const db = new Database(':memory:');
  // 内存数据库不需要 WAL 模式
  db.exec(`
    PRAGMA synchronous = NORMAL;
    PRAGMA cache_size = 10000;
    PRAGMA temp_store = MEMORY;
  `);
  db.exec(SCHEMA_SQL);
  return db;
}
