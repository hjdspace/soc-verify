/**
 * ToolRunGroup — 一轮连续工具调用的紧凑分组渲染（ToolChips 风格）。
 *
 * 视觉参考 beautiful-ui 的 ToolChips primitive：折叠头（N 个工具调用 · 用时）
 * + 行式工具条目（图标 · 标题 · 内联摘要 chip）+ 底部文件 diff chips
 * （hover 弹出行级 diff 预览，点击打开文件）。行展开后复用 tool-registry
 * 的专项展开体（ToolBodyView）。执行中的组自动展开、完成后自动折叠。
 *
 * 交互式工具（ask）不参与分组——见 groupToolMessages。
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { Sparkle } from 'lucide-react';
import { openReviewAwareFile } from '@renderer/stores/diff-review';
import { useSessionCoreStore } from '@renderer/stores/session-core';
import type { ChatMessage, SubagentActivity } from '@renderer/stores/session-types';
import { cn } from '@renderer/lib/utils';
import { ThinkingOrb } from '@renderer/components/visual';
import { getToolMeta, isSkillRead, extractResultText, hasResultWarning, SUBAGENT_TOOLS } from './tool-helpers';
import {
  getToolSummary,
  ToolBodyView,
  CATEGORY_ICON,
  toolToOrbState,
  NO_SUBAGENTS,
  isInteractiveTool,
} from './tool-registry';
import { getFileDiffPreview, type FileDiffPreview } from './tool-bodies/shared/diff-stats';

// ── 消息分组 ────────────────────────────────────────────

export type ToolRunItem =
  | { kind: 'card'; message: ChatMessage }
  | { kind: 'run'; messages: ChatMessage[] };

/**
 * 把消息流切分为渲染项：连续的非交互 tool 消息归入同一 run（group），
 * 其余消息（含交互式工具 ask）单独成 card 项，保持原 MessageBubble 渲染。
 */
export function groupToolMessages(messages: ChatMessage[]): ToolRunItem[] {
  const items: ToolRunItem[] = [];
  let run: ChatMessage[] = [];
  const flush = () => {
    if (run.length > 0) {
      items.push({ kind: 'run', messages: run });
      run = [];
    }
  };
  for (const message of messages) {
    if (message.role === 'tool' && !isInteractiveTool(message.toolName)) {
      run.push(message);
      continue;
    }
    flush();
    items.push({ kind: 'card', message });
  }
  flush();
  return items;
}

// ── 小工具 ──────────────────────────────────────────────

function isErrorMessage(message: ChatMessage): boolean {
  return typeof message.toolResult === 'object' && message.toolResult !== null
    && 'isError' in message.toolResult
    && (message.toolResult as { isError: boolean }).isError;
}

function messageDuration(message: ChatMessage): number | null {
  if (message.toolStartTime && message.toolEndTime) return message.toolEndTime - message.toolStartTime;
  if (message.toolStartTime && !message.toolResult) return Date.now() - message.toolStartTime;
  return null;
}

function formatDuration(ms: number): string {
  return ms > 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** diff chip hover 预览最多展示的行数，其余折叠为 footer 提示 */
const PREVIEW_MAX_LINES = 14;

// ── 工具行 ──────────────────────────────────────────────

function ToolRunRow({
  message,
  open,
  onToggle,
  animationDelay,
}: {
  message: ChatMessage;
  open: boolean;
  onToggle: (id: string) => void;
  animationDelay: number;
}) {
  const isExecuting = !message.toolResult;
  const meta = getToolMeta(message.toolName);
  const toolName = message.toolName ?? '';
  const resultText = extractResultText(message.toolResult);

  // task/subagent 工具：读取该 tool call 关联的 subagent 实时状态
  const taskAgents = useSessionCoreStore(useShallow((s) => {
    if (!SUBAGENT_TOOLS.has(message.toolName ?? '') || !message.toolCallId) return NO_SUBAGENTS;
    const list: SubagentActivity[] = [];
    for (const sess of s.sessions) {
      for (const a of Object.values(sess.subagents ?? {})) {
        if (a.parentToolCallId === message.toolCallId) list.push(a);
      }
    }
    return list.length > 0 ? list : NO_SUBAGENTS;
  }));

  // 执行中每秒重渲染以刷新用时
  const [, tick] = useState(0);
  useEffect(() => {
    if (!isExecuting || !message.toolStartTime) return;
    const interval = setInterval(() => tick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [isExecuting, message.toolStartTime]);

  const isError = isErrorMessage(message);
  const hasWarning = !isError && !isExecuting && hasResultWarning(resultText);
  const status: 'running' | 'error' | 'warn' | 'ok' = isExecuting
    ? 'running'
    : isError
      ? 'error'
      : hasWarning
        ? 'warn'
        : 'ok';

  const Icon = CATEGORY_ICON[meta.category] ?? Sparkle;
  const isSkill = toolName === 'read' && isSkillRead(message.toolArgs);
  const summary = getToolSummary(message, taskAgents);
  const duration = messageDuration(message);

  return (
    <div
      data-testid="tool-run-row"
      style={{ animation: `fade-up 300ms var(--ease-out-strong) ${animationDelay}ms both` }}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onToggle(message.id)}
        className={cn(
          'group/row -mx-[3px] flex h-7 w-[calc(100%+6px)] min-w-0 items-center gap-2 rounded-lg px-[3px] text-left transition-colors duration-100 hover:bg-[var(--dsw-hover-bg)]',
          isExecuting && 'ap-sweep',
        )}
      >
        {/* 前导格：状态机（DSH §6.1）；ok 行 hover 时图标切换为 chevron */}
        <span className="relative flex size-4 shrink-0 items-center justify-center text-muted-foreground" data-status={status}>
          {status === 'running' && (
            <ThinkingOrb state={toolToOrbState(toolName)} size={20} theme="auto" />
          )}
          {(status === 'error' || status === 'warn') && <span className="ap-sdot" data-status={status} />}
          {status === 'ok' && (
            <>
              <Icon className={cn(
                'h-3 w-3 shrink-0 transition-opacity duration-100 group-hover/row:opacity-0',
                open && 'opacity-0',
              )} />
              <svg
                width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                strokeLinecap="round" strokeLinejoin="round"
                className={cn(
                  'absolute transition-[opacity,transform] duration-150 group-hover/row:opacity-100',
                  open ? 'opacity-100' : 'opacity-0',
                )}
                style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }}
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </>
          )}
        </span>

        {/* 标题 · 技能徽标 */}
        <span className="shrink-0 text-[12.5px] font-medium text-foreground">{meta.label}</span>
        {isSkill && (
          <span className="flex shrink-0 items-center gap-0.5 rounded px-1 py-px text-[9px] font-medium text-primary-foreground bg-primary/15">
            <Sparkle className="h-2 w-2" />
            技能
          </span>
        )}

        {/* 内联摘要 chip */}
        <span
          className={cn(
            'inline-flex h-5.5 min-w-0 flex-1 items-center truncate rounded-md bg-[var(--dsw-selector)] px-1.5',
            'text-[11.5px] text-[var(--dsw-label-secondary)] shadow-[0_0_0_1px_var(--dsw-border-l1)]',
            'transition-colors duration-100 hover:bg-[var(--dsw-hover-solid)]',
            status === 'error' && 'text-destructive',
          )}
        >
          {summary}
        </span>

        {/* 用时 */}
        {duration != null && (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">
            {formatDuration(duration)}
          </span>
        )}
      </button>

      {/* 展开体：专项视图（与 ToolCard 共用 ToolBodyView 分发）。
          折叠时跳过渲染（而非 0fr 收起）——展开体含逐行高亮与大量 DOM，
          挂载即执行是切换会话卡秒级的主因之一；grid 动画只在展开后生效 */}
      {open ? (
        <div
          className="grid overflow-hidden transition-[grid-template-rows,opacity] duration-300"
          style={{
            gridTemplateRows: '1fr',
            opacity: 1,
            transitionTimingFunction: 'var(--ease-out-strong)',
          }}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="mb-1 ml-2 mr-0.5 mt-0.5 rounded-[10px] border border-[var(--dsw-border-l1)] bg-[var(--dsw-code-block)] px-1 pb-1 pt-0.5">
              <ToolBodyView message={message} taskAgents={taskAgents} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── diff chip hover 预览（portal 到 body，避免父级 transform 干扰定位） ──

type PreviewState = {
  file: FileDiffPreview;
  x: number;
  top?: number;
  bottom?: number;
};

function DiffPreviewCard({ preview }: { preview: PreviewState }) {
  const lines = preview.file.lines.slice(0, PREVIEW_MAX_LINES);
  const hidden = preview.file.lines.length - lines.length;
  return createPortal(
    <div
      data-testid="tool-diff-preview"
      className="ap-echip-float fixed z-50 w-72 overflow-hidden rounded-[10px] bg-[var(--dsw-layer-1)]"
      style={{
        left: preview.x,
        top: preview.top,
        bottom: preview.bottom,
        animation: 'pop-in 160ms var(--ease-out-strong) both',
        transformOrigin: preview.top === undefined ? 'bottom left' : 'top left',
      }}
    >
      <div className="flex items-center justify-between border-b border-[var(--dsw-border-l2)] px-2.5 py-1.5 font-mono text-[11px]">
        <span className="min-w-0 truncate text-[var(--dsw-label-secondary)]">{preview.file.path}</span>
        <span className="shrink-0 tabular-nums">
          <span className="text-[var(--dsw-success)]">+{preview.file.added}</span>
          {preview.file.deleted > 0 && <span className="text-[var(--dsw-error)]"> −{preview.file.deleted}</span>}
        </span>
      </div>
      <div className="py-1 font-mono text-[11px] leading-[1.8]">
        {lines.map((line, index) => (
          <div
            key={index}
            className={cn(
              'flex gap-2 whitespace-pre px-2.5',
              line.type === 'add' && 'bg-[color-mix(in_srgb,var(--dsw-success)_12%,transparent)] text-[var(--dsw-success)]',
              line.type === 'del' && 'bg-[color-mix(in_srgb,var(--dsw-error)_10%,transparent)] text-[var(--dsw-error)]',
              line.type === 'ctx' && 'text-[var(--dsw-label-secondary)]',
            )}
          >
            <span className="w-3 shrink-0 select-none">{line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '}</span>
            <span className="min-w-0 truncate">{line.content || ' '}</span>
          </div>
        ))}
        {hidden > 0 && (
          <div className="px-2.5 pt-0.5 text-[10px] text-[var(--dsw-label-tertiary)]">
            其余 {hidden} 行 — 点击 chip 打开文件
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ── ToolRunGroup ────────────────────────────────────────

export function ToolRunGroup({ messages }: { messages: ChatMessage[] }) {
  const anyExecuting = useMemo(() => messages.some((m) => !m.toolResult), [messages]);
  const [open, setOpen] = useState(anyExecuting);
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<PreviewState | null>(null);

  // 执行中自动展开（新行流式出现可见），回合完成自动折叠为紧凑头
  useEffect(() => {
    setOpen(anyExecuting);
  }, [anyExecuting]);

  // 组级计时：执行中每秒重渲染刷新头部用时
  const [, tick] = useState(0);
  useEffect(() => {
    if (!anyExecuting) return;
    const interval = setInterval(() => tick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [anyExecuting]);

  const toggleRow = (id: string) =>
    setOpenRows((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const diffFiles = useMemo(() => {
    const seen = new Set<string>();
    const list: { message: ChatMessage; file: FileDiffPreview }[] = [];
    for (const message of messages) {
      if (isErrorMessage(message)) continue;
      const file = getFileDiffPreview(message);
      if (!file || seen.has(file.path)) continue;
      seen.add(file.path);
      list.push({ message, file });
    }
    return list;
  }, [messages]);

  const openPreview = (file: FileDiffPreview) => (event: React.SyntheticEvent) => {
    const chip = (event.currentTarget as Element).closest('[data-diffchip]');
    if (!chip) return;
    const rect = chip.getBoundingClientRect();
    const previewHeight = 38 + Math.min(file.lines.length, PREVIEW_MAX_LINES) * 19;
    const fitsBelow = rect.bottom + 6 + previewHeight <= window.innerHeight - 12;
    setPreview({
      file,
      x: Math.max(12, Math.min(rect.left, window.innerWidth - 300)),
      ...(fitsBelow
        ? { top: rect.bottom + 6 }
        : { bottom: window.innerHeight - rect.top + 6 }),
    });
  };
  const closePreview = (path: string) => () =>
    setPreview((current) => (current?.file.path === path ? null : current));

  const openFile = (path: string) => {
    const fileName = path.replace(/\\/g, '/').split('/').pop() ?? path;
    openReviewAwareFile(path, fileName);
  };

  // 头部统计
  const total = messages.length;
  const failCount = messages.filter(isErrorMessage).length;
  const totalDuration = messages.reduce((sum, m) => sum + (messageDuration(m) ?? 0), 0);
  const isSingle = total === 1;

  const headerLabel: ReactNode = anyExecuting
    ? <>正在执行工具 <span className="tabular-nums">· {total}</span></>
    : <><span className="tabular-nums">{total} 个工具调用</span>{failCount > 0 && <span className="text-destructive"> · {failCount} 失败</span>}{totalDuration > 0 && <span className="tabular-nums"> · {formatDuration(totalDuration)}</span>}</>;

  return (
    <div className="w-full" data-testid="tool-run-group" data-executing={anyExecuting || undefined}>
      {!isSingle && (
        <button
          type="button"
          aria-expanded={open}
          data-testid="tool-run-header"
          onClick={() => setOpen((v) => !v)}
          className="-mx-1.5 flex w-fit items-center gap-1.5 rounded-lg px-1.5 py-1 text-[12.5px] text-[var(--dsw-label-secondary)] transition-colors duration-100 hover:bg-[var(--dsw-hover-bg)]"
        >
          {anyExecuting ? (
            <span className="flex size-4 items-center justify-center">
              <ThinkingOrb state="working" size={20} theme="auto" />
            </span>
          ) : (
            <svg
              width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
              strokeLinecap="round" strokeLinejoin="round"
              className="transition-transform duration-200"
              style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }}
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          )}
          {headerLabel}
        </button>
      )}

      {/* 组体：折叠时不挂载行集（展开体逐行高亮成本高，挂载即卡顿）。 */}
      {(open || isSingle) && (
        <div
          className={cn('grid overflow-hidden transition-[grid-template-rows,opacity] duration-300', isSingle && 'min-h-0')}
          style={{
            gridTemplateRows: '1fr',
            opacity: 1,
            transitionTimingFunction: 'var(--ease-out-strong)',
          }}
        >
          <div className="min-h-0 overflow-hidden">
            <div className={cn('flex flex-col gap-1', !isSingle && 'mt-1.5 pb-1')}>
              {messages.map((message, index) => (
                <ToolRunRow
                  key={message.id}
                  message={message}
                  open={openRows.has(message.id)}
                  onToggle={toggleRow}
                  animationDelay={Math.min(index, 4) * 60}
                />
              ))}
            </div>

            {/* 文件 diff chips */}
            {diffFiles.length > 0 && (
              <div className={cn('flex max-w-full flex-wrap gap-1.5 border-t border-[var(--dsw-border-l1)] pt-2.5', !isSingle && 'mt-2.5')}>
                {diffFiles.map(({ file }, i) => (
                  <span key={file.path} data-diffchip className="relative">
                    <button
                      type="button"
                      data-testid="tool-diff-chip"
                      aria-expanded={preview?.file.path === file.path}
                      aria-label={`查看 ${file.path} 的 diff`}
                      onMouseEnter={openPreview(file)}
                      onMouseLeave={closePreview(file.path)}
                      onFocus={openPreview(file)}
                      onBlur={closePreview(file.path)}
                      onClick={() => openFile(file.path)}
                      title={`点击打开文件: ${file.path}`}
                      className="ap-echip inline-flex h-7 max-w-full items-center gap-2 rounded-md bg-[var(--dsw-layer-1)] px-2 font-mono text-[11.5px] text-foreground transition-colors duration-100 hover:bg-[var(--dsw-hover-solid)]"
                      style={{ animation: `pop-in 250ms var(--ease-out-strong) ${i * 80}ms both` }}
                    >
                      <span className="min-w-0 truncate">{file.path.split(/[\\/]/).pop()}</span>
                      <span className="shrink-0 tabular-nums text-[var(--dsw-success)]">+{file.added}</span>
                      {file.deleted > 0 && <span className="shrink-0 tabular-nums text-[var(--dsw-error)]">−{file.deleted}</span>}
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {preview && <DiffPreviewCard preview={preview} />}
    </div>
  );
}
