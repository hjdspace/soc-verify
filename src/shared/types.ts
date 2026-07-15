export interface AppVersionInfo {
  app: string;
  version: string;
  stage: string;
}

// ─── 项目管理类型 ──────────────────────────────────────────────

export interface ProjectInfo {
  id: string;
  name: string;
  rootPath: string;
  createdAt: number;
  lastOpenedAt: number;
}

export interface ProjectState {
  projectId: string;
  uiLayout: {
    leftRailCollapsed: boolean;
    rightPanelCollapsed: boolean;
    optionDockExpanded: boolean;
  };
  lastSessionIds: string[];
}

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileTreeNode[];
}

export interface FileTreeUpdate {
  projectId: string;
  type: 'add' | 'unlink' | 'change';
  path: string;
}

// ─── 源代码管理类型 ──────────────────────────────────────────

export interface SourceControlFileStatus {
  path: string;
  originalPath?: string;
  indexStatus: string;
  workTreeStatus: string;
  staged: boolean;
  unstaged: boolean;
}

export interface SourceControlStatus {
  isRepository: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  files: SourceControlFileStatus[];
}

export interface SourceControlCommitResult {
  commitHash: string;
  summary: string;
}

// ─── 插件配置类型 ──────────────────────────────────────────────

export interface PluginConfigEntry {
  id: string;
  name: string;
  version: string;
  kind: import('./plugin-types').PluginKind;
  source: 'node_modules' | 'local';
  path: string;
  enabled: boolean;
  error?: string;
}

export interface PluginConfig {
  plugins: PluginConfigEntry[];
}

// ─── 仿真类型 ──────────────────────────────────────────────────

export type SimulationStatus = 'pending' | 'running' | 'pass' | 'fail' | 'error' | 'aborted';

export interface CompileError {
  file: string;
  line: number;
  column?: number;
  severity: 'error' | 'warning';
  message: string;
}

export interface SimulationHistoryEntry {
  runId: string;
  caseId: string;
  caseName: string;
  subsys: string;
  options: Record<string, unknown>;
  status: SimulationStatus;
  startTime: number;
  endTime: number;
  duration: number;
  compileErrors?: CompileError[];
}

// ─── 覆盖率类型 ────────────────────────────────────────────────

export type CoverageType = 'line' | 'toggle' | 'functional' | 'assertion';

export interface CoverageSummary {
  overall: number;
  line: number;
  toggle: number;
  functional: number;
  assertion: number;
}

export interface CoverageBySubsys {
  subsys: string;
  summary: CoverageSummary;
}

// ─── 回归类型 ──────────────────────────────────────────────────

export interface RegressionSuite {
  name: string;
  caseIds: string[];
  options: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface RegressionResult {
  suiteName: string;
  runId: string;
  totalCases: number;
  passed: number;
  failed: number;
  duration: number;
  timestamp: number;
  results: Array<{
    caseId: string;
    caseName: string;
    status: SimulationStatus;
    duration: number;
  }>;
}

// ─── TO 检查清单类型 ───────────────────────────────────────────

export type TOItemStatus = 'pass' | 'pending' | 'blocked';

export interface TOChecklistItem {
  id: string;
  category: 'coverage' | 'regression' | 'signoff';
  name: string;
  description: string;
  status: TOItemStatus;
  autoEvaluated: boolean;
  threshold?: number;
  actualValue?: number;
  details?: string;
}

// ─── 后台任务类型 ──────────────────────────────────────────────

export type TaskType = 'simulation' | 'ai_session' | 'regression';
export type TaskStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface BackgroundTask {
  id: string;
  name: string;
  type: TaskType;
  status: TaskStatus;
  progress: number;
  startedAt: number;
  completedAt?: number;
  metadata?: Record<string, unknown>;
}

// ─── 环境配置类型 ──────────────────────────────────────────────

export interface EdaToolInfo {
  name: string;
  version?: string;
  path: string;
  detected: boolean;
}

export interface EnvConfig {
  tools: EdaToolInfo[];
  envVars: Record<string, string>;
}

// ─── 凭据类型 ──────────────────────────────────────────────────

export interface CredentialEntry {
  providerId: string;
  label: string;
  apiKeyMasked: string;
  baseUrl?: string;
  createdAt: number;
}

export interface CredentialInput {
  providerId: string;
  label: string;
  apiKey: string;
  baseUrl?: string;
}

// ─── 错误分析类型 ──────────────────────────────────────────────

/** 失败仿真的错误分类 */
export type ErrorType = 'compile_error' | 'sim_error';

/** 错误分析会话的状态 */
export type ErrorAnalysisStatus = 'analyzing' | 'fixing' | 'retrying' | 'completed' | 'stopped' | 'failed';

/** 错误分析会话信息 */
export interface ErrorAnalysisSession {
  sessionId: string;
  projectId: string;
  caseName: string;
  errorType: ErrorType;
  status: ErrorAnalysisStatus;
  retryCount: number;
  maxRetries: number;
  createdAt: number;
  /** 触发错误分析的仿真 runId */
  sourceRunId?: string;
  /** 错误上下文摘要 */
  errorSummary?: string;
}

/** 从日志中提取的结构化编译错误 */
export interface ExtractedCompileError {
  tool: 'Xcelium' | 'VCS';
  errorType?: string;
  errorCode: string;
  file?: string;
  line?: string;
  errorInfo: string;
  lineNumber: number;
  context: string[];
}

/** 从日志中提取的结构化仿真错误 */
export interface ExtractedSimError {
  tool: 'UVM' | 'SPRD' | 'VCS' | 'VCS/NC' | 'Timing';
  severity?: string;
  errorType?: string;
  timestamp?: string;
  testCase?: string;
  message: string;
  file?: string;
  line?: string;
  location?: string;
  code?: string;
  typeName?: string;
  index?: string;
  lineNumber: number;
  context: string[];
}

/** 日志分析结果 */
export interface LogAnalysisResult {
  filePath: string;
  toolType: string;
  totalLines: number;
  totalErrors: number;
  errors: ExtractedCompileError[] | ExtractedSimError[];
  truncated: boolean;
  criticalErrors?: number;
  fatalErrors?: number;
  errorCount?: number;
}

// ─── Diff Review 类型 ────────────────────────────────────────

/** 单个 tool call 的信息，用于 diff 计算和撤销 */
export interface DiffToolCall {
  /** 工具调用唯一标识 */
  id: string;
  /** 工具名：write / edit / apply_patch / ast_edit */
  toolName: string;
  /** 文件路径 */
  filePath: string;
  /** 时间戳，用于排序 */
  timestamp: number;
  /** 来源会话 ID */
  sessionId?: string;
  /** EDIT: oldText（被替换的原文段） */
  oldText?: string;
  /** EDIT: newText（替换后的新文段） */
  newText?: string;
  /** WRITE: 文件内容（全量新增） */
  content?: string;
  /** 是否为创建新文件（WRITE 工具） */
  isNewFile: boolean;
}

/** Diff 中的一行 */
export interface DiffLine {
  /** 行类型：ctx=上下文, add=新增, del=删除 */
  type: 'ctx' | 'add' | 'del';
  /** 行内容（不含前缀符号） */
  content: string;
  /** 原文件行号（del 行有值） */
  oldLine?: number;
  /** 新文件行号（add 和 ctx 行有值） */
  newLine?: number;
  /** 所属 hunk 序号（从 1 开始），ctx 行为 null */
  hunkId?: number;
}

/** Hunk 边界信息 */
export interface DiffHunkInfo {
  /** hunk 序号（从 1 开始） */
  id: number;
  /** 来源 tool call ID */
  toolCallId: string;
  /** 来源工具名 */
  toolName: string;
  /** 该 hunk 是否已被后续编辑覆盖（无法拒绝） */
  overwritten: boolean;
  /** 该 hunk 在 diff 行数组中的起始索引 */
  startLineIndex: number;
  /** 该 hunk 在 diff 行数组中的结束索引（不含） */
  endLineIndex: number;
  /** 统计：新增行数 */
  addCount: number;
  /** 统计：删除行数 */
  delCount: number;
}

/** getFileDiff API 返回的完整文件 diff 结果 */
export interface FileDiffResult {
  /** 文件路径 */
  filePath: string;
  /** 文件是否为新创建（WRITE） */
  isNewFile: boolean;
  /** diff 行数组（包含 ctx/add/del） */
  lines: DiffLine[];
  /** hunk 列表 */
  hunks: DiffHunkInfo[];
  /** 统计：总新增行数 */
  totalAdd: number;
  /** 统计：总删除行数 */
  totalDel: number;
}

/** applyDiffRejections 的单个拒绝项 */
export interface DiffRejection {
  /** hunk 序号 */
  hunkId: number;
  /** 来源 tool call ID */
  toolCallId: string;
  /** 工具名 */
  toolName: string;
  /** oldText（用于撤销替换） */
  oldText?: string;
  /** newText（用于定位和替换） */
  newText?: string;
  /** 是否为删除整个文件（WRITE 拒绝） */
  deleteFile: boolean;
}

/** applyDiffRejections API 的返回 */
export interface ApplyRejectionsResult {
  ok: boolean;
  /** 成功应用的拒绝数 */
  appliedCount: number;
  /** 失败的拒绝（oldText 在文件中未找到等） */
  failures: Array<{ hunkId: number; reason: string }>;
}
