import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Wrench, X } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import type { SubagentActivity } from '@renderer/stores/session-types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ThinkingOrb } from '@renderer/components/visual';

/**
 * Subagent 树形行卡片（DSH §7 形态：缩进树形行，无独立磁贴网格）。
 *
 * subagent 工具派遣子代理后作为其展开内容渲染：
 * - 每个 subagent 一行：状态点（running=追逐点阵）+ 名称 + 任务概要 + tabular 指标
 * - 点击行：右侧抽屉展示任务指令、当前工具活动与实时输出流
 *
 * 抽屉经 createPortal 挂到 document.body：行卡片的 fade-up 入场动画带
 * fill-mode both，最终帧 transform 会长期保留，使该祖先成为 position:fixed
 * 的包含块——不 portal 的话抽屉会被定位/裁剪在卡片内部（历史 bug）。
 *
 * 数据由 session store 的 subagent_lifecycle / subagent_progress 帧驱动，
 * 经 parentToolCallId 过滤后传入。任务概要优先取派遣参数快照
 * （assignment/description，经 resolvePiSubagentActivities 合并），实时帧只
 * 补充运行态字段（currentTool / recentOutput / tokens）。
 */

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

/** 运行中每秒重渲染（刷新用时指标），终态停止 */
function useTicker(active: boolean): void {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => tick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [active]);
}

/** 状态点样式：running 语义编织动画 / completed 绿 / failed 红 / aborted 灰 */
function statusDotEl(status: SubagentActivity['status']) {
  if (status === 'running') {
    return <ThinkingOrb state="weaving" size={20} theme="auto" />;
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

/** 任务概要：派遣参数快照优先，退回角色描述 */
function taskSummary(agent: SubagentActivity): string | undefined {
  const text = agent.assignment ?? agent.description;
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 单个树形行 */
function AgentRow({ agent, onClick }: { agent: SubagentActivity; onClick: () => void }) {
  const running = agent.status === 'running';
  useTicker(running);
  const duration = (agent.endedAt ?? Date.now()) - agent.startedAt;
  const summary = taskSummary(agent);
  const currentTool = running ? agent.currentTool : undefined;

  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`subagent-tile-${agent.id}`}
      className="ml-2 flex w-[calc(100%-0.5rem)] flex-col gap-px rounded-r-lg border-l border-[var(--dsw-border-l2)] px-1.5 py-1 text-left transition-colors hover:bg-[var(--dsw-hover-bg)]"
      title={summary ?? agent.agent}
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
        <span className="ml-auto shrink-0 font-mono text-[9px] tabular-nums text-muted-foreground/70">
          {fmtTokens(agent.tokens)} tok · {fmtDuration(duration)}
        </span>
      </div>
      {/* 任务概要：无快照时退回当前活动，再退回终态文案 */}
      <div className="flex items-center gap-2 pl-4">
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[10.5px]',
            summary ? 'text-[var(--dsw-label-secondary)]' : 'font-mono text-muted-foreground/60',
          )}
        >
          {summary
            ?? (running ? (currentTool ?? agent.lastIntent ?? '…') : '…')}
        </span>
      </div>
      {/* 运行中的当前工具活动（与概要同行会互相挤占，单列一行） */}
      {running && currentTool && summary && (
        <div className="flex items-center gap-1 pl-4 text-[10px] text-primary/80">
          <Wrench className="h-2.5 w-2.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate font-mono">{currentTool}</span>
        </div>
      )}
    </button>
  );
}

/** 右侧抽屉：任务指令 + 当前工具活动 + 实时输出流（portal 到 body，见文件头注释） */
function Drawer({ agent, onClose }: { agent: SubagentActivity; onClose: () => void }) {
  const running = agent.status === 'running';
  useTicker(running);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 输出流追加时自动滚动到底部；用户手动上滚后停止跟随
  const followRef = useRef(true);
  useEffect(() => {
    if (!followRef.current) return;
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [agent.recentOutput.length, agent.currentTool]);

  // store 侧已将引擎滚动窗口合并为正序累积日志，直接渲染
  const lines = agent.recentOutput;
  const duration = (agent.endedAt ?? Date.now()) - agent.startedAt;
  const currentTool = running ? agent.currentTool : undefined;
  const currentToolArgs = running ? agent.currentToolArgs : undefined;

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[1px]"
        onClick={onClose}
        data-testid="subagent-drawer-mask"
      />
      <aside
        className="fixed right-0 top-0 z-50 flex h-full w-[360px] max-w-[85vw] flex-col rounded-l-xl border-l border-[var(--dsw-border-l2)] bg-[var(--dsw-layer-1)] shadow-[var(--dsw-shadow-lv3)]"
        data-testid="subagent-drawer"
      >
        <header className="flex items-center gap-1.5 border-b border-[var(--dsw-border-l1)] px-3 py-2.5">
          {statusDotEl(agent.status)}
          <span className="truncate text-xs font-semibold text-foreground">{agent.agent}</span>
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em]',
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
            <div className="mb-1 text-[9px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/60">
              任务指令
            </div>
            <MarkdownRenderer content={agent.assignment ?? agent.description ?? ''} />
          </div>
        )}

        {/* 终态 Token 用量（父子归属，issue 05）/ 阻断原因显式展示 */}
        {agent.usage && (
          <div
            className="grid grid-cols-3 gap-x-3 gap-y-1 border-b border-[var(--dsw-border-l1)] px-3 py-2 font-mono text-[10px] tabular-nums text-muted-foreground"
            data-testid="subagent-usage"
          >
            <span>in {fmtTokens(agent.usage.input)}</span>
            <span>out {fmtTokens(agent.usage.output)}</span>
            <span>cache {fmtTokens(agent.usage.cacheRead)}</span>
            <span>{agent.usage.turns} turns</span>
            <span>{agent.usage.toolCalls} tools</span>
            <span>${agent.usage.costUsd.toFixed(4)}</span>
          </div>
        )}
        {agent.blockedReason && (
          <div
            className="border-b border-[var(--dsw-border-l1)] px-3 py-2 text-[10.5px] leading-relaxed text-destructive"
            data-testid="subagent-blocked-reason"
          >
            {agent.blockedReason}
          </div>
        )}

        {/* 当前工具活动：与主聊天框的工具行形态对齐 */}
        {(currentTool ?? (!running && agent.lastIntent)) && (
          <div
            className="flex items-center gap-1.5 border-b border-[var(--dsw-border-l1)] px-3 py-1.5"
            data-testid="subagent-current-tool"
          >
            <Wrench className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
              {currentTool ?? agent.lastIntent}
            </span>
            {currentToolArgs && (
              <span className="truncate font-mono text-[10px] text-muted-foreground/60" title={agent.currentToolArgs}>
                {agent.currentToolArgs}
              </span>
            )}
          </div>
        )}

        <div
          ref={logRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          className="flex-1 overflow-y-auto px-3 py-2"
        >
          {agent.lastIntent && running && (
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
            {running && (
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
    </>,
    document.body,
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
