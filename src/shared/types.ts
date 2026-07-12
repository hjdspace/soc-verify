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
  endpoint?: string;
  createdAt: number;
}

export interface CredentialInput {
  providerId: string;
  label: string;
  apiKey: string;
  endpoint?: string;
}
