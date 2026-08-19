/**
 * Terminal-native ToolCard component (Scheme A).
 *
 * Renders AI Agent tool calls with specialized views per tool type:
 * - read:    code display with line numbers + syntax highlighting
 * - write:   green background with + prefix (all new lines) + syntax highlighting
 * - edit:    diff view with red/green lines + syntax highlighting
 * - bash:    command + terminal output
 * - eval:    code input + result output
 * - grep:    search results with highlighted matches
 * - glob:    file list
 * - task:    sub-agent task items
 * - job:     background job progress
 * - todo:    checklist
 * - web_search: search results
 * - ask:     question + options
 * - mcp__*:  MCP tools (server/tool format)
 * - host tools: specialized views for SoC verification
 * - fallback: generic JSON display
 */
import { useState, useEffect, useMemo, useCallback, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Loader2, ChevronDown, Terminal } from 'lucide-react';
import { openReviewAwareFile } from '@renderer/stores/diff-review';
import { useProjectStore } from '@renderer/stores/project';
import { useTerminalStore } from '@renderer/stores/terminal';
import { useSessionStore, type ChatMessage, type SubagentActivity } from '@renderer/stores/session';
import { SubagentCard } from './SubagentCard';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from '@renderer/stores/toast';
import hljs from 'highlight.js';
import { cn } from '@renderer/lib/utils';
import {
  getToolMeta,
  isMCPTool,
  parseMCPToolName,
  detectLanguage,
  extractResultText,
  tryParseJSON,
  parseJsonArray,
  argStr,
  argVal,
  shortenPath,
  countGrepMatches,
  countLines,
  numFromObj,
  parseTaskItems,
  parseJobItems,
  parseTodoItems,
  computeSimpleDiff,
  extractEditFilePath,
  extractOmpEditPathFromResult,
  hasResultWarning,
  parseOmpEditResult,
  type DiffLineData,
} from './tool-helpers';

// ── Syntax highlighting ─────────────────────────────────

/**
 * Highlight code using highlight.js and return HTML string.
 * Uses dangerouslySetInnerHTML for performance.
 */
function highlightCode(code: string, language: string): string {
  try {
    if (language && language !== 'plaintext' && hljs.getLanguage(language)) {
      return hljs.highlight(code, { language }).value;
    }
    // Auto-detect
    return hljs.highlightAuto(code).value;
  } catch {
    return escapeHtml(code);
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * CodeHighlight: renders code with syntax highlighting.
 * Uses highlight.js for lightweight, read-only highlighting.
 */
function CodeHighlight({ code, language, className }: { code: string; language: string; className?: string }) {
  const html = useMemo(() => highlightCode(code, language), [code, language]);
  return (
    <code
      className={cn('hljs font-mono whitespace-pre-wrap break-words', className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// ── Clickable file path header ──────────────────────────

/**
 * Renders a clickable file path header used in expanded body views.
 * Clicking opens the file in the workbench editor via openFileDestination.
 */
function ClickablePathHeader({ filePath }: { filePath: string }) {
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const fileName = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath;
    openReviewAwareFile(filePath, fileName);
  }, [filePath]);

  return (
    <div
      onClick={handleClick}
      className="cursor-pointer border-b border-border/30 bg-background/50 px-2.5 py-0.5 text-[10px] text-muted-foreground/60 hover:underline"
      title={`点击打开文件: ${filePath}`}
    >
      {filePath}
    </div>
  );
}

// ── Main ToolCard ───────────────────────────────────────

const FILE_TOOLS = new Set(['read', 'read_file', 'write', 'write_file', 'edit', 'edit_file', 'apply_patch', 'ast_edit']);

/** 模块级空数组常量：非 task 工具的 selector 返回稳定引用，避免无关重渲染 */
const NO_SUBAGENTS: SubagentActivity[] = [];

export function ToolCard({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  const isExecuting = !message.toolResult;
  const meta = getToolMeta(message.toolName);
  const resultText = extractResultText(message.toolResult);

  // task 工具：读取该 tool call 关联的 subagent 实时状态（subagent_* 帧驱动）
  // useShallow：selector 每次生成新数组，元素引用不变时返回缓存引用，
  // 避免 useSyncExternalStore 因 snapshot 引用变化陷入无限重渲染
  const taskAgents = useSessionStore(useShallow((s) => {
    if (message.toolName !== 'task' || !message.toolCallId) return NO_SUBAGENTS;
    const list: SubagentActivity[] = [];
    for (const sess of s.sessions) {
      for (const a of Object.values(sess.subagents ?? {})) {
        if (a.parentToolCallId === message.toolCallId) list.push(a);
      }
    }
    return list.length > 0 ? list : NO_SUBAGENTS;
  }));

  // even after the file has been reviewed and removed from the queue.
  const toolName = message.toolName ?? '';
  const isFileTool = !isExecuting && FILE_TOOLS.has(toolName);
  const filePath = isFileTool ? extractEditFilePath(message.toolArgs, resultText) : '';

  const handlePathClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!filePath) return;
    const fileName = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath;
    openReviewAwareFile(filePath, fileName);
  }, [filePath]);

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

  const summary = buildSummary(message, taskAgents);
  const isError = typeof message.toolResult === 'object' && message.toolResult !== null
    && 'isError' in message.toolResult
    && (message.toolResult as { isError: boolean }).isError;
  const hasWarning = !isError && !isExecuting && hasResultWarning(resultText);
  const diffStats = !isError && !isExecuting ? getFileDiffStats(message) : null;

  const statusDotClass = isExecuting
    ? ''
    : isError
      ? 'bg-status-fail-foreground'
      : hasWarning
        ? 'bg-warning-foreground'
        : 'bg-status-pass-foreground';

  return (
    <div
      data-testid="tool-card"
      className={cn(
        'overflow-hidden rounded-md border border-border/60 bg-secondary/20 font-mono',
        expanded && 'border-border',
      )}
    >
      <div
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left transition-colors hover:bg-secondary/40"
      >
        {isExecuting ? (
          <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin text-primary" />
        ) : (
          <span className={cn('h-2 w-2 shrink-0 rounded-full', statusDotClass)} />
        )}
        <span className={cn('shrink-0 text-[11px] font-semibold', meta.color)}>
          {meta.label}
        </span>
        {isFileTool && filePath ? (
          <span
            onClick={handlePathClick}
            className="flex-1 min-w-0 truncate text-[11px] cursor-pointer text-status-running-foreground hover:underline"
            title={`点击打开文件: ${filePath}`}
          >
            {summary}
          </span>
        ) : (
          <span className="flex-1 min-w-0 truncate text-[11px] text-muted-foreground">
            {summary}
          </span>
        )}
        {diffStats && (
          <span className="flex shrink-0 items-center gap-1 text-[10px] tabular-nums">
            <span className="text-status-pass-foreground">+{diffStats.added}</span>
            <span className="text-destructive">-{diffStats.deleted}</span>
          </span>
        )}
        {duration != null && (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
            {duration > 1000 ? `${(duration / 1000).toFixed(1)}s` : `${duration}ms`}
          </span>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
          className="flex shrink-0 items-center justify-center rounded p-0.5 transition-colors hover:bg-secondary/60"
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

      {expanded && (
        <div className="border-t border-border/40">
          <ToolBody message={message} isExecuting={isExecuting} taskAgents={taskAgents} />
        </div>
      )}
    </div>
  );
}

// ── Summary ─────────────────────────────────────────────

function buildSummary(message: ChatMessage, taskAgents: SubagentActivity[]): ReactNode {
  const name = message.toolName ?? '';
  const args = message.toolArgs;
  const resultText = extractResultText(message.toolResult);
  const isExecuting = !message.toolResult;

  // MCP tools
  if (isMCPTool(name)) {
    const parsed = parseMCPToolName(name);
    const toolLabel = parsed ? parsed.toolName : name;
    const argSummary = argStr(args, 'query', 'command', 'path', 'file', 'text', 'input') ?? '';
    const short = argSummary.replace(/[\n\t]/g, ' ').trim().slice(0, 40);
    if (isExecuting) return <><span className="text-foreground">{toolLabel}</span>{' \u00b7 '}executing...</>;
    const resultLines = resultText ? countLines(resultText) : 0;
    return <><span className="text-foreground">{toolLabel}</span>{short ? `: ${short}` : ''}{' \u00b7 '}{resultLines > 0 ? `${resultLines} lines` : 'done'}</>;
  }

  switch (name) {
    case 'read':
    case 'read_file': {
      const path = argStr(args, 'path', 'file_path') ?? '';
      const lineCount = resultText ? resultText.split('\n').length : 0;
      return <><span className="text-foreground">{shortenPath(path)}</span> {' \u00b7 '} {isExecuting ? 'reading...' : `${lineCount} lines`}</>;
    }
    case 'write':
    case 'write_file': {
      const path = argStr(args, 'path', 'file_path') ?? '';
      const lines = (argStr(args, 'content') ?? '').split('\n').length;
      return <><span className="text-foreground">{shortenPath(path)}</span> {' \u00b7 '} {isExecuting ? 'writing...' : `wrote ${lines} lines`}</>;
    }
    case 'edit':
    case 'edit_file':
    case 'apply_patch':
    case 'ast_edit': {
      const path = extractEditFilePath(args, resultText);
      if (!path) return <>{isExecuting ? 'editing...' : 'edited'}</>;
      const hasWarn = !isExecuting && hasResultWarning(resultText);
      return <><span className="text-foreground">{shortenPath(path)}</span> {' \u00b7 '} {isExecuting ? 'editing...' : hasWarn ? 'edited (with warnings)' : 'edited'}</>;
    }
    case 'bash': {
      const cmd = argStr(args, 'command') ?? '';
      const short = cmd.replace(/[\n\t]/g, ' ').trim().slice(0, 50);
      return <><span className="text-foreground">{short}</span>{cmd.length > 50 ? '...' : ''}</>;
    }
    case 'eval':
    case 'js':
    case 'python': {
      const code = argStr(args, 'code') ?? '';
      const short = code.replace(/\n/g, ' ').trim().slice(0, 40);
      return <><span className="text-foreground">{short}</span>{code.length > 40 ? '...' : ''}</>;
    }
    case 'grep':
    case 'search': {
      const pattern = argStr(args, 'pattern', 'query') ?? '';
      const matchCount = countGrepMatches(resultText);
      return <><span className="text-foreground">/{pattern}/</span> {' \u00b7 '} {isExecuting ? 'searching...' : `${matchCount} match${matchCount !== 1 ? 'es' : ''}`}</>;
    }
    case 'glob':
    case 'find': {
      const pattern = argStr(args, 'pattern') ?? '';
      const fileCount = resultText ? resultText.trim().split('\n').filter(Boolean).length : 0;
      return <><span className="text-foreground">{pattern}</span> {' \u00b7 '} {isExecuting ? 'finding...' : `${fileCount} files`}</>;
    }
    case 'task': {
      // 优先使用 subagent 实时状态（subagent_* 帧驱动），无数据时回退到结果文本解析
      if (taskAgents.length > 0) {
        const running = taskAgents.filter((a) => a.status === 'running').length;
        if (running > 0) {
          return <>{taskAgents.length} 个子代理 {' \u00b7 '}{running} 运行中</>;
        }
        const done = taskAgents.filter((a) => a.status === 'completed').length;
        const failed = taskAgents.filter((a) => a.status === 'failed').length;
        return <>{taskAgents.length} 个子代理 {' \u00b7 '}{done} 成功{failed > 0 ? ` / ${failed} 失败` : ''}</>;
      }
      const tasks = parseTaskItems(resultText);
      if (isExecuting) return <>dispatching sub-agents...</>;
      const done = tasks.filter((t) => t.status === 'done').length;
      return <>{tasks.length} sub-agents {' \u00b7 '} {done}/{tasks.length} done</>;
    }
    case 'job': {
      const jobs = parseJobItems(resultText);
      if (isExecuting) return <>starting jobs...</>;
      const running = jobs.filter((j) => j.status === 'running').length;
      return <>{jobs.length} jobs {' \u00b7 '} {running > 0 ? `${running} running` : 'all done'}</>;
    }
    case 'todo': {
      const todos = parseTodoItems(args, resultText);
      const done = todos.filter((t) => t.status === 'completed').length;
      return <>{todos.length} items {' \u00b7 '} {done}/{todos.length} done</>;
    }
    case 'web_search': {
      const query = argStr(args, 'query', 'q') ?? '';
      return <>"{query}" {' \u00b7 '} {isExecuting ? 'searching...' : `${countLines(resultText)} results`}</>;
    }
    case 'ask': {
      // Support both single-question (question/options) and multi-question (questions[]) formats
      const questionsArg = argVal(args, 'questions');
      if (Array.isArray(questionsArg) && questionsArg.length > 0) {
        const count = questionsArg.length;
        const firstQ = questionsArg[0] as Record<string, unknown> | undefined;
        const firstQuestionText = typeof firstQ?.question === 'string' ? firstQ.question : '';
        const hasResult = !isExecuting && resultText;
        if (hasResult) {
          return <><span className="text-foreground">{count} 个问题已回答</span></>;
        }
        return <><span className="text-foreground/80">{count} 个问题</span>{firstQuestionText ? `: ${firstQuestionText.slice(0, 40)}` : ''}</>;
      }
      const question = argStr(args, 'question', 'prompt') ?? '';
      if (isExecuting) return <span className="truncate">{question.slice(0, 60) || 'asking...'}</span>;
      return <><span className="text-foreground/80">已回答</span></>;
    }
    case 'list_subsys': {
      const items = parseJsonArray(resultText);
      return <>{isExecuting ? 'listing...' : `${items?.length ?? 0} subsystems found`}</>;
    }
    case 'list_cases': {
      const items = parseJsonArray(resultText);
      const subsys = argStr(args, 'subsys');
      return <>{subsys ? `subsys=${subsys} ` : ''}{isExecuting ? 'listing...' : `${items?.length ?? 0} cases`}</>;
    }
    case 'run_simulation': {
      const caseId = argStr(args, 'caseId', 'case', 'testcase') ?? '';
      const subsys = argStr(args, 'subsys');
      const label = [subsys, caseId].filter(Boolean).join('/') || 'simulation';
      return <><span className="text-foreground">{label}</span></>;
    }
    case 'get_coverage': {
      const subsys = argStr(args, 'subsys') ?? 'all';
      const runId = argStr(args, 'runId') ?? '';
      return <>{subsys}{runId ? ` {' \u00b7 '} ${runId}` : ''}</>;
    }
    case 'get_compile_errors': {
      const errors = parseJsonArray(resultText);
      const errCount = errors?.filter((e) => {
        const sev = String(e.severity ?? e.level ?? '').toLowerCase();
        return sev === 'error' || sev === 'fatal';
      }).length ?? 0;
      return <>{isExecuting ? 'checking...' : errCount > 0 ? `${errCount} errors` : 'no errors'}</>;
    }
    case 'get_run_status': {
      const runId = argStr(args, 'runId') ?? '';
      return <><span className="text-foreground">{runId}</span></>;
    }
    case 'get_sim_options_schema': {
      if (isExecuting) return <>loading schema...</>;
      const parsed = tryParseJSON(resultText);
      const count = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed).length : 0;
      return <>{count > 0 ? `${count} options` : 'no options'}</>;
    }
    default: {
      if (isExecuting) return <span className="text-foreground/60">executing...</span>;
      if (!resultText) return 'no output';
      return <span className="text-foreground/80">{name || 'tool'}</span>;
    }
  }
}

type FileDiffStats = { added: number; deleted: number };

function contentLineCount(content: string): number {
  if (!content) return 0;
  return content.replace(/\r?\n$/, '').split(/\r?\n/).length;
}

function computeDiffStats(oldText: string, newText: string): FileDiffStats {
  if (!oldText) return { added: contentLineCount(newText), deleted: 0 };
  if (!newText) return { added: 0, deleted: contentLineCount(oldText) };
  const diff = computeSimpleDiff(oldText, newText);
  return {
    added: diff.filter((line) => line.type === 'add').length,
    deleted: diff.filter((line) => line.type === 'del').length,
  };
}

function resultDetails(result: unknown): Record<string, unknown> | null {
  if (typeof result !== 'object' || result === null) return null;
  const details = (result as Record<string, unknown>).details;
  return typeof details === 'object' && details !== null
    ? details as Record<string, unknown>
    : null;
}

function statsFromResultDiff(diff: string): FileDiffStats | null {
  let added = 0;
  let deleted = 0;
  for (const line of diff.split('\n')) {
    if (/^\+\s*\d+\|/.test(line)) added++;
    else if (/^-\s*\d+\|/.test(line)) deleted++;
  }
  return added > 0 || deleted > 0 ? { added, deleted } : null;
}

function statsFromPatch(patch: string): FileDiffStats | null {
  let added = 0;
  let deleted = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) deleted++;
  }
  return added > 0 || deleted > 0 ? { added, deleted } : null;
}

function statsFromEditArgs(args: unknown): FileDiffStats | null {
  const oldText = argStr(args, 'oldText', 'old_string', 'old_text', 'find');
  const newText = argStr(args, 'newText', 'new_string', 'new_text', 'replace');
  if (oldText != null && newText != null) return computeDiffStats(oldText, newText);

  const edits = argVal(args, 'edits');
  if (Array.isArray(edits)) {
    let added = 0;
    let deleted = 0;
    let found = false;
    for (const edit of edits) {
      if (typeof edit !== 'object' || edit === null) continue;
      const record = edit as Record<string, unknown>;
      const oldValue = record.old_text ?? record.oldText ?? record.old_string;
      const newValue = record.new_text ?? record.newText ?? record.new_string;
      if (typeof oldValue !== 'string' || typeof newValue !== 'string') continue;
      const stats = computeDiffStats(oldValue, newValue);
      added += stats.added;
      deleted += stats.deleted;
      found = true;
    }
    if (found) return { added, deleted };
  }

  const patch = argStr(args, 'input', 'patch', 'diff');
  return patch ? statsFromPatch(patch) : null;
}

function getFileDiffStats(message: ChatMessage): FileDiffStats | null {
  const toolName = message.toolName ?? '';
  const details = resultDetails(message.toolResult);

  if (toolName === 'write' || toolName === 'write_file') {
    const content = argStr(message.toolArgs, 'content');
    if (content == null) return null;
    const beforeContent = message.toolBeforeContent
      ?? (typeof details?.beforeContent === 'string' ? details.beforeContent : undefined);
    return beforeContent == null
      ? { added: contentLineCount(content), deleted: 0 }
      : computeDiffStats(beforeContent, content);
  }

  if (toolName === 'edit' || toolName === 'edit_file' || toolName === 'apply_patch' || toolName === 'ast_edit') {
    if (typeof details?.diff === 'string') {
      const stats = statsFromResultDiff(details.diff);
      if (stats) return stats;
    }
    if (typeof details?.oldText === 'string' && typeof details.newText === 'string') {
      return computeDiffStats(details.oldText, details.newText);
    }
    return statsFromEditArgs(message.toolArgs);
  }

  return null;
}

// ── Tool body dispatcher ────────────────────────────────

function ToolBody({
  message,
  isExecuting,
  taskAgents,
}: {
  message: ChatMessage;
  isExecuting: boolean;
  taskAgents: SubagentActivity[];
}) {
  const name = message.toolName ?? '';
  const resultText = extractResultText(message.toolResult);

  // task 工具：有 subagent 实时数据时用磁贴卡片（执行中也展示实时进度）
  if (name === 'task' && taskAgents.length > 0) {
    return <SubagentCard agents={taskAgents} />;
  }

  if (isExecuting) {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-2 text-[11px] text-muted-foreground">
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        <span>executing...</span>
      </div>
    );
  }

  // MCP tools — render as generic with server info header
  if (isMCPTool(name)) {
    const parsed = parseMCPToolName(name);
    return <McpBody serverName={parsed?.serverName} toolName={parsed?.toolName} args={message.toolArgs} resultText={resultText} />;
  }

  switch (name) {
    case 'read':
    case 'read_file':
      return <ReadBody args={message.toolArgs} resultText={resultText} />;
    case 'write':
    case 'write_file':
      return <WriteBody args={message.toolArgs} resultText={resultText} />;
    case 'edit_file':
    case 'edit':
    case 'apply_patch':
    case 'ast_edit':
      return <EditBody args={message.toolArgs} resultText={resultText} />;
    case 'bash':
      return <BashBody args={message.toolArgs} resultText={resultText} />;
    case 'eval':
    case 'js':
    case 'python':
      return <EvalBody args={message.toolArgs} resultText={resultText} />;
    case 'grep':
    case 'search':
      return <GrepBody args={message.toolArgs} resultText={resultText} />;
    case 'glob':
    case 'find':
      return <GlobBody args={message.toolArgs} resultText={resultText} />;
    case 'task':
      return <TaskBody resultText={resultText} />;
    case 'job':
      return <JobBody resultText={resultText} />;
    case 'todo':
      return <TodoBody args={message.toolArgs} resultText={resultText} />;
    case 'web_search':
      return <WebSearchBody args={message.toolArgs} resultText={resultText} />;
    case 'ask':
      return <AskBody args={message.toolArgs} resultText={resultText} />;
    case 'list_subsys':
      return <HostTableBody resultText={resultText} columns={[
        { key: 'name', label: 'Subsystem' },
        { key: 'path', label: 'Path' },
        { key: 'caseCount', label: 'Cases' },
      ]} />;
    case 'list_cases':
      return <HostTableBody resultText={resultText} columns={[
        { key: 'name', label: 'Case' },
        { key: 'subsys', label: 'Subsystem' },
        { key: 'status', label: 'Status', type: 'badge' as const },
      ]} emptyMessage="未找到用例" />;
    case 'run_simulation':
      return <SimRunBody args={message.toolArgs} resultText={resultText} message={message} />;
    case 'get_sim_options_schema':
      return <SimOptionsSchemaBody resultText={resultText} />;
    case 'get_coverage':
      return <CoverageBody resultText={resultText} />;
    case 'get_compile_errors':
      return <CompileErrorsBody resultText={resultText} />;
    case 'get_run_status':
      return <RunStatusBody args={message.toolArgs} resultText={resultText} />;
    default:
      return <GenericBody args={message.toolArgs} resultText={resultText} />;
  }
}

// ── MCP ─────────────────────────────────────────────────

function McpBody({ serverName, toolName, args, resultText }: {
  serverName?: string;
  toolName?: string;
  args: unknown;
  resultText: string;
}) {
  const hasArgs = args != null && typeof args === 'object' && Object.keys(args as object).length > 0;
  // Try to detect if result is JSON for pretty rendering
  const parsed = tryParseJSON(resultText);
  const isJsonResult = parsed != null;

  return (
    <div className="text-[11px] leading-relaxed">
      <div className="border-b border-border/40 bg-background/50 px-2.5 py-1 text-[10px] text-warning-foreground/80">
        <span className="text-muted-foreground/50">mcp:</span>{serverName ?? 'unknown'}{' / '}{toolName ?? 'tool'}
      </div>
      {hasArgs && (
        <div>
          <div className="border-b border-border/30 bg-background/30 px-2.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground/60">args</div>
          <pre className="overflow-x-auto px-2.5 py-1 text-[10px] text-muted-foreground">{JSON.stringify(args, null, 2)}</pre>
        </div>
      )}
      {resultText && (
        <div>
          <div className="border-b border-border/30 bg-background/30 px-2.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground/60">result</div>
          {isJsonResult ? (
            <pre className="max-h-72 overflow-auto px-2.5 py-1 text-[10px] text-muted-foreground">{JSON.stringify(parsed, null, 2)}</pre>
          ) : (
            <pre className="max-h-72 overflow-auto px-2.5 py-1 text-[10px] text-muted-foreground">{resultText}</pre>
          )}
        </div>
      )}
      {!hasArgs && !resultText && <div className="px-2.5 py-2 text-muted-foreground/50">no output</div>}
    </div>
  );
}

// ── Read ────────────────────────────────────────────────

function ReadBody({ args, resultText }: { args: unknown; resultText: string }) {
  const offset = typeof argVal(args, 'offset') === 'number' ? (argVal(args, 'offset') as number) : 1;
  const filePath = argStr(args, 'path', 'file_path') ?? '';
  const language = detectLanguage(filePath);
  const lines = resultText.split('\n');

  return (
    <div className="text-[11px] leading-relaxed">
      {filePath && <ClickablePathHeader filePath={filePath} />}
      <div className="flex max-h-80 overflow-auto">
        <div className="select-none border-r border-border/40 bg-background/50 px-2 py-1.5 text-right text-muted-foreground/60">
          {lines.map((_, i) => <div key={i}>{offset + i}</div>)}
        </div>
        <div className="flex-1 overflow-x-auto px-2.5 py-1.5">
          <CodeHighlight code={resultText} language={language} className="text-foreground/90" />
        </div>
      </div>
    </div>
  );
}

// ── Write ───────────────────────────────────────────────

function WriteBody({ args, resultText }: { args: unknown; resultText: string }) {
  const content = argStr(args, 'content') ?? resultText;
  const filePath = argStr(args, 'path', 'file_path') ?? '';
  const language = detectLanguage(filePath);
  const lines = content.split('\n');

  return (
    <div className="text-[11px] leading-relaxed">
      {filePath && <ClickablePathHeader filePath={filePath} />}
      <div className="max-h-80 overflow-auto bg-diff-add/20">
        {lines.map((line, i) => (
          <div key={i} className="flex">
            <span className="w-5 shrink-0 select-none text-center text-status-pass-foreground">+</span>
            <span className="w-8 shrink-0 select-none border-r border-status-pass-foreground/20 pr-1 text-right text-status-pass-foreground/60">{i + 1}</span>
            <span className="flex-1 overflow-x-auto px-2 text-diff-add-foreground">
              <CodeHighlight code={line || '\u00A0'} language={language} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Edit ────────────────────────────────────────────────

/** Extract old/new text from omp edit tool args, handling the `edits` array format. */
function extractEditTexts(args: unknown): { oldText: string | undefined; newText: string | undefined } {
  // Try flat arg names first (oldText, old_string, old_text, find)
  const flatOld = argStr(args, 'oldText', 'old_string', 'old_text', 'find');
  const flatNew = argStr(args, 'newText', 'new_string', 'new_text', 'replace');
  if (flatOld != null || flatNew != null) {
    return { oldText: flatOld, newText: flatNew };
  }

  // omp edit tool uses { path, edits: [{ old_text, new_text }] }
  const editsVal = argVal(args, 'edits');
  if (Array.isArray(editsVal) && editsVal.length > 0) {
    const firstEdit = editsVal[0];
    if (firstEdit && typeof firstEdit === 'object') {
      const editObj = firstEdit as Record<string, unknown>;
      const oldText = typeof editObj.old_text === 'string' ? editObj.old_text
        : typeof editObj.oldText === 'string' ? editObj.oldText
        : typeof editObj.old_string === 'string' ? editObj.old_string
        : undefined;
      const newText = typeof editObj.new_text === 'string' ? editObj.new_text
        : typeof editObj.newText === 'string' ? editObj.newText
        : typeof editObj.new_string === 'string' ? editObj.new_string
        : undefined;
      if (oldText != null || newText != null) {
        return { oldText, newText };
      }
    }
  }
  return { oldText: undefined, newText: undefined };
}

function EditBody({ args, resultText }: { args: unknown; resultText: string }) {
  const filePath = extractEditFilePath(args, resultText);
  const language = detectLanguage(filePath);
  const { oldText, newText } = extractEditTexts(args);

  if (oldText != null && newText != null) {
    const diff = computeSimpleDiff(oldText, newText);
    // Show file path header
    return (
      <div className="text-[11px] leading-relaxed">
        {filePath && <ClickablePathHeader filePath={filePath} />}
        <div className="max-h-80 overflow-auto">
          {diff.map((line, i) => <DiffLineView key={i} line={line} language={language} />)}
        </div>
        {hasResultWarning(resultText) && <EditWarningBlock resultText={resultText} />}
      </div>
    );
  }

  // Fallback: apply_patch and some edit adapters carry the unified patch in args.
  const patchText = argStr(args, 'input', 'patch', 'diff') ?? '';
  if (patchText.includes('@@') || /^[+-]/m.test(patchText)) {
    const lines = patchText.split('\n').map((content) => {
      if (content.startsWith('*** ') || content.startsWith('+++') || content.startsWith('---') || content.startsWith('@@')) return { type: 'hunk' as const, content };
      if (content.startsWith('+')) return { type: 'add' as const, content: content.slice(1) };
      if (content.startsWith('-')) return { type: 'del' as const, content: content.slice(1) };
      return { type: 'ctx' as const, content: content.startsWith(' ') ? content.slice(1) : content };
    });
    return (
      <div className="text-[11px] leading-relaxed">
        {filePath && <ClickablePathHeader filePath={filePath} />}
        <div className="max-h-80 overflow-auto">
          {lines.map((line, i) => {
            if (line.type === 'hunk') {
              return <div key={i} className="bg-secondary/40 px-2.5 py-0.5 text-[10px] text-muted-foreground/70">{line.content}</div>;
            }
            return <DiffLineView key={i} line={line} language={language} />;
          })}
        </div>
        {hasResultWarning(resultText) && <EditWarningBlock resultText={resultText} />}
      </div>
    );
  }

  // omp edit format: input is `[file#tag]\nDEL 42-49\n`, result has `[path#tag]\n42:content...\nWarnings:...`
  const ompPath = extractOmpEditPathFromResult(resultText);
  if (ompPath || (argStr(args, 'input') && resultText.match(/^\[[^\]]+#[A-Za-z0-9_]+\]/))) {
    return <OmpEditResultView resultText={resultText} language={detectLanguage(ompPath || filePath)} />;
  }

  return <GenericBody args={args} resultText={resultText} />;
}

/** Render omp edit tool result: shows post-edit file content + warnings. */
function OmpEditResultView({ resultText, language }: { resultText: string; language: string }) {
  const { filePath, contentLines, warnings } = parseOmpEditResult(resultText);
  return (
    <div className="text-[11px] leading-relaxed">
      {filePath && <ClickablePathHeader filePath={filePath} />}
      {contentLines.length > 0 && (
        <div className="max-h-80 overflow-auto">
          {contentLines.map((line, i) => (
            <div key={i} className="flex">
              <span className="w-10 shrink-0 select-none border-r border-border/30 pr-1 text-right text-[10px] text-muted-foreground/40">
                {line.lineNum || '\u00A0'}
              </span>
              <span className="flex-1 overflow-x-auto px-2 text-muted-foreground">
                <CodeHighlight code={line.content || '\u00A0'} language={language} />
              </span>
            </div>
          ))}
        </div>
      )}
      {warnings.length > 0 && (
        <div className="border-t border-warning/30 bg-warning/5 px-2.5 py-1">
          <div className="text-[9px] font-semibold uppercase tracking-wide text-warning-foreground">Warnings</div>
          {warnings.map((w, i) => (
            <div key={i} className="text-[10px] text-warning-foreground/80">{w}</div>
          ))}
        </div>
      )}
      {contentLines.length === 0 && warnings.length === 0 && (
        <pre className="max-h-48 overflow-auto px-2.5 py-1 text-[10px] text-muted-foreground">{resultText}</pre>
      )}
    </div>
  );
}

/** Render the warnings section from an edit result. */
function EditWarningBlock({ resultText }: { resultText: string }) {
  const { warnings } = parseOmpEditResult(resultText);
  if (warnings.length === 0) return null;
  return (
    <div className="border-t border-warning/30 bg-warning/5 px-2.5 py-1">
      <div className="text-[9px] font-semibold uppercase tracking-wide text-warning-foreground">Warnings</div>
      {warnings.map((w, i) => (
        <div key={i} className="text-[10px] text-warning-foreground/80">{w}</div>
      ))}
    </div>
  );
}

function DiffLineView({ line, language }: { line: DiffLineData; language: string }) {
  const sign = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
  return (
    <div className={cn('flex', line.type === 'add' && 'bg-diff-add/20', line.type === 'del' && 'bg-diff-del/20')}>
      <span className={cn(
        'w-8 shrink-0 select-none pr-1 text-right text-[10px]',
        line.type === 'add' && 'text-status-pass-foreground/60',
        line.type === 'del' && 'text-status-fail-foreground/60',
        line.type === 'ctx' && 'text-muted-foreground/40',
      )}>
        {line.oldLine != null ? line.oldLine : ' '}
      </span>
      <span className={cn(
        'w-4 shrink-0 select-none text-center',
        line.type === 'add' && 'text-status-pass-foreground',
        line.type === 'del' && 'text-status-fail-foreground',
        line.type === 'ctx' && 'text-muted-foreground/50',
      )}>{sign}</span>
      <span className={cn(
        'flex-1 overflow-x-auto px-1.5',
        line.type === 'add' && 'text-diff-add-foreground',
        line.type === 'del' && 'text-diff-del-foreground line-through',
        line.type === 'ctx' && 'text-muted-foreground',
      )}>
        <CodeHighlight code={line.content || '\u00A0'} language={language} />
      </span>
    </div>
  );
}

// ── Bash ────────────────────────────────────────────────

function BashBody({ args, resultText }: { args: unknown; resultText: string }) {
  const cmd = argStr(args, 'command') ?? '';
  return (
    <div className="text-[11px] leading-relaxed">
      <div className="border-b border-border/40 bg-background/50 px-2.5 py-1 text-violet-foreground">
        <span className="text-muted-foreground/50">$ </span>{cmd}
      </div>
      <pre className="max-h-72 overflow-auto px-2.5 py-1.5 text-muted-foreground">{resultText || '\u00A0'}</pre>
    </div>
  );
}

// ── Eval ────────────────────────────────────────────────

function EvalBody({ args, resultText }: { args: unknown; resultText: string }) {
  const code = argStr(args, 'code') ?? '';
  return (
    <div className="text-[11px] leading-relaxed">
      <div className="border-b border-border/40 bg-background/50 px-2.5 py-1 text-violet-foreground">
        <span className="text-muted-foreground/50">{'\u203a'} </span>{code}
      </div>
      <pre className="max-h-72 overflow-auto px-2.5 py-1.5 text-muted-foreground">
        <span className="text-status-pass-foreground">{'\u2190'} </span>{resultText || '\u00A0'}
      </pre>
    </div>
  );
}

// ── Grep ────────────────────────────────────────────────

function GrepBody({ args, resultText }: { args: unknown; resultText: string }) {
  const pattern = argStr(args, 'pattern', 'query') ?? '';
  const lines = resultText.split('\n').filter(Boolean);
  const files: Array<{ file: string; matches: Array<{ ln: string; text: string }> }> = [];
  let currentFile: string | null = null;

  for (const line of lines) {
    const match = line.match(/^([^:]+):(\d+):(.*)$/);
    if (match) {
      const [, file, ln, text] = match;
      if (file !== currentFile) { currentFile = file; files.push({ file, matches: [] }); }
      files[files.length - 1].matches.push({ ln, text });
    } else {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        const file = line.slice(0, colonIdx);
        if (file !== currentFile) { currentFile = file; files.push({ file, matches: [] }); }
        files[files.length - 1].matches.push({ ln: '', text: line.slice(colonIdx + 1) });
      }
    }
  }

  if (files.length === 0) return <GenericBody args={args} resultText={resultText} />;

  const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = pattern ? new RegExp(`(${escapeRegex(pattern)})`, 'gi') : null;

  return (
    <div className="max-h-80 overflow-auto text-[11px] leading-relaxed">
      {files.map((f, fi) => (
        <div key={fi}>
          <div className="border-b border-border/30 bg-background/50 px-2.5 py-0.5 font-semibold text-chart-1">{f.file}</div>
          {f.matches.map((m, mi) => (
            <div key={mi} className="flex gap-2 px-2.5 py-0.5">
              <span className="shrink-0 text-right text-muted-foreground/50" style={{ minWidth: '28px' }}>{m.ln}</span>
              <span className="text-muted-foreground">{regex ? highlightMatches(m.text, regex) : m.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function highlightMatches(text: string, regex: RegExp): ReactNode {
  const parts = text.split(regex);
  const matches = text.match(regex);
  if (!matches) return text;
  const result: ReactNode[] = [];
  parts.forEach((part, i) => {
    result.push(part);
    if (i < matches.length) {
      result.push(<span key={i} className="rounded bg-chart-1/20 px-0.5 text-chart-1">{matches[i]}</span>);
    }
  });
  return result;
}

// ── Glob ────────────────────────────────────────────────

function GlobBody({ args, resultText }: { args: unknown; resultText: string }) {
  const pattern = argStr(args, 'pattern') ?? '';
  const files = resultText.split('\n').filter(Boolean);
  return (
    <div className="max-h-80 overflow-auto px-2.5 py-1.5 text-[11px] leading-relaxed">
      {pattern && <div className="mb-1 text-[10px] text-muted-foreground/60">pattern: {pattern}</div>}
      {files.map((file, i) => (
        <div key={i} className="py-0.5 text-muted-foreground">
          <span className="text-chart-1">{'\u00b0'} </span>{file}
        </div>
      ))}
      {files.length === 0 && <div className="text-muted-foreground/50">no files found</div>}
    </div>
  );
}

// ── Task ────────────────────────────────────────────────

function TaskBody({ resultText }: { resultText: string }) {
  const items = parseTaskItems(resultText);
  if (items.length === 0) {
    return <pre className="max-h-72 overflow-auto px-2.5 py-1.5 text-[11px] text-muted-foreground">{resultText || '\u00A0'}</pre>;
  }
  return (
    <div className="text-[11px] leading-relaxed">
      {items.map((item, i) => (
        <div key={i} className="flex items-start gap-2 border-b border-border/30 px-2.5 py-1.5 last:border-b-0">
          <span className={cn(
            'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px]',
            item.status === 'done' && 'bg-status-pass/15 text-status-pass-foreground',
            item.status === 'running' && 'bg-primary/15 text-primary',
            item.status === 'pending' && 'bg-secondary text-muted-foreground',
            item.status === 'error' && 'bg-status-fail/15 text-status-fail-foreground',
          )}>
            {item.status === 'done' ? '\u2713' : item.status === 'running' ? '\u27f3' : item.status === 'error' ? '\u2717' : '\u00b7'}
          </span>
          <div className="min-w-0 flex-1">
            <div className={cn('font-medium', item.status === 'done' ? 'text-muted-foreground line-through' : 'text-foreground')}>
              {item.title}
            </div>
            {item.meta && <div className="mt-0.5 text-[10px] text-muted-foreground/60">{item.meta}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Job ─────────────────────────────────────────────────

function JobBody({ resultText }: { resultText: string }) {
  const items = parseJobItems(resultText);
  if (items.length === 0) {
    return <pre className="max-h-72 overflow-auto px-2.5 py-1.5 text-[11px] text-muted-foreground">{resultText || '\u00A0'}</pre>;
  }
  return (
    <div className="text-[11px] leading-relaxed">
      {items.map((item, i) => (
        <div key={i} className="flex items-center gap-2 border-b border-border/30 px-2.5 py-1.5 last:border-b-0">
          <span className="shrink-0 font-semibold text-chart-2">{item.id}</span>
          <span className="flex-1 min-w-0 truncate text-muted-foreground">{item.desc}</span>
          {item.progress != null && (
            <div className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-secondary">
              <div className="h-full rounded-full bg-chart-2" style={{ width: `${item.progress}%` }} />
            </div>
          )}
          <span className={cn(
            'shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
            item.status === 'done' && 'bg-status-pass/15 text-status-pass-foreground',
            item.status === 'running' && 'bg-primary/15 text-primary',
            item.status === 'failed' && 'bg-status-fail/15 text-status-fail-foreground',
          )}>{item.status}</span>
        </div>
      ))}
    </div>
  );
}

// ── Todo ────────────────────────────────────────────────

function TodoBody({ args, resultText }: { args: unknown; resultText: string }) {
  const items = parseTodoItems(args, resultText);
  if (items.length === 0) return <GenericBody args={args} resultText={resultText} />;
  return (
    <div className="px-2.5 py-1.5 text-[11px] leading-relaxed">
      {items.map((item, i) => (
        <div key={i} className="flex items-center gap-2 py-0.5">
          <span className={cn(
            'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[8px]',
            item.status === 'completed' && 'border-violet-foreground bg-violet-foreground text-background',
            item.status === 'in_progress' && 'border-primary bg-primary/20 text-primary',
            item.status === 'pending' && 'border-border bg-transparent text-transparent',
            item.status === 'abandoned' && 'border-muted-foreground/40 bg-transparent text-muted-foreground/40',
          )}>
            {item.status === 'completed' ? '\u2713' : item.status === 'in_progress' ? '\u25b6' : item.status === 'abandoned' ? '\u2013' : ''}
          </span>
          <span className={cn(
            item.status === 'completed' && 'text-muted-foreground/50 line-through',
            item.status === 'in_progress' && 'font-medium text-foreground',
            item.status === 'pending' && 'text-muted-foreground',
            item.status === 'abandoned' && 'text-muted-foreground/40 line-through',
          )}>{item.text}</span>
        </div>
      ))}
    </div>
  );
}

// ── Web Search ──────────────────────────────────────────

function WebSearchBody({ args, resultText }: { args: unknown; resultText: string }) {
  const query = argStr(args, 'query', 'q') ?? '';
  const parsed = tryParseJSON(resultText);

  type SearchResult = { title: string; url: string; snippet: string };
  let results: SearchResult[] = [];

  if (Array.isArray(parsed)) {
    results = (parsed as Array<Record<string, unknown>>).map((obj) => ({
      title: String(obj.title ?? obj.name ?? ''),
      url: String(obj.url ?? obj.link ?? obj.href ?? ''),
      snippet: String(obj.snippet ?? obj.description ?? obj.summary ?? ''),
    })).filter((r) => r.title || r.url);
  } else {
    results = resultText.split('\n').filter(Boolean).map((line) => ({ title: line, url: '', snippet: '' }));
  }

  return (
    <div className="text-[11px] leading-relaxed">
      {query && <div className="border-b border-border/40 bg-background/50 px-2.5 py-1 text-[10px] text-muted-foreground/60">query: "{query}"</div>}
      {results.length > 0 ? results.map((r, i) => (
        <div key={i} className="border-b border-border/30 px-2.5 py-1.5 last:border-b-0">
          <div className="font-medium text-status-fail-foreground">{r.title}</div>
          {r.url && <div className="text-[10px] text-muted-foreground/50">{r.url}</div>}
          {r.snippet && <div className="mt-0.5 text-muted-foreground">{r.snippet}</div>}
        </div>
      )) : <pre className="px-2.5 py-1.5 text-muted-foreground">{resultText || '\u00A0'}</pre>}
    </div>
  );
}

// ── Ask ─────────────────────────────────────────────────

/** Normalise an untrusted options array into { label, description? } objects. */
function normalizeAskOptions(raw: unknown): Array<{ label: string; description?: string }> {
  if (!Array.isArray(raw)) return [];
  return raw.map((o) => {
    if (typeof o === 'string') return { label: o };
    if (o && typeof o === 'object') {
      const obj = o as Record<string, unknown>;
      const label = typeof obj.label === 'string' ? obj.label : String(obj.label ?? '');
      const description = typeof obj.description === 'string' && obj.description.trim() ? obj.description.trim() : undefined;
      return description ? { label, description } : { label };
    }
    return { label: String(o) };
  });
}

/** Normalise untrusted `questions` array args into a renderable structure. */
function normalizeAskQuestions(raw: unknown): Array<{
  id: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multi?: boolean;
  recommended?: number;
}> {
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object') return { id: '?', question: '', options: [] };
    const q = entry as Record<string, unknown>;
    return {
      id: typeof q.id === 'string' ? q.id : '?',
      question: typeof q.question === 'string' ? q.question : '',
      options: normalizeAskOptions(q.options),
      multi: q.multi === true,
      recommended: typeof q.recommended === 'number' ? q.recommended : undefined,
    };
  });
}

/** Parse the tool result text to extract user answers for display. */
function parseAskResult(resultText: string): { selectedLabels: string[]; customInput?: string } | null {
  if (!resultText) return null;
  // Match "User selected: option1, option2"
  const selectedMatch = resultText.match(/User selected:\s*(.+)/);
  if (selectedMatch) {
    return { selectedLabels: selectedMatch[1].split(',').map((s) => s.trim()).filter(Boolean) };
  }
  // Match "User provided custom input: ..." or multi-line variant
  const customMatch = resultText.match(/User provided custom input:\s*(.+)/);
  if (customMatch) {
    return { selectedLabels: [], customInput: customMatch[1].trim() };
  }
  // Multi-question: "User answers:\nq1: answer1\nq2: answer2"
  if (resultText.startsWith('User answers:')) {
    return { selectedLabels: [resultText] };
  }
  return null;
}

function AskBody({ args, resultText }: { args: unknown; resultText: string }) {
  const questionsArg = argVal(args, 'questions');
  const questions = normalizeAskQuestions(questionsArg);

  // Multi-question format: render each question with its options
  if (questions.length > 0) {
    const hasResult = resultText.trim().length > 0;
    return (
      <div className="px-2.5 py-2 text-[11px] leading-relaxed">
        {questions.map((q, qi) => {
          // Try to extract the answer for this question from the result text
          const answerRegex = new RegExp(`${q.id}:\\s*(.+)`);
          const answerMatch = hasResult ? resultText.match(answerRegex) : null;
          const answerText = answerMatch ? answerMatch[1].trim() : null;
          // Check if this answer is a custom input (quoted)
          const isCustomAnswer = answerText != null && answerText.startsWith('"') && answerText.endsWith('"');
          const customText = isCustomAnswer && answerText != null ? answerText.slice(1, -1) : undefined;
          // Check if it's a multi-select (enclosed in [])
          const isMultiAnswer = answerText != null && answerText.startsWith('[') && answerText.endsWith(']');
          const multiLabels = isMultiAnswer && answerText != null ? answerText.slice(1, -1).split(',').map((s) => s.trim()) : [];

          return (
            <div key={q.id} className={cn(qi > 0 && 'mt-2 border-t border-border/30 pt-2')}>
              {/* Question header */}
              <div className="mb-1 flex items-start gap-1.5">
                <span className="shrink-0 text-[9px] font-bold text-chart-2">Q{qi + 1}</span>
                <span className="flex-1 font-medium text-foreground whitespace-pre-wrap break-words">{q.question}</span>
                {q.multi && (
                  <span className="shrink-0 rounded bg-secondary/60 px-1 py-0.5 text-[8px] text-muted-foreground">多选</span>
                )}
              </div>

              {/* Options with selection markers */}
              <div className="flex flex-col gap-0.5">
                {q.options.map((opt, oi) => {
                  const isSelected = hasResult && (
                    (isMultiAnswer && multiLabels.includes(opt.label)) ||
                    (!isMultiAnswer && !isCustomAnswer && answerText === opt.label)
                  );
                  return (
                    <div key={oi} className={cn(
                      'flex items-start gap-1.5 rounded px-2 py-0.5 transition-colors',
                      isSelected && 'bg-status-pass/10',
                    )}>
                      <span className="mt-0.5 shrink-0 text-[10px]">
                        {q.multi ? (isSelected ? '☑' : '☐') : (isSelected ? '◉' : '○')}
                      </span>
                      <div className="min-w-0 flex-1">
                        <span className={cn('text-[10px]', isSelected ? 'text-foreground font-medium' : 'text-muted-foreground')}>
                          {opt.label}
                        </span>
                        {opt.description && (
                          <div className="text-[9px] text-muted-foreground/60">{opt.description}</div>
                        )}
                      </div>
                      {q.recommended === oi && !hasResult && (
                        <span className="shrink-0 rounded bg-primary/15 px-1 py-0.5 text-[8px] font-medium text-primary">推荐</span>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Show custom answer if present */}
              {customText && (
                <div className="mt-1 flex items-start gap-1.5 rounded bg-status-pass/10 px-2 py-0.5">
                  <span className="mt-0.5 shrink-0 text-[10px] text-status-pass-foreground">✎</span>
                  <span className="text-[10px] text-status-pass-foreground">{customText}</span>
                </div>
              )}

              {/* Show "no answer" if result exists but no match found */}
              {hasResult && !answerText && (
                <div className="mt-1 text-[10px] text-muted-foreground/50">(无答案)</div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  // Legacy single-question format
  const question = argStr(args, 'question', 'prompt') ?? '';
  const optionsArg = argVal(args, 'options');
  const options = normalizeAskOptions(optionsArg);
  const hasResult = resultText.trim().length > 0;
  const parsedResult = hasResult ? parseAskResult(resultText) : null;
  const selectedSet = new Set(parsedResult?.selectedLabels ?? []);

  return (
    <div className="px-2.5 py-2 text-[11px] leading-relaxed">
      <div className="mb-1.5 flex items-start gap-1.5">
        <span className="shrink-0 text-[9px] font-bold text-chart-2">Q</span>
        <span className="flex-1 font-medium text-foreground whitespace-pre-wrap break-words">{question}</span>
      </div>
      {options.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {options.map((opt, oi) => {
            const isSelected = selectedSet.has(opt.label);
            return (
              <div key={oi} className={cn(
                'flex items-start gap-1.5 rounded px-2 py-0.5 transition-colors',
                isSelected && 'bg-status-pass/10',
              )}>
                <span className="mt-0.5 shrink-0 text-[10px]">
                  {isSelected ? '◉' : '○'}
                </span>
                <div className="min-w-0 flex-1">
                  <span className={cn('text-[10px]', isSelected ? 'text-foreground font-medium' : 'text-muted-foreground')}>
                    {opt.label}
                  </span>
                  {opt.description && (
                    <div className="text-[9px] text-muted-foreground/60">{opt.description}</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {/* Show custom input answer */}
      {parsedResult?.customInput && (
        <div className="mt-1 flex items-start gap-1.5 rounded bg-status-pass/10 px-2 py-0.5">
          <span className="mt-0.5 shrink-0 text-[10px] text-status-pass-foreground">✎</span>
          <span className="text-[10px] text-status-pass-foreground">{parsedResult.customInput}</span>
        </div>
      )}
      {/* Show raw result as fallback if no structured answer found */}
      {hasResult && !parsedResult && (
        <div className="mt-1 text-[10px] text-status-pass-foreground">{resultText}</div>
      )}
    </div>
  );
}

// ── Host Table ──────────────────────────────────────────

type TableColumn = { key: string; label: string; type?: 'badge' | 'text' };

function HostTableBody({ resultText, columns, emptyMessage }: { resultText: string; columns: TableColumn[]; emptyMessage?: string }) {
  const items = parseJsonArray(resultText);
  if (!items || items.length === 0) {
    // Check if result is an error object
    const parsed = tryParseJSON(resultText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'error' in parsed) {
      return <div className="px-2.5 py-2 text-[11px] text-status-fail-foreground">{String((parsed as Record<string, unknown>).error)}</div>;
    }
    return <div className="px-2.5 py-2 text-[11px] text-muted-foreground">{emptyMessage ?? '无数据'}</div>;
  }
  return (
    <div className="max-h-80 overflow-auto text-[11px] leading-relaxed">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-border/40 bg-background/50">
            {columns.map((col) => (
              <th key={col.key} className="px-2.5 py-1 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">{col.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item, i) => (
            <tr key={i} className="border-b border-border/30 last:border-b-0">
              {columns.map((col) => {
                const val = item[col.key];
                if (col.type === 'badge') {
                  return <td key={col.key} className="px-2.5 py-1"><StatusBadge status={String(val ?? '').toLowerCase()} /></td>;
                }
                return <td key={col.key} className="px-2.5 py-1 text-muted-foreground">{val != null ? String(val) : ''}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase();
  const cls = s === 'pass' || s === 'passed' || s === 'done' || s === 'success'
    ? 'bg-status-pass/15 text-status-pass-foreground'
    : s === 'fail' || s === 'failed' || s === 'error'
      ? 'bg-status-fail/15 text-status-fail-foreground'
      : s === 'running' || s === 'active'
        ? 'bg-primary/15 text-primary'
        : 'bg-secondary text-muted-foreground';
  return <span className={cn('rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide', cls)}>{status || 'unknown'}</span>;
}

// ── Simulation Run ──────────────────────────────────────

function SimRunBody({ args, resultText }: { args: unknown; resultText: string; message: ChatMessage }) {
  const parsed = tryParseJSON(resultText) as Record<string, unknown> | null;
  const caseId = argStr(args, 'caseId', 'case', 'testcase') ?? '';
  const subsys = argStr(args, 'subsys') ?? '';
  const status = parsed ? String(parsed.status ?? parsed.result ?? '') : '';
  const runId = parsed ? String(parsed.runId ?? parsed.run_id ?? '') : '';
  const seed = parsed ? String(parsed.seed ?? '') : '';
  const simTime = parsed ? String(parsed.simTime ?? parsed.sim_time ?? '') : '';
  const isError = parsed && 'error' in parsed;

  // Build a display command from the args
  const cmdParts = ['runsim', '-cmd', 'run'];
  if (caseId) cmdParts.push('-case', caseId);
  if (subsys) cmdParts.push('-subsys', subsys);
  const optionsVal = argVal(args, 'options');
  if (optionsVal && typeof optionsVal === 'object') {
    for (const [k, v] of Object.entries(optionsVal as Record<string, unknown>)) {
      if (v !== undefined && v !== null && v !== '') {
        cmdParts.push(`-${k}`, String(v));
      }
    }
  }
  const displayCommand = cmdParts.join(' ');

  const handleOpenInTerminal = useCallback(() => {
    const projectId = useProjectStore.getState().currentProjectId;
    if (!projectId) {
      useToastStore.getState().warning('未打开项目', '需要先打开项目才能在终端中运行仿真。');
      return;
    }
    trpc.simulation.runInTerminal.mutate({
      projectId,
      options: {
        caseId,
        caseName: caseId,
        subsys,
        options: (typeof optionsVal === 'object' && optionsVal !== null ? optionsVal : {}) as Record<string, unknown>,
      },
    })
      .then((result) => {
        useTerminalStore.getState().createTabForSession(
          result.terminalId,
          `sim: ${caseId}`,
          result.cwd,
          (result as { backend?: string }).backend === 'log-mode',
          (result as { warning?: string | null }).warning ?? null,
        );
      })
      .catch((err) => {
        useToastStore.getState().error('终端启动失败', err instanceof Error ? err.message : String(err));
      });
  }, [caseId, subsys, optionsVal]);

  return (
    <div className="px-2.5 py-2 text-[11px] leading-relaxed">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="font-semibold text-foreground">{subsys && caseId ? `${subsys}/${caseId}` : caseId || 'simulation'}</span>
        {status && <StatusBadge status={status} />}
      </div>
      {/* Command display */}
      <div className="mb-1.5 rounded border border-border/40 bg-background/50 px-2 py-1 font-mono text-[10px] text-violet-foreground break-all">
        <span className="text-muted-foreground/50">$ </span>{displayCommand}
      </div>
      {(runId || seed || simTime) && (
        <div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground/60">
          {runId && <span>run_id: {runId}</span>}
          {seed && <span>seed: {seed}</span>}
          {simTime && <span>sim_time: {simTime}</span>}
        </div>
      )}
      {isError && (
        <div className="mt-1 text-status-fail-foreground">{String(parsed!.error)}</div>
      )}
      {!parsed && !isError && <pre className="mt-1 text-muted-foreground">{resultText}</pre>}
      {/* Open in terminal button */}
      {!isError && (
        <button
          onClick={handleOpenInTerminal}
          className="mt-1.5 flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="在终端中运行此仿真命令"
        >
          <Terminal className="h-2.5 w-2.5" />
          在终端中运行
        </button>
      )}
    </div>
  );
}

// ── Sim Options Schema ──────────────────────────────────

function SimOptionsSchemaBody({ resultText }: { resultText: string }) {
  const parsed = tryParseJSON(resultText) as Record<string, unknown> | null;

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return <GenericBody args={null} resultText={resultText} />;
  }

  const fields = Object.entries(parsed).map(([key, val]) => {
    const v = (val ?? {}) as Record<string, unknown>;
    return {
      key,
      label: typeof v.label === 'string' ? v.label : key,
      type: typeof v.type === 'string' ? v.type : 'string',
      default: v.default,
      enumValues: Array.isArray(v.enumValues) ? v.enumValues as string[] : undefined,
      description: typeof v.description === 'string' ? v.description : undefined,
    };
  });

  if (fields.length === 0) {
    return <div className="px-2.5 py-2 text-[11px] text-muted-foreground">无仿真选项</div>;
  }

  return (
    <div className="max-h-80 overflow-auto text-[11px] leading-relaxed">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-border/40 bg-background/50">
            <th className="px-2.5 py-1 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">Option</th>
            <th className="px-2.5 py-1 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">Type</th>
            <th className="px-2.5 py-1 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">Default</th>
            <th className="px-2.5 py-1 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">Description</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((f) => (
            <tr key={f.key} className="border-b border-border/30 last:border-b-0">
              <td className="px-2.5 py-1">
                <span className="font-mono text-foreground">{f.key}</span>
                <span className="ml-1 text-[10px] text-muted-foreground/50">{f.label !== f.key ? f.label : ''}</span>
              </td>
              <td className="px-2.5 py-1">
                <span className="rounded bg-secondary/60 px-1 py-0.5 text-[9px] font-medium text-muted-foreground">{f.type}</span>
              </td>
              <td className="px-2.5 py-1 font-mono text-[10px] text-muted-foreground">
                {f.enumValues ? (
                  <span className="text-chart-1">{f.enumValues.join(' | ')}</span>
                ) : f.default !== undefined ? (
                  String(f.default)
                ) : (
                  <span className="text-muted-foreground/40">—</span>
                )}
              </td>
              <td className="px-2.5 py-1 text-[10px] text-muted-foreground/70">
                {f.description ?? ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Coverage ────────────────────────────────────────────

function CoverageBody({ resultText }: { resultText: string }) {
  const parsed = tryParseJSON(resultText) as Record<string, unknown> | null;
  const metrics = [
    { label: 'Line', value: numFromObj(parsed, 'line', 'lineCoverage') },
    { label: 'Toggle', value: numFromObj(parsed, 'toggle', 'toggleCoverage') },
    { label: 'FSM', value: numFromObj(parsed, 'fsm', 'fsmCoverage', 'functional') },
    { label: 'Assert', value: numFromObj(parsed, 'assertion', 'assertCoverage') },
  ];

  if (!metrics.some((m) => m.value != null)) {
    return <GenericBody args={null} resultText={resultText} />;
  }

  return (
    <div className="grid grid-cols-4 gap-px bg-border/40 text-[11px] leading-relaxed">
      {metrics.map((m) => {
        const pct = m.value != null ? (m.value > 1 ? m.value : m.value * 100) : null;
        const cls = pct == null ? 'text-muted-foreground' : pct >= 85 ? 'text-status-pass-foreground' : pct >= 70 ? 'text-warning-foreground' : 'text-status-fail-foreground';
        return (
          <div key={m.label} className="bg-secondary/20 px-2 py-2 text-center">
            <div className="text-[9px] uppercase tracking-wide text-muted-foreground/60">{m.label}</div>
            <div className={cn('mt-0.5 text-base font-bold tabular-nums', cls)}>{pct != null ? `${pct.toFixed(1)}%` : '--'}</div>
          </div>
        );
      })}
    </div>
  );
}

// ── Compile Errors ──────────────────────────────────────

function CompileErrorsBody({ resultText }: { resultText: string }) {
  const parsed = parseJsonArray(resultText);
  let errors: Array<{ severity: string; message: string; file?: string; line?: number }> = [];

  if (parsed) {
    errors = parsed.map((item) => ({
      severity: String(item.severity ?? item.level ?? 'error'),
      message: String(item.message ?? item.text ?? item.msg ?? ''),
      file: item.file ? String(item.file) : item.path ? String(item.path) : undefined,
      line: typeof item.line === 'number' ? item.line : typeof item.lineNumber === 'number' ? item.lineNumber : undefined,
    }));
  } else {
    errors = resultText.split('\n').filter(Boolean).map((line) => {
      const match = line.match(/^(error|warning|info)[:\s]+(.+?)(?:\s+at\s+(.+):(\d+))?$/i);
      if (match) return { severity: match[1].toLowerCase(), message: match[2], file: match[3], line: match[4] ? parseInt(match[4], 10) : undefined };
      return { severity: 'error', message: line };
    });
  }

  if (errors.length === 0) {
    return <div className="px-2.5 py-2 text-[11px] text-status-pass-foreground">No compilation errors found.</div>;
  }

  return (
    <div className="max-h-80 overflow-auto text-[11px] leading-relaxed">
      {errors.map((err, i) => {
        const isError = err.severity === 'error' || err.severity === 'fatal';
        return (
          <div key={i} className="border-b border-border/30 px-2.5 py-1.5 last:border-b-0">
            <div className="flex items-center gap-1.5">
              <span className={cn(
                'rounded px-1 py-0.5 text-[9px] font-bold uppercase',
                isError ? 'bg-status-fail/15 text-status-fail-foreground' : 'bg-warning/15 text-warning-foreground',
              )}>{err.severity}</span>
              <span className="text-foreground">{err.message}</span>
            </div>
            {err.file && (
              <div className="mt-0.5 font-mono text-[10px] text-status-running-foreground">
                {err.file}{err.line ? `:${err.line}` : ''}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Run Status ──────────────────────────────────────────

function RunStatusBody({ args, resultText }: { args: unknown; resultText: string }) {
  const parsed = tryParseJSON(resultText) as Record<string, unknown> | null;
  const runId = argStr(args, 'runId') ?? '';

  if (!parsed) {
    return <GenericBody args={args} resultText={resultText} />;
  }

  const status = String(parsed.status ?? parsed.state ?? 'unknown');
  const fields = Object.entries(parsed).filter(([k]) => k !== 'status' && k !== 'state');

  return (
    <div className="px-2.5 py-2 text-[11px] leading-relaxed">
      <div className="mb-1.5 flex items-center gap-2">
        {runId && <span className="font-semibold text-foreground">{runId}</span>}
        <StatusBadge status={status} />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[10px] text-muted-foreground/70">
        {fields.map(([k, v]) => (
          <span key={k}>{k}: {String(v)}</span>
        ))}
      </div>
    </div>
  );
}

// ── Generic fallback ────────────────────────────────────

function GenericBody({ args, resultText }: { args: unknown; resultText: string }) {
  const hasArgs = args != null && typeof args === 'object' && Object.keys(args as object).length > 0;
  return (
    <div className="text-[11px] leading-relaxed">
      {hasArgs && (
        <div>
          <div className="border-b border-border/30 bg-background/50 px-2.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground/60">args</div>
          <pre className="overflow-x-auto px-2.5 py-1 text-[10px] text-muted-foreground">{JSON.stringify(args, null, 2)}</pre>
        </div>
      )}
      {resultText && (
        <div>
          <div className="border-b border-border/30 bg-background/50 px-2.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground/60">result</div>
          <pre className="max-h-48 overflow-auto px-2.5 py-1 text-[10px] text-muted-foreground">{resultText}</pre>
        </div>
      )}
      {!hasArgs && !resultText && <div className="px-2.5 py-2 text-muted-foreground/50">no output</div>}
    </div>
  );
}
