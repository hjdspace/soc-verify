/**
 * TodoPanel — 输入框上方的任务小卡（DSH §10.1 形态）。
 *
 * tip 面、radius 12、border-l1；头部：checklist 图标 + 「任务」 +
 * 进度分段文案 + chevron。展开体 grid-rows 0fr→1fr 入场（折叠为卸载）；
 * 任务行为独立卡片（input-major 面 + lv2 阴影），错峰 fade-up 入场
 * （i*80ms，跨阶段全局递增）；终态徽章 pop-in：完成=绿实徽勾、
 * 放弃=红实徽 X + 红 tint 重试 pill（图标旋转）；进行中=蓝环旋转、
 * 待处理=虚线环。空清单整体隐藏。
 * 视觉/交互参考 beautiful-ui:
 * D:\AI\beautiful-ui\components\primitives\TaskRows.tsx
 * （useTick 脚本化演示状态机不移植）
 */
import { memo, useMemo } from 'react';
import { Check, ChevronDown, ListTodo, RotateCcw, X } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import type { TodoPhaseData, TodoItemData } from './tool-helpers';

// ── Todo item ───────────────────────────────────────────

function TodoItemView({ item, index }: { item: TodoItemData; index: number }) {
  return (
    <div
      className="ap-todo-row flex items-center gap-2 rounded-lg border border-[var(--dsw-border-l1)] bg-[var(--dsw-input-major)] px-2 py-1 shadow-[var(--dsw-shadow-lv2)]"
      style={{ animationDelay: `${index * 80}ms` }}
    >
      {/* 状态徽章：终态实徽 pop-in，进行中旋转环，待处理虚线环 */}
      <span
        className={cn(
          'flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
          item.status === 'completed' && 'ap-todo-badge bg-status-pass text-background',
          item.status === 'in_progress' &&
            'border-[1.5px] border-l-primary border-t-primary [animation:spin_1s_linear_infinite]',
          item.status === 'pending' && 'border-[1.5px] border-dashed border-muted-foreground/50',
          item.status === 'abandoned' && 'ap-todo-badge bg-status-fail text-background',
        )}
      >
        {item.status === 'completed' && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
        {item.status === 'abandoned' && <X className="h-2.5 w-2.5" strokeWidth={3} />}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-[11px] leading-relaxed',
          item.status === 'completed' && 'text-muted-foreground/50 line-through',
          item.status === 'in_progress' && 'font-medium text-foreground',
          item.status === 'pending' && 'text-muted-foreground',
          item.status === 'abandoned' && 'text-muted-foreground/40 line-through',
        )}
      >
        {item.text}
      </span>
      {/* 放弃态重试 pill：TaskRows Failed pill 同款（红 tint + 旋转重试图标） */}
      {item.status === 'abandoned' && (
        <span className="ap-todo-retry flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium">
          已放弃
          <RotateCcw className="ap-todo-retry-icon h-2.5 w-2.5" />
        </span>
      )}
    </div>
  );
}

// ── Main TodoPanel ──────────────────────────────────────

interface TodoPanelProps {
  phases: TodoPhaseData[];
  isExecuting: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

function TodoPanelImpl({ phases, isExecuting, collapsed, onToggleCollapse }: TodoPanelProps) {
  const { allItems, completedCount, inProgressCount, pendingCount, allDone } = useMemo(() => {
    const items = phases.flatMap((p) => p.items);
    const done = items.filter((i) => i.status === 'completed').length;
    const inProg = items.filter((i) => i.status === 'in_progress').length;
    const total = items.length;
    return {
      allItems: items,
      completedCount: done,
      inProgressCount: inProg,
      pendingCount: items.filter((i) => i.status === 'pending').length,
      allDone: total > 0 && done === total,
    };
  }, [phases]);

  if (allItems.length === 0) return null;

  // 进度分段文案：零段丢弃（DSH §10.1）
  const parts: string[] = [`${completedCount}/${allItems.length} 已完成`];
  if (!allDone) {
    if (isExecuting) parts.push('更新中...');
    else if (inProgressCount > 0) parts.push(`${inProgressCount} 项进行中`);
    else if (pendingCount > 0) parts.push('待开始');
  }
  const statusText = parts.join(' · ');

  return (
    <div className="mx-2 mb-2 shrink-0 overflow-hidden rounded-xl border border-[var(--dsw-border-l1)] bg-[var(--dsw-tip)]">
      {/* Summary bar (click to toggle) */}
      <div
        onClick={onToggleCollapse}
        className="flex cursor-pointer select-none items-center gap-2 px-2.5 py-2 transition-colors hover:bg-[var(--dsw-hover-bg)]"
      >
        <ListTodo
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            allDone ? 'text-status-pass-foreground' : 'text-muted-foreground',
          )}
        />
        <span
          className={cn(
            'shrink-0 text-xs font-semibold',
            allDone ? 'text-status-pass-foreground' : 'text-foreground',
          )}
        >
          {allDone ? '任务 — 全部完成' : '任务'}
        </span>
        <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">{statusText}</span>

        <button
          onClick={(e) => { e.stopPropagation(); onToggleCollapse(); }}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-[var(--dsw-hover-solid)]"
          title={collapsed ? '展开' : '折叠'}
        >
          <ChevronDown
            className={cn('h-3.5 w-3.5 transition-transform', !collapsed && 'rotate-180')}
          />
        </button>
      </div>

      {/* Expanded body — grid-rows 0fr→1fr 入场（折叠方向为卸载，保持「收起后不在文档」契约） */}
      {!collapsed && (
        <div className="ap-todo-body">
          <div className="min-h-0 overflow-hidden">
            <div className="max-h-[180px] overflow-y-auto px-1.5 pb-1.5 pt-1">
              {phases.map((phase, pi) => {
                // 错峰延迟跨阶段全局递增：本阶段首行索引 = 之前所有阶段行数之和
                const phaseOffset = phases.slice(0, pi).reduce((n, p) => n + p.items.length, 0);
                return (
                  <div key={pi}>
                    {phases.length > 1 && (
                      <div className="px-1 pb-1 pt-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground/60">
                        {phase.name}
                      </div>
                    )}
                    <div className="flex flex-col gap-1">
                      {phase.items.map((item, ii) => (
                        <TodoItemView
                          key={`${pi}-${ii}`}
                          item={item as TodoItemData}
                          index={phaseOffset + ii}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export const TodoPanel = memo(TodoPanelImpl);
