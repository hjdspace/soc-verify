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
  read:         { label: 'read',         category: 'file',        color: 'text-blue-400' },
  write:        { label: 'write',        category: 'file',        color: 'text-green-400' },
  edit:         { label: 'edit',         category: 'file',        color: 'text-yellow-400' },
  apply_patch:  { label: 'edit',         category: 'file',        color: 'text-yellow-400' },
  ast_edit:     { label: 'ast_edit',     category: 'file',        color: 'text-yellow-400' },
  bash:         { label: 'bash',         category: 'exec',        color: 'text-purple-400' },
  eval:         { label: 'eval',         category: 'exec',        color: 'text-indigo-400' },
  js:           { label: 'eval',         category: 'exec',        color: 'text-indigo-400' },
  python:       { label: 'eval',         category: 'exec',        color: 'text-indigo-400' },
  grep:         { label: 'grep',         category: 'search',      color: 'text-cyan-400' },
  search:       { label: 'grep',         category: 'search',      color: 'text-cyan-400' },
  glob:         { label: 'glob',         category: 'search',      color: 'text-sky-400' },
  find:         { label: 'glob',         category: 'search',      color: 'text-sky-400' },
  ast_grep:     { label: 'ast_grep',     category: 'search',      color: 'text-cyan-400' },
  web_search:   { label: 'web_search',   category: 'search',      color: 'text-red-400' },
  task:         { label: 'task',         category: 'agent',       color: 'text-orange-400' },
  job:          { label: 'job',          category: 'agent',       color: 'text-teal-400' },
  todo:         { label: 'todo',         category: 'agent',       color: 'text-violet-400' },
  ask:          { label: 'ask',          category: 'interactive', color: 'text-lime-400' },
  list_subsys:            { label: 'list_subsys',            category: 'host', color: 'text-emerald-400' },
  list_cases:             { label: 'list_cases',             category: 'host', color: 'text-emerald-400' },
  run_simulation:         { label: 'run_simulation',         category: 'host', color: 'text-emerald-400' },
  get_run_status:         { label: 'get_run_status',         category: 'host', color: 'text-emerald-400' },
  get_compile_errors:     { label: 'get_compile_errors',     category: 'host', color: 'text-emerald-400' },
  get_coverage:           { label: 'get_coverage',           category: 'host', color: 'text-emerald-400' },
  get_sim_options_schema: { label: 'get_sim_options_schema', category: 'host', color: 'text-emerald-400' },
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
    return { label, category: 'mcp', color: 'text-amber-400' };
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
      items.push({ title: trimmed.replace(/^[\u2713\[]+(done|ok)?\]?\s*/i, '').trim(), status: 'done' });
    } else if (trimmed.startsWith('\u27f3') || /^\[running\]/i.test(trimmed)) {
      items.push({ title: trimmed.replace(/^[\u27f3\[]+(running)?\]?\s*/i, '').trim(), status: 'running' });
    } else if (/^[-*]\s/.test(trimmed)) {
      items.push({ title: trimmed.replace(/^[-*]\s/, ''), status: 'done' });
    }
  }
  return items;
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

export type TodoItemData = { text: string; done: boolean };

export function parseTodoItems(args: unknown, resultText: string): TodoItemData[] {
  const todosArg = argVal(args, 'todos');
  if (Array.isArray(todosArg)) {
    return todosArg.map((item) => {
      if (typeof item === 'string') return { text: item, done: false };
      const obj = item as Record<string, unknown>;
      return {
        text: String(obj.text ?? obj.content ?? obj.task ?? ''),
        done: Boolean(obj.done ?? obj.completed ?? obj.checked),
      };
    });
  }

  const parsed = tryParseJSON(resultText);
  if (Array.isArray(parsed)) {
    return parsed.map((item) => {
      if (typeof item === 'string') return { text: item, done: false };
      const obj = item as Record<string, unknown>;
      return {
        text: String(obj.text ?? obj.content ?? obj.task ?? ''),
        done: Boolean(obj.done ?? obj.completed ?? obj.checked),
      };
    });
  }

  const lines = resultText.split('\n').filter(Boolean);
  const items: TodoItemData[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[x\]/i.test(trimmed) || trimmed.startsWith('\u2713')) {
      items.push({ text: trimmed.replace(/^(\[x\]|\[X\]|\u2713)\s*/, ''), done: true });
    } else if (/^\[ \]/.test(trimmed) || /^[-*]\s/.test(trimmed)) {
      items.push({ text: trimmed.replace(/^(\[ \]|[-*])\s*/, ''), done: false });
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
