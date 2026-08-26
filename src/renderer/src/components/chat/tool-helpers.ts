/**
 * Helper utilities for ToolCard rendering.
 * Extracted to keep the main component file manageable.
 */

export type ToolCategory = 'file' | 'exec' | 'search' | 'agent' | 'interactive' | 'host' | 'mcp' | 'other';

export type ToolMeta = {
  label: string;
  category: ToolCategory;
  color: string;
};

export const TOOL_META: Record<string, ToolMeta> = {
  read:         { label: 'read',         category: 'file',        color: 'text-status-running-foreground' },
  read_file:    { label: 'read_file',    category: 'file',        color: 'text-status-running-foreground' },
  write:        { label: 'write',        category: 'file',        color: 'text-status-pass-foreground' },
  write_file:   { label: 'write_file',   category: 'file',        color: 'text-status-pass-foreground' },
  edit:         { label: 'edit',         category: 'file',        color: 'text-warning-foreground' },
  edit_file:    { label: 'edit_file',    category: 'file',        color: 'text-warning-foreground' },
  apply_patch:  { label: 'edit',         category: 'file',        color: 'text-warning-foreground' },
  ast_edit:     { label: 'ast_edit',     category: 'file',        color: 'text-warning-foreground' },
  bash:         { label: 'bash',         category: 'exec',        color: 'text-violet-foreground' },
  eval:         { label: 'eval',         category: 'exec',        color: 'text-violet-foreground' },
  js:           { label: 'eval',         category: 'exec',        color: 'text-violet-foreground' },
  python:       { label: 'eval',         category: 'exec',        color: 'text-violet-foreground' },
  grep:         { label: 'grep',         category: 'search',      color: 'text-chart-1' },
  search:       { label: 'grep',         category: 'search',      color: 'text-chart-1' },
  glob:         { label: 'glob',         category: 'search',      color: 'text-chart-1' },
  find:         { label: 'glob',         category: 'search',      color: 'text-chart-1' },
  ast_grep:     { label: 'ast_grep',     category: 'search',      color: 'text-chart-1' },
  web_search:   { label: 'web_search',   category: 'search',      color: 'text-status-fail-foreground' },
  task:         { label: 'task',         category: 'agent',       color: 'text-chart-4' },
  job:          { label: 'job',          category: 'agent',       color: 'text-chart-2' },
  todo:         { label: 'todo',         category: 'agent',       color: 'text-violet-foreground' },
  ask:          { label: 'ask',          category: 'interactive', color: 'text-chart-2' },
  list_subsys:            { label: 'list_subsys',            category: 'host', color: 'text-status-pass-foreground' },
  list_cases:             { label: 'list_cases',             category: 'host', color: 'text-status-pass-foreground' },
  run_simulation:         { label: 'run_simulation',         category: 'host', color: 'text-status-pass-foreground' },
  get_run_status:         { label: 'get_run_status',         category: 'host', color: 'text-status-pass-foreground' },
  get_compile_errors:     { label: 'get_compile_errors',     category: 'host', color: 'text-status-pass-foreground' },
  get_coverage:           { label: 'get_coverage',           category: 'host', color: 'text-status-pass-foreground' },
  get_sim_options_schema: { label: 'get_sim_options_schema', category: 'host', color: 'text-status-pass-foreground' },
};

/** Check if a tool name is an MCP tool (mcp__<server>_<tool>) */
export function isMCPTool(name: string | undefined): boolean {
  return !!name && name.startsWith('mcp__');
}

/** Parse MCP tool name into server and tool components */
export function parseMCPToolName(name: string): { serverName: string; toolName: string } | null {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice(5);
  const underscoreIdx = rest.indexOf('_');
  if (underscoreIdx === -1) return null;
  return {
    serverName: rest.slice(0, underscoreIdx),
    toolName: rest.slice(underscoreIdx + 1),
  };
}

export function getToolMeta(name: string | undefined): ToolMeta {
  if (!name) return { label: 'tool', category: 'other', color: 'text-muted-foreground' };
  if (isMCPTool(name)) {
    const parsed = parseMCPToolName(name);
    const label = parsed ? `${parsed.serverName}/${parsed.toolName}` : name;
    return { label, category: 'mcp', color: 'text-warning-foreground' };
  }
  return TOOL_META[name] ?? { label: name, category: 'other', color: 'text-muted-foreground' };
}

/** Detect highlight.js language from a file path */
export function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    py: 'python', pyw: 'python',
    c: 'c', h: 'c',
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp',
    json: 'json',
    md: 'markdown', markdown: 'markdown',
    yaml: 'yaml', yml: 'yaml',
    html: 'xml', htm: 'xml', vue: 'xml',
    css: 'css', scss: 'scss', less: 'less',
    sv: 'verilog', svh: 'verilog', v: 'verilog', vh: 'verilog',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    tcl: 'tcl',
    xml: 'xml',
    sql: 'sql',
    go: 'go',
    rs: 'rust',
    java: 'java',
    rb: 'ruby',
    php: 'php',
    toml: 'ini',
    ini: 'ini',
    diff: 'diff',
  };
  return map[ext] ?? 'plaintext';
}

/** Extract text content from various result formats */
export function extractResultText(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) return result.map((r) => extractResultText(r)).join('\n');
  if (typeof result === 'object') {
    const obj = result as Record<string, unknown>;
    if (Array.isArray(obj.content)) {
      return (obj.content as Array<Record<string, unknown>>)
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('\n');
    }
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.output === 'string') return obj.output;
    if (typeof obj.result === 'string') return obj.result;
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

/** 工具结果是否指向目录：omp read 读目录成功返回 details.isDirectory，或旧消息中的 EISDIR 错误文本 */
export function isDirectoryToolResult(result: unknown): boolean {
  if (/EISDIR/i.test(extractResultText(result))) return true;
  if (result != null && typeof result === 'object') {
    const details = (result as Record<string, unknown>).details;
    if (details != null && typeof details === 'object'
      && (details as Record<string, unknown>).isDirectory === true) return true;
  }
  return false;
}

/** Try to parse text as JSON, return null if not parseable */
export function tryParseJSON(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** Parse text as JSON array of objects */
export function parseJsonArray(text: string): Record<string, unknown>[] | null {
  const parsed = tryParseJSON(text);
  if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
  return null;
}

/** Extract a string field from args object */
export function argStr(args: unknown, ...keys: string[]): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const obj = args as Record<string, unknown>;
  for (const k of keys) {
    if (typeof obj[k] === 'string') return obj[k] as string;
  }
  return undefined;
}

/** Extract any field from args object */
export function argVal(args: unknown, key: string): unknown {
  if (typeof args !== 'object' || args === null) return undefined;
  return (args as Record<string, unknown>)[key];
}

/**
 * Extract file path from omp edit tool's `input` field.
 * omp edit format: `[filename#tag]\nDEL 42-49\n` or `[filename#tag]\nINS ...\n`
 * The first line contains `[filename#tag]` where filename may be a relative
 * path or just a basename.
 */
export function extractOmpEditPathFromInput(args: unknown): string {
  const input = argStr(args, 'input');
  if (!input) return '';
  // Match [path#tag] at the start of the input
  const match = input.match(/^\[([^\]]+)#[A-Za-z0-9_]+\]/);
  if (match) return match[1];
  return '';
}

/**
 * Extract file path from omp edit tool's result text.
 * Result format starts with `[absolute_path#tag]` on the first line.
 */
export function extractOmpEditPathFromResult(resultText: string): string {
  if (!resultText) return '';
  const match = resultText.match(/^\[([^\]]+)#[A-Za-z0-9_]+\]/m);
  if (match) return match[1];
  return '';
}

/**
 * Unified file path extraction for edit-family tools.
 * Tries args.path / args.file_path first, then omp input format, then result text.
 */
export function extractEditFilePath(args: unknown, resultText: string): string {
  const direct = argStr(args, 'path', 'file_path');
  if (direct) return direct;
  // Try result text first (has absolute path), then input field (may only have filename)
  const fromResult = extractOmpEditPathFromResult(resultText);
  if (fromResult) return fromResult;
  const fromInput = extractOmpEditPathFromInput(args);
  if (fromInput) return fromInput;
  // Try apply_patch format
  const patch = argStr(args, 'input', 'patch', 'diff');
  if (patch) {
    const m = patch.match(/^\*\*\*\s+(?:Update|Add|Delete) File:\s*(.+)$/m);
    if (m?.[1]) return m[1].trim();
  }
  return '';
}

/**
 * Check if result text contains warnings (omp edit tool format).
 * omp results have a "Warnings:" section when path resolution had issues.
 */
export function hasResultWarning(resultText: string): boolean {
  if (!resultText) return false;
  return /^Warnings?:/m.test(resultText);
}

/**
 * Parse omp edit result text into content lines and warnings.
 * Result format:
 * ```
 * [path#tag]
 * 40:// code line
 * 41:
 * 42:
 * 43:// more code
 * 
 * Warnings:
 * Path "..." does not exist; matched ...
 * ```
 */
export function parseOmpEditResult(resultText: string): {
  filePath: string;
  contentLines: Array<{ lineNum: string; content: string }>;
  warnings: string[];
} {
  const filePath = extractOmpEditPathFromResult(resultText);
  const lines = resultText.split('\n');
  const contentLines: Array<{ lineNum: string; content: string }> = [];
  const warnings: string[] = [];
  let inWarnings = false;
  let skipHeader = filePath ? 1 : 0; // skip the [path#tag] header line

  for (const line of lines) {
    if (skipHeader > 0) {
      skipHeader--;
      continue;
    }
    if (/^Warnings?:/i.test(line.trim())) {
      inWarnings = true;
      continue;
    }
    if (inWarnings) {
      // Warning content lines (indented or plain text)
      if (line.trim()) warnings.push(line.trim());
      continue;
    }
    // Content lines: `42:// code` or `42:` or empty
    const match = line.match(/^(\d+):(.*)$/);
    if (match) {
      contentLines.push({ lineNum: match[1], content: match[2] });
    } else if (line.trim() === '') {
      // Empty line in content area
      contentLines.push({ lineNum: '', content: '' });
    }
  }

  return { filePath, contentLines, warnings };
}

/** Shorten a file path for display */
export function shortenPath(p: string): string {
  if (!p) return '';
  const parts = p.replace(/\\/g, '/').split('/');
  if (parts.length <= 3) return p;
  return '.../' + parts.slice(-2).join('/');
}

/** Count grep matches from result text */
export function countGrepMatches(resultText: string): number {
  if (!resultText) return 0;
  return resultText.split('\n').filter((l) => l.trim() && !l.startsWith('Search')).length;
}

/** Count non-empty lines */
export function countLines(text: string): number {
  if (!text) return 0;
  return text.split('\n').filter(Boolean).length;
}

/** Extract a number from object by trying multiple keys */
export function numFromObj(obj: Record<string, unknown> | null, ...keys: string[]): number | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const num = parseFloat(v.replace('%', ''));
      if (!isNaN(num)) return num;
    }
  }
  return undefined;
}

// ── Parsed types ────────────────────────────────────────

export type TaskItemData = {
  title: string;
  status: 'done' | 'running' | 'pending' | 'error';
  meta?: string;
};

export function parseTaskItems(resultText: string): TaskItemData[] {
  const parsed = tryParseJSON(resultText);
  if (Array.isArray(parsed)) {
    return parsed.map((item) => {
      const obj = item as Record<string, unknown>;
      const rawStatus = typeof obj.status === 'string' ? obj.status : 'done';
      const status: TaskItemData['status'] = rawStatus === 'running' ? 'running'
        : rawStatus === 'error' || rawStatus === 'failed' ? 'error'
        : rawStatus === 'pending' ? 'pending'
        : 'done';
      const metaParts: string[] = [];
      if (typeof obj.agent === 'string') metaParts.push(`agent: ${obj.agent}`);
      if (typeof obj.duration === 'number') metaParts.push(`${obj.duration}ms`);
      if (typeof obj.tokens === 'number') metaParts.push(`${obj.tokens} tokens`);
      return {
        title: String(obj.title ?? obj.description ?? obj.name ?? 'task'),
        status,
        meta: metaParts.length > 0 ? metaParts.join(' \u00b7 ') : undefined,
      };
    });
  }
  const lines = resultText.split('\n').filter(Boolean);
  const items: TaskItemData[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('\u2713') || /^\[(done|ok)\]/i.test(trimmed)) {
      items.push({ title: trimmed.replace(/^[\u2713[]+(done|ok)?\]?\s*/i, '').trim(), status: 'done' });
    } else if (trimmed.startsWith('\u27f3') || /^\[running\]/i.test(trimmed)) {
      items.push({ title: trimmed.replace(/^[\u27f3[]+(running)?\]?\s*/i, '').trim(), status: 'running' });
    } else if (/^[-*]\s/.test(trimmed)) {
      // "- `task_id` (job `task_id`) — description" 行来自 omp task 工具的派遣文本。
      // 旧逻辑默认为 'done'，但实际这些子代理可能仍在运行——必须结合
      // details.async.state 判断（见 parseTaskItemsFromResult / isTaskAsyncRunning）。
      // 仅在此无法确定运行状态，保守用 'pending' 而非 'done'。
      items.push({ title: trimmed.replace(/^[-*]\s/, ''), status: 'pending' });
    }
  }
  return items;
}

/**
 * 检查 task 工具结果是否表明子代理仍在异步运行中。
 *
 * omp task 工具返回 `details.async = { state: 'running', jobId, type }` 
 * 表示子代理已被派遣但尚未全部完成。此时 toolResult 虽然已存在
 * （派遣确认文本），但子代理实际仍在后台运行。
 */
export function isTaskAsyncRunning(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return false;
  const obj = result as Record<string, unknown>;
  const details = obj.details;
  if (typeof details !== 'object' || details === null) return false;
  const asyncInfo = (details as Record<string, unknown>).async;
  if (typeof asyncInfo !== 'object' || asyncInfo === null) return false;
  return (asyncInfo as Record<string, unknown>).state === 'running';
}

/**
 * 从完整的 toolResult 对象解析 task 子项，优先使用 details.progress
 * 数组（包含准确的 status/index/id/description/agent/durationMs/tokens），
 * 仅在 details.progress 不存在时回退到 parseTaskItems(resultText)。
 *
 * 当 details.async.state === 'running' 且 progress 中子项状态为 'pending' 时，
 * 这些子代理实际仍在运行中，不应显示为已完成。
 */
export function parseTaskItemsFromResult(result: unknown): TaskItemData[] {
  if (typeof result !== 'object' || result === null) {
    return parseTaskItems(extractResultText(result));
  }
  const obj = result as Record<string, unknown>;
  const details = typeof obj.details === 'object' && obj.details !== null
    ? obj.details as Record<string, unknown>
    : null;

  // 优先从 details.progress 解析（包含准确的 status 字段）
  if (details && Array.isArray(details.progress)) {
    const asyncRunning = isTaskAsyncRunning(result);
    const items = (details.progress as Array<Record<string, unknown>>).map((p) => {
      const rawStatus = typeof p.status === 'string' ? p.status : 'pending';
      // 若 async.state === 'running'，pending 子代理实际处于运行中
      const status: TaskItemData['status'] = rawStatus === 'completed' ? 'done'
        : rawStatus === 'failed' || rawStatus === 'error' ? 'error'
        : rawStatus === 'running' ? 'running'
        : asyncRunning ? 'running'  // pending + async running → running
        : 'pending';
      const metaParts: string[] = [];
      if (typeof p.agent === 'string') metaParts.push(`agent: ${p.agent}`);
      const durationMs = typeof p.durationMs === 'number' ? p.durationMs : undefined;
      if (durationMs !== undefined && durationMs > 0) metaParts.push(`${durationMs}ms`);
      const tokens = typeof p.tokens === 'number' ? p.tokens : undefined;
      if (tokens !== undefined && tokens > 0) metaParts.push(`${tokens} tokens`);
      return {
        title: String(p.description ?? p.id ?? p.name ?? 'task'),
        status,
        meta: metaParts.length > 0 ? metaParts.join(' \u00b7 ') : undefined,
      };
    });
    if (items.length > 0) return items;
  }

  // Fallback: 从 resultText 解析
  return parseTaskItems(extractResultText(result));
}

/**
 * 从 task 工具结果的 details.progress 数组构建 SubagentActivity 兼容对象列表。
 * 当没有实时 subagent 事件数据（sess.subagents 为空）时，用此函数从
 * toolResult 中提取静态快照数据，驱动 SubagentCard 磁贴渲染。
 *
 * 返回的对象结构与 SubagentActivity 接口兼容，可直接传给 SubagentCard。
 */
export type StaticSubagent = {
  id: string;
  index: number;
  agent: string;
  description?: string;
  assignment?: string;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  parentToolCallId?: string;
  currentTool?: string;
  lastIntent?: string;
  recentOutput: string[];
  toolCount: number;
  tokens: number;
  requests: number;
  tokenHistory: number[];
  startedAt: number;
  endedAt?: number;
};

export function buildSubagentsFromResult(
  result: unknown,
  parentToolCallId: string | undefined,
): StaticSubagent[] {
  if (typeof result !== 'object' || result === null) return [];
  const obj = result as Record<string, unknown>;
  const details = typeof obj.details === 'object' && obj.details !== null
    ? obj.details as Record<string, unknown>
    : null;
  if (!details || !Array.isArray(details.progress)) return [];

  const asyncRunning = isTaskAsyncRunning(result);
  const now = Date.now();

  return (details.progress as Array<Record<string, unknown>>).map((p) => {
    const rawStatus = typeof p.status === 'string' ? p.status : 'pending';
    const status: StaticSubagent['status'] =
      rawStatus === 'completed' ? 'completed'
      : rawStatus === 'failed' || rawStatus === 'error' ? 'failed'
      : rawStatus === 'aborted' ? 'aborted'
      : asyncRunning ? 'running'  // pending + async running → running
      : 'aborted';                  // pending + not running → aborted (stale)

    const id = typeof p.id === 'string' ? p.id : `sa-${Math.random().toString(36).slice(2, 8)}`;
    const recentOutput = Array.isArray(p.recentOutput)
      ? (p.recentOutput as unknown[]).filter((l): l is string => typeof l === 'string')
      : [];

    return {
      id,
      index: typeof p.index === 'number' ? p.index : 0,
      agent: typeof p.agent === 'string' ? p.agent : 'subagent',
      description: typeof p.description === 'string' ? p.description : undefined,
      assignment: typeof p.assignment === 'string' ? p.assignment : undefined,
      status,
      parentToolCallId,
      currentTool: typeof p.currentTool === 'string' ? p.currentTool : undefined,
      lastIntent: typeof p.lastIntent === 'string' ? p.lastIntent : undefined,
      recentOutput,
      toolCount: typeof p.toolCount === 'number' ? p.toolCount : 0,
      tokens: typeof p.tokens === 'number' ? p.tokens : 0,
      requests: typeof p.requests === 'number' ? p.requests : 0,
      tokenHistory: [],
      startedAt: now,
      endedAt: status !== 'running' ? now : undefined,
    };
  });
}

export type JobItemData = {
  id: string;
  desc: string;
  status: 'running' | 'done' | 'failed';
  progress?: number;
};

export function parseJobItems(resultText: string): JobItemData[] {
  const parsed = tryParseJSON(resultText);
  if (Array.isArray(parsed)) {
    return parsed.map((item, i) => {
      const obj = item as Record<string, unknown>;
      const rawStatus = typeof obj.status === 'string' ? obj.status : 'done';
      const status: JobItemData['status'] = rawStatus === 'running' ? 'running'
        : rawStatus === 'failed' || rawStatus === 'error' ? 'failed'
        : 'done';
      return {
        id: String(obj.id ?? obj.jobId ?? `#${i + 1}`),
        desc: String(obj.description ?? obj.name ?? obj.command ?? 'job'),
        status,
        progress: typeof obj.progress === 'number' ? obj.progress : undefined,
      };
    });
  }
  return [];
}

// ── Todo types (three-state) ───────────────────────────

export type TodoItemStatus = 'pending' | 'in_progress' | 'completed' | 'abandoned';

export type TodoItemData = { text: string; status: TodoItemStatus };

export type TodoPhaseData = {
  name: string;
  items: TodoItemData[];
};

/** Result of scanning session messages for the latest todo state. */
export type TodoPanelState = {
  phases: TodoPhaseData[];
  isExecuting: boolean;
};

/** Map a raw status string to our TodoItemStatus union. */
function normalizeTodoStatus(raw: string): TodoItemStatus {
  const s = raw.toLowerCase();
  if (s === 'completed' || s === 'done' || s === 'complete') return 'completed';
  if (s === 'in_progress' || s === 'inprogress' || s === 'running' || s === 'active') return 'in_progress';
  if (s === 'abandoned' || s === 'dropped' || s === 'skipped') return 'abandoned';
  return 'pending';
}

/**
 * Extract todo phases from the omp todo tool result object.
 * The result contains `details.phases` with `TodoPhase[]` where each task has
 * `{ content: string, status: "pending" | "in_progress" | "completed" | "abandoned" }`.
 */
export function extractTodoPhases(result: unknown): TodoPhaseData[] {
  if (typeof result !== 'object' || result === null) return [];
  const obj = result as Record<string, unknown>;
  const details = obj.details;
  if (typeof details !== 'object' || details === null) return [];
  const phases = (details as Record<string, unknown>).phases;
  if (!Array.isArray(phases)) return [];
  return (phases as Array<Record<string, unknown>>)
    .map((phase) => {
      const tasks = Array.isArray(phase.tasks) ? phase.tasks : [];
      return {
        name: String(phase.name ?? ''),
        items: (tasks as Array<Record<string, unknown>>)
          .map((task) => ({
            text: String(task.content ?? task.text ?? task.task ?? ''),
            status: normalizeTodoStatus(String(task.status ?? 'pending')),
          }))
          .filter((item) => item.text),
      };
    })
    .filter((phase) => phase.items.length > 0);
}

/**
 * Extract todo phases from the omp todo tool args (for `init` op preview).
 * Only `init` ops carry the full list in args; other ops (`start`, `done`, etc.)
 * only carry the target task/phase name.
 */
export function extractTodoPhasesFromArgs(args: unknown): TodoPhaseData[] {
  if (typeof args !== 'object' || args === null) return [];
  const obj = args as Record<string, unknown>;
  const op = String(obj.op ?? '');

  if (op === 'init') {
    // `list: [{ phase, items: string[] }]` format
    if (Array.isArray(obj.list)) {
      return (obj.list as Array<Record<string, unknown>>)
        .map((phase) => ({
          name: String(phase.name ?? ''),
          items: (Array.isArray(phase.items) ? phase.items : [])
            .map((item) => ({
              text: String(item),
              status: 'pending' as const,
            }))
            .filter((item) => item.text),
        }))
        .filter((phase) => phase.items.length > 0);
    }
    // Flat `items: string[]` format
    if (Array.isArray(obj.items)) {
      const items = (obj.items as unknown[])
        .map((item) => ({
          text: typeof item === 'string' ? item : String((item as Record<string, unknown>)?.text ?? item),
          status: 'pending' as const,
        }))
        .filter((item) => item.text);
      if (items.length > 0) {
        return [{ name: String(obj.phase ?? 'Tasks'), items }];
      }
    }
  }

  return [];
}

/**
 * Parse todo phases from the omp todo tool result text (markdown fallback).
 * Format: `## Phase Name` headers followed by `[ ]`, `[/]`, `[x]`, `[-]` task lines.
 */
function parseTodoPhasesFromText(text: string): TodoPhaseData[] {
  if (!text) return [];
  const lines = text.split('\n');
  const phases: TodoPhaseData[] = [];
  let currentPhase: TodoPhaseData | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Task lines: [ ] task, [/] task, [x] task, [-] task, ✓ task
    const taskMatch = trimmed.match(/^\[([ xX/-])\]\s*(.+)$/);
    if (taskMatch) {
      if (!currentPhase) currentPhase = { name: 'Tasks', items: [] };
      const status: TodoItemStatus =
        taskMatch[1].toLowerCase() === 'x' ? 'completed'
        : taskMatch[1] === '/' ? 'in_progress'
        : taskMatch[1] === '-' ? 'abandoned'
        : 'pending';
      currentPhase.items.push({ text: taskMatch[2], status });
      continue;
    }

    // ✓ or ✗ prefix
    if (trimmed.startsWith('\u2713')) {
      if (!currentPhase) currentPhase = { name: 'Tasks', items: [] };
      currentPhase.items.push({ text: trimmed.replace(/^\u2713\s*/, ''), status: 'completed' });
      continue;
    }

    // Phase header: ## Phase Name or Phase: Name (only if not a task line)
    const phaseMatch = trimmed.match(/^#{1,3}\s+(.+)$/);
    if (phaseMatch) {
      if (currentPhase && currentPhase.items.length > 0) phases.push(currentPhase);
      currentPhase = { name: phaseMatch[1], items: [] };
      continue;
    }
    const phaseColon = trimmed.match(/^Phase:\s*(.+)$/i);
    if (phaseColon) {
      if (currentPhase && currentPhase.items.length > 0) phases.push(currentPhase);
      currentPhase = { name: phaseColon[1], items: [] };
      continue;
    }
  }
  if (currentPhase && currentPhase.items.length > 0) phases.push(currentPhase);
  return phases;
}

/**
 * Check whether all todo items across all phases are completed or abandoned
 * (i.e. no pending or in_progress items remain).
 */
function isAllTodoDone(phases: TodoPhaseData[]): boolean {
  const allItems = phases.flatMap((p) => p.items);
  if (allItems.length === 0) return false;
  return allItems.every(
    (item) => item.status === 'completed' || item.status === 'abandoned',
  );
}

/**
 * Scan session messages for the latest todo tool state.
 * Returns the phases from the most recent completed `todo` tool call.
 * If a newer `todo` call is still executing, `isExecuting` is true.
 * For `init` ops still executing, shows the initial items from args.
 *
 * If the latest todo is fully completed and a new user turn has started
 * (a user message appears after the todo tool call), returns null so the
 * pinned panel is hidden. The completed todo is still visible in the chat
 * scroll area via the ToolCard renderer.
 */
export function getLatestTodoState(messages: ReadonlyArray<{ role: string; toolName?: string; toolResult?: unknown; toolArgs?: unknown }>): TodoPanelState | null {
  let phases: TodoPhaseData[] | null = null;
  let isExecuting = false;
  let todoIndex = -1;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'tool' || msg.toolName !== 'todo') continue;

    if (msg.toolResult != null) {
      // Found the latest completed todo tool call
      if (!phases) {
        phases = extractTodoPhases(msg.toolResult);
        if (phases.length === 0) {
          // Fallback: try parsing result text
          const resultText = extractResultText(msg.toolResult);
          phases = parseTodoPhasesFromText(resultText);
        }
        if (phases.length === 0) {
          // Fallback: try args
          phases = extractTodoPhasesFromArgs(msg.toolArgs);
        }
      }
      todoIndex = i;
      break; // Stop after finding the latest result
    } else {
      // This todo tool is still executing
      isExecuting = true;
      // For init ops, try to show the items from args as a preview
      if (!phases) {
        const fromArgs = extractTodoPhasesFromArgs(msg.toolArgs);
        if (fromArgs.length > 0) phases = fromArgs;
      }
      if (todoIndex === -1) todoIndex = i;
    }
  }

  if (!phases || phases.length === 0) return null;

  // If all todo items are completed/abandoned, check whether a new user
  // turn has started after the latest todo tool call. If so, hide the
  // pinned panel — the completed todo is still visible in the chat stream
  // via the ToolCard component.
  if (!isExecuting && isAllTodoDone(phases) && todoIndex >= 0) {
    for (let i = todoIndex + 1; i < messages.length; i++) {
      if (messages[i].role === 'user') {
        return null;
      }
    }
  }

  return { phases, isExecuting };
}

/**
 * Flattened todo items from phases (for backward compat with ToolCard summary/body).
 */
export function flattenTodoItems(phases: TodoPhaseData[]): TodoItemData[] {
  return phases.flatMap((phase) => phase.items);
}

// ── Legacy parseTodoItems (backward compat for inline ToolCard) ─────

export function parseTodoItems(args: unknown, resultText: string): TodoItemData[] {
  const todosArg = argVal(args, 'todos');
  if (Array.isArray(todosArg)) {
    return (todosArg as Array<Record<string, unknown>>).map((item): TodoItemData => {
      if (typeof item === 'string') return { text: item, status: 'pending' };
      const statusRaw = String(item.status ?? '');
      if (statusRaw) return { text: String(item.text ?? item.content ?? item.task ?? ''), status: normalizeTodoStatus(statusRaw) };
      return {
        text: String(item.text ?? item.content ?? item.task ?? ''),
        status: (item.done ?? item.completed ?? item.checked) ? 'completed' : 'pending',
      };
    }).filter((item) => item.text);
  }

  const parsed = tryParseJSON(resultText);
  if (Array.isArray(parsed)) {
    return (parsed as Array<Record<string, unknown>>).map((item): TodoItemData => {
      if (typeof item === 'string') return { text: item, status: 'pending' };
      const statusRaw = String(item.status ?? '');
      if (statusRaw) return { text: String(item.text ?? item.content ?? item.task ?? ''), status: normalizeTodoStatus(statusRaw) };
      return {
        text: String(item.text ?? item.content ?? item.task ?? ''),
        status: (item.done ?? item.completed ?? item.checked) ? 'completed' : 'pending',
      };
    }).filter((item) => item.text);
  }

  // Try parsing as phases from text
  const fromText = parseTodoPhasesFromText(resultText);
  if (fromText.length > 0) return flattenTodoItems(fromText);

  // Legacy line parsing
  const lines = resultText.split('\n').filter(Boolean);
  const items: TodoItemData[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[x\]/i.test(trimmed) || trimmed.startsWith('\u2713')) {
      items.push({ text: trimmed.replace(/^(\[x\]|\[X\]|\u2713)\s*/, ''), status: 'completed' });
    } else if (/^\[ \]/.test(trimmed) || /^[-*]\s/.test(trimmed)) {
      items.push({ text: trimmed.replace(/^(\[ \]|[-*])\s*/, ''), status: 'pending' });
    }
  }
  return items;
}

/** Simple LCS-based diff */
export type DiffLineData = {
  type: 'add' | 'del' | 'ctx';
  content: string;
  oldLine?: number;
  newLine?: number;
};

export function computeSimpleDiff(oldText: string, newText: string): DiffLineData[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const m = oldLines.length;
  const n = newLines.length;
  const result: DiffLineData[] = [];

  if (m + n > 500) {
    oldLines.forEach((line, i) => result.push({ type: 'del', content: line, oldLine: i + 1 }));
    newLines.forEach((line, i) => result.push({ type: 'add', content: line, newLine: i + 1 }));
    return result;
  }

  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  let i = 0, j = 0, oldLn = 1, newLn = 1;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      result.push({ type: 'ctx', content: oldLines[i], oldLine: oldLn, newLine: newLn });
      i++; j++; oldLn++; newLn++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: 'del', content: oldLines[i], oldLine: oldLn });
      i++; oldLn++;
    } else {
      result.push({ type: 'add', content: newLines[j], newLine: newLn });
      j++; newLn++;
    }
  }
  while (i < m) {
    result.push({ type: 'del', content: oldLines[i], oldLine: oldLn });
    i++; oldLn++;
  }
  while (j < n) {
    result.push({ type: 'add', content: newLines[j], newLine: newLn });
    j++; newLn++;
  }

  return result;
}
