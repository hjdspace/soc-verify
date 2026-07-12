import type { SubsysDiscovery, CaseStatus, SubsysInfo, CaseInfo, SimOptionsSchema } from './discovery';
import type {
  SubsysDiscoveryPlugin,
  CaseParserPlugin,
  SimOptionSchemaProvider,
  SimulationRunnerPlugin,
  CoverageParserPlugin,
  PluginRegistry,
  CaseInfo as PluginCaseInfo,
  SubsysInfo as PluginSubsysInfo,
  SimulationRunOptions,
  SimulationRunHandle,
  SimulationRunStatus,
  CompileError,
  CoverageData,
} from '@shared/plugin-types';

/**
 * Plugin-backed SubsysDiscovery implementation.
 *
 * Bridges the SubsysDiscoveryPlugin and CaseParserPlugin interfaces to the
 * SubsysDiscovery interface used by HostToolsRegistry.
 */
export class PluginBackedDiscovery implements SubsysDiscovery {
  private projectRoot: string;
  private registry: PluginRegistry;
  private caseCache = new Map<string, PluginCaseInfo[]>();

  constructor(projectRoot: string, registry: PluginRegistry) {
    this.projectRoot = projectRoot;
    this.registry = registry;
  }

  async listSubsys(filter?: string): Promise<SubsysInfo[]> {
    if (this.registry.subsysDiscoverers.length === 0) return [];

    // Use the first subsys discoverer plugin
    const plugin = this.registry.subsysDiscoverers[0];
    let subsysList = await plugin.discover(this.projectRoot);

    if (filter) {
      const lowerFilter = filter.toLowerCase();
      subsysList = subsysList.filter((s) => s.name.toLowerCase().includes(lowerFilter));
    }

    return subsysList.map((s: PluginSubsysInfo) => ({
      name: s.name,
      path: s.path,
      caseCount: 0, // Will be filled by listCases
      description: undefined,
    }));
  }

  async listCases(subsys?: string, status?: CaseStatus): Promise<CaseInfo[]> {
    if (this.registry.caseParsers.length === 0) return [];

    const targetSubsys = subsys ?? '';
    if (!targetSubsys) return [];

    // Check cache
 let cached = this.caseCache.get(targetSubsys);
    if (!cached) {
      const plugin = this.registry.caseParsers[0];
      cached = await plugin.parse(this.projectRoot, targetSubsys);
      this.caseCache.set(targetSubsys, cached);
    }

    let cases = cached.map((c: PluginCaseInfo) => ({
      name: c.name,
      subsys: targetSubsys,
      path: c.path,
      status: 'pending' as CaseStatus,
    }));

    if (status && status !== 'all') {
      cases = cases.filter((c) => c.status === status);
    }

    return cases;
  }

  async getSimOptionsSchema(): Promise<SimOptionsSchema> {
    if (this.registry.simOptionSchemaProviders.length === 0) return {};

    const plugin = this.registry.simOptionSchemaProviders[0];
    const schema = await plugin.getSchema('');
    // Convert SimOptionSchema to SimOptionsSchema (Record<string, unknown>)
    const result: SimOptionsSchema = {};
    for (const field of schema.fields) {
      result[field.key] = {
        type: field.type,
        label: field.label,
        default: field.default,
        enumValues: field.enumValues,
        description: field.description,
      };
    }
    return result;
  }

  clearCache(): void {
    this.caseCache.clear();
  }
}

/**
 * Plugin-backed simulation runner adapter.
 * Provides methods that HostToolsRegistry can call.
 */
export class PluginBackedSimulation {
  private registry: PluginRegistry;

  constructor(registry: PluginRegistry) {
    this.registry = registry;
  }

  hasRunner(): boolean {
    return this.registry.simulationRunners.length > 0;
  }

  async run(opts: SimulationRunOptions): Promise<SimulationRunHandle> {
    if (!this.hasRunner()) throw new Error('No simulation-runner plugin loaded');
    const plugin = this.registry.simulationRunners[0];
    return plugin.run(opts);
  }

  async getStatus(runId: string): Promise<SimulationRunStatus> {
    if (!this.hasRunner()) throw new Error('No simulation-runner plugin loaded');
    const plugin = this.registry.simulationRunners[0];
    return plugin.getStatus(runId);
  }

  async getCompileErrors(runId: string): Promise<CompileError[]> {
    if (!this.hasRunner()) throw new Error('No simulation-runner plugin loaded');
    const plugin = this.registry.simulationRunners[0];
    return plugin.getCompileErrors(runId);
  }

  async abort(runId: string): Promise<void> {
    if (!this.hasRunner()) throw new Error('No simulation-runner plugin loaded');
    const plugin = this.registry.simulationRunners[0];
    return plugin.abort(runId);
  }
}

/**
 * Plugin-backed coverage parser adapter.
 */
export class PluginBackedCoverage {
  private projectRoot: string;
  private registry: PluginRegistry;

  constructor(projectRoot: string, registry: PluginRegistry) {
    this.projectRoot = projectRoot;
    this.registry = registry;
  }

  hasParser(): boolean {
    return this.registry.coverageParsers.length > 0;
  }

  async parse(runId: string): Promise<CoverageData> {
    if (!this.hasParser()) throw new Error('No coverage-parser plugin loaded');
    const plugin = this.registry.coverageParsers[0];
    return plugin.parse(this.projectRoot, runId);
  }
}
