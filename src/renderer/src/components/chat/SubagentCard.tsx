import { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import type { SubagentActivity } from '@renderer/stores/session';
import { MarkdownRenderer } from './MarkdownRenderer';

/**
 * Subagent 专用卡片（方案 C：聚合磁贴 + 抽屉详情）。
 *
 * task 工具派遣 subagent 后替换默认 TaskBody 渲染：
 * - 磁贴网格：每个 subagent 一个磁贴（状态点 + currentTool + token sparkline）
 * - 点击磁贴：右侧抽屉展示完整实时日志流（recentOutput 正序）
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

/** 状态点样式：running 脉冲 / completed 绿 / failed 红 / aborted 灰 */
function statusDotClass(status: SubagentActivity['status']): string {
  switch (status) {
    case 'running': return 'bg-primary animate-pulse';
    case 'completed': return 'bg-status-pass-foreground';
    case 'failed': return 'bg-status-fail-foreground';
    default: return 'bg-muted-foreground/40';
  }
}

function statusLabel(status: SubagentActivity['status']): string {
  switch (status) {
    case 'running': return 'running';
    case 'completed': return 'done';
    case 'failed': return 'failed';
    default: return 'aborted';
  }
}

/** token 增量迷你柱状图 */
function Sparkline({ history }: { history: number[] }) {
  const bars = history.slice(-12);
  const max = Math.max(1, ...bars);
  return (
    <div className="flex h-3 items-end gap-px" data-testid="subagent-sparkline">
      {bars.length === 0 && <span className="h-0.5 w-full rounded-sm bg-border" />}
      {bars.map((v, i) => (
        <span
          key={i}
          className="min-h-0.5 flex-1 rounded-sm bg-primary/40"
          style={{ height: `${Math.max(12, (v / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

/** 单个磁贴 */
function Tile({ agent, onClick }: { agent: SubagentActivity; onClick: () => void }) {
  const running = agent.status === 'running';
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`subagent-tile-${agent.id}`}
      className="flex flex-col gap-1 rounded-md border border-border/60 bg-background/40 px-2 py-1.5 text-left transition-colors hover:border-border hover:bg-secondary/40"
      title={agent.description ?? agent.agent}
    >
      <div className="flex items-center gap-1.5">
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', statusDotClass(agent.status))} />
        <span className="truncate text-[10px] font-semibold text-foreground/80">{agent.agent}</span>
        {running && <Loader2 className="ml-auto h-2 w-2 shrink-0 animate-spin text-primary/70" />}
      </div>
      <div
        className={cn(
          'h-4 truncate text-[10px]',
          running ? 'text-muted-foreground' : 'text-muted-foreground/50',
        )}
      >
        {running
          ? (agent.currentTool ?? agent.lastIntent ?? '…')
          : agent.status === 'completed' ? '\u2713 完成'
          : agent.status === 'failed' ? '\u2717 失败'
          : '\u2013 已中止'}
      </div>
      <Sparkline history={agent.tokenHistory} />
      <div className="flex justify-between text-[9px] tabular-nums text-muted-foreground/60">
        <span>{agent.toolCount} tools</span>
        <span>{fmtTokens(agent.tokens)} tok</span>
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

  // recentOutput 为倒序（[0] 最新），日志展示用正序
  const lines = [...agent.recentOutput].reverse();
  const duration = (agent.endedAt ?? Date.now()) - agent.startedAt;

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-background/60 backdrop-blur-[1px]"
        onClick={onClose}
        data-testid="subagent-drawer-mask"
      />
      <aside
        className="fixed right-0 top-0 z-50 flex h-full w-[420px] max-w-[85vw] flex-col border-l border-border bg-card shadow-2xl"
        data-testid="subagent-drawer"
      >
        <header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <span className={cn('h-2 w-2 rounded-full', statusDotClass(agent.status))} />
          <span className="text-xs font-bold">{agent.agent}</span>
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
              agent.status === 'running' && 'bg-primary/15 text-primary',
              agent.status === 'completed' && 'bg-status-pass/15 text-status-pass-foreground',
              agent.status === 'failed' && 'bg-status-fail/15 text-status-fail-foreground',
              agent.status === 'aborted' && 'bg-secondary text-muted-foreground',
            )}
          >
            {statusLabel(agent.status)}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded p-1 text-muted-foreground/60 transition-colors hover:bg-secondary hover:text-foreground"
            title="关闭 (Esc)"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </header>

        {(agent.assignment ?? agent.description) && (
          <div
            className="max-h-40 overflow-y-auto border-b border-border/60 px-3 py-2"
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
            <div className="mb-2 text-[11px] italic text-primary/80" data-testid="subagent-intent">
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

        <footer className="flex items-center gap-3 border-t border-border px-3 py-2 font-mono text-[10px] text-muted-foreground/70">
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
    <div className="px-2 py-1.5" data-testid="subagent-card">
      <div className="grid grid-cols-3 gap-1.5">
        {sorted.map((agent) => (
          <Tile key={agent.id} agent={agent} onClick={() => setOpenId(agent.id)} />
        ))}
      </div>
      {opened && <Drawer agent={opened} onClose={() => setOpenId(null)} />}
    </div>
  );
}
