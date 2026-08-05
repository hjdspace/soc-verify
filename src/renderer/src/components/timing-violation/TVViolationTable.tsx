/**
 * TVViolationTable — 虚拟滚动违例列表表格
 *
 * 使用 @tanstack/react-virtual 实现虚拟滚动，支持几十万条数据流畅滚动。
 * 表格每行显示 NUM、Hier、Time、Check 摘要、确认状态（颜色标记）。
 * 点击列头切换排序，点击行展开查看违例详情。
 * 行首有 checkbox 支持多选，用于批量确认/忽略。
 *
 * 使用 measureElement 动态测量行高，确保展开行不与下方行重叠。
 */

import { useRef, useState, useCallback, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronUp, ChevronDown, ChevronRight, Sparkles, Loader2, Check, XCircle } from 'lucide-react';
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
  selectedViolationIds: Set<number>;
  onToggleSelect: (id: number) => void;
  onSelectAll: () => void;
  onRowConfirm: (violation: ViolationWithConfirmation) => void;
  onRowAISuggest: (violation: ViolationWithConfirmation) => void;
  aiSuggestingViolationId: number | null;
  aiSuggestionViolationId: number | null;
  aiSuggestion: { confirmer: string | undefined; result: string | undefined; reason: string | undefined; confidence: number; analysis?: string } | null;
  onApplyAISuggestion: (violation: ViolationWithConfirmation) => void;
  onClearAISuggestion: () => void;
};

const ROW_HEIGHT = 36;

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
  { key: 'hier', label: 'Hierarchy', width: 'flex-1 min-w-0' },
  { key: 'time_fs', label: '时间', width: 'w-28' },
];

type RenderItem =
  | { type: 'group'; caseName: string; count: number }
  | { type: 'violation'; violation: ViolationWithConfirmation; violationIndex: number };

const GROUP_HEADER_HEIGHT = 30;

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
  selectedViolationIds,
  onToggleSelect,
  onSelectAll,
  onRowConfirm,
  onRowAISuggest,
  aiSuggestingViolationId,
  aiSuggestionViolationId,
  aiSuggestion,
  onApplyAISuggestion,
  onClearAISuggestion,
}: ViolationTableProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const toggleExpand = useCallback((id: number) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  const toggleGroup = useCallback((caseName: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(caseName)) {
        next.delete(caseName);
      } else {
        next.add(caseName);
      }
      return next;
    });
  }, []);

  // 当存在多个用例时，按用例名分组展示（可折叠）
  const flatItems = useMemo<RenderItem[]>(() => {
    const distinctCases = new Set(violations.map((v) => v.caseName));
    const shouldGroup = distinctCases.size > 1;

    if (!shouldGroup) {
      return violations.map((v, i) => ({
        type: 'violation' as const,
        violation: v,
        violationIndex: i,
      }));
    }

    // 按用例名分组，保持原始顺序
    const groupMap = new Map<string, ViolationWithConfirmation[]>();
    for (const v of violations) {
      const arr = groupMap.get(v.caseName) ?? [];
      arr.push(v);
      groupMap.set(v.caseName, arr);
    }

    const items: RenderItem[] = [];
    for (const [caseName, groupViolations] of groupMap) {
      items.push({ type: 'group', caseName, count: groupViolations.length });
      if (!collapsedGroups.has(caseName)) {
        for (const v of groupViolations) {
          items.push({ type: 'violation', violation: v, violationIndex: items.length });
        }
      }
    }
    return items;
  }, [violations, collapsedGroups]);

  const rowVirtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index: number) => {
      const item = flatItems[index];
      return item && item.type === 'group' ? GROUP_HEADER_HEIGHT : ROW_HEIGHT;
    },
    overscan: 10,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  const totalPages = Math.ceil(total / pageSize);
  const allSelected = violations.length > 0 && violations.every((v) => selectedViolationIds.has(v.id));
  const someSelected = violations.some((v) => selectedViolationIds.has(v.id));

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return null;
    return sortOrder === 'asc'
      ? <ChevronUp className="inline h-2.5 w-2.5" />
      : <ChevronDown className="inline h-2.5 w-2.5" />;
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* 表头 */}
      <div className="flex shrink-0 items-center border-b bg-secondary/30 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {/* Checkbox 列 */}
        <div className="w-8 flex items-center justify-center">
          <input
            type="checkbox"
            checked={allSelected}
            ref={(el) => { if (el) el.indeterminate = !allSelected && someSelected; }}
            onChange={onSelectAll}
            className="h-3.5 w-3.5"
            title={allSelected ? '取消全选' : '全选当前页'}
          />
        </div>
        <div className="w-5" />
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
        {/* Check 摘要列（不可排序） */}
        <div className="flex-1 min-w-0 px-2 py-1.5">Check</div>
        <div className="w-24 px-2 py-1.5">状态</div>
        <div className="w-28 px-2 py-1.5">操作</div>
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
              const item = flatItems[virtualRow.index];
              if (!item) return null;

              // 分组标题行
              if (item.type === 'group') {
                const isCollapsed = collapsedGroups.has(item.caseName);
                return (
                  <div
                    key={`group-${item.caseName}`}
                    data-index={virtualRow.index}
                    ref={rowVirtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <div
                      className="flex items-center border-b border-border bg-secondary/50 px-2 cursor-pointer select-none hover:bg-secondary/70 transition-colors"
                      style={{ height: GROUP_HEADER_HEIGHT }}
                      onClick={() => toggleGroup(item.caseName)}
                    >
                      <div className="w-8" />
                      <div className="w-5 flex items-center justify-center">
                        {isCollapsed ? (
                          <ChevronRight className="h-3 w-3 text-muted-foreground" />
                        ) : (
                          <ChevronDown className="h-3 w-3 text-muted-foreground" />
                        )}
                      </div>
                      <span className="px-2 text-xs font-semibold text-foreground">{item.caseName}</span>
                      <span className="ml-1 text-[10px] text-muted-foreground">({item.count} 条)</span>
                    </div>
                  </div>
                );
              }

              // 违例行
              const v = item.violation;
              const isExpanded = v.id === expandedId;
              const isSelected = selectedViolationIds.has(v.id);
              const statusStyle = STATUS_STYLES[v.status];

              return (
                <div
                  key={v.id}
                  data-index={virtualRow.index}
                  ref={rowVirtualizer.measureElement}
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
                    className={cn(
                      'flex items-center border-b border-border/30 px-2 text-xs transition-colors hover:bg-accent/30',
                      isExpanded && 'bg-accent/20',
                      isSelected && 'bg-primary/5',
                    )}
                    style={{ height: ROW_HEIGHT }}
                  >
                    {/* Checkbox */}
                    <div className="w-8 flex items-center justify-center">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => onToggleSelect(v.id)}
                        className="h-3.5 w-3.5"
                        onClick={(e) => e.stopPropagation()}
                      />
                    </div>
                    {/* 展开按钮 */}
                    <div
                      className="w-5 flex items-center justify-center cursor-pointer"
                      onClick={() => toggleExpand(v.id)}
                    >
                      <ChevronRight
                        className={cn(
                          'h-3 w-3 text-muted-foreground transition-transform',
                          isExpanded && 'rotate-90',
                        )}
                      />
                    </div>
                    <div
                      className="w-16 px-2 tabular-nums text-muted-foreground cursor-pointer"
                      onClick={() => toggleExpand(v.id)}
                    >
                      {v.num}
                    </div>
                    <div
                      className="flex-1 min-w-0 truncate px-2 font-mono text-foreground cursor-pointer"
                      onClick={() => toggleExpand(v.id)}
                    >
                      {v.hier}
                    </div>
                    <div
                      className="w-28 px-2 tabular-nums text-muted-foreground cursor-pointer"
                      onClick={() => toggleExpand(v.id)}
                    >
                      {formatTimeDisplay(v.timeFs)}
                    </div>
                    <div
                      className="flex-1 min-w-0 truncate px-2 text-muted-foreground cursor-pointer"
                      onClick={() => toggleExpand(v.id)}
                    >
                      {v.checkInfo}
                    </div>
                    <div className="w-24 px-2">
                      <span className="inline-flex items-center gap-1.5">
                        <span className={cn('size-1.5 rounded-full', statusStyle.dot)} />
                        <span className={cn('text-[11px]', statusStyle.text)}>
                          {statusStyle.label}
                        </span>
                      </span>
                    </div>
                    {/* 操作按钮 */}
                    <div className="w-28 px-2 flex items-center gap-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onRowConfirm(v);
                        }}
                        className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                        title="确认此违例"
                      >
                        确认
                      </button>
                      {aiSuggestingViolationId === v.id ? (
                        <Loader2 className="size-3 animate-spin text-primary" />
                      ) : (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onRowAISuggest(v);
                          }}
                          className="flex items-center gap-0.5 rounded border border-border px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/10 transition-colors"
                          title="AI 智能建议"
                        >
                          <Sparkles className="size-2.5" />
                          AI
                        </button>
                      )}
                    </div>
                  </div>

                  {/* 展开详情 */}
                  {isExpanded && (
                    <div className="border-b bg-secondary/10 px-10 py-3">
                      {/* AI 建议展示 */}
                      {aiSuggestionViolationId === v.id && aiSuggestion && (
                        <div className="mb-3 rounded border border-primary/30 bg-primary/5 px-3 py-2">
                          {/* 当前违例标识 */}
                          <div className="mb-2 rounded bg-background/60 px-2 py-1.5">
                            <div className="text-[10px] font-semibold uppercase text-muted-foreground">
                              当前分析的违例
                            </div>
                            <div className="mt-0.5 flex items-center gap-3 text-[11px]">
                              <span className="font-mono font-semibold text-primary">Vio#{v.num}</span>
                              <span className="truncate font-mono text-foreground">{v.hier}</span>
                            </div>
                            <div className="mt-0.5 flex items-center gap-3 text-[10px] text-muted-foreground">
                              <span>时间: {formatTimeDisplay(v.timeFs)}</span>
                              <span>用例: {v.caseName}</span>
                              <span>Corner: {v.corner ?? '默认 (未匹配)'}</span>
                            </div>
                          </div>

                          {/* AI 建议标题 + 置信度 */}
                          <div className="mb-2 flex items-center justify-between">
                            <div className="flex items-center gap-1.5">
                              <Sparkles className="size-3 text-primary" />
                              <span className="text-[11px] font-semibold text-primary">AI 分析建议</span>
                              {aiSuggestion.confidence > 0 && (
                                <div className="flex items-center gap-1">
                                  <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                                    <div
                                      className={cn(
                                        'h-full rounded-full transition-all',
                                        aiSuggestion.confidence >= 0.7
                                          ? 'bg-green-500'
                                          : aiSuggestion.confidence >= 0.4
                                            ? 'bg-amber-500'
                                            : 'bg-red-500',
                                      )}
                                      style={{ width: `${Math.round(aiSuggestion.confidence * 100)}%` }}
                                    />
                                  </div>
                                  <span className="text-[10px] text-muted-foreground">
                                    {Math.round(aiSuggestion.confidence * 100)}%
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>

                          {/* 结构化展示 AI 建议 */}
                          <div className="space-y-1.5">
                            {aiSuggestion.confirmer && (
                              <div className="flex items-start gap-2 text-[11px]">
                                <span className="shrink-0 text-muted-foreground">确认人:</span>
                                <span className="text-foreground">{aiSuggestion.confirmer}</span>
                              </div>
                            )}
                            {aiSuggestion.result && (
                              <div className="flex items-start gap-2 text-[11px]">
                                <span className="shrink-0 text-muted-foreground">确认结果:</span>
                                <span className={cn(
                                  'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium',
                                  aiSuggestion.result === 'pass'
                                    ? 'bg-green-500/15 text-green-600 dark:text-green-400'
                                    : 'bg-red-500/15 text-red-600 dark:text-red-400',
                                )}>
                                  {aiSuggestion.result === 'pass' ? '✓ Pass' : '✗ Issue'}
                                </span>
                              </div>
                            )}
                            {aiSuggestion.reason && (
                              <div className="flex items-start gap-2 text-[11px]">
                                <span className="shrink-0 text-muted-foreground">分析理由:</span>
                                <span className="text-foreground">{aiSuggestion.reason}</span>
                              </div>
                            )}
                            {aiSuggestion.analysis && (
                              <div className="flex items-start gap-2 text-[11px]">
                                <span className="shrink-0 text-muted-foreground">详细分析:</span>
                                <span className="text-muted-foreground">{aiSuggestion.analysis}</span>
                              </div>
                            )}
                          </div>

                          {/* 操作按钮：确认 / 重新分析 / 拒绝 */}
                          <div className="mt-2 flex items-center gap-1.5">
                            {aiSuggestion.confirmer && aiSuggestion.result && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onApplyAISuggestion(v);
                                }}
                                className="flex items-center gap-0.5 rounded bg-primary px-2.5 py-1 text-[10px] font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                              >
                                <Check className="size-2.5" />
                                确认并应用
                              </button>
                            )}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onClearAISuggestion();
                                onRowAISuggest(v);
                              }}
                              className="flex items-center gap-0.5 rounded border border-primary/40 bg-primary/5 px-2.5 py-1 text-[10px] font-medium text-primary hover:bg-primary/10 transition-colors"
                            >
                              <Sparkles className="size-2.5" />
                              重新分析
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onClearAISuggestion();
                              }}
                              className="flex items-center gap-0.5 rounded border border-border px-2.5 py-1 text-[10px] font-medium text-muted-foreground hover:bg-accent transition-colors"
                            >
                              <XCircle className="size-2.5" />
                              拒绝
                            </button>
                          </div>
                        </div>
                      )}
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
                        <div>
                          <span className="text-muted-foreground">导入时间: </span>
                          <span className="text-foreground">{v.createdAt}</span>
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
            {selectedViolationIds.size > 0 && (
              <span className="ml-2 text-primary">
                · 已选 {selectedViolationIds.size} 条
              </span>
            )}
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
