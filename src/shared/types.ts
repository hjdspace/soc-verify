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
