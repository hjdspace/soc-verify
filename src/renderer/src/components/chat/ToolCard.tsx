/**
 * ToolCard — 单条工具调用的卡片渲染（交互式工具 ask 仍走此卡）。
 *
 * 摘要构建器与展开体组件在 tool-registry.tsx 集中登记；本模块只负责
 * 卡片外观（状态机前导格 · 摘要 · diff 统计 · 用时 · 展开开关）与
 * 展开体分发。连续工具调用的分组渲染见 ToolRunGroup。
 */
import { useState, useEffect, useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ChevronDown, Sparkle } from 'lucide-react';
import { openReviewAwareFile } from '@renderer/stores/diff-review';
import { useSessionCoreStore } from '@renderer/stores/session-core';
import type { ChatMessage, SubagentActivity } from '@renderer/stores/session-types';
import { cn } from '@renderer/lib/utils';
import { ThinkingOrb } from '@renderer/components/visual';
import {
  getToolMeta,
  isSkillRead,
  extractEditFilePath,
  extractResultText,
  hasResultWarning,
  isDirectoryToolResult,
} from './tool-helpers';
import {
  getToolSummary,
  ToolBodyView,
  CATEGORY_ICON,
  toolToOrbState,
  FILE_TOOLS,
  NO_SUBAGENTS,
} from './tool-registry';
import { getFileDiffStats } from './tool-bodies/shared/diff-stats';

// ── ToolCard ───────────────────────────────────────────

export function ToolCard({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  const isExecuting = !message.toolResult;
  const meta = getToolMeta(message.toolName);
  const resultText = extractResultText(message.toolResult);

  // task 工具：读取该 tool call 关联的 subagent 实时状态
  const taskAgents = useSessionCoreStore(useShallow((s) => {
    if (message.toolName !== 'task' || !message.toolCallId) return NO_SUBAGENTS;
    const list: SubagentActivity[] = [];
    for (const sess of s.sessions) {
      for (const a of Object.values(sess.subagents ?? {})) {
        if (a.parentToolCallId === message.toolCallId) list.push(a);
      }
    }
    return list.length > 0 ? list : NO_SUBAGENTS;
  }));

  const toolName = message.toolName ?? '';
  const isFileTool = !isExecuting && FILE_TOOLS.has(toolName);
  const filePath = isFileTool ? extractEditFilePath(message.toolArgs, resultText) : '';
  // 当 AI 读取的是一个目录时，路径不应可点击——
  // omp read 读目录成功返回目录树（details.isDirectory），点击会在编辑器中打开目录报 EISDIR。
  const isDirError = !isExecuting && isDirectoryToolResult(message.toolResult);
  const isClickablePath = isFileTool && filePath && !isDirError;

  const handlePathClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!filePath) return;
    const fileName = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath;
    openReviewAwareFile(filePath, fileName);
  }, [filePath]);

  // Tick for live duration display while executing
  const [, tick] = useState(0);
  useEffect(() => {
    if (!isExecuting || !message.toolStartTime) return;
    const interval = setInterval(() => tick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [isExecuting, message.toolStartTime]);

  const duration = message.toolStartTime && message.toolEndTime
    ? message.toolEndTime - message.toolStartTime
    : message.toolStartTime && !message.toolResult
      ? Date.now() - message.toolStartTime
      : null;

  // Detect skill read: read tool with skill:// path
  const isSkill = toolName === 'read' && isSkillRead(message.toolArgs);

  // Summary via shared registry (MCP / fallback included)
  const summary = getToolSummary(message, taskAgents);

  const isError = typeof message.toolResult === 'object' && message.toolResult !== null
    && 'isError' in message.toolResult
    && (message.toolResult as { isError: boolean }).isError;
  const hasWarning = !isError && !isExecuting && hasResultWarning(resultText);
  const diffStats = !isError && !isExecuting ? getFileDiffStats(message) : null;

  // 状态机（DSH §6.1）：running=追逐点阵+扫光 / error=红点+红摘要 / warn=琥珀点 / ok=变体图标
  const status: 'running' | 'error' | 'warn' | 'ok' = isExecuting
    ? 'running'
    : isError
      ? 'error'
      : hasWarning
        ? 'warn'
        : 'ok';

  const Icon = CATEGORY_ICON[meta.category] ?? Sparkle;

  return (
    <div
      data-testid="tool-card"
      className={cn(
        'overflow-hidden rounded-[10px] border border-[var(--dsw-border-l1)] bg-[var(--dsw-code-block)]',
        expanded && 'border-[var(--dsw-border-l2)]',
      )}
    >
      <div
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          'flex min-h-[26px] w-full cursor-pointer select-none items-center gap-1.5 px-2 py-1 text-left transition-colors hover:bg-[var(--dsw-hover-bg)]',
          isExecuting && 'ap-sweep',
        )}
      >
        {/* 前导格 */}
        {status === 'running' && (
          <span className="flex h-4 w-4 shrink-0 items-center justify-center" data-status="running">
            <ThinkingOrb state={toolToOrbState(toolName)} size={20} theme="auto" />
          </span>
        )}
        {(status === 'error' || status === 'warn') && (
          <span className="flex h-4 w-4 shrink-0 items-center justify-center">
            <span className="ap-sdot" data-status={status} />
          </span>
        )}
        {status === 'ok' && (
          <span className="flex h-4 w-4 shrink-0 items-center justify-center" data-status="ok">
            <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
          </span>
        )}

        {/* 标题 · 分隔点 · 摘要 */}
        <span className="shrink-0 text-[11px] font-medium text-muted-foreground">{meta.label}</span>
        {isSkill && (
          <span
            className="flex shrink-0 items-center gap-0.5 rounded px-1 py-px text-[9px] font-medium text-primary-foreground bg-primary/15"
            data-testid="skill-badge"
          >
            <Sparkle className="h-2 w-2" />
            技能
          </span>
        )}
        <span className="h-0.5 w-0.5 shrink-0 rounded-full bg-[var(--dsw-label-caption)]" />
        {isClickablePath ? (
          <span
            onClick={handlePathClick}
            className="min-w-0 flex-1 cursor-pointer truncate text-[11px] text-status-running-foreground underline decoration-[var(--dsw-border-l3)] underline-offset-2 hover:decoration-current"
            title={`点击打开文件: ${filePath}`}
          >
            {summary}
          </span>
        ) : (
          <span className={cn('min-w-0 flex-1 truncate text-[11px]', status === 'error' && 'text-destructive')}>
            {summary}
          </span>
        )}

        {/* 尾部：diff 统计 / 用时 / 展开开关 */}
        {diffStats && (
          <span className="flex shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums">
            <span className="text-status-pass-foreground">+{diffStats.added}</span>
            <span className="text-destructive">-{diffStats.deleted}</span>
          </span>
        )}
        {duration != null && (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">
            {duration > 1000 ? `${(duration / 1000).toFixed(1)}s` : `${duration}ms`}
          </span>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
          className="flex shrink-0 items-center justify-center rounded p-0.5 transition-colors hover:bg-[var(--dsw-active-bg)]"
          title={expanded ? '折叠' : '展开'}
        >
          <ChevronDown
            className={cn(
              'h-3 w-3 text-muted-foreground/60 transition-transform',
              expanded && 'rotate-180',
            )}
          />
        </button>
      </div>

      {/* 折叠时跳过展开体渲染（挂载即执行逐行高亮是切换会话卡顿的主因之一） */}
      {expanded ? (
        <div className="border-t border-[var(--dsw-border-l1)] px-1 pb-1 pt-0.5">
          <ToolBodyView message={message} taskAgents={taskAgents} />
        </div>
      ) : null}
    </div>
  );
}
