/**
 * Database Viewer Service — 只读 SQLite 数据库查看服务。
 *
 * 提供 magic bytes 校验、表列表、Schema 查询、分页数据查询、CSV 导出。
 * 所有数据库连接以 readonly 模式打开，使用完毕后立即关闭。
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

/** SQLite 文件 magic header（前 16 字节） */
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'utf-8');

/** 支持的数据库文件扩展名（小写、无前导点） */
export const DB_EXTENSIONS = new Set(['db', 'sqlite', 'sqlite3', 'db3']);

/** 筛选操作符 → SQL 片段映射 */
const OPERATOR_MAP: Record<string, string> = {
  eq: '=',
  neq: '!=',
  gt: '>',
  lt: '<',
  gte: '>=',
  lte: '<=',
};

/** WHERE 子句中禁止的关键字（防注入） */
const FORBIDDEN_KEYWORDS = /;\s|--|\/\*|\*\/|\bUNION\b|\bATTACH\b|\bPRAGMA\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bDROP\b|\bALTER\b|\bCREATE\b/i;

// ── 类型定义 ──────────────────────────────────────────────

export type TableInfo = {
  name: string;
  rowCount: number;
};

export type ColumnInfo = {
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
  primaryKey: boolean;
};

export type TableSchema = {
  sql: string;
  columns: ColumnInfo[];
};

export type FilterCondition = {
  column: string;
  operator: string;
  value: string;
};

export type QueryResult = {
  rows: Record<string, unknown>[];
  totalRows: number;
  page: number;
  pageSize: number;
};

export type ExportOptions = {
  dbPath: string;
  table: string;
  sortColumn?: string;
  sortDirection?: 'asc' | 'desc';
  filters?: FilterCondition[];
};

// ── 工具函数 ──────────────────────────────────────────────

/** 校验文件是否为 SQLite 数据库（检查 magic bytes） */
export function isSqliteFile(dbPath: string): boolean {
  try {
    const fd = readFileSync(dbPath, { encoding: null, flag: 'r' });
    if (fd.length < 16) return false;
    return Buffer.compare(fd.subarray(0, 16), SQLITE_MAGIC) === 0;
  } catch {
    return false;
  }
}

/** 以 readonly 模式打开数据库连接 */
function openReadonly(dbPath: string): Database.Database {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 3000');
  return db;
}

/** 验证表名是否为合法标识符（防注入） */
function validateIdentifier(name: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid ${label}: ${name}`);
  }
}

/** 验证筛选操作符是否合法 */
function validateOperator(op: string): string {
  const sqlOp = OPERATOR_MAP[op];
  if (!sqlOp && op !== 'is_null' && op !== 'is_not_null' && op !== 'contains' && op !== 'not_contains') {
    throw new Error(`Invalid filter operator: ${op}`);
  }
  return sqlOp ?? op;
}

/** 获取表的所有列名 */
function getTableColumns(db: Database.Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/** 用双引号包裹标识符 */
function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** 构建 WHERE 子句（参数化查询，防注入） */
function buildWhereClause(
  columns: string[],
  filters?: FilterCondition[],
): { clause: string; params: unknown[] } {
  if (!filters || filters.length === 0) {
    return { clause: '', params: [] };
  }

  const parts: string[] = [];
  const params: unknown[] = [];

  for (const f of filters) {
    if (!columns.includes(f.column)) {
      throw new Error(`Filter column not found in table: ${f.column}`);
    }
    const op = validateOperator(f.operator);
    const col = quoteIdentifier(f.column);

    if (f.operator === 'is_null') {
      parts.push(`${col} IS NULL`);
    } else if (f.operator === 'is_not_null') {
      parts.push(`${col} IS NOT NULL`);
    } else if (f.operator === 'contains') {
      parts.push(`${col} LIKE ?`);
      params.push(`%${f.value}%`);
    } else if (f.operator === 'not_contains') {
      parts.push(`${col} NOT LIKE ?`);
      params.push(`%${f.value}%`);
    } else {
      parts.push(`${col} ${op} ?`);
      params.push(f.value);
    }
  }

  return { clause: `WHERE ${parts.join(' AND ')}`, params };
}

/** 构建 ORDER BY 子句 */
function buildOrderBy(
  columns: string[],
  sortColumn?: string,
  sortDirection?: 'asc' | 'desc',
): string {
  if (!sortColumn) return '';
  if (!columns.includes(sortColumn)) {
    throw new Error(`Sort column not found in table: ${sortColumn}`);
  }
  const dir = sortDirection === 'desc' ? 'DESC' : 'ASC';
  return `ORDER BY ${quoteIdentifier(sortColumn)} ${dir}`;
}

// ── 公共 API ──────────────────────────────────────────────

/** 列出数据库中所有用户表（排除 sqlite_ 前缀内部表） */
export function listTables(dbPath: string): TableInfo[] {
  if (!isSqliteFile(dbPath)) {
    throw new Error('Not a valid SQLite database file');
  }

  const db = openReadonly(dbPath);
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;

    return tables.map((t) => {
      const count = db.prepare(`SELECT COUNT(*) as cnt FROM ${quoteIdentifier(t.name)}`).get() as { cnt: number };
      return { name: t.name, rowCount: count.cnt };
    });
  } finally {
    db.close();
  }
}

/** 获取表的 Schema（建表 SQL + 列定义） */
export function getTableSchema(dbPath: string, table: string): TableSchema {
  validateIdentifier(table, 'table name');
  if (!isSqliteFile(dbPath)) {
    throw new Error('Not a valid SQLite database file');
  }

  const db = openReadonly(dbPath);
  try {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?")
      .get(table) as { sql: string } | undefined;

    if (!row || !row.sql) {
      throw new Error(`Table not found: ${table}`);
    }

    const colRows = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;

    const columns: ColumnInfo[] = colRows.map((c) => ({
      name: c.name,
      type: c.type,
      notNull: c.notnull === 1,
      defaultValue: c.dflt_value,
      primaryKey: c.pk > 0,
    }));

    return { sql: row.sql, columns };
  } finally {
    db.close();
  }
}

/** 分页查询表数据（支持筛选 + 排序） */
export function queryTable(
  dbPath: string,
  table: string,
  page: number,
  pageSize: number,
  sortColumn?: string,
  sortDirection?: 'asc' | 'desc',
  filters?: FilterCondition[],
): QueryResult {
  validateIdentifier(table, 'table name');
  if (!isSqliteFile(dbPath)) {
    throw new Error('Not a valid SQLite database file');
  }

  // 安全限制
  if (page < 1) page = 1;
  if (pageSize < 1 || pageSize > 500) pageSize = 50;

  const db = openReadonly(dbPath);
  try {
    const columns = getTableColumns(db, table);
    if (columns.length === 0) {
      throw new Error(`Table not found or empty: ${table}`);
    }

    const { clause: whereClause, params: whereParams } = buildWhereClause(columns, filters);
    const orderBy = buildOrderBy(columns, sortColumn, sortDirection);

    // 总行数（带筛选）
    const countSql = `SELECT COUNT(*) as cnt FROM ${quoteIdentifier(table)} ${whereClause}`;
    const countRow = db.prepare(countSql).get(...whereParams) as { cnt: number };
    const totalRows = countRow.cnt;

    // 分页数据
    const offset = (page - 1) * pageSize;
    const dataSql = `SELECT * FROM ${quoteIdentifier(table)} ${whereClause} ${orderBy} LIMIT ? OFFSET ?`;
    const rows = db.prepare(dataSql).all(...whereParams, pageSize, offset) as Record<string, unknown>[];

    return { rows, totalRows, page, pageSize };
  } finally {
    db.close();
  }
}

/** 导出表数据为 CSV（不受分页限制，受筛选+排序约束） */
export function exportCsv(options: ExportOptions): string {
  const { dbPath, table, sortColumn, sortDirection, filters } = options;
  validateIdentifier(table, 'table name');
  if (!isSqliteFile(dbPath)) {
    throw new Error('Not a valid SQLite database file');
  }

  const db = openReadonly(dbPath);
  try {
    const columns = getTableColumns(db, table);
    if (columns.length === 0) {
      throw new Error(`Table not found or empty: ${table}`);
    }

    const { clause: whereClause, params: whereParams } = buildWhereClause(columns, filters);
    const orderBy = buildOrderBy(columns, sortColumn, sortDirection);

    // 导出上限 10000 行，防止内存溢出
    const sql = `SELECT * FROM ${quoteIdentifier(table)} ${whereClause} ${orderBy} LIMIT 10000`;
    const rows = db.prepare(sql).all(...whereParams) as Record<string, unknown>[];

    // 构建 CSV
    const escapeCsv = (val: unknown): string => {
      if (val === null || val === undefined) return '';
      if (val instanceof Buffer) {
        // BLOB → 十六进制
        return val.toString('hex');
      }
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const header = columns.map(escapeCsv).join(',');
    const body = rows.map((row) => columns.map((col) => escapeCsv(row[col])).join(',')).join('\n');

    return `${header}\n${body}`;
  } finally {
    db.close();
  }
}
