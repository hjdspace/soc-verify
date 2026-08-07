/**
 * DatabaseViewer — 只读 SQLite 数据库查看器。
 *
 * 布局：左侧表列表 + 右侧（数据/Schema 子标签页）
 * 功能：分页浏览、列筛选、列排序、CSV 导出、行详情弹窗、BLOB 十六进制预览
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Database as DatabaseIcon,
  Table as TableIcon,
  RefreshCw,
  Download,
  Loader2,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  X,
  Plus,
  Trash2,
  Search,
} from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';

// ── 类型定义 ──────────────────────────────────────────────

type TableInfo = { name: string; rowCount: number };
type ColumnInfo = { name: string; type: string; notNull: boolean; defaultValue: string | null; primaryKey: boolean };
type FilterCondition = { column: string; operator: string; value: string };
type SortDirection = 'asc' | 'desc';

type SubTab = 'data' | 'schema';

const PAGE_SIZE_OPTIONS = [20, 50, 100, 200];

const OPERATOR_OPTIONS = [
  { value: 'eq', label: '=' },
  { value: 'neq', label: '!=' },
  { value: 'gt', label: '>' },
  { value: 'lt', label: '<' },
  { value: 'gte', label: '>=' },
  { value: 'lte', label: '<=' },
  { value: 'contains', label: '包含' },
  { value: 'not_contains', label: '不包含' },
  { value: 'is_null', label: '为空' },
  { value: 'is_not_null', label: '不为空' },
];

// ── 工具函数 ──────────────────────────────────────────────

/** 将单元格值渲染为字符串 */
function renderCellValue(value: unknown): { text: string; isBlob: boolean } {
  if (value === null || value === undefined) return { text: 'NULL', isBlob: false };
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    const hex = Array.from(bytes.subarray(0, 64))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ');
    const suffix = bytes.length > 64 ? `... (${bytes.length} bytes)` : ` (${bytes.length} bytes)`;
    return { text: hex + suffix, isBlob: true };
  }
  if (typeof value === 'object') {
    return { text: JSON.stringify(value), isBlob: false };
  }
  return { text: String(value), isBlob: false };
}

/** 截断长文本 */
function truncate(text: string, maxLen = 80): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}

// ── 主组件 ────────────────────────────────────────────────

interface DatabaseViewerProps {
  filePath: string;
}

export function DatabaseViewer({ filePath }: DatabaseViewerProps) {
  const [valid, setValid] = useState<boolean | null>(null);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [subTab, setSubTab] = useState<SubTab>('data');
  const [loadingTables, setLoadingTables] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 校验 + 加载表列表
  const loadTables = useCallback(async () => {
    setLoadingTables(true);
    setError(null);
    try {
      const result = await trpc.database.listTables.query({ dbPath: filePath });
      setTables(result.tables);
      if (result.tables.length > 0 && !selectedTable) {
        setSelectedTable(result.tables[0].name);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingTables(false);
    }
  }, [filePath, selectedTable]);

  // 初始加载：校验 magic bytes
  useEffect(() => {
    let cancelled = false;
    setValid(null);
    trpc.database.checkDatabase
      .query({ dbPath: filePath })
      .then((result) => {
        if (cancelled) return;
        setValid(result.valid);
        if (result.valid) {
          void loadTables();
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setValid(false);
        }
      });
    return () => { cancelled = true; };
  }, [filePath, loadTables]);

  // ── 渲染 ──────────────────────────────────────────

  if (valid === null) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        正在校验数据库文件...
      </div>
    );
  }

  if (!valid) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <AlertCircle className="h-8 w-8 text-status-fail-foreground" />
        <div className="text-center">
          <div className="font-medium text-foreground">文件不支持</div>
          <div className="mt-1 text-xs">
            该文件不是有效的 SQLite 数据库文件，无法以数据库模式查看。
          </div>
        </div>
        <div className="text-[10px] text-muted-foreground/70" title={filePath}>
          {filePath}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <AlertCircle className="h-8 w-8 text-status-fail-foreground" />
        <div className="text-center">
          <div className="font-medium text-foreground">加载失败</div>
          <div className="mt-1 text-xs">{error}</div>
        </div>
        <button
          onClick={() => void loadTables()}
          className="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
        >
          <RefreshCw className="h-3 w-3" />
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-1 overflow-hidden">
      {/* ── 左侧：表列表 ───────────────────────────── */}
      <div className="flex w-48 shrink-0 flex-col border-r bg-secondary/20">
        <div className="flex items-center justify-between border-b px-2 py-1.5">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <DatabaseIcon className="h-3 w-3" />
            数据库表
          </div>
          <button
            onClick={() => void loadTables()}
            title="刷新表列表"
            className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>
        <div className="flex-1 overflow-auto">
          {loadingTables ? (
            <div className="flex items-center justify-center p-4 text-[11px] text-muted-foreground">
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              加载中...
            </div>
          ) : tables.length === 0 ? (
            <div className="p-4 text-center text-[11px] text-muted-foreground">
              无可用表
            </div>
          ) : (
            tables.map((table) => (
              <button
                key={table.name}
                onClick={() => {
                  setSelectedTable(table.name);
                  setSubTab('data');
                }}
                className={cn(
                  'flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs transition-colors',
                  selectedTable === table.name
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:bg-accent/50',
                )}
              >
                <TableIcon className="h-3 w-3 shrink-0 opacity-60" />
                <span className="flex-1 truncate">{table.name}</span>
                <span className="text-[9px] text-muted-foreground/70">{table.rowCount}</span>
              </button>
            ))
          )}
        </div>
      </div>

      {/* ── 右侧：数据/Schema ─────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {selectedTable ? (
          <>
            {/* 子标签页 */}
            <div className="flex h-7 shrink-0 items-center border-b bg-secondary/30">
              <SubTabButton active={subTab === 'data'} onClick={() => setSubTab('data')} label="数据" />
              <SubTabButton active={subTab === 'schema'} onClick={() => setSubTab('schema')} label="Schema" />
              <div className="ml-auto truncate px-3 text-[10px] text-muted-foreground">
                {selectedTable}
              </div>
            </div>

            {subTab === 'data' ? (
              <DataTabContent filePath={filePath} table={selectedTable} />
            ) : (
              <SchemaTabContent filePath={filePath} table={selectedTable} />
            )}
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
            请从左侧选择一张表
          </div>
        )}
      </div>
    </div>
  );
}

// ── 子标签页按钮 ──────────────────────────────────────────

function SubTabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex h-full items-center border-r px-3 text-[11px] transition-colors',
        active ? 'bg-background text-foreground font-medium' : 'text-muted-foreground hover:bg-background/50',
      )}
    >
      {label}
    </button>
  );
}

// ── Schema 子标签页 ───────────────────────────────────────

function SchemaTabContent({ filePath, table }: { filePath: string; table: string }) {
  const [schema, setSchema] = useState<{ sql: string; columns: ColumnInfo[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    trpc.database.getTableSchema
      .query({ dbPath: filePath, table })
      .then((result) => {
        if (!cancelled) setSchema(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [filePath, table]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        加载 Schema...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-status-fail-foreground">
        <AlertCircle className="mr-2 h-4 w-4" />
        {error}
      </div>
    );
  }

  if (!schema) return null;

  return (
    <div className="flex-1 overflow-auto p-3">
      {/* 建表 SQL */}
      <div className="mb-4">
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          建表语句
        </div>
        <pre className="overflow-auto rounded-md border border-border/50 bg-secondary/20 p-3 text-xs">
          <code className="font-mono">{schema.sql}</code>
        </pre>
      </div>

      {/* 列定义 */}
      <div>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          列定义 ({schema.columns.length})
        </div>
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b text-left text-[11px] uppercase text-muted-foreground">
              <th className="px-2 py-1">列名</th>
              <th className="px-2 py-1">类型</th>
              <th className="px-2 py-1">非空</th>
              <th className="px-2 py-1">主键</th>
              <th className="px-2 py-1">默认值</th>
            </tr>
          </thead>
          <tbody>
            {schema.columns.map((col) => (
              <tr key={col.name} className="border-b border-border/30">
                <td className="px-2 py-1 font-medium text-foreground">{col.name}</td>
                <td className="px-2 py-1 font-mono text-muted-foreground">{col.type || '(无)'}</td>
                <td className="px-2 py-1">
                  {col.notNull ? (
                    <span className="text-status-fail-foreground">NOT NULL</span>
                  ) : (
                    <span className="text-muted-foreground/50">-</span>
                  )}
                </td>
                <td className="px-2 py-1">
                  {col.primaryKey ? (
                    <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[9px] font-semibold text-primary">PK</span>
                  ) : (
                    <span className="text-muted-foreground/50">-</span>
                  )}
                </td>
                <td className="px-2 py-1 font-mono text-muted-foreground">{col.defaultValue ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── 数据子标签页 ──────────────────────────────────────────

function DataTabContent({ filePath, table }: { filePath: string; table: string }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sortColumn, setSortColumn] = useState<string | undefined>(undefined);
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [filters, setFilters] = useState<FilterCondition[]>([]);
  const [data, setData] = useState<{ rows: Record<string, unknown>[]; totalRows: number } | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRow, setSelectedRow] = useState<Record<string, unknown> | null>(null);
  const [exporting, setExporting] = useState(false);

  // 加载数据
  const loadData = useCallback(() => {
    setLoading(true);
    setError(null);
    trpc.database.queryTable
      .query({
        dbPath: filePath,
        table,
        page,
        pageSize,
        sortColumn,
        sortDirection,
        filters: filters.length > 0 ? filters : undefined,
      })
      .then((result) => {
        setData({ rows: result.rows, totalRows: result.totalRows });
        // 从第一行提取列名（如果没有行，尝试从 schema 获取）
        if (result.rows.length > 0) {
          setColumns(Object.keys(result.rows[0]));
        }
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [filePath, table, page, pageSize, sortColumn, sortDirection, filters]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // 重置分页当筛选/排序改变
  useEffect(() => {
    setPage(1);
  }, [filters, sortColumn, sortDirection, pageSize]);

  const totalPages = data ? Math.max(1, Math.ceil(data.totalRows / pageSize)) : 1;

  const handleSort = (col: string) => {
    if (sortColumn === col) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(col);
      setSortDirection('asc');
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const result = await trpc.database.exportCsv.mutate({
        dbPath: filePath,
        table,
        sortColumn,
        sortDirection,
        filters: filters.length > 0 ? filters : undefined,
      });
      // 创建下载
      const blob = new Blob([result.csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${table}_export.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  };

  const handleAddFilter = () => {
    if (columns.length === 0) return;
    setFilters([...filters, { column: columns[0], operator: 'eq', value: '' }]);
  };

  const handleRemoveFilter = (index: number) => {
    setFilters(filters.filter((_, i) => i !== index));
  };

  const handleUpdateFilter = (index: number, field: keyof FilterCondition, value: string) => {
    setFilters(filters.map((f, i) => (i === index ? { ...f, [field]: value } : f)));
  };

  // ── 渲染 ──────────────────────────────────────────

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      {/* 工具栏 */}
      <div className="flex items-center gap-2 border-b bg-secondary/20 px-3 py-1.5">
        <button
          onClick={() => void loadData()}
          title="刷新"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
          刷新
        </button>
        <button
          onClick={() => void handleExport()}
          disabled={exporting}
          title="导出 CSV"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          {exporting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
          导出 CSV
        </button>
        <div className="ml-auto flex items-center gap-2">
          {data && (
            <span className="text-[10px] text-muted-foreground">
              {data.totalRows} 行
            </span>
          )}
          <select
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value))}
            className="rounded border border-border bg-background px-1 py-0.5 text-[10px] text-foreground"
          >
            {PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>{size} 行/页</option>
            ))}
          </select>
        </div>
      </div>

      {/* 筛选栏 */}
      <div className="border-b bg-secondary/10 px-3 py-1">
        <div className="flex items-center gap-2">
          <Search className="h-3 w-3 text-muted-foreground" />
          <span className="text-[10px] text-muted-foreground">筛选</span>
          {filters.map((filter, index) => (
            <div key={index} className="flex items-center gap-1">
              <select
                value={filter.column}
                onChange={(e) => handleUpdateFilter(index, 'column', e.target.value)}
                className="rounded border border-border bg-background px-1 py-0.5 text-[10px]"
              >
                {columns.map((col) => (
                  <option key={col} value={col}>{col}</option>
                ))}
              </select>
              <select
                value={filter.operator}
                onChange={(e) => handleUpdateFilter(index, 'operator', e.target.value)}
                className="rounded border border-border bg-background px-1 py-0.5 text-[10px]"
              >
                {OPERATOR_OPTIONS.map((op) => (
                  <option key={op.value} value={op.value}>{op.label}</option>
                ))}
              </select>
              {filter.operator !== 'is_null' && filter.operator !== 'is_not_null' && (
                <input
                  type="text"
                  value={filter.value}
                  onChange={(e) => handleUpdateFilter(index, 'value', e.target.value)}
                  placeholder="值"
                  className="w-24 rounded border border-border bg-background px-1.5 py-0.5 text-[10px]"
                />
              )}
              <button
                onClick={() => handleRemoveFilter(index)}
                className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Trash2 className="h-2.5 w-2.5" />
              </button>
            </div>
          ))}
          <button
            onClick={handleAddFilter}
            disabled={columns.length === 0}
            className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            <Plus className="h-2.5 w-2.5" />
            添加条件
          </button>
        </div>
      </div>

      {/* 数据表格 */}
      <div className="min-w-0 flex-1 overflow-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            加载中...
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center text-xs text-status-fail-foreground">
            <AlertCircle className="mr-2 h-4 w-4" />
            {error}
          </div>
        ) : !data || data.rows.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            无数据
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10">
              <tr className="border-b bg-secondary/40 text-left text-[10px] uppercase text-muted-foreground">
                {columns.map((col) => (
                  <th
                    key={col}
                    className="cursor-pointer whitespace-nowrap px-2 py-1 hover:text-foreground"
                    onClick={() => handleSort(col)}
                  >
                    <div className="flex items-center gap-0.5">
                      {col}
                      {sortColumn === col && (
                        sortDirection === 'asc'
                          ? <ChevronUp className="h-2.5 w-2.5" />
                          : <ChevronDown className="h-2.5 w-2.5" />
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, rowIndex) => (
                <tr
                  key={rowIndex}
                  className="cursor-pointer border-b border-border/30 hover:bg-accent/30"
                  onClick={() => setSelectedRow(row)}
                >
                  {columns.map((col) => {
                    const { text, isBlob } = renderCellValue(row[col]);
                    return (
                      <td
                        key={col}
                        className={cn(
                          'max-w-48 truncate px-2 py-1',
                          isBlob && 'font-mono text-muted-foreground',
                          row[col] === null && 'italic text-muted-foreground/50',
                        )}
                        title={text}
                      >
                        {truncate(text)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 分页 */}
      {data && (
        <div className="flex items-center justify-between border-t bg-secondary/20 px-3 py-1">
          <span className="text-[10px] text-muted-foreground">
            第 {page} / {totalPages} 页，共 {data.totalRows} 行
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(Math.max(1, page - 1))}
              disabled={page <= 1}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
            >
              <ChevronLeft className="h-3 w-3" />
            </button>
            <button
              onClick={() => setPage(Math.min(totalPages, page + 1))}
              disabled={page >= totalPages}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
            >
              <ChevronRight className="h-3 w-3" />
            </button>
          </div>
        </div>
      )}

      {/* 行详情弹窗 */}
      {selectedRow && (
        <RowDetailDialog
          row={selectedRow}
          columns={columns}
          onClose={() => setSelectedRow(null)}
        />
      )}
    </div>
  );
}

// ── 行详情弹窗 ────────────────────────────────────────────

function RowDetailDialog({
  row,
  columns,
  onClose,
}: {
  row: Record<string, unknown>;
  columns: string[];
  onClose: () => void;
}) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="flex max-h-[80%] w-[600px] flex-col overflow-hidden rounded-md border border-border bg-popover shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 弹窗头 */}
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-xs font-semibold text-foreground">行详情</span>
          <button
            onClick={onClose}
            className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        {/* 弹窗内容 */}
        <div className="overflow-auto">
          <table className="w-full text-xs">
            <tbody>
              {columns.map((col) => {
                const { text, isBlob } = renderCellValue(row[col]);
                return (
                  <tr key={col} className="border-b border-border/30">
                    <td className="w-32 shrink-0 bg-secondary/20 px-3 py-1.5 font-medium text-foreground align-top">
                      {col}
                    </td>
                    <td className={cn('px-3 py-1.5 font-mono', isBlob && 'text-muted-foreground')}>
                      <div className="break-all whitespace-pre-wrap">{text}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
