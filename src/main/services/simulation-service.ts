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
import { caseStatsRegistry } from '../case/case-stats-registry';
import { PluginBackedSimulation } from '../plugin-adapters';

/**
 * Get or create a SimulationManager for a project.
 * The manager is cached per project root path in SimulationRegistry.
 *
 * 新建/已有的 SimulationManager 会同步注入到 CaseStatsService，
 * 使 AI 的 list_cases / get_case_stats 能拿到实时仿真状态。
 */
export function getSimulationManager(projectId: string) {
  const project = requireProject(projectId);
  const registry = pluginLoader.getRegistry(project.rootPath);
  const adapter = new PluginBackedSimulation(registry);
  const manager = simulationRegistry.getOrCreate(project.rootPath, projectId, adapter);
  // 同步注入到 CaseStatsService（若 service 已存在则更新其 simulationManager 引用）
  caseStatsRegistry.setSimulationManager(project.rootPath, manager);
  return manager;
}
