/**
 * ToolCard — thin dispatch shell + TOOL_REGISTRY.
 *
 * Renders AI Agent tool calls with specialized views per tool type.
 * Each tool's summary builder and body component live in tool-bodies/<category>/.
 * This module wires them together via a single TOOL_REGISTRY lookup.
 */
import { useState, useEffect, useCallback, type ReactNode, type ComponentType } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Loader2, ChevronDown } from 'lucide-react';
import { openReviewAwareFile } from '@renderer/stores/diff-review';
import { useSessionStore, type ChatMessage, type SubagentActivity } from '@renderer/stores/session';
import { SubagentCard } from './SubagentCard';
import { cn } from '@renderer/lib/utils';
import {
  getToolMeta,
  isMCPTool,
  parseMCPToolName,
  extractResultText,
  argStr,
  argVal,
  shortenPath,
  countGrepMatches,
  countLines,
  tryParseJSON,
  parseJsonArray,
  parseTaskItemsFromResult,
  isTaskAsyncRunning,
  buildSubagentsFromResult,
  parseJobItems,
  parseTodoItems,
  extractEditFilePath,
  hasResultWarning,
} from './tool-helpers';
import { getFileDiffStats } from './tool-bodies/shared/diff-stats';
import { GenericBody } from './tool-bodies/shared/GenericBody';
import { McpBody } from './tool-bodies/shared/McpBody';
import { HostTableBody } from './tool-bodies/shared/HostTableBody';
import { ReadBody } from './tool-bodies/file/ReadBody';
import { WriteBody } from './tool-bodies/file/WriteBody';
import { EditBody } from './tool-bodies/file/EditBody';
import { BashBody } from './tool-bodies/exec/BashBody';
import { EvalBody } from './tool-bodies/exec/EvalBody';
import { GrepBody } from './tool-bodies/exec/GrepBody';
import { GlobBody } from './tool-bodies/exec/GlobBody';
import { WebSearchBody } from './tool-bodies/exec/WebSearchBody';
import { TaskBody } from './tool-bodies/agent/TaskBody';
import { JobBody } from './tool-bodies/agent/JobBody';
import { TodoBody } from './tool-bodies/agent/TodoBody';
import { SimRunBody } from './tool-bodies/host/SimRunBody';
import { SimOptionsSchemaBody } from './tool-bodies/host/SimOptionsSchemaBody';
import { CoverageBody } from './tool-bodies/host/CoverageBody';
import { CompileErrorsBody } from './tool-bodies/host/CompileErrorsBody';
import { RunStatusBody } from './tool-bodies/host/RunStatusBody';
import { AskBody } from './tool-bodies/interactive/AskBody';

// ── Types ──────────────────────────────────────────────

type ToolBodyProps = { message: ChatMessage; taskAgents: SubagentActivity[] };

type ToolEntry = {
  summary: (message: ChatMessage, taskAgents: SubagentActivity[]) => ReactNode;
  Body: ComponentType<ToolBodyProps>;
};

// ── Summary helpers ────────────────────────────────────

function readSummary(message: ChatMessage): ReactNode {
  const args = message.toolArgs;
  const resultText = extractResultText(message.toolResult);
  const isExecuting = !message.toolResult;
  const path = argStr(args, 'path', 'file_path') ?? '';
  const lineCount = resultText ? resultText.split('\n').length : 0;
  return <><span className="text-foreground">{shortenPath(path)}</span> {' \u00b7 '} {isExecuting ? 'reading...' : `${lineCount} lines`}</>;
}

function writeSummary(message: ChatMessage): ReactNode {
  const args = message.toolArgs;
  const isExecuting = !message.toolResult;
  const path = argStr(args, 'path', 'file_path') ?? '';
  const lines = (argStr(args, 'content') ?? '').split('\n').length;
  return <><span className="text-foreground">{shortenPath(path)}</span> {' \u00b7 '} {isExecuting ? 'writing...' : `wrote ${lines} lines`}</>;
}

function editSummary(message: ChatMessage): ReactNode {
  const args = message.toolArgs;
  const resultText = extractResultText(message.toolResult);
  const isExecuting = !message.toolResult;
  const path = extractEditFilePath(args, resultText);
  if (!path) return <>{isExecuting ? 'editing...' : 'edited'}</>;
  const hasWarn = !isExecuting && hasResultWarning(resultText);
  return <><span className="text-foreground">{shortenPath(path)}</span> {' \u00b7 '} {isExecuting ? 'editing...' : hasWarn ? 'edited (with warnings)' : 'edited'}</>;
}

function bashSummary(message: ChatMessage): ReactNode {
  const cmd = argStr(message.toolArgs, 'command') ?? '';
  const short = cmd.replace(/[\n\t]/g, ' ').trim().slice(0, 50);
  return <><span className="text-foreground">{short}</span>{cmd.length > 50 ? '...' : ''}</>;
}

function evalSummary(message: ChatMessage): ReactNode {
  const code = argStr(message.toolArgs, 'code') ?? '';
  const short = code.replace(/\n/g, ' ').trim().slice(0, 40);
  return <><span className="text-foreground">{short}</span>{code.length > 40 ? '...' : ''}</>;
}

function grepSummary(message: ChatMessage): ReactNode {
  const pattern = argStr(message.toolArgs, 'pattern', 'query') ?? '';
  const resultText = extractResultText(message.toolResult);
  const isExecuting = !message.toolResult;
  const matchCount = countGrepMatches(resultText);
  return <><span className="text-foreground">/{pattern}/</span> {' \u00b7 '} {isExecuting ? 'searching...' : `${matchCount} match${matchCount !== 1 ? 'es' : ''}`}</>;
}

function globSummary(message: ChatMessage): ReactNode {
  const pattern = argStr(message.toolArgs, 'pattern') ?? '';
  const resultText = extractResultText(message.toolResult);
  const isExecuting = !message.toolResult;
  const fileCount = resultText ? resultText.trim().split('\n').filter(Boolean).length : 0;
  return <><span className="text-foreground">{pattern}</span> {' \u00b7 '} {isExecuting ? 'finding...' : `${fileCount} files`}</>;
}

function taskSummary(message: ChatMessage, taskAgents: SubagentActivity[]): ReactNode {
  const isExecuting = !message.toolResult;
  if (taskAgents.length > 0) {
    const running = taskAgents.filter((a) => a.status === 'running').length;
    if (running > 0) return <>{taskAgents.length} 个子代理 {' \u00b7 '}{running} 运行中</>;
    const done = taskAgents.filter((a) => a.status === 'completed').length;
    const failed = taskAgents.filter((a) => a.status === 'failed').length;
    return <>{taskAgents.length} 个子代理 {' \u00b7 '}{done} 成功{failed > 0 ? ` / ${failed} 失败` : ''}</>;
  }
  const taskItems = parseTaskItemsFromResult(message.toolResult);
  if (isExecuting) return <>dispatching sub-agents...</>;
  if (isTaskAsyncRunning(message.toolResult)) {
    const running = taskItems.filter((t) => t.status === 'running').length;
    return <>{taskItems.length} 个子代理 {' \u00b7 '}{running} 运行中</>;
  }
  const done = taskItems.filter((t) => t.status === 'done').length;
  const failed = taskItems.filter((t) => t.status === 'error').length;
  return <>{taskItems.length} 个子代理 {' \u00b7 '}{done} 成功{failed > 0 ? ` / ${failed} 失败` : ''}</>;
}

function jobSummary(message: ChatMessage): ReactNode {
  const isExecuting = !message.toolResult;
  const resultText = extractResultText(message.toolResult);
  const jobs = parseJobItems(resultText);
  if (isExecuting) return <>starting jobs...</>;
  const running = jobs.filter((j) => j.status === 'running').length;
  return <>{jobs.length} jobs {' \u00b7 '} {running > 0 ? `${running} running` : 'all done'}</>;
}

function todoSummary(message: ChatMessage): ReactNode {
  const args = message.toolArgs;
  const resultText = extractResultText(message.toolResult);
  const todos = parseTodoItems(args, resultText);
  const done = todos.filter((t) => t.status === 'completed').length;
  return <>{todos.length} items {' \u00b7 '} {done}/{todos.length} done</>;
}

function webSearchSummary(message: ChatMessage): ReactNode {
  const isExecuting = !message.toolResult;
  const resultText = extractResultText(message.toolResult);
  const query = argStr(message.toolArgs, 'query', 'q') ?? '';
  return <>"{query}" {' \u00b7 '} {isExecuting ? 'searching...' : `${countLines(resultText)} results`}</>;
}

function askSummary(message: ChatMessage): ReactNode {
  const isExecuting = !message.toolResult;
  const resultText = extractResultText(message.toolResult);
  const args = message.toolArgs;
  const questionsArg = argVal(args, 'questions');
  if (Array.isArray(questionsArg) && questionsArg.length > 0) {
    const count = questionsArg.length;
    const firstQ = questionsArg[0] as Record<string, unknown> | undefined;
    const firstQuestionText = typeof firstQ?.question === 'string' ? firstQ.question : '';
    const hasResult = !isExecuting && resultText;
    if (hasResult) return <><span className="text-foreground">{count} 个问题已回答</span></>;
    return <><span className="text-foreground/80">{count} 个问题</span>{firstQuestionText ? `: ${firstQuestionText.slice(0, 40)}` : ''}</>;
  }
  const question = argStr(args, 'question', 'prompt') ?? '';
  if (isExecuting) return <span className="truncate">{question.slice(0, 60) || 'asking...'}</span>;
  return <><span className="text-foreground/80">已回答</span></>;
}

function listSubsysSummary(message: ChatMessage): ReactNode {
  const isExecuting = !message.toolResult;
  const items = parseJsonArray(extractResultText(message.toolResult));
  return <>{isExecuting ? 'listing...' : `${items?.length ?? 0} subsystems found`}</>;
}

function listCasesSummary(message: ChatMessage): ReactNode {
  const isExecuting = !message.toolResult;
  const items = parseJsonArray(extractResultText(message.toolResult));
  const subsys = argStr(message.toolArgs, 'subsys');
  return <>{subsys ? `subsys=${subsys} ` : ''}{isExecuting ? 'listing...' : `${items?.length ?? 0} cases`}</>;
}

function runSimulationSummary(message: ChatMessage): ReactNode {
  const caseId = argStr(message.toolArgs, 'caseId', 'case', 'testcase') ?? '';
  const subsys = argStr(message.toolArgs, 'subsys');
  const label = [subsys, caseId].filter(Boolean).join('/') || 'simulation';
  return <><span className="text-foreground">{label}</span></>;
}

function coverageSummary(message: ChatMessage): ReactNode {
  const subsys = argStr(message.toolArgs, 'subsys') ?? 'all';
  const runId = argStr(message.toolArgs, 'runId') ?? '';
  return <>{subsys}{runId ? ` {' \u00b7 '} ${runId}` : ''}</>;
}

function compileErrorsSummary(message: ChatMessage): ReactNode {
  const isExecuting = !message.toolResult;
  const errors = parseJsonArray(extractResultText(message.toolResult));
  const errCount = errors?.filter((e) => {
    const sev = String(e.severity ?? e.level ?? '').toLowerCase();
    return sev === 'error' || sev === 'fatal';
  }).length ?? 0;
  return <>{isExecuting ? 'checking...' : errCount > 0 ? `${errCount} errors` : 'no errors'}</>;
}

function runStatusSummary(message: ChatMessage): ReactNode {
  const runId = argStr(message.toolArgs, 'runId') ?? '';
  return <><span className="text-foreground">{runId}</span></>;
}

function simOptionsSchemaSummary(message: ChatMessage): ReactNode {
  const isExecuting = !message.toolResult;
  if (isExecuting) return <>loading schema...</>;
  const parsed = tryParseJSON(extractResultText(message.toolResult));
  const count = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed).length : 0;
  return <>{count > 0 ? `${count} options` : 'no options'}</>;
}

function defaultSummary(message: ChatMessage): ReactNode {
  const isExecuting = !message.toolResult;
  const resultText = extractResultText(message.toolResult);
  const name = message.toolName ?? '';
  if (isExecuting) return <span className="text-foreground/60">executing...</span>;
  if (!resultText) return 'no output';
  return <span className="text-foreground/80">{name || 'tool'}</span>;
}

function mcpSummary(message: ChatMessage): ReactNode {
  const name = message.toolName ?? '';
  const isExecuting = !message.toolResult;
  const resultText = extractResultText(message.toolResult);
  const parsed = parseMCPToolName(name);
  const toolLabel = parsed ? parsed.toolName : name;
  const argSummary = argStr(message.toolArgs, 'query', 'command', 'path', 'file', 'text', 'input') ?? '';
  const short = argSummary.replace(/[\n\t]/g, ' ').trim().slice(0, 40);
  if (isExecuting) return <><span className="text-foreground">{toolLabel}</span>{' \u00b7 '}executing...</>;
  const resultLines = resultText ? countLines(resultText) : 0;
  return <><span className="text-foreground">{toolLabel}</span>{short ? `: ${short}` : ''}{' \u00b7 '}{resultLines > 0 ? `${resultLines} lines` : 'done'}</>;
}

// ── Body wrappers (adapt old props to unified ToolBodyProps) ──

function ReadBodyWrap({ message }: ToolBodyProps) {
  return <ReadBody args={message.toolArgs} resultText={extractResultText(message.toolResult)} />;
}
function WriteBodyWrap({ message }: ToolBodyProps) {
  return <WriteBody args={message.toolArgs} resultText={extractResultText(message.toolResult)} />;
}
function EditBodyWrap({ message }: ToolBodyProps) {
  return <EditBody args={message.toolArgs} resultText={extractResultText(message.toolResult)} />;
}
function BashBodyWrap({ message }: ToolBodyProps) {
  return <BashBody args={message.toolArgs} resultText={extractResultText(message.toolResult)} />;
}
function EvalBodyWrap({ message }: ToolBodyProps) {
  return <EvalBody args={message.toolArgs} resultText={extractResultText(message.toolResult)} />;
}
function GrepBodyWrap({ message }: ToolBodyProps) {
  return <GrepBody args={message.toolArgs} resultText={extractResultText(message.toolResult)} />;
}
function GlobBodyWrap({ message }: ToolBodyProps) {
  return <GlobBody args={message.toolArgs} resultText={extractResultText(message.toolResult)} />;
}
function WebSearchBodyWrap({ message }: ToolBodyProps) {
  return <WebSearchBody args={message.toolArgs} resultText={extractResultText(message.toolResult)} />;
}
function TaskBodyWrap({ message }: ToolBodyProps) {
  return <TaskBody result={message.toolResult} resultText={extractResultText(message.toolResult)} />;
}
function JobBodyWrap({ message }: ToolBodyProps) {
  return <JobBody resultText={extractResultText(message.toolResult)} />;
}
function TodoBodyWrap({ message }: ToolBodyProps) {
  return <TodoBody args={message.toolArgs} resultText={extractResultText(message.toolResult)} />;
}
function SimRunBodyWrap({ message }: ToolBodyProps) {
  return <SimRunBody args={message.toolArgs} resultText={extractResultText(message.toolResult)} />;
}
function SimOptionsSchemaBodyWrap({ message }: ToolBodyProps) {
  return <SimOptionsSchemaBody resultText={extractResultText(message.toolResult)} />;
}
function CoverageBodyWrap({ message }: ToolBodyProps) {
  return <CoverageBody resultText={extractResultText(message.toolResult)} />;
}
function CompileErrorsBodyWrap({ message }: ToolBodyProps) {
  return <CompileErrorsBody resultText={extractResultText(message.toolResult)} />;
}
function RunStatusBodyWrap({ message }: ToolBodyProps) {
  return <RunStatusBody args={message.toolArgs} resultText={extractResultText(message.toolResult)} />;
}
function AskBodyWrap({ message }: ToolBodyProps) {
  return <AskBody args={message.toolArgs} resultText={extractResultText(message.toolResult)} />;
}

function ListSubsysBodyWrap({ message }: ToolBodyProps) {
  return <HostTableBody resultText={extractResultText(message.toolResult)} columns={[
    { key: 'name', label: 'Subsystem' },
    { key: 'path', label: 'Path' },
    { key: 'caseCount', label: 'Cases' },
  ]} />;
}
function ListCasesBodyWrap({ message }: ToolBodyProps) {
  return <HostTableBody resultText={extractResultText(message.toolResult)} columns={[
    { key: 'name', label: 'Case' },
    { key: 'subsys', label: 'Subsystem' },
    { key: 'status', label: 'Status', type: 'badge' as const },
  ]} emptyMessage="未找到用例" />;
}

function GenericBodyWrap({ message }: ToolBodyProps) {
  return <GenericBody args={message.toolArgs} resultText={extractResultText(message.toolResult)} />;
}

function McpBodyWrap({ message }: ToolBodyProps) {
  const parsed = parseMCPToolName(message.toolName ?? '');
  return <McpBody serverName={parsed?.serverName} toolName={parsed?.toolName} args={message.toolArgs} resultText={extractResultText(message.toolResult)} />;
}

// ── TOOL_REGISTRY ──────────────────────────────────────

const TOOL_REGISTRY: Record<string, ToolEntry> = {
  read:                    { summary: readSummary, Body: ReadBodyWrap },
  read_file:               { summary: readSummary, Body: ReadBodyWrap },
  write:                   { summary: writeSummary, Body: WriteBodyWrap },
  write_file:              { summary: writeSummary, Body: WriteBodyWrap },
  edit:                    { summary: editSummary, Body: EditBodyWrap },
  edit_file:               { summary: editSummary, Body: EditBodyWrap },
  apply_patch:             { summary: editSummary, Body: EditBodyWrap },
  ast_edit:                { summary: editSummary, Body: EditBodyWrap },
  bash:                    { summary: bashSummary, Body: BashBodyWrap },
  eval:                    { summary: evalSummary, Body: EvalBodyWrap },
  js:                      { summary: evalSummary, Body: EvalBodyWrap },
  python:                  { summary: evalSummary, Body: EvalBodyWrap },
  grep:                    { summary: grepSummary, Body: GrepBodyWrap },
  search:                  { summary: grepSummary, Body: GrepBodyWrap },
  glob:                    { summary: globSummary, Body: GlobBodyWrap },
  find:                    { summary: globSummary, Body: GlobBodyWrap },
  web_search:              { summary: webSearchSummary, Body: WebSearchBodyWrap },
  task:                    { summary: taskSummary, Body: TaskBodyWrap },
  job:                     { summary: jobSummary, Body: JobBodyWrap },
  todo:                    { summary: todoSummary, Body: TodoBodyWrap },
  ask:                     { summary: askSummary, Body: AskBodyWrap },
  list_subsys:             { summary: listSubsysSummary, Body: ListSubsysBodyWrap },
  list_cases:              { summary: listCasesSummary, Body: ListCasesBodyWrap },
  run_simulation:          { summary: runSimulationSummary, Body: SimRunBodyWrap },
  get_sim_options_schema:  { summary: simOptionsSchemaSummary, Body: SimOptionsSchemaBodyWrap },
  get_coverage:            { summary: coverageSummary, Body: CoverageBodyWrap },
  get_compile_errors:      { summary: compileErrorsSummary, Body: CompileErrorsBodyWrap },
  get_run_status:          { summary: runStatusSummary, Body: RunStatusBodyWrap },
};

// ── Constants ──────────────────────────────────────────

const FILE_TOOLS = new Set(['read', 'read_file', 'write', 'write_file', 'edit', 'edit_file', 'apply_patch', 'ast_edit']);

/** Module-level empty array: non-task tools return stable reference, avoid re-renders */
const NO_SUBAGENTS: SubagentActivity[] = [];

// ── ToolCard ───────────────────────────────────────────

export function ToolCard({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  const isExecuting = !message.toolResult;
  const meta = getToolMeta(message.toolName);
  const resultText = extractResultText(message.toolResult);

  // task 工具：读取该 tool call 关联的 subagent 实时状态
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

  const toolName = message.toolName ?? '';
  const isFileTool = !isExecuting && FILE_TOOLS.has(toolName);
  const filePath = isFileTool ? extractEditFilePath(message.toolArgs, resultText) : '';
  // 当 AI 读取的是一个目录时（EISDIR 错误），路径不应可点击——
  // 点击会尝试在编辑器中打开目录，导致同样的 EISDIR 报错。
  const isDirError = !isExecuting && /EISDIR/i.test(resultText);
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

  // Lookup summary + body from registry, with MCP/fallback
  const isMCP = isMCPTool(toolName);
  const entry = isMCP ? undefined : TOOL_REGISTRY[toolName];
  const summary = entry
    ? entry.summary(message, taskAgents)
    : isMCP
      ? mcpSummary(message)
      : defaultSummary(message);

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
        {isClickablePath ? (
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
          <ToolBody message={message} isExecuting={isExecuting} taskAgents={taskAgents} entry={entry} isMCP={isMCP} />
        </div>
      )}
    </div>
  );
}

// ── ToolBody dispatcher ────────────────────────────────

function ToolBody({
  message,
  isExecuting,
  taskAgents,
  entry,
  isMCP,
}: {
  message: ChatMessage;
  isExecuting: boolean;
  taskAgents: SubagentActivity[];
  entry: ToolEntry | undefined;
  isMCP: boolean;
}) {
  const name = message.toolName ?? '';

  // task 工具：有 subagent 实时数据时用磁贴卡片
  if (name === 'task' && taskAgents.length > 0) {
    return <SubagentCard agents={taskAgents} />;
  }

  // task 工具：无实时数据但 toolResult.details.progress 存在时，从静态快照构建磁贴卡片
  if (name === 'task' && !isExecuting && message.toolResult) {
    const staticAgents = buildSubagentsFromResult(message.toolResult, message.toolCallId);
    if (staticAgents.length > 0) {
      return <SubagentCard agents={staticAgents as SubagentActivity[]} />;
    }
  }

  // Executing placeholder (task with no subagent data falls through to TaskBody)
  if (isExecuting && name !== 'task') {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-2 text-[11px] text-muted-foreground">
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        <span>executing...</span>
      </div>
    );
  }

  // MCP tools
  if (isMCP) {
    return <McpBodyWrap message={message} taskAgents={taskAgents} />;
  }

  // Registry lookup
  if (entry) {
    const { Body } = entry;
    return <Body message={message} taskAgents={taskAgents} />;
  }

  // Fallback
  return <GenericBodyWrap message={message} taskAgents={taskAgents} />;
}
