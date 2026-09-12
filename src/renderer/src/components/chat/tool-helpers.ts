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
  fetch_content:      { label: 'fetch_content',      category: 'search', color: 'text-status-fail-foreground' },
  get_search_content: { label: 'get_search_content', category: 'search', color: 'text-status-fail-foreground' },
  source_check:       { label: 'source_check',       category: 'search', color: 'text-status-fail-foreground' },
  subagent:     { label: 'subagent',     category: 'agent',       color: 'text-chart-4' },
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

/** Check if a read tool call is actually a skill invocation (path starts with skill://) */
export function isSkillRead(args: unknown): boolean {
  const path = argStr(args, 'path', 'file_path');
  return !!path && path.startsWith('skill://');
}

/** Extract the skill name from a skill:// path in read tool args */
export function extractSkillName(args: unknown): string | null {
  const path = argStr(args, 'path', 'file_path');
  if (!path || !path.startsWith('skill://')) return null;
  const rest = path.slice('skill://'.length);
  // skill://<name> or skill://<name>/<relative-path>
  const slashIdx = rest.indexOf('/');
  return slashIdx === -1 ? rest : rest.slice(0, slashIdx);
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
 * Result header is the first `[path]` / `[path#tag]` line — hashline-mode
 * edits carry the `#tag` suffix, replace/patch/sloppy modes emit a bare
 * `[absolute_path]` header (engine `edit/result.ts` default header).
 */
export function extractOmpEditPathFromResult(resultText: string): string {
  if (!resultText) return '';
  const match = resultText.match(/^\[([^\]]+?)(?:#[A-Za-z0-9_]+)?\]/m);
  if (match) return match[1];
  return '';
}

export type SloppyEditPair = { find: string; put: string };

/**
 * 解析 sloppy 模式 edit 输入（omp PI_EDIT_VARIANT=sloppy）：
 * `<SM:EDIT path="...">` + `<SM:FIND>当前文本</SM:FIND><SM:PUT>最终文本</SM:PUT>` 对。
 * 该模式输入没有 +/-/@@ 行，无法走 unified patch 解析，需单独提取 find/put 对。
 */
export function extractSloppyEditInput(args: unknown): { path: string | undefined; pairs: SloppyEditPair[] } | null {
  const input = argStr(args, 'input');
  if (!input || !/<SM:EDIT\b/i.test(input)) return null;
  const pathMatch = input.match(/<SM:EDIT\b[^>]*?\bpath="([^"]*)"/i);
  const pairs: SloppyEditPair[] = [];
  const pairRe = /<SM:FIND>([\s\S]*?)<\/SM:FIND>\s*<SM:PUT>([\s\S]*?)<\/SM:PUT>/gi;
  let match: RegExpExecArray | null;
  while ((match = pairRe.exec(input)) !== null) {
    // 标签独占一行：剥掉标签后紧跟的一个换行（引擎将其视为分隔符而非内容）
    const find = match[1].replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    const put = match[2].replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    pairs.push({ find, put });
  }
  if (pairs.length === 0) return null;
  return { path: pathMatch?.[1], pairs };
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
  // sloppy 模式：<SM:EDIT path="...">
  const sloppy = extractSloppyEditInput(args);
  if (sloppy?.path) return sloppy.path;
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
 * Extract todo items from the rpiv-todo (@juicesharp/rpiv-todo, pi 引擎) tool
 * result: `details.tasks` is the flat Task[] persistence snapshot
 * (`{ id, subject, status: pending|in_progress|completed|deleted, activeForm? }`)
 * — no omp-style phases. `deleted` 是墓碑态，不展示。
 * 返回 null 表示结果不是 rpiv 格式（无 details.tasks）；items 为空数组表示
 * 是 rpiv 格式但清单已清空（clear / 全部 tombstone）。
 */
/**
 * 提取工具结果的结构化 details（AgentToolResult.details，runner 侧透传）。
 * pi-web-access 等扩展把 queries/totalResults/artifact 等结构化摘要放在
 * details 而非 content 文本里，UI 卡片优先读它构建富展示。
 */
export function getToolDetails(result: unknown): Record<string, unknown> | null {
  if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
    const details = (result as Record<string, unknown>).details;
    if (typeof details === 'object' && details !== null && !Array.isArray(details)) {
      return details as Record<string, unknown>;
    }
  }
  return null;
}

export function extractRpivTodoTasks(result: unknown): TodoItemData[] | null {
  if (typeof result !== 'object' || result === null) return null;
  const details = (result as Record<string, unknown>).details;
  if (typeof details !== 'object' || details === null) return null;
  const tasks = (details as Record<string, unknown>).tasks;
  if (!Array.isArray(tasks)) return null;
  return (tasks as Array<Record<string, unknown>>)
    .filter((t) => String(t.status ?? '') !== 'deleted')
    .map((t) => {
      const subject = String(t.subject ?? '');
      const status = String(t.status ?? 'pending');
      // in_progress 优先展示 activeForm（present-continuous 进度标签）
      const activeForm =
        status === 'in_progress' && typeof t.activeForm === 'string' && t.activeForm
          ? t.activeForm
          : '';
      return {
        text: activeForm ? `${subject} (${activeForm})` : subject,
        status: normalizeTodoStatus(status),
      };
    })
    .filter((item) => item.text);
}

/**
 * Extract todo phases from the omp todo tool result object.
 * The result contains `details.phases` with `TodoPhase[]` where each task has
 * `{ content: string, status: "pending" | "in_progress" | "completed" | "abandoned" }`.
 * 兼容 rpiv-todo（pi 引擎）的 `details.tasks` 扁平快照：映射为单 phase。
 */
export function extractTodoPhases(result: unknown): TodoPhaseData[] {
  if (typeof result !== 'object' || result === null) return [];
  const obj = result as Record<string, unknown>;
  const details = obj.details;
  if (typeof details !== 'object' || details === null) return [];
  const phases = (details as Record<string, unknown>).phases;
  if (Array.isArray(phases)) {
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
  // rpiv-todo（pi 引擎）：details.tasks 扁平 Task[] 快照 → 单 phase
  const rpivTasks = extractRpivTodoTasks(result);
  if (rpivTasks && rpivTasks.length > 0) {
    return [{ name: '任务', items: rpivTasks }];
  }
  return [];
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

  // rpiv-todo result text lines (pi 引擎：[status] #id subject / Created #id: ...)
  const fromRpivLines = parseRpivTodoLines(resultText);
  if (fromRpivLines.length > 0) return fromRpivLines;

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

/**
 * rpiv-todo（pi 引擎）结果文本行解析：
 * `list`/`get` action 输出 `[status] #id subject [(activeForm)] [⛓ #dep,…]`，
 * `create` action 输出 `Created #id: subject (status)`。
 */
function parseRpivTodoLines(text: string): TodoItemData[] {
  if (!text) return [];
  const items: TodoItemData[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const listMatch = trimmed.match(/^\[(pending|in_progress|completed|deleted)\]\s*#\d+\s+(.+)$/);
    if (listMatch) {
      if (listMatch[1] !== 'deleted') {
        // 剥掉尾部依赖链展示（⛓ #1,2），保留 activeForm
        items.push({
          text: listMatch[2].replace(/\s*⛓.*$/, '').trim(),
          status: normalizeTodoStatus(listMatch[1]),
        });
      }
      continue;
    }
    const createMatch = trimmed.match(/^Created #\d+:\s+(.+?)\s+\((pending|in_progress|completed)\)$/);
    if (createMatch) {
      items.push({ text: createMatch[1].trim(), status: normalizeTodoStatus(createMatch[2]) });
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
