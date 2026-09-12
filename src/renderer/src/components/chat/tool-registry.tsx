/**
 * tool-registry — ToolCard / ToolRunGroup 共享的工具注册表。
 *
 * 从 ToolCard 抽出的 TOOL_REGISTRY：每类工具的摘要构建器（summary）与
 * 展开体组件（Body）在此集中登记，ToolCard（单卡）与 ToolRunGroup
 * （分组行）两个渲染层共用。新增工具时只需要改这一个文件。
 */
import { type ReactNode, type ComponentType } from 'react';
import {
  Bot,
  CircleQuestionMark,
  Database,
  FileText,
  Puzzle,
  Search,
  Sparkle,
  Terminal,
} from 'lucide-react';
import type { OrbState } from '@renderer/components/visual';
import { ThinkingOrb } from '@renderer/components/visual';
import type { ChatMessage, SubagentActivity } from '@renderer/stores/session-types';
import {
  isMCPTool,
  extractResultText,
  argStr,
  argVal,
  shortenPath,
  countGrepMatches,
  countLines,
  tryParseJSON,
  parseJsonArray,
  parseJobItems,
  parseTodoItems,
  extractRpivTodoTasks,
  extractEditFilePath,
  hasResultWarning,
  isSkillRead,
  extractSkillName,
  parseMCPToolName,
  getToolDetails,
} from './tool-helpers';
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
import { WebFetchBody, GetSearchContentBody } from './tool-bodies/exec/WebFetchBody';
import { SourceCheckBody } from './tool-bodies/exec/SourceCheckBody';
import {
  getPiSubagentPresentation,
  resolvePiSubagentActivities,
  SubagentBody,
} from './tool-bodies/agent/SubagentBody';
import { JobBody } from './tool-bodies/agent/JobBody';
import { TodoBody } from './tool-bodies/agent/TodoBody';
import { SimRunBody } from './tool-bodies/host/SimRunBody';
import { SimOptionsSchemaBody } from './tool-bodies/host/SimOptionsSchemaBody';
import { CoverageBody } from './tool-bodies/host/CoverageBody';
import { CompileErrorsBody } from './tool-bodies/host/CompileErrorsBody';
import { RunStatusBody } from './tool-bodies/host/RunStatusBody';
import { AskBody } from './tool-bodies/interactive/AskBody';

// ── Types ──────────────────────────────────────────────

export type ToolBodyProps = { message: ChatMessage; subagents: SubagentActivity[] };

export type ToolEntry = {
  summary: (message: ChatMessage, subagents: SubagentActivity[]) => ReactNode;
  Body: ComponentType<ToolBodyProps>;
};

// ── Summary helpers ────────────────────────────────────

function readSummary(message: ChatMessage): ReactNode {
  const args = message.toolArgs;
  const resultText = extractResultText(message.toolResult);
  const isExecuting = !message.toolResult;
  const path = argStr(args, 'path', 'file_path') ?? '';
  const lineCount = resultText ? resultText.split('\n').length : 0;
  // Skill read: show skill name instead of raw skill:// path
  if (isSkillRead(args)) {
    const skillName = extractSkillName(args) ?? 'skill';
    return <><span className="text-foreground">{skillName}</span> {' \u00b7 '} {isExecuting ? 'loading skill...' : `${lineCount} lines`}</>;
  }
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

function subagentSummary(message: ChatMessage, liveSubagents: SubagentActivity[]): ReactNode {
  const presentation = getPiSubagentPresentation(message);
  if (presentation.mode === 'management') {
    const action = argStr(message.toolArgs, 'action') ?? 'management';
    const target = argStr(message.toolArgs, 'id', 'runId', 'agent');
    return <><span className="text-foreground">{action}</span>{target ? ` ${target}` : ''} {' \u00b7 '} {message.toolResult === undefined ? 'executing...' : 'done'}</>;
  }

  const subagents = resolvePiSubagentActivities(presentation, liveSubagents);
  if (subagents.length === 0) return <>{presentation.mode} {' \u00b7 '} done</>;
  const running = subagents.filter((agent) => agent.status === 'running').length;
  if (running > 0) return <>{subagents.length} 个子代理 {' \u00b7 '}{running} 运行中</>;
  const completed = subagents.filter((agent) => agent.status === 'completed').length;
  const failed = subagents.filter((agent) => agent.status === 'failed').length;
  const aborted = subagents.filter((agent) => agent.status === 'aborted').length;
  return <>{subagents.length} 个子代理 {' \u00b7 '}{completed} 成功{failed > 0 ? ` / ${failed} 失败` : ''}{aborted > 0 ? ` / ${aborted} 中止` : ''}</>;
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
  // rpiv-todo（pi 引擎）优先用 details.tasks 快照；omp 回退文本解析
  const todos = extractRpivTodoTasks(message.toolResult) ?? parseTodoItems(args, resultText);
  const done = todos.filter((t) => t.status === 'completed').length;
  return <>{todos.length} items {' \u00b7 '} {done}/{todos.length} done</>;
}

function webSearchSummary(message: ChatMessage): ReactNode {
  const isExecuting = !message.toolResult;
  const resultText = extractResultText(message.toolResult);
  const query = argStr(message.toolArgs, 'query', 'q') ?? '';
  // pi-web-access：details 携带结构化统计（queryCount/totalResults）
  const details = getToolDetails(message.toolResult);
  if (!isExecuting && details) {
    const queryCount = Number(details.queryCount ?? 0);
    const successful = Number(details.successfulQueries ?? queryCount);
    const totalResults = Number(details.totalResults ?? 0);
    if (queryCount > 0) {
      const label = queryCount > 1 ? `${successful}/${queryCount} queries` : query;
      return <><span className="text-foreground">&quot;{label}&quot;</span> {' \u00b7 '} {totalResults} results</>;
    }
  }
  return <>"{query}" {' \u00b7 '} {isExecuting ? 'searching...' : `${countLines(resultText)} results`}</>;
}

function fetchContentSummary(message: ChatMessage): ReactNode {
  const isExecuting = !message.toolResult;
  const urlsArg = argVal(message.toolArgs, 'urls');
  const urls = Array.isArray(urlsArg) && urlsArg.length > 0
    ? urlsArg.map((u) => String(u))
    : [argStr(message.toolArgs, 'url') ?? ''].filter(Boolean);
  const detail = urls.length > 1 ? `${urls.length} URLs` : (urls[0] ?? '');
  const details = getToolDetails(message.toolResult);
  const successful = Number(details?.successful ?? 0);
  const urlCount = Number(details?.urlCount ?? urls.length);
  const statusText = isExecuting || urlCount === 0 ? 'fetching...' : `${successful}/${urlCount} fetched`;
  return <><span className="text-foreground">{detail}</span>{detail ? ' \u00b7 ' : ''}{statusText}</>;
}

function getSearchContentSummary(message: ChatMessage): ReactNode {
  const isExecuting = !message.toolResult;
  const resultText = extractResultText(message.toolResult);
  const responseId = argStr(message.toolArgs, 'responseId') ?? '';
  return <><span className="text-foreground">{responseId || 'search content'}</span> {' \u00b7 '} {isExecuting ? 'retrieving...' : `${countLines(resultText)} lines`}</>;
}

function sourceCheckSummary(message: ChatMessage): ReactNode {
  const isExecuting = !message.toolResult;
  const claim = argStr(message.toolArgs, 'claim') ?? '';
  const details = getToolDetails(message.toolResult);
  const assessments = details?.artifact && typeof details.artifact === 'object'
    ? (details.artifact as { claims?: Array<{ status?: unknown }> }).claims
    : undefined;
  const status = Array.isArray(assessments) && typeof assessments[0]?.status === 'string'
    ? (assessments[0].status as string)
    : '';
  const label = status === 'supported' ? '已证实' : status === 'contradicted' ? '已证伪' : status ? '证据不足' : '';
  const sourceCount = Number(details?.sourceCount ?? 0);
  return (
    <>
      <span className="text-foreground">&quot;{claim.slice(0, 40)}{claim.length > 40 ? '...' : ''}&quot;</span>
      {' \u00b7 '}
      {isExecuting ? 'checking...' : label || `${sourceCount} sources`}
    </>
  );
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
  return <ReadBody args={message.toolArgs} resultText={extractResultText(message.toolResult)} toolResult={message.toolResult} />;
}
function WriteBodyWrap({ message }: ToolBodyProps) {
  return <WriteBody args={message.toolArgs} resultText={extractResultText(message.toolResult)} />;
}
function EditBodyWrap({ message }: ToolBodyProps) {
  return <EditBody args={message.toolArgs} resultText={extractResultText(message.toolResult)} toolResult={message.toolResult} />;
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
  return <WebSearchBody args={message.toolArgs} result={message.toolResult} resultText={extractResultText(message.toolResult)} />;
}
function WebFetchBodyWrap({ message }: ToolBodyProps) {
  return <WebFetchBody args={message.toolArgs} result={message.toolResult} resultText={extractResultText(message.toolResult)} />;
}
function GetSearchContentBodyWrap({ message }: ToolBodyProps) {
  return <GetSearchContentBody args={message.toolArgs} result={message.toolResult} resultText={extractResultText(message.toolResult)} />;
}
function SourceCheckBodyWrap({ message }: ToolBodyProps) {
  return <SourceCheckBody args={message.toolArgs} result={message.toolResult} resultText={extractResultText(message.toolResult)} />;
}
function SubagentBodyWrap({ message, subagents }: ToolBodyProps) {
  return <SubagentBody message={message} liveSubagents={subagents} />;
}
function JobBodyWrap({ message }: ToolBodyProps) {
  return <JobBody resultText={extractResultText(message.toolResult)} />;
}
function TodoBodyWrap({ message }: ToolBodyProps) {
  return <TodoBody args={message.toolArgs} result={message.toolResult} resultText={extractResultText(message.toolResult)} />;
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

export const TOOL_REGISTRY: Record<string, ToolEntry> = {
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
  fetch_content:           { summary: fetchContentSummary, Body: WebFetchBodyWrap },
  get_search_content:      { summary: getSearchContentSummary, Body: GetSearchContentBodyWrap },
  source_check:            { summary: sourceCheckSummary, Body: SourceCheckBodyWrap },
  subagent:                { summary: subagentSummary, Body: SubagentBodyWrap },
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

export const FILE_TOOLS = new Set(['read', 'read_file', 'write', 'write_file', 'edit', 'edit_file', 'apply_patch', 'ast_edit']);
export const SEARCH_TOOLS = new Set(['grep', 'search', 'glob', 'find', 'ast_grep', 'web_search', 'fetch_content', 'get_search_content', 'source_check']);
export const EXEC_TOOLS = new Set(['bash', 'eval', 'js', 'python']);

/**
 * 交互式工具（ask）：问答卡片必须独立醒目呈现，不参与工具运行分组。
 */
const INTERACTIVE_TOOLS = new Set(['ask']);

export function isInteractiveTool(toolName: string | undefined): boolean {
  return !!toolName && INTERACTIVE_TOOLS.has(toolName);
}

/**
 * Map a tool name to a ThinkingOrb state that semantically represents
 * the tool's activity type.
 *
 * - File tools (read/write/edit) → `working` (orbiting particles)
 * - Search tools (grep/glob)    → `searching` (scanning meridian)
 * - Exec tools (bash/eval)       → `solving` (band scramble → resolve)
 * - Everything else              → `working` (default orbiting particles)
 */
export function toolToOrbState(toolName: string): OrbState {
  if (FILE_TOOLS.has(toolName)) return 'working';
  if (SEARCH_TOOLS.has(toolName)) return 'searching';
  if (EXEC_TOOLS.has(toolName)) return 'solving';
  return 'working';
}

/** Module-level empty array: tools without subagents return a stable reference. */
export const NO_SUBAGENTS: SubagentActivity[] = [];

/** 工具类别 → 折叠行前导图标（DSH §6.1：16px 槽位内 14px 变体图标） */
export const CATEGORY_ICON: Record<string, ComponentType<{ className?: string }>> = {
  file: FileText,
  exec: Terminal,
  search: Search,
  agent: Bot,
  interactive: CircleQuestionMark,
  host: Database,
  mcp: Puzzle,
  other: Sparkle,
};

// ── Shared lookup helpers ──────────────────────────────

/** 摘要统一入口：registry 命中 → 注册表摘要；MCP → mcp 摘要；否则 default。 */
export function getToolSummary(message: ChatMessage, subagents: SubagentActivity[] = NO_SUBAGENTS): ReactNode {
  const toolName = message.toolName ?? '';
  const isMCP = isMCPTool(toolName);
  const entry = isMCP ? undefined : TOOL_REGISTRY[toolName];
  if (entry) return entry.summary(message, subagents);
  return isMCP ? mcpSummary(message) : defaultSummary(message);
}

// ── ToolBody dispatcher ────────────────────────────────

/**
 * 展开体统一分发器：pi-subagents 直接消费原生结果与实时状态，其余工具走
 * executing 占位、MCP、registry、GenericBody 兜底。ToolCard 与 ToolRunGroup 共用。
 */
export function ToolBodyView({
  message,
  subagents,
}: {
  message: ChatMessage;
  subagents: SubagentActivity[];
}) {
  const name = message.toolName ?? '';
  const isExecuting = !message.toolResult;

  if (name === 'subagent') {
    return <SubagentBodyWrap message={message} subagents={subagents} />;
  }

  // Executing placeholder
  if (isExecuting) {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-2 font-mono text-[11px] text-muted-foreground">
        <ThinkingOrb state="solving" size={20} theme="auto" />
        <span>executing...</span>
      </div>
    );
  }

  // MCP tools
  if (isMCPTool(name)) {
    return <McpBodyWrap message={message} subagents={subagents} />;
  }

  // Registry lookup
  const entry = TOOL_REGISTRY[name];
  if (entry) {
    const { Body } = entry;
    return <Body message={message} subagents={subagents} />;
  }

  // Fallback
  return <GenericBodyWrap message={message} subagents={subagents} />;
}
