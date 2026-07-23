import { EventEmitter } from 'node:events';
import { SimulationManager, type SimulationRunRecord } from './simulation-manager';
import type { PluginBackedSimulation } from '../plugin-adapters';
import type { SimulationRunOptions } from '@shared/plugin-types';

/**
 * Registry that manages SimulationManager instances per project root.
 * Provides a singleton-like access pattern for the tRPC router.
 */
class SimulationRegistryImpl extends EventEmitter {
  private managers = new Map<string, SimulationManager>();

  getOrCreate(projectRoot: string, projectId: string, adapter: PluginBackedSimulation): SimulationManager {
    let manager = this.managers.get(projectRoot);
    if (!manager) {
      manager = new SimulationManager({ projectRoot, projectId, simulationAdapter: adapter });
      manager.on('run:started', (record: SimulationRunRecord) => {
        this.emit('run:started', record);
      });
      manager.on('run:statusChanged', (record: SimulationRunRecord) => {
        this.emit('run:statusChanged', record);
      });
      manager.on('run:completed', (record: SimulationRunRecord) => {
        this.emit('run:completed', record);
      });
      manager.on('run:aborted', (record: SimulationRunRecord) => {
        this.emit('run:aborted', record);
      });
      // Load history lazily
      void manager.loadHistory();
      this.managers.set(projectRoot, manager);
    }
    return manager;
  }

  get(projectRoot: string): SimulationManager | null {
    return this.managers.get(projectRoot) ?? null;
  }

  remove(projectRoot: string): void {
    const manager = this.managers.get(projectRoot);
    if (manager) {
      manager.destroy();
      this.managers.delete(projectRoot);
    }
  }

  destroyAll(): void {
    for (const [, manager] of this.managers) {
      manager.destroy();
    }
    this.managers.clear();
  }
}

export const simulationRegistry = new SimulationRegistryImpl();
