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
import { Loader2, ChevronDown } from 'lucide-react';
import { useDiffReviewStore } from '@renderer/stores/diff-review';
import hljs from 'highlight.js';
import { cn } from '@renderer/lib/utils';
import type { ChatMessage } from '@renderer/stores/session';
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

// ── Main ToolCard ───────────────────────────────────────

const FILE_EDITING_TOOLS = new Set(['write', 'edit', 'apply_patch', 'ast_edit']);

export function ToolCard({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  const isExecuting = !message.toolResult;
  const meta = getToolMeta(message.toolName);
  const isFileTool = !isExecuting && FILE_EDITING_TOOLS.has(message.toolName ?? '');
  const filePath = isFileTool
    ? (argStr(message.toolArgs, 'path', 'file_path') ?? '')
    : '';

  const handleOpenDiffReview = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!filePath) return;
    useDiffReviewStore.getState().refreshQueue();
    useDiffReviewStore.getState().openFile(filePath);
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

  const summary = buildSummary(message);
  const isError = typeof message.toolResult === 'object' && message.toolResult !== null
    && 'isError' in message.toolResult
    && (message.toolResult as { isError: boolean }).isError;

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
          <span className={cn('h-2 w-2 shrink-0 rounded-full', isError ? 'bg-red-500' : 'bg-green-500')} />
        )}
        <span className={cn('shrink-0 text-[11px] font-semibold', meta.color)}>
          {meta.label}
        </span>
        {isFileTool && filePath ? (
          <span
            onClick={handleOpenDiffReview}
            className="flex-1 min-w-0 truncate text-[11px] cursor-pointer text-blue-500 hover:text-blue-400 hover:underline"
            title={`点击在 Diff Review 中打开: ${filePath}`}
          >
            {summary}
          </span>
        ) : (
          <span className="flex-1 min-w-0 truncate text-[11px] text-muted-foreground">
            {summary}
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
          <ToolBody message={message} isExecuting={isExecuting} />
        </div>
      )}
    </div>
  );
}

// ── Summary ─────────────────────────────────────────────

function buildSummary(message: ChatMessage): ReactNode {
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
    case 'read': {
      const path = argStr(args, 'path', 'file_path') ?? '';
      const lineCount = resultText ? resultText.split('\n').length : 0;
      return <><span className="text-foreground">{shortenPath(path)}</span> {' \u00b7 '} {isExecuting ? 'reading...' : `${lineCount} lines`}</>;
    }
    case 'write': {
      const path = argStr(args, 'path', 'file_path') ?? '';
      const lines = (argStr(args, 'content') ?? '').split('\n').length;
      return <><span className="text-foreground">{shortenPath(path)}</span> {' \u00b7 '} new file, {lines} lines</>;
    }
    case 'edit':
    case 'apply_patch':
    case 'ast_edit': {
      const path = argStr(args, 'path', 'file_path') ?? '';
      return <><span className="text-foreground">{shortenPath(path)}</span> {' \u00b7 '} {isExecuting ? 'editing...' : 'edited'}</>;
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
      const done = todos.filter((t) => t.done).length;
      return <>{todos.length} items {' \u00b7 '} {done}/{todos.length} done</>;
    }
    case 'web_search': {
      const query = argStr(args, 'query', 'q') ?? '';
      return <>"{query}" {' \u00b7 '} {isExecuting ? 'searching...' : `${countLines(resultText)} results`}</>;
    }
    case 'ask': {
      const question = argStr(args, 'question', 'prompt') ?? '';
      return <span className="truncate">{question.slice(0, 60)}</span>;
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
    default: {
      if (isExecuting) return <span className="text-foreground/60">executing...</span>;
      if (!resultText) return 'no output';
      return <span className="text-foreground/80">{name || 'tool'}</span>;
    }
  }
}

// ── Tool body dispatcher ────────────────────────────────

function ToolBody({ message, isExecuting }: { message: ChatMessage; isExecuting: boolean }) {
  const name = message.toolName ?? '';
  const resultText = extractResultText(message.toolResult);

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
      return <ReadBody args={message.toolArgs} resultText={resultText} />;
    case 'write':
      return <WriteBody args={message.toolArgs} resultText={resultText} />;
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
      return <AskBody args={message.toolArgs} />;
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
      ]} />;
    case 'run_simulation':
      return <SimRunBody args={message.toolArgs} resultText={resultText} />;
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
      <div className="border-b border-border/40 bg-background/50 px-2.5 py-1 text-[10px] text-amber-400/80">
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
    <div className="flex max-h-80 overflow-auto text-[11px] leading-relaxed">
      <div className="select-none border-r border-border/40 bg-background/50 px-2 py-1.5 text-right text-muted-foreground/60">
        {lines.map((_, i) => <div key={i}>{offset + i}</div>)}
      </div>
      <div className="flex-1 overflow-x-auto px-2.5 py-1.5">
        <CodeHighlight code={resultText} language={language} className="text-foreground/90" />
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
    <div className="max-h-80 overflow-auto bg-green-500/10 text-[11px] leading-relaxed">
      {lines.map((line, i) => (
        <div key={i} className="flex">
          <span className="w-5 shrink-0 select-none text-center text-green-500">+</span>
          <span className="w-8 shrink-0 select-none border-r border-green-500/20 pr-1 text-right text-green-700/60 dark:text-green-500/40">{i + 1}</span>
          <span className="flex-1 overflow-x-auto px-2 text-green-700 dark:text-green-300/90">
            <CodeHighlight code={line || '\u00A0'} language={language} />
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Edit ────────────────────────────────────────────────

function EditBody({ args, resultText }: { args: unknown; resultText: string }) {
  const filePath = argStr(args, 'path', 'file_path') ?? '';
  const language = detectLanguage(filePath);
  const oldText = argStr(args, 'oldText', 'old_string', 'find');
  const newText = argStr(args, 'newText', 'new_string', 'replace');

  if (oldText != null && newText != null) {
    const diff = computeSimpleDiff(oldText, newText);
    return (
      <div className="max-h-80 overflow-auto text-[11px] leading-relaxed">
        {diff.map((line, i) => <DiffLineView key={i} line={line} language={language} />)}
      </div>
    );
  }

  // Fallback: if resultText looks like diff
  if (resultText.includes('@@') || /^[+-]/m.test(resultText)) {
    const lines = resultText.split('\n').map((content) => {
      if (content.startsWith('+++') || content.startsWith('---') || content.startsWith('@@')) return { type: 'hunk' as const, content };
      if (content.startsWith('+')) return { type: 'add' as const, content: content.slice(1) };
      if (content.startsWith('-')) return { type: 'del' as const, content: content.slice(1) };
      return { type: 'ctx' as const, content: content.startsWith(' ') ? content.slice(1) : content };
    });
    return (
      <div className="max-h-80 overflow-auto text-[11px] leading-relaxed">
        {lines.map((line, i) => {
          if (line.type === 'hunk') {
            return <div key={i} className="bg-secondary/40 px-2.5 py-0.5 text-[10px] text-muted-foreground/70">{line.content}</div>;
          }
          return <DiffLineView key={i} line={line} language={language} />;
        })}
      </div>
    );
  }

  return <GenericBody args={args} resultText={resultText} />;
}

function DiffLineView({ line, language }: { line: DiffLineData; language: string }) {
  const sign = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
  return (
    <div className={cn('flex', line.type === 'add' && 'bg-green-500/10', line.type === 'del' && 'bg-red-500/10')}>
      <span className={cn(
        'w-8 shrink-0 select-none pr-1 text-right text-[10px]',
        line.type === 'add' && 'text-green-600/60 dark:text-green-500/40',
        line.type === 'del' && 'text-red-600/60 dark:text-red-500/40',
        line.type === 'ctx' && 'text-muted-foreground/40',
      )}>
        {line.type === 'add' ? line.newLine ?? '' : line.oldLine ?? ''}
      </span>
      <span className={cn(
        'w-4 shrink-0 select-none text-center',
        line.type === 'add' && 'text-green-500',
        line.type === 'del' && 'text-red-500',
        line.type === 'ctx' && 'text-muted-foreground/50',
      )}>{sign}</span>
      <span className={cn(
        'flex-1 overflow-x-auto px-1.5',
        line.type === 'add' && 'text-green-700 dark:text-green-300/90',
        line.type === 'del' && 'text-red-700/80 line-through dark:text-red-300/70',
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
      <div className="border-b border-border/40 bg-background/50 px-2.5 py-1 text-purple-400">
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
      <div className="border-b border-border/40 bg-background/50 px-2.5 py-1 text-indigo-400">
        <span className="text-muted-foreground/50">{'\u203a'} </span>{code}
      </div>
      <pre className="max-h-72 overflow-auto px-2.5 py-1.5 text-muted-foreground">
        <span className="text-green-500">{'\u2190'} </span>{resultText || '\u00A0'}
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
          <div className="border-b border-border/30 bg-background/50 px-2.5 py-0.5 font-semibold text-cyan-400">{f.file}</div>
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
      result.push(<span key={i} className="rounded bg-cyan-500/20 px-0.5 text-cyan-400">{matches[i]}</span>);
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
          <span className="text-sky-400">{'\u00b0'} </span>{file}
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
            item.status === 'done' && 'bg-green-500/15 text-green-500',
            item.status === 'running' && 'bg-primary/15 text-primary',
            item.status === 'pending' && 'bg-secondary text-muted-foreground',
            item.status === 'error' && 'bg-red-500/15 text-red-500',
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
          <span className="shrink-0 font-semibold text-teal-400">{item.id}</span>
          <span className="flex-1 min-w-0 truncate text-muted-foreground">{item.desc}</span>
          {item.progress != null && (
            <div className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-secondary">
              <div className="h-full rounded-full bg-teal-400" style={{ width: `${item.progress}%` }} />
            </div>
          )}
          <span className={cn(
            'shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
            item.status === 'done' && 'bg-green-500/15 text-green-500',
            item.status === 'running' && 'bg-primary/15 text-primary',
            item.status === 'failed' && 'bg-red-500/15 text-red-500',
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
            item.done ? 'border-violet-400 bg-violet-400 text-background' : 'border-border bg-transparent text-transparent',
          )}>{item.done ? '\u2713' : ''}</span>
          <span className={cn(item.done ? 'text-muted-foreground/50 line-through' : 'text-muted-foreground')}>{item.text}</span>
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
          <div className="font-medium text-red-400">{r.title}</div>
          {r.url && <div className="text-[10px] text-muted-foreground/50">{r.url}</div>}
          {r.snippet && <div className="mt-0.5 text-muted-foreground">{r.snippet}</div>}
        </div>
      )) : <pre className="px-2.5 py-1.5 text-muted-foreground">{resultText || '\u00A0'}</pre>}
    </div>
  );
}

// ── Ask ─────────────────────────────────────────────────

function AskBody({ args }: { args: unknown }) {
  const question = argStr(args, 'question', 'prompt') ?? '';
  const optionsArg = argVal(args, 'options');
  const options: string[] = Array.isArray(optionsArg)
    ? optionsArg.map((o) => typeof o === 'string' ? o : String((o as Record<string, unknown>)?.label ?? (o as Record<string, unknown>)?.text ?? o))
    : [];

  return (
    <div className="px-2.5 py-2 text-[11px] leading-relaxed">
      <div className="mb-1.5 font-medium text-lime-400"><span className="mr-1">?</span>{question}</div>
      {options.length > 0 && (
        <div className="flex flex-col gap-1">
          {options.map((opt, i) => (
            <div key={i} className="cursor-pointer rounded border border-border px-2 py-1 text-muted-foreground transition-colors hover:border-lime-400/50 hover:text-lime-400">{opt}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Host Table ──────────────────────────────────────────

type TableColumn = { key: string; label: string; type?: 'badge' | 'text' };

function HostTableBody({ resultText, columns }: { resultText: string; columns: TableColumn[] }) {
  const items = parseJsonArray(resultText);
  if (!items || items.length === 0) {
    return <pre className="max-h-72 overflow-auto px-2.5 py-1.5 text-[11px] text-muted-foreground">{resultText || 'no data'}</pre>;
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
    ? 'bg-green-500/15 text-green-500'
    : s === 'fail' || s === 'failed' || s === 'error'
      ? 'bg-red-500/15 text-red-500'
      : s === 'running' || s === 'active'
        ? 'bg-primary/15 text-primary'
        : 'bg-secondary text-muted-foreground';
  return <span className={cn('rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide', cls)}>{status || 'unknown'}</span>;
}

// ── Simulation Run ──────────────────────────────────────

function SimRunBody({ args, resultText }: { args: unknown; resultText: string }) {
  const parsed = tryParseJSON(resultText) as Record<string, unknown> | null;
  const caseId = argStr(args, 'caseId', 'case', 'testcase') ?? '';
  const subsys = argStr(args, 'subsys') ?? '';
  const status = parsed ? String(parsed.status ?? parsed.result ?? '') : '';
  const runId = parsed ? String(parsed.runId ?? parsed.run_id ?? '') : '';
  const seed = parsed ? String(parsed.seed ?? '') : '';
  const simTime = parsed ? String(parsed.simTime ?? parsed.sim_time ?? '') : '';

  return (
    <div className="px-2.5 py-2 text-[11px] leading-relaxed">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="font-semibold text-foreground">{subsys && caseId ? `${subsys}/${caseId}` : caseId || 'simulation'}</span>
        {status && <StatusBadge status={status} />}
      </div>
      {(runId || seed || simTime) && (
        <div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground/60">
          {runId && <span>run_id: {runId}</span>}
          {seed && <span>seed: {seed}</span>}
          {simTime && <span>sim_time: {simTime}</span>}
        </div>
      )}
      {!parsed && <pre className="mt-1 text-muted-foreground">{resultText}</pre>}
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
        const cls = pct == null ? 'text-muted-foreground' : pct >= 85 ? 'text-green-500' : pct >= 70 ? 'text-yellow-500' : 'text-red-500';
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
    return <div className="px-2.5 py-2 text-[11px] text-green-500">No compilation errors found.</div>;
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
                isError ? 'bg-red-500/15 text-red-500' : 'bg-yellow-500/15 text-yellow-500',
              )}>{err.severity}</span>
              <span className="text-foreground">{err.message}</span>
            </div>
            {err.file && (
              <div className="mt-0.5 font-mono text-[10px] text-blue-400">
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
