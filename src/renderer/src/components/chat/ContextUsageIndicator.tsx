import { useState, useRef, useEffect } from 'react';
import { Loader2, Minimize2 } from 'lucide-react';
import { DEFAULT_CONTEXT_WINDOW } from '@shared/context-management';
import type { SessionEntry } from '@renderer/stores/session-types';
import { cn } from '@renderer/lib/utils';

type ContextUsageIndicatorProps = {
  session: SessionEntry;
  onCompact: () => Promise<boolean>;
};

function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}k`;
  }
  return Math.max(0, Math.round(value)).toLocaleString();
}

export function ContextUsageIndicator({ session, onCompact }: ContextUsageIndicatorProps) {
  // `detailOpen` is toggled by click; stays open until user clicks again or
  // clicks outside.  Hover shows a lightweight tooltip with just the percent.
  const [detailOpen, setDetailOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const usage = session.contextUsage ?? {
    tokens: 0,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    percent: 0,
  };
  const percent = Math.min(100, Math.max(0, usage.percent));
  const remaining = Math.max(0, usage.contextWindow - usage.tokens);
  const isCompacting = session.isCompacting === true;
  const canCompact = session.status === 'idle'
    && usage.tokens > 0
    && !isCompacting
    && !session.contextCompacted;
  const breakdown = session.contextBreakdown;
  const ringColor = percent >= 90
    ? 'stroke-destructive'
    : percent >= 75 ? 'stroke-warning-foreground' : 'stroke-primary';

  // Close detail popover on outside click
  useEffect(() => {
    if (!detailOpen) return;
    function handleOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setDetailOpen(false);
      }
    }
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [detailOpen]);

  return (
    <div
      ref={containerRef}
      className="relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        aria-label={`上下文已使用 ${Math.round(percent)}%`}
        aria-expanded={detailOpen}
        onClick={() => setDetailOpen((v) => !v)}
        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
      >
        <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] -rotate-90" aria-hidden="true">
          <circle cx="12" cy="12" r="8" fill="none" strokeWidth="2.5" className="stroke-muted" />
          <circle
            cx="12"
            cy="12"
            r="8"
            fill="none"
            pathLength="100"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={`${percent} 100`}
            className={cn('transition-[stroke-dasharray] duration-200', ringColor)}
          />
        </svg>
      </button>

      {/* ── Hover tooltip: simple percent only ─────────────── */}
      {hovered && !detailOpen && (
        <div className="absolute bottom-7 right-0 z-50 rounded-md border border-border bg-popover px-2.5 py-1 text-popover-foreground shadow-xl">
          <span className="whitespace-nowrap font-mono text-[11px] font-medium">
            上下文已使用 {Math.round(percent)}%{usage.approximate ? '（近似）' : ''}
          </span>
        </div>
      )}

      {/* ── Click detail popover: full breakdown ───────────── */}
      <div
        className={cn(
          'absolute bottom-7 right-0 z-50 w-56 rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-xl transition-opacity duration-150',
          detailOpen
            ? 'visible pointer-events-auto opacity-100'
            : 'invisible pointer-events-none opacity-0',
        )}
      >
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-semibold">
            上下文用量
            {usage.approximate && (
              <span className="ml-1 text-[9px] font-normal text-muted-foreground">近似</span>
            )}
          </span>
          <span className="font-mono text-[11px] font-medium text-foreground">{Math.round(percent)}%</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              'h-full rounded-full transition-[width] duration-200',
              percent >= 90 ? 'bg-destructive' : percent >= 75 ? 'bg-warning-foreground' : 'bg-primary',
            )}
            style={{ width: `${percent}%` }}
          />
        </div>

        <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 text-[10px]">
          <dt className="text-muted-foreground">已使用</dt>
          <dd className="font-mono text-foreground">{formatTokens(usage.tokens)}</dd>
          <dt className="text-muted-foreground">剩余</dt>
          <dd className="font-mono text-foreground">{formatTokens(remaining)}</dd>
          <dt className="text-muted-foreground">窗口上限</dt>
          <dd className="font-mono text-foreground">{formatTokens(usage.contextWindow)}</dd>
          <dt className="text-muted-foreground">模型</dt>
          <dd className="max-w-32 truncate text-right text-foreground" title={session.model?.name}>
            {session.model?.name ?? '未选择'}
          </dd>
          <dt className="text-muted-foreground">自动压缩</dt>
          <dd className="text-foreground">{session.autoCompactionEnabled === false ? '关闭' : '开启'}</dd>
        </dl>

        {breakdown && (
          <div className="mt-3 border-t border-border/60 pt-2.5">
            <div className="mb-1.5 text-[9px] font-semibold uppercase text-muted-foreground">估算构成</div>
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-[10px]">
              <dt className="text-muted-foreground">消息</dt>
              <dd className="font-mono text-foreground">{formatTokens(breakdown.messagesTokens)}</dd>
              <dt className="text-muted-foreground">系统提示词</dt>
              <dd className="font-mono text-foreground">{formatTokens(breakdown.systemPromptTokens)}</dd>
              <dt className="text-muted-foreground">工具定义</dt>
              <dd className="font-mono text-foreground">{formatTokens(breakdown.systemToolsTokens)}</dd>
              <dt className="text-muted-foreground">项目上下文</dt>
              <dd className="font-mono text-foreground">{formatTokens(breakdown.systemContextTokens)}</dd>
              <dt className="text-muted-foreground">Skills</dt>
              <dd className="font-mono text-foreground">{formatTokens(breakdown.skillsTokens)}</dd>
            </dl>
          </div>
        )}

        <button
          type="button"
          onClick={() => {
            void onCompact().then((succeeded) => {
              if (succeeded) {
                setDetailOpen(false);
              }
            });
          }}
          disabled={!canCompact}
          className="mt-3 flex h-7 w-full items-center justify-center gap-1.5 rounded bg-primary/10 px-2 text-[10px] font-medium text-primary transition-colors hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isCompacting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Minimize2 className="h-3 w-3" />}
          {isCompacting ? '压缩中' : '手动压缩'}
        </button>
      </div>
    </div>
  );
}
