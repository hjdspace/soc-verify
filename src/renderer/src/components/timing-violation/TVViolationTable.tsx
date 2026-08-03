/**
 * TVViolationTable — 虚拟滚动违例列表表格
 *
 * 使用 @tanstack/react-virtual 实现虚拟滚动，支持几十万条数据流畅滚动。
 * 表格每行显示 NUM、Hier、Time、Check 摘要、确认状态（颜色标记）。
 * 点击列头切换排序，点击行展开查看违例详情。
 */

import { useRef, useState, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronUp, ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { formatTimeDisplay } from '@renderer/lib/tv-utils';
import type {
  ViolationWithConfirmation,
  SortField,
  SortOrder,
  ConfirmationStatus,
} from '@renderer/stores/timing-violation';

type ViolationTableProps = {
  violations: ViolationWithConfirmation[];
  total: number;
  loading: boolean;
  sortField: SortField;
  sortOrder: SortOrder;
  onSort: (field: SortField) => void;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
};

const ROW_HEIGHT = 36;
const EXPANDED_ROW_HEIGHT = 120;

const STATUS_STYLES: Record<ConfirmationStatus, { dot: string; text: string; label: string }> = {
  pending: { dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400', label: '待确认' },
  confirmed: { dot: 'bg-green-500', text: 'text-green-600 dark:text-green-400', label: '已确认' },
  ignored: { dot: 'bg-gray-400', text: 'text-gray-500', label: '已忽略' },
};

type ColumnDef = {
  key: SortField;
  label: string;
  width: string;
};

const COLUMNS: ColumnDef[] = [
  { key: 'num', label: 'NUM', width: 'w-16' },
  { key: 'hier', label: 'Hierarchy', width: 'flex-1' },
  { key: 'time_fs', label: '时间', width: 'w-28' },
  { key: 'created_at', label: '导入时间', width: 'w-36' },
];

export function TVViolationTable({
  violations,
  total,
  loading,
  sortField,
  sortOrder,
  onSort,
  page,
  pageSize,
  onPageChange,
}: ViolationTableProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const toggleExpand = useCallback((id: number) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  const rowVirtualizer = useVirtualizer({
    count: violations.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) =>
      violations[index]?.id === expandedId ? EXPANDED_ROW_HEIGHT : ROW_HEIGHT,
    overscan: 10,
  });

  const totalPages = Math.ceil(total / pageSize);

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return null;
    return sortOrder === 'asc'
      ? <ChevronUp className="inline h-2.5 w-2.5" />
      : <ChevronDown className="inline h-2.5 w-2.5" />;
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* 表头 */}
      <div className="flex shrink-0 items-center border-b bg-secondary/30 px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <div className="w-8" />
        {COLUMNS.map((col) => (
          <button
            key={col.key}
            onClick={() => onSort(col.key)}
            className={cn(
              'flex items-center gap-0.5 px-2 py-1.5 text-left hover:text-foreground transition-colors',
              col.width,
            )}
          >
            {col.label}
            <SortIcon field={col.key} />
          </button>
        ))}
        <div className="w-24 px-2 py-1.5">状态</div>
      </div>

      {/* 虚拟滚动区域 */}
      <div ref={parentRef} className="flex-1 overflow-auto">
        {loading && violations.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            加载中...
          </div>
        ) : violations.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <p>暂无违例数据</p>
            <p className="text-[11px]">点击上方"选择文件"按钮导入 vio_summary.log</p>
          </div>
        ) : (
          <div
            style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: 'relative' }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const v = violations[virtualRow.index];
              if (!v) return null;
              const isExpanded = v.id === expandedId;
              const statusStyle = STATUS_STYLES[v.status];

              return (
                <div
                  key={v.id}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {/* 主行 */}
                  <div
                    onClick={() => toggleExpand(v.id)}
                    className={cn(
                      'flex cursor-pointer items-center border-b border-border/30 text-xs transition-colors hover:bg-accent/30',
                      isExpanded && 'bg-accent/20',
                    )}
                    style={{ height: ROW_HEIGHT }}
                  >
                    <div className="w-8 flex items-center justify-center">
                      <ChevronRight
                        className={cn(
                          'h-3 w-3 text-muted-foreground transition-transform',
                          isExpanded && 'rotate-90',
                        )}
                      />
                    </div>
                    <div className="w-16 px-2 tabular-nums text-muted-foreground">{v.num}</div>
                    <div className="flex-1 truncate px-2 font-mono text-foreground">
                      {v.hier}
                    </div>
                    <div className="w-28 px-2 tabular-nums text-muted-foreground">
                      {formatTimeDisplay(v.timeFs)}
                    </div>
                    <div className="w-36 truncate px-2 text-muted-foreground">
                      {v.createdAt}
                    </div>
                    <div className="w-24 px-2">
                      <span className="inline-flex items-center gap-1.5">
                        <span className={cn('size-1.5 rounded-full', statusStyle.dot)} />
                        <span className={cn('text-[11px]', statusStyle.text)}>
                          {statusStyle.label}
                        </span>
                      </span>
                    </div>
                  </div>

                  {/* 展开详情 */}
                  {isExpanded && (
                    <div
                      className="border-b bg-secondary/10 px-10 py-3"
                      style={{ height: EXPANDED_ROW_HEIGHT - ROW_HEIGHT }}
                    >
                      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[11px]">
                        <div>
                          <span className="text-muted-foreground">完整 Hier: </span>
                          <span className="font-mono text-foreground">{v.hier}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">原始时间: </span>
                          <span className="font-mono text-foreground">{v.timeDisplay}</span>
                        </div>
                        <div className="col-span-2">
                          <span className="text-muted-foreground">Check 信息: </span>
                          <span className="font-mono text-foreground break-all">{v.checkInfo}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">用例: </span>
                          <span className="text-foreground">{v.caseName}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Corner: </span>
                          <span className="text-foreground">{v.corner ?? '—'}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Seed: </span>
                          <span className="text-foreground">{v.seed ?? '—'}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">子系统: </span>
                          <span className="text-foreground">{v.subsys ?? '—'}</span>
                        </div>
                        <div className="col-span-2 truncate">
                          <span className="text-muted-foreground">文件路径: </span>
                          <span className="font-mono text-foreground">{v.filePath}</span>
                        </div>
                        {v.confirmer && (
                          <div>
                            <span className="text-muted-foreground">确认人: </span>
                            <span className="text-foreground">{v.confirmer}</span>
                          </div>
                        )}
                        {v.result && (
                          <div>
                            <span className="text-muted-foreground">确认结果: </span>
                            <span className="text-foreground">{v.result}</span>
                          </div>
                        )}
                        {v.reason && (
                          <div className="col-span-2">
                            <span className="text-muted-foreground">确认理由: </span>
                            <span className="text-foreground">{v.reason}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 分页栏 */}
      {total > 0 && (
        <div className="flex shrink-0 items-center justify-between border-t bg-secondary/20 px-3 py-1.5 text-[11px] text-muted-foreground">
          <span>
            共 {total.toLocaleString()} 条 · 第 {page}/{totalPages} 页
          </span>
          <div className="flex items-center gap-1">
            <button
              disabled={page <= 1}
              onClick={() => onPageChange(page - 1)}
              className="rounded border border-border px-2 py-0.5 transition-colors hover:bg-accent disabled:opacity-40"
            >
              上一页
            </button>
            <button
              disabled={page >= totalPages}
              onClick={() => onPageChange(page + 1)}
              className="rounded border border-border px-2 py-0.5 transition-colors hover:bg-accent disabled:opacity-40"
            >
              下一页
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
