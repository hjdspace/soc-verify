/**
 * Database router — 只读 SQLite 数据库查看能力。
 *
 * Procedure 列表：
 *  - database.checkDatabase：校验文件是否为有效 SQLite 数据库
 *  - database.listTables：列出所有用户表（排除 sqlite_ 前缀）及行数
 *  - database.getTableSchema：获取表的 CREATE TABLE 语句 + 列定义
 *  - database.queryTable：分页查询表数据（支持筛选 + 排序）
 *  - database.exportCsv：导出表数据为 CSV 字符串
 *
 * 所有操作以 readonly 模式打开数据库，使用后立即关闭连接。
 */

import { t, TRPCError } from '../router-context';
import {
  listTables,
  getTableSchema,
  queryTable,
  exportCsv,
  isSqliteFile,
  type FilterCondition,
} from '../../database/db-viewer';

/** 将 service 层错误映射为 tRPC 错误 */
function toTrpcError(err: unknown, operation: string): TRPCError {
  if (err instanceof Error) {
    return new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `${operation} failed: ${err.message}`,
      cause: err,
    });
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: `${operation} failed: ${String(err)}`,
  });
}

export const databaseRouter = t.router({
  /** 校验文件是否为有效 SQLite 数据库（magic bytes 检查） */
  checkDatabase: t.procedure
    .input((raw): { dbPath: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.dbPath !== 'string' || r.dbPath.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'dbPath is required' });
      }
      return { dbPath: r.dbPath };
    })
    .query(({ input }) => {
      return { valid: isSqliteFile(input.dbPath) };
    }),

  /** 列出数据库中所有用户表及行数 */
  listTables: t.procedure
    .input((raw): { dbPath: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.dbPath !== 'string' || r.dbPath.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'dbPath is required' });
      }
      return { dbPath: r.dbPath };
    })
    .query(({ input }) => {
      try {
        const tables = listTables(input.dbPath);
        return { tables };
      } catch (err) {
        throw toTrpcError(err, 'listTables');
      }
    }),

  /** 获取表的 Schema（建表 SQL + 列定义） */
  getTableSchema: t.procedure
    .input((raw): { dbPath: string; table: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.dbPath !== 'string' || r.dbPath.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'dbPath is required' });
      }
      if (typeof r.table !== 'string' || r.table.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'table is required' });
      }
      return { dbPath: r.dbPath, table: r.table };
    })
    .query(({ input }) => {
      try {
        return getTableSchema(input.dbPath, input.table);
      } catch (err) {
        throw toTrpcError(err, 'getTableSchema');
      }
    }),

  /** 分页查询表数据（支持筛选 + 排序） */
  queryTable: t.procedure
    .input((raw): {
      dbPath: string;
      table: string;
      page: number;
      pageSize: number;
      sortColumn?: string;
      sortDirection?: 'asc' | 'desc';
      filters?: FilterCondition[];
    } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.dbPath !== 'string' || r.dbPath.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'dbPath is required' });
      }
      if (typeof r.table !== 'string' || r.table.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'table is required' });
      }
      if (typeof r.page !== 'number' || r.page < 1) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'page must be >= 1' });
      }
      if (typeof r.pageSize !== 'number' || r.pageSize < 1) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'pageSize must be >= 1' });
      }
      const sortColumn = typeof r.sortColumn === 'string' ? r.sortColumn : undefined;
      const sortDirection = r.sortDirection === 'desc' ? 'desc' : r.sortDirection === 'asc' ? 'asc' : undefined;
      const filters = Array.isArray(r.filters)
        ? r.filters.filter(
            (f): f is FilterCondition =>
              typeof f === 'object' && f !== null &&
              typeof (f as Record<string, unknown>).column === 'string' &&
              typeof (f as Record<string, unknown>).operator === 'string' &&
              typeof (f as Record<string, unknown>).value === 'string',
          )
        : undefined;
      return { dbPath: r.dbPath, table: r.table, page: r.page, pageSize: r.pageSize, sortColumn, sortDirection, filters };
    })
    .query(({ input }) => {
      try {
        return queryTable(
          input.dbPath,
          input.table,
          input.page,
          input.pageSize,
          input.sortColumn,
          input.sortDirection,
          input.filters,
        );
      } catch (err) {
        throw toTrpcError(err, 'queryTable');
      }
    }),

  /** 导出表数据为 CSV 字符串 */
  exportCsv: t.procedure
    .input((raw): {
      dbPath: string;
      table: string;
      sortColumn?: string;
      sortDirection?: 'asc' | 'desc';
      filters?: FilterCondition[];
    } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.dbPath !== 'string' || r.dbPath.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'dbPath is required' });
      }
      if (typeof r.table !== 'string' || r.table.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'table is required' });
      }
      const sortColumn = typeof r.sortColumn === 'string' ? r.sortColumn : undefined;
      const sortDirection = r.sortDirection === 'desc' ? 'desc' : r.sortDirection === 'asc' ? 'asc' : undefined;
      const filters = Array.isArray(r.filters)
        ? r.filters.filter(
            (f): f is FilterCondition =>
              typeof f === 'object' && f !== null &&
              typeof (f as Record<string, unknown>).column === 'string' &&
              typeof (f as Record<string, unknown>).operator === 'string' &&
              typeof (f as Record<string, unknown>).value === 'string',
          )
        : undefined;
      return { dbPath: r.dbPath, table: r.table, sortColumn, sortDirection, filters };
    })
    .mutation(({ input }) => {
      try {
        const csv = exportCsv(input);
        return { csv };
      } catch (err) {
        throw toTrpcError(err, 'exportCsv');
      }
    }),
});
