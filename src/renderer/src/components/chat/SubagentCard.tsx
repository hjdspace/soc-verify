import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import type { SubagentActivity } from '@renderer/stores/session-types';
import { MarkdownRenderer } from './MarkdownRenderer';

/**
 * Subagent 树形行卡片（DSH §7 形态：缩进树形行，无独立磁贴网格）。
 *
 * task 工具派遣 subagent 后替换默认 TaskBody 渲染：
 * - 每个 subagent 一行：状态点（running=追逐点阵）+ 名称 + 活动摘要 + tabular 指标
 * - 点击行：右侧抽屉展示完整实时日志流（recentOutput 正序）
 *
 * 数据由 session store 的 subagent_lifecycle / subagent_progress 帧驱动，
 * 经 parentToolCallId 过滤后传入。
 */

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

/** 状态点样式：running 追逐点阵 / completed 绿 / failed 红 / aborted 灰 */
function statusDotEl(status: SubagentActivity['status']) {
  if (status === 'running') {
    return (
      <span className="ap-chase" aria-hidden>
        <i /><i /><i /><i /><i /><i /><i /><i />
      </span>
    );
  }
  const cls = status === 'completed' ? 'bg-status-pass-foreground'
    : status === 'failed' ? 'bg-status-fail-foreground'
    : 'bg-muted-foreground/40';
  return <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', cls)} />;
}

function statusLabel(status: SubagentActivity['status']): string {
  switch (status) {
    case 'running': return '运行中';
    case 'completed': return '已完成';
    case 'failed': return '失败';
    default: return '已中止';
  }
}

/** 单个树形行 */
function AgentRow({ agent, onClick }: { agent: SubagentActivity; onClick: () => void }) {
  const running = agent.status === 'running';
  const duration = (agent.endedAt ?? Date.now()) - agent.startedAt;
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`subagent-tile-${agent.id}`}
      className="ml-2 flex w-[calc(100%-0.5rem)] flex-col gap-px rounded-r-lg border-l border-[var(--dsw-border-l2)] px-1.5 py-1 text-left transition-colors hover:bg-[var(--dsw-hover-bg)]"
      title={agent.description ?? agent.agent}
    >
      <div className="flex items-center gap-1.5">
        {statusDotEl(agent.status)}
        <span className="truncate text-[11px] font-medium text-foreground">{agent.agent}</span>
        <span className={cn(
          'shrink-0 text-[9px]',
          running && 'text-primary',
          !running && agent.status !== 'aborted' ? (
            agent.status === 'completed' ? 'text-status-pass-foreground' : 'text-destructive'
          ) : undefined,
          agent.status === 'aborted' && 'text-muted-foreground',
        )}>
          {statusLabel(agent.status)}
        </span>
      </div>
      <div className="flex items-center gap-2 pl-4">
        <span
          className={cn(
            'min-w-0 flex-1 truncate font-mono text-[10px]',
            running ? 'text-muted-foreground' : 'text-muted-foreground/60',
          )}
        >
          {running
            ? (agent.currentTool ?? agent.lastIntent ?? '…')
            : agent.status === 'completed' ? '\u2713 完成'
            : agent.status === 'failed' ? '\u2717 失败'
            : '\u2013 已中止'}
        </span>
        <span className="shrink-0 font-mono text-[9px] tabular-nums text-muted-foreground/70">
          {fmtTokens(agent.tokens)} tok · {fmtDuration(duration)}
        </span>
      </div>
    </button>
  );
}

/** 右侧抽屉：完整实时日志 */
function Drawer({ agent, onClose }: { agent: SubagentActivity; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // store 侧已将引擎滚动窗口合并为正序累积日志，直接渲染
  const lines = agent.recentOutput;
  const duration = (agent.endedAt ?? Date.now()) - agent.startedAt;

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[1px]"
        onClick={onClose}
        data-testid="subagent-drawer-mask"
      />
      <aside
        className="fixed right-0 top-0 z-50 flex h-full w-[320px] max-w-[85vw] flex-col rounded-l-xl border-l border-[var(--dsw-border-l2)] bg-[var(--dsw-layer-1)] shadow-[var(--dsw-shadow-lv3)]"
        data-testid="subagent-drawer"
      >
        <header className="flex items-center gap-1.5 border-b border-[var(--dsw-border-l1)] px-3 py-2.5">
          {statusDotEl(agent.status)}
          <span className="truncate text-xs font-semibold text-foreground">{agent.agent}</span>
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
              agent.status === 'running' && 'bg-primary/15 text-primary',
              agent.status === 'completed' && 'bg-status-pass/15 text-status-pass-foreground',
              agent.status === 'failed' && 'bg-destructive/15 text-destructive',
              agent.status === 'aborted' && 'bg-muted text-muted-foreground',
            )}
          >
            {statusLabel(agent.status)}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded p-1 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
            title="关闭 (Esc)"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </header>

        {(agent.assignment ?? agent.description) && (
          <div
            className="max-h-40 overflow-y-auto border-b border-[var(--dsw-border-l1)] px-3 py-2"
            data-testid="subagent-assignment"
          >
            <div className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground/60">
              任务指令
            </div>
            <MarkdownRenderer content={agent.assignment ?? agent.description ?? ''} />
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-3 py-2">
          {agent.lastIntent && agent.status === 'running' && (
            <div className="mb-2 font-mono text-[11px] italic text-primary/80" data-testid="subagent-intent">
              {agent.lastIntent}
            </div>
          )}
          <div className="space-y-0.5 font-mono text-[10.5px] leading-relaxed" data-testid="subagent-log">
            {lines.length === 0 && <div className="text-muted-foreground/50">暂无输出…</div>}
            {lines.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap break-all text-muted-foreground">
                {line}
              </div>
            ))}
            {agent.status === 'running' && (
              <span className="inline-block h-3 w-1 animate-pulse bg-primary align-middle" />
            )}
          </div>
        </div>

        <footer className="flex items-center gap-3 border-t border-[var(--dsw-border-l1)] px-3 py-2 font-mono text-[10px] tabular-nums text-muted-foreground/70">
          <span>{fmtDuration(duration)}</span>
          <span>{agent.toolCount} tools</span>
          <span>{agent.requests} reqs</span>
          <span className="ml-auto">{fmtTokens(agent.tokens)} tokens</span>
        </footer>
      </aside>
    </>
  );
}

export function SubagentCard({ agents }: { agents: SubagentActivity[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  // 按 index 排序保持派遣顺序稳定
  const sorted = [...agents].sort((a, b) => a.index - b.index);
  const opened = sorted.find((a) => a.id === openId) ?? null;

  return (
    <div className="flex flex-col gap-0.5 px-1 py-1" data-testid="subagent-card">
      {sorted.map((agent) => (
        <AgentRow key={agent.id} agent={agent} onClick={() => setOpenId(agent.id)} />
      ))}
      {opened && <Drawer agent={opened} onClose={() => setOpenId(null)} />}
    </div>
  );
}
