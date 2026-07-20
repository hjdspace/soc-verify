/**
 * Plugin-backed coverage parser adapter.
 *
 * Bridges the CoverageParserPlugin interface from @shared/plugin-types
 * to the methods that HostToolsRegistry and CoverageRouter call.
 */

import type {
  CoverageParserPlugin,
  PluginRegistry,
  CoverageData,
} from '@shared/plugin-types';

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
