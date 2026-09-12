// ──────────────────────────────────────────────────────────────────────────
// AI 引擎内置工具目录 — 设置页展示用的静态清单。
//
// pi 引擎的内置工具是固定集合（由 runner 侧 host tools 契约固定），
// 不依赖活跃会话即可枚举。此目录提供中文标签和英文描述，供设置页渲染开关。
// 当有活跃会话时，实际枚举结果会覆盖静态清单以保持同步。
// ──────────────────────────────────────────────────────────────────────────

export type BuiltinToolMeta = {
  name: string;
  label: string;
  description: string;
};

export const BUILTIN_TOOL_CATALOG: BuiltinToolMeta[] = [
  { name: 'read', label: '读取文件', description: 'Reads a file from the local filesystem' },
  { name: 'write', label: '写入文件', description: 'Writes a file to the local filesystem' },
  { name: 'edit', label: '编辑文件', description: 'Performs exact string replacements in an existing file' },
  { name: 'bash', label: '执行命令', description: 'Executes a shell command and returns its output' },
  { name: 'glob', label: '文件搜索', description: 'Finds files matching a glob pattern' },
  { name: 'grep', label: '内容搜索', description: 'Searches for a pattern in file contents' },
  { name: 'task', label: '子任务', description: 'Launches a sub-agent to handle complex, multi-step tasks' },
  { name: 'web_search', label: '网络搜索', description: 'Searches the web and returns results' },
  { name: 'fetch_content', label: '网页抓取', description: 'Fetches URL(s) and extracts readable content as markdown (supports GitHub repos, PDFs, YouTube, videos)' },
  { name: 'get_search_content', label: '搜索内容检索', description: 'Retrieves stored content from previous web_search/fetch_content calls by responseId' },
  { name: 'source_check', label: '来源核查', description: 'Checks a claim against web sources and returns a research artifact with passage citations' },
  { name: 'todo', label: '任务列表', description: 'Creates and updates a structured task list for the session' },
  { name: 'ast_grep', label: 'AST 搜索', description: 'Searches code using AST patterns' },
  { name: 'ast_edit', label: 'AST 编辑', description: 'Edits code using AST transformations' },
  { name: 'debug', label: '调试', description: 'Debugs code with breakpoints and step execution' },
  { name: 'eval', label: '代码执行', description: 'Evaluates JavaScript/TypeScript code in a sandbox' },
  { name: 'github', label: 'GitHub', description: 'Interacts with GitHub repositories, issues, and PRs' },
  { name: 'lsp', label: '语言服务器', description: 'Queries language server for symbols, references, and diagnostics' },
  { name: 'inspect_image', label: '图片检查', description: 'Inspects and analyzes image content' },
  { name: 'browser', label: '浏览器', description: 'Controls a headless browser for web interactions' },
  { name: 'computer', label: '计算机控制', description: 'Controls the computer desktop environment' },
  { name: 'checkpoint', label: '检查点', description: 'Creates a named checkpoint to track file state' },
  { name: 'rewind', label: '回退', description: 'Restores files to a previous checkpoint state' },
  { name: 'security_scan', label: '安全扫描', description: 'Scans code for security vulnerabilities' },
  { name: 'hub', label: '工具中心', description: 'Discovers and installs tools from the hub' },
  { name: 'memory_edit', label: '记忆编辑', description: 'Edits persistent memory entries' },
  { name: 'retain', label: '记忆保留', description: 'Retains important information in persistent memory' },
  { name: 'recall', label: '记忆回忆', description: 'Recalls information from persistent memory' },
  { name: 'reflect', label: '记忆反思', description: 'Reflects on and consolidates memory entries' },
  { name: 'learn', label: '学习', description: 'Learns from session interactions to improve future behavior' },
  { name: 'manage_skill', label: '技能管理', description: 'Manages installed skills and their configurations' },
];

/** 快速查找：工具名 → BuiltinToolMeta */
const byName = new Map<string, BuiltinToolMeta>();
for (const t of BUILTIN_TOOL_CATALOG) {
  byName.set(t.name, t);
}

/** 根据工具名查找中文标签，未找到时返回工具名本身 */
export function getBuiltinLabel(name: string): string {
  return byName.get(name)?.label ?? name;
}

/** 根据工具名查找描述，未找到时返回空字符串 */
export function getBuiltinDescription(name: string): string {
  return byName.get(name)?.description ?? '';
}

/** 所有内置工具名集合（不含 ask、不含隐藏工具） */
export const BUILTIN_TOOL_NAMES = new Set(BUILTIN_TOOL_CATALOG.map((t) => t.name));
