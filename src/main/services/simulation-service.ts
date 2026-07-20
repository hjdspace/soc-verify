/**
 * Simulation domain service — factory for SimulationManager instances.
 *
 * Encapsulates the coordination between ProjectManager, PluginLoader, and
 * SimulationRegistry. Previously this helper lived in the kitchen-sink
 * router-context.ts.
 */

import { requireProject } from './project-service';
import { pluginLoader } from '../plugins/loader';
import { simulationRegistry } from '../simulation/simulation-registry';
import { PluginBackedSimulation } from '../plugin-adapters';

/**
 * Get or create a SimulationManager for a project.
 * The manager is cached per project root path in SimulationRegistry.
 */
export function getSimulationManager(projectId: string) {
  const project = requireProject(projectId);
  const registry = pluginLoader.getRegistry(project.rootPath);
  const adapter = new PluginBackedSimulation(registry);
  return simulationRegistry.getOrCreate(project.rootPath, projectId, adapter);
}
