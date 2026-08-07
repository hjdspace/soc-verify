/**
 * database-viewer 端到端测试。
 *
 * 测试缝：直接调用 db-viewer service 层，使用真实 SQLite 临时文件。
 * 覆盖：magic bytes 校验、表列表、Schema 查询、分页查询（筛选+排序）、CSV 导出。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import {
  isSqliteFile,
  listTables,
  getTableSchema,
  queryTable,
  exportCsv,
} from '../../src/main/database/db-viewer';
import { databaseRouter } from '../../src/main/ipc/routers/database-router';

// ── 测试数据库搭建 ────────────────────────────────────────

let tempDir: string;
let dbPath: string;
let nonSqlitePath: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'db-viewer-test-'));
  dbPath = join(tempDir, 'test.db');
  nonSqlitePath = join(tempDir, 'fake.db');

  // 创建测试数据库
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT,
      age INTEGER,
      avatar BLOB
    );
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT,
      status TEXT DEFAULT 'draft'
    );
    CREATE TABLE sqlite_sequence (name TEXT, seq TEXT);
  `);

  // 插入测试数据
  const insertUser = db.prepare('INSERT INTO users (name, email, age, avatar) VALUES (?, ?, ?, ?)');
  insertUser.run('Alice', 'alice@example.com', 30, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  insertUser.run('Bob', 'bob@example.com', 25, null);
  insertUser.run('Charlie', 'charlie@example.com', 35, null);
  insertUser.run('David', null, 28, null);
  insertUser.run('Eve', 'eve@example.com', null, null);
  insertUser.run('Frank', 'frank@example.com', 40, Buffer.from([0xff, 0xd8, 0xff]));

  const insertPost = db.prepare('INSERT INTO posts (id, title, content, status) VALUES (?, ?, ?, ?)');
  insertPost.run(1, 'Hello World', 'My first post', 'published');
  insertPost.run(2, 'Second Post', 'Another post', 'draft');
  insertPost.run(3, 'SQLite Guide', 'A guide to SQLite', 'published');

  db.close();

  // 创建一个非 SQLite 的 .db 文件
  writeFileSync(nonSqlitePath, 'this is not a sqlite database file');
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ── 测试 ──────────────────────────────────────────────────

describe('db-viewer service', () => {
  // ─── isSqliteFile ────────────────────────────────────────

  describe('isSqliteFile', () => {
    it('对有效 SQLite 文件返回 true', () => {
      expect(isSqliteFile(dbPath)).toBe(true);
    });

    it('对非 SQLite 文件返回 false', () => {
      expect(isSqliteFile(nonSqlitePath)).toBe(false);
    });

    it('对不存在的文件返回 false', () => {
      expect(isSqliteFile(join(tempDir, 'nonexistent.db'))).toBe(false);
    });
  });

  // ─── listTables ──────────────────────────────────────────

  describe('listTables', () => {
    it('列出所有用户表及行数，排除 sqlite_ 前缀内部表', () => {
      const tables = listTables(dbPath);
      const names = tables.map((t) => t.name);
      expect(names).toContain('users');
      expect(names).toContain('posts');
      expect(names).not.toContain('sqlite_sequence');
      expect(names).not.toContain('sqlite_master');
    });

    it('users 表有 6 行', () => {
      const tables = listTables(dbPath);
      const usersTable = tables.find((t) => t.name === 'users');
      expect(usersTable?.rowCount).toBe(6);
    });

    it('posts 表有 3 行', () => {
      const tables = listTables(dbPath);
      const postsTable = tables.find((t) => t.name === 'posts');
      expect(postsTable?.rowCount).toBe(3);
    });

    it('对非 SQLite 文件抛出错误', () => {
      expect(() => listTables(nonSqlitePath)).toThrow('Not a valid SQLite database');
    });
  });

  // ─── getTableSchema ──────────────────────────────────────

  describe('getTableSchema', () => {
    it('返回 users 表的建表 SQL 和列定义', () => {
      const schema = getTableSchema(dbPath, 'users');
      expect(schema.sql).toContain('CREATE TABLE users');
      expect(schema.columns).toHaveLength(5);
    });

    it('id 列是主键', () => {
      const schema = getTableSchema(dbPath, 'users');
      const idCol = schema.columns.find((c) => c.name === 'id');
      expect(idCol?.primaryKey).toBe(true);
    });

    it('name 列是非空的', () => {
      const schema = getTableSchema(dbPath, 'users');
      const nameCol = schema.columns.find((c) => c.name === 'name');
      expect(nameCol?.notNull).toBe(true);
    });

    it('对不存在的表抛出错误', () => {
      expect(() => getTableSchema(dbPath, 'nonexistent_table')).toThrow('Table not found');
    });

    it('对非法表名抛出错误', () => {
      expect(() => getTableSchema(dbPath, 'users; DROP TABLE users')).toThrow('Invalid table name');
    });
  });

  // ─── queryTable ─────────────────────────────────────────

  describe('queryTable', () => {
    it('分页查询 users 表（第 1 页，每页 50 行）', () => {
      const result = queryTable(dbPath, 'users', 1, 50);
      expect(result.rows).toHaveLength(6);
      expect(result.totalRows).toBe(6);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(50);
    });

    it('分页查询 users 表（第 1 页，每页 3 行）', () => {
      const result = queryTable(dbPath, 'users', 1, 3);
      expect(result.rows).toHaveLength(3);
      expect(result.totalRows).toBe(6);
    });

    it('分页查询 users 表（第 2 页，每页 3 行）', () => {
      const result = queryTable(dbPath, 'users', 2, 3);
      expect(result.rows).toHaveLength(3);
      expect(result.totalRows).toBe(6);
    });

    it('按 age 降序排序', () => {
      const result = queryTable(dbPath, 'users', 1, 50, 'age', 'desc');
      const ages = result.rows.map((r) => r.age).filter((a) => a !== null);
      expect(ages).toEqual([40, 35, 30, 28, 25]);
    });

    it('按 name 升序排序', () => {
      const result = queryTable(dbPath, 'users', 1, 50, 'name', 'asc');
      expect(result.rows[0].name).toBe('Alice');
      expect(result.rows[1].name).toBe('Bob');
    });

    it('筛选 name 包含 "a" 的行', () => {
      const result = queryTable(dbPath, 'users', 1, 50, undefined, undefined, [
        { column: 'name', operator: 'contains', value: 'a' },
      ]);
      // Alice, Charlie, David, Frank
      expect(result.rows).toHaveLength(4);
      expect(result.totalRows).toBe(4);
    });

    it('筛选 age > 30 的行', () => {
      const result = queryTable(dbPath, 'users', 1, 50, undefined, undefined, [
        { column: 'age', operator: 'gt', value: '30' },
      ]);
      // Charlie (35), Frank (40)
      expect(result.rows).toHaveLength(2);
    });

    it('筛选 email 为空的行', () => {
      const result = queryTable(dbPath, 'users', 1, 50, undefined, undefined, [
        { column: 'email', operator: 'is_null', value: '' },
      ]);
      // David
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].name).toBe('David');
    });

    it('组合筛选 + 排序', () => {
      const result = queryTable(dbPath, 'users', 1, 50, 'age', 'desc', [
        { column: 'name', operator: 'contains', value: 'a' },
      ]);
      // Alice, Charlie, David, Frank — 按 age desc: Frank(40), Charlie(35), Alice(30), David(28)
      expect(result.rows).toHaveLength(4);
      expect(result.rows[0].name).toBe('Frank');
    });

    it('对非法表名抛出错误', () => {
      expect(() => queryTable(dbPath, 'users; DROP TABLE users', 1, 50)).toThrow('Invalid table name');
    });

    it('对非法筛选列名抛出错误', () => {
      expect(() =>
        queryTable(dbPath, 'users', 1, 50, undefined, undefined, [
          { column: 'nonexistent_col', operator: 'eq', value: '1' },
        ]),
      ).toThrow('Filter column not found');
    });
  });

  // ─── exportCsv ───────────────────────────────────────────

  describe('exportCsv', () => {
    it('导出 users 表全部数据为 CSV', () => {
      const csv = exportCsv({ dbPath, table: 'users' });
      const lines = csv.split('\n');
      // header + 6 rows
      expect(lines).toHaveLength(7);
      expect(lines[0]).toContain('id');
      expect(lines[0]).toContain('name');
      expect(lines[0]).toContain('email');
      expect(lines[0]).toContain('age');
      expect(lines[0]).toContain('avatar');
    });

    it('CSV 中包含 Alice', () => {
      const csv = exportCsv({ dbPath, table: 'users' });
      expect(csv).toContain('Alice');
      expect(csv).toContain('alice@example.com');
    });

    it('CSV 中 BLOB 被导出为十六进制', () => {
      const csv = exportCsv({ dbPath, table: 'users' });
      // Alice's avatar: 89 50 4e 47 → hex "89504e47"
      expect(csv).toContain('89504e47');
    });

    it('导出带筛选的 CSV', () => {
      const csv = exportCsv({
        dbPath,
        table: 'users',
        filters: [{ column: 'name', operator: 'eq', value: 'Alice' }],
      });
      const lines = csv.split('\n');
      // header + 1 row
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('Alice');
    });

    it('导出带排序的 CSV', () => {
      const csv = exportCsv({
        dbPath,
        table: 'users',
        sortColumn: 'name',
        sortDirection: 'desc',
      });
      const lines = csv.split('\n');
      // First data row should be Frank (desc order: Frank, Eve, David, Charlie, Bob, Alice)
      expect(lines[1]).toContain('Frank');
    });
  });
});

// ── Router 层测试（输入校验） ─────────────────────────────

describe('database-router input validation', () => {
  const caller = databaseRouter.createCaller({});

  it('checkDatabase 缺少 dbPath 时抛出 BAD_REQUEST', async () => {
    await expect(caller.checkDatabase({} as unknown as { dbPath: string })).rejects.toThrow('dbPath is required');
  });

  it('listTables 缺少 dbPath 时抛出 BAD_REQUEST', async () => {
    await expect(caller.listTables({} as unknown as { dbPath: string })).rejects.toThrow('dbPath is required');
  });

  it('getTableSchema 缺少 table 时抛出 BAD_REQUEST', async () => {
    await expect(caller.getTableSchema({ dbPath: '/tmp/test.db' } as unknown as { dbPath: string; table: string })).rejects.toThrow('table is required');
  });

  it('queryTable 缺少 page 时抛出 BAD_REQUEST', async () => {
    await expect(
      caller.queryTable({ dbPath, table: 'users', pageSize: 50 } as unknown as { dbPath: string; table: string; page: number; pageSize: number }),
    ).rejects.toThrow('page must be >= 1');
  });

  it('queryTable page < 1 时抛出 BAD_REQUEST', async () => {
    await expect(
      caller.queryTable({ dbPath: dbPath, table: 'users', page: 0, pageSize: 50 }),
    ).rejects.toThrow('page must be >= 1');
  });

  it('queryTable 端到端调用成功', async () => {
    const result = await caller.queryTable({
      dbPath: dbPath,
      table: 'users',
      page: 1,
      pageSize: 10,
    });
    expect(result.rows).toHaveLength(6);
    expect(result.totalRows).toBe(6);
  });

  it('exportCsv 端到端调用成功', async () => {
    const result = await caller.exportCsv({
      dbPath: dbPath,
      table: 'posts',
    });
    expect(result.csv).toContain('title');
    expect(result.csv).toContain('Hello World');
  });
});
