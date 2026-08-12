/**
 * TodoPanel — Fixed panel above the chat input box.
 *
 * Shows the LLM's todo/task list with three-state items (pending / in_progress /
 * completed / abandoned), a progress ring, and a collapsible item list.
 * The panel stays visible during chat and is updated in real-time as the LLM
 * calls the `todo` tool.
 */
import { memo, useMemo } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import type { TodoPhaseData, TodoItemData } from './tool-helpers';

// ── Progress ring ───────────────────────────────────────

const RING_RADIUS = 11;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS; // ≈ 69.12

function ProgressRing({ percent, allDone }: { percent: number; allDone: boolean }) {
  const dashoffset = RING_CIRCUMFERENCE * (1 - percent / 100);
  const color = allDone ? 'var(--status-pass-foreground)' : 'var(--primary)';

  return (
    <div className="relative h-7 w-7 shrink-0">
      <svg viewBox="0 0 28 28" className="h-full w-full -rotate-90">
        <circle
          cx="14" cy="14" r={RING_RADIUS}
          fill="none"
          stroke="var(--secondary)"
          strokeWidth="3"
        />
        <circle
          cx="14" cy="14" r={RING_RADIUS}
          fill="none"
          stroke={color}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={dashoffset}
          style={{ transition: 'stroke-dashoffset 0.4s ease, stroke 0.3s ease' }}
        />
      </svg>
      <div
        className="absolute inset-0 flex items-center justify-center text-[9px] font-bold tabular-nums"
        style={{ color }}
      >
        {allDone ? <Check className="h-3.5 w-3.5" /> : `${Math.round(percent)}%`}
      </div>
    </div>
  );
}

// ── Todo item ───────────────────────────────────────────

function TodoItemView({ item }: { item: TodoItemData }) {
  const iconContent = item.status === 'completed' ? <Check className="h-2.5 w-2.5" />
    : item.status === 'in_progress' ? <span className="text-[8px]">▶</span>
    : item.status === 'abandoned' ? <span className="text-[8px]">–</span>
    : null;

  return (
    <div className={cn('flex items-start gap-2 rounded px-2 py-1.5 transition-colors hover:bg-secondary/40')}>
      <span
        className={cn(
          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded text-[8px] font-bold',
          item.status === 'completed' && 'bg-status-pass-foreground text-background',
          item.status === 'in_progress' && 'border-[1.5px] border-primary bg-primary/20 text-primary',
          item.status === 'pending' && 'border-[1.5px] border-border bg-transparent',
          item.status === 'abandoned' && 'border-[1.5px] border-muted-foreground/40 bg-transparent text-muted-foreground/40',
        )}
      >
        {iconContent}
      </span>
      <span
        className={cn(
          'flex-1 min-w-0 text-[11px] leading-relaxed',
          item.status === 'completed' && 'text-muted-foreground/50 line-through',
          item.status === 'in_progress' && 'font-medium text-foreground',
          item.status === 'pending' && 'text-muted-foreground',
          item.status === 'abandoned' && 'text-muted-foreground/40 line-through',
        )}
      >
        {item.text}
        {item.status === 'in_progress' && (
          <span
            className="ml-1.5 inline-block h-1 w-1 animate-pulse rounded-full bg-primary align-middle"
            style={{ animationDuration: '1.2s' }}
          />
        )}
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
  const { allItems, completedCount, inProgressCount, percent, allDone } = useMemo(() => {
    const items = phases.flatMap((p) => p.items);
    const done = items.filter((i) => i.status === 'completed').length;
    const inProg = items.filter((i) => i.status === 'in_progress').length;
    const total = items.length;
    const pct = total > 0 ? (done / total) * 100 : 0;
    return {
      allItems: items,
      completedCount: done,
      inProgressCount: inProg,
      percent: pct,
      allDone: total > 0 && done === total,
    };
  }, [phases]);

  if (allItems.length === 0) return null;

  const statusText = allDone
    ? `${completedCount}/${allItems.length} 已完成`
    : isExecuting
      ? `${completedCount}/${allItems.length} 已完成 · 更新中...`
      : inProgressCount > 0
        ? `${completedCount}/${allItems.length} 已完成 · ${inProgressCount} 项进行中`
        : `${completedCount}/${allItems.length} 已完成 · 待开始`;

  return (
    <div className="shrink-0 border-t bg-card">
      {/* Summary bar (click to toggle) */}
      <div
        onClick={onToggleCollapse}
        className="flex cursor-pointer items-center gap-2 px-3 py-2 transition-colors hover:bg-accent select-none"
      >
        <ProgressRing percent={percent} allDone={allDone} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <span
              className={allDone ? 'text-status-pass-foreground' : 'text-violet-foreground'}
              style={allDone ? { color: 'var(--status-pass-foreground)' } : undefined}
            >
              <Check className="h-3 w-3" />
            </span>
            <span className={allDone ? 'text-status-pass-foreground' : undefined} style={allDone ? { color: 'var(--status-pass-foreground)' } : undefined}>
              {allDone ? '排查计划 — 全部完成' : '排查计划'}
            </span>
          </div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">{statusText}</div>
        </div>

        <button
          onClick={(e) => { e.stopPropagation(); onToggleCollapse(); }}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-secondary"
          title={collapsed ? '展开' : '折叠'}
        >
          <ChevronDown
            className={cn('h-3.5 w-3.5 transition-transform', !collapsed && 'rotate-180')}
          />
        </button>
      </div>

      {/* Progress bar (thin line at bottom of summary) */}
      <div className="h-0.5 overflow-hidden bg-secondary">
        <div
          className="h-full transition-all duration-400"
          style={{
            width: `${percent}%`,
            background: allDone ? 'var(--status-pass-foreground)' : 'var(--primary)',
            transitionDuration: '400ms',
          }}
        />
      </div>

      {/* Expanded body */}
      {!collapsed && (
        <div className="max-h-80 overflow-y-auto">
          {phases.map((phase, pi) => (
            <div key={pi} className="px-3 py-1.5">
              {phases.length > 1 && (
                <div className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground/60">
                  {phase.name}
                </div>
              )}
              {phase.items.map((item, ii) => (
                <TodoItemView key={ii} item={item} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export const TodoPanel = memo(TodoPanelImpl);
