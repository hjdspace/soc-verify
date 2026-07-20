/**
 * Plugin-backed simulation runner adapter.
 *
 * Bridges the SimulationRunnerPlugin interface from @shared/plugin-types
 * to the methods that HostToolsRegistry and SimulationManager call.
 */

import type {
  SimulationRunnerPlugin,
  PluginRegistry,
  SimulationRunOptions,
  SimulationRunHandle,
  SimulationRunStatus,
  CompileError,
} from '@shared/plugin-types';

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
