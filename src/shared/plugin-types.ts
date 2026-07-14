// 插件系统类型定义（M0 占位骨架，M2+ 细化）
export type PluginKind =
  | 'case-parser'
  | 'subsys-discoverer'
  | 'coverage-parser'
  | 'simulation-runner'
  | 'sim-option-schema';

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  kind: PluginKind;
  description?: string;
}

export interface CaseInfo {
  id: string;
  name: string;
  path: string;
  /** Base case name — set when this case inherits from another case (child case) */
  baseCase?: string;
  /** Config file path where this case was defined */
  filePath?: string;
  /** Simulation -base parameter parsed from config file path */
  base?: string;
  /** Simulation -block parameter parsed from config file path */
  block?: string;
}

export interface SubsysInfo {
  id: string;
  name: string;
  path: string;
  kind: 'subsys' | 'top';
}

export interface CoverageData {
  runId: string;
  overall: number;
  line?: number;
  toggle?: number;
  functional?: number;
  assertion?: number;
  bySubsys?: Array<{
    subsys: string;
    line: number;
    toggle: number;
    functional: number;
    assertion: number;
    overall: number;
  }>;
}

export interface CompileError {
  file: string;
  line: number;
  column?: number;
  severity: 'error' | 'warning';
  message: string;
}

export interface SimulationRunOptions {
  caseId: string;
  caseName?: string;
  subsys: string;
  options?: Record<string, unknown>;
  /** 项目根路径，由后端注入，供插件确定工作目录和环境 */
  projectRoot?: string;
}

export interface SimulationRunHandle {
  runId: string;
}

export interface SimulationRunStatus {
  runId: string;
  status: 'pending' | 'running' | 'pass' | 'fail' | 'error' | 'aborted';
  startTime?: number;
  endTime?: number;
  message?: string;
}

export interface SimOptionField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'enum';
  default?: unknown;
  enumValues?: string[];
  description?: string;
  /** UI 分组标签，用于前端将字段按类别组织显示 */
  group?: string;
}

export interface SimOptionSchema {
  fields: SimOptionField[];
}

export interface CaseParserPlugin {
  manifest: PluginManifest & { kind: 'case-parser' };
  parse(projectRoot: string, subsys: string): Promise<CaseInfo[]>;
}

export interface SubsysDiscoveryPlugin {
  manifest: PluginManifest & { kind: 'subsys-discoverer' };
  discover(projectRoot: string): Promise<SubsysInfo[]>;
}

export interface CoverageParserPlugin {
  manifest: PluginManifest & { kind: 'coverage-parser' };
  parse(projectRoot: string, runId: string): Promise<CoverageData>;
}

export interface SimulationRunnerPlugin {
  manifest: PluginManifest & { kind: 'simulation-runner' };
  run(opts: SimulationRunOptions): Promise<SimulationRunHandle>;
  getStatus(runId: string): Promise<SimulationRunStatus>;
  getCompileErrors(runId: string): Promise<CompileError[]>;
  abort(runId: string): Promise<void>;
}

export interface SimOptionSchemaProvider {
  manifest: PluginManifest & { kind: 'sim-option-schema' };
  getSchema(subsys: string): Promise<SimOptionSchema>;
}

export type AnyPlugin =
  | CaseParserPlugin
  | SubsysDiscoveryPlugin
  | CoverageParserPlugin
  | SimulationRunnerPlugin
  | SimOptionSchemaProvider;

export interface PluginRegistry {
  caseParsers: CaseParserPlugin[];
  subsysDiscoverers: SubsysDiscoveryPlugin[];
  coverageParsers: CoverageParserPlugin[];
  simulationRunners: SimulationRunnerPlugin[];
  simOptionSchemaProviders: SimOptionSchemaProvider[];
}

// ─── 插件加载结果 ──────────────────────────────────────────────

export interface PluginLoadResult {
  manifest: PluginManifest;
  plugin: AnyPlugin;
  source: 'node_modules' | 'local';
  path: string;
  error?: string;
}
