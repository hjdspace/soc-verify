/**
 * Plugin-backed SubsysDiscovery adapter.
 *
 * Bridges the SubsysDiscoveryPlugin and CaseParserPlugin interfaces from
 * @shared/plugin-types to the SubsysDiscovery interface used by
 * HostToolsRegistry. This adapter sits at the seam between the host
 * interface layer (src/main/host/) and the router/service layer.
 */

import type { SubsysDiscovery, CaseStatus, SubsysInfo, CaseInfo, SimOptionsSchema } from '../host/discovery';
import type {
  SubsysDiscoveryPlugin,
  CaseParserPlugin,
  SimOptionSchemaProvider,
  PluginRegistry,
  CaseInfo as PluginCaseInfo,
  SubsysInfo as PluginSubsysInfo,
} from '@shared/plugin-types';

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
      id: c.id,
      name: c.name,
      subsys: targetSubsys,
      path: c.path,
      status: 'pending' as CaseStatus,
      baseCase: c.baseCase,
      filePath: c.filePath,
      base: c.base,
      block: c.block,
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
