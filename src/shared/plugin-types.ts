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
}

export interface CaseInfo {
  id: string;
  name: string;
  path: string;
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
}

export interface SimulationRunOptions {
  caseId: string;
  subsys: string;
}

export interface SimulationRunHandle {
  runId: string;
}

export interface SimOptionField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'enum';
  default?: unknown;
  enumValues?: string[];
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
}

export interface SimOptionSchemaProvider {
  manifest: PluginManifest & { kind: 'sim-option-schema' };
  getSchema(subsys: string): Promise<SimOptionSchema>;
}

export interface PluginRegistry {
  caseParsers: CaseParserPlugin[];
  subsysDiscoverers: SubsysDiscoveryPlugin[];
  coverageParsers: CoverageParserPlugin[];
  simulationRunners: SimulationRunnerPlugin[];
  simOptionSchemaProviders: SimOptionSchemaProvider[];
}
