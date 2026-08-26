/**
 * TodoPanel — 输入框上方的任务小卡（DSH §10.1 形态）。
 *
 * tip 面、radius 12、border-l1；头部：checklist 图标 + 「任务」 +
 * 进度分段文案 + chevron。展开列表 180px 帽：
 * 完成=绿实环勾、进行中=蓝环旋转、待处理=虚线环。
 * 空清单整体隐藏。
 */
import { memo, useMemo } from 'react';
import { Check, ChevronDown, ListTodo } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import type { TodoPhaseData, TodoItemData } from './tool-helpers';

// ── Todo item ───────────────────────────────────────────

function TodoItemView({ item }: { item: TodoItemData }) {
  return (
    <div className="flex items-center gap-2 rounded px-2 py-1 transition-colors hover:bg-[var(--dsw-hover-bg)]">
      {/* 状态环 */}
      <span
        className={cn(
          'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full',
          item.status === 'completed' && 'border-[1.5px] border-status-pass-foreground text-status-pass-foreground',
          item.status === 'in_progress' && 'border-[1.5px] border-l-primary border-t-primary [animation:ap-rotate_1s_linear_infinite]',
          item.status === 'pending' && 'border-[1.5px] border-dashed border-muted-foreground/50',
          item.status === 'abandoned' && 'border-[1.5px] border-dashed border-muted-foreground/30',
        )}
      >
        {item.status === 'completed' && <Check className="h-2 w-2" />}
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

      {/* Expanded body */}
      {!collapsed && (
        <div className="max-h-[180px] overflow-y-auto pb-1.5">
          {phases.map((phase, pi) => (
            <div key={pi}>
              {phases.length > 1 && (
                <div className="px-2.5 pb-0.5 pt-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground/60">
                  {phase.name}
                </div>
              )}
              {phase.items.map((item, ii) => (
                <TodoItemView key={`${pi}-${ii}`} item={item as TodoItemData} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export const TodoPanel = memo(TodoPanelImpl);
