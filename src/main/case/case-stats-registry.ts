/**
 * Case Stats Registry — per-project CaseStatsService 生命周期管理。
 *
 * 镜像 SimulationRegistry / CoverageRegistry 的单例模式：
 * 一个 projectRoot 对应一个 CaseStatsService，懒创建，跨调用复用。
 * 这样 PluginBackedDiscovery 的 caseCache 也能跨调用复用。
 */

import type { PluginRegistry } from '@shared/plugin-types';
import type { SimulationManager } from '../simulation/simulation-manager';
import { PluginBackedDiscovery } from '../plugin-adapters/discovery';
import { CaseStatsService } from './case-stats-service';

class CaseStatsRegistryImpl {
  private services = new Map<string, CaseStatsService>();

  /**
   * 获取或创建指定项目的 CaseStatsService。
   *
   * @param projectRoot 项目根路径
   * @param registry 插件注册表（用于创建 PluginBackedDiscovery）
   * @param simulationManager 仿真管理器（可选，可在创建后通过 setSimulationManager 注入）
   */
  getOrCreate(
    projectRoot: string,
    registry: PluginRegistry,
    simulationManager?: SimulationManager | null,
  ): CaseStatsService {
    let service = this.services.get(projectRoot);
    if (!service) {
      const discovery = new PluginBackedDiscovery(projectRoot, registry);
      service = new CaseStatsService({ discovery, simulationManager });
      this.services.set(projectRoot, service);
    } else if (simulationManager) {
      // 已存在的 service 也同步更新 simulationManager 引用
      service.setSimulationManager(simulationManager);
    }
    return service;
  }

  /** 注入 SimulationManager 到指定项目的 service（若 service 尚未创建则忽略）。 */
  setSimulationManager(projectRoot: string, mgr: SimulationManager | null): void {
    const service = this.services.get(projectRoot);
    if (service) {
      service.setSimulationManager(mgr);
    }
  }

  get(projectRoot: string): CaseStatsService | null {
    return this.services.get(projectRoot) ?? null;
  }

  remove(projectRoot: string): void {
    this.services.delete(projectRoot);
  }

  clearAll(): void {
    this.services.clear();
  }
}

export const caseStatsRegistry = new CaseStatsRegistryImpl();
