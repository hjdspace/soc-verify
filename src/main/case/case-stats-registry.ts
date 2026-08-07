/**
 * Case Stats Registry — per-project CaseStatsService + DB 生命周期管理。
 *
 * 镜像 SimulationRegistry / CoverageRegistry 的单例模式：
 * 一个 projectRoot 对应一个 CaseStatsService + CaseDatabase，懒创建，跨调用复用。
 * 关闭项目时关闭 DB 连接（ADR 0017）。
 */

import type { PluginRegistry } from '@shared/plugin-types';
import type { SimulationManager } from '../simulation/simulation-manager';
import { PluginBackedDiscovery } from '../plugin-adapters/discovery';
import { CaseStatsService } from './case-stats-service';
import { initDatabase, closeDatabase, getDbPath, type CaseDatabase } from './db/case-database';
import { CaseScanner } from './case-scanner';
import { SimulationRunListener } from './sim-run-listener';

class CaseStatsRegistryImpl {
  private services = new Map<string, CaseStatsService>();
  private dbs = new Map<string, CaseDatabase>();
  private scanners = new Map<string, CaseScanner>();
  private listeners = new Map<string, SimulationRunListener>();

  /**
   * 获取或创建指定项目的 DB 连接（懒创建）。
   * DB 文件位于 .socverify/cases.db（ADR 0017）。
   */
  getOrCreateDb(projectRoot: string): CaseDatabase {
    let db = this.dbs.get(projectRoot);
    if (!db) {
      const dbPath = getDbPath(projectRoot);
      db = initDatabase(dbPath);
      this.dbs.set(projectRoot, db);
    }
    return db;
  }

  /**
   * 获取或创建指定项目的 CaseScanner（懒创建）。
   */
  getOrCreateScanner(projectRoot: string, registry: PluginRegistry): CaseScanner {
    let scanner = this.scanners.get(projectRoot);
    if (!scanner) {
      const db = this.getOrCreateDb(projectRoot);
      scanner = new CaseScanner(projectRoot, registry, db);
      this.scanners.set(projectRoot, scanner);
    }
    return scanner;
  }

  /**
   * 获取或创建指定项目的 CaseStatsService。
   *
   * 当 DB 可用时，CaseStatsService 从 DB 读取数据（秒开）。
   * DB 不可用时回退到插件 discovery（原行为）。
   *
   * @param projectRoot 项目根路径
   * @param registry 插件注册表（用于创建 PluginBackedDiscovery + CaseScanner）
   * @param simulationManager 仿真管理器（可选，可在创建后通过 setSimulationManager 注入）
   */
  getOrCreate(
    projectRoot: string,
    registry: PluginRegistry,
    simulationManager?: SimulationManager | null,
  ): CaseStatsService {
    let service = this.services.get(projectRoot);
    if (!service) {
      const db = this.getOrCreateDb(projectRoot);
      const discovery = new PluginBackedDiscovery(projectRoot, registry);
      service = new CaseStatsService({ discovery, simulationManager, db });
      this.services.set(projectRoot, service);
    } else if (simulationManager) {
      // 已存在的 service 也同步更新 simulationManager 引用
      service.setSimulationManager(simulationManager);
    }
    // 仿真运行记录持久化（ADR 0017 决策 4）：
    // 当 SimulationManager 可用时，创建并启动 Listener，监听 run:completed 事件写入 DB。
    if (simulationManager) {
      this.attachListener(projectRoot, simulationManager);
    }
    return service;
  }

  /** 注入 SimulationManager 到指定项目的 service（若 service 尚未创建则忽略）。 */
  setSimulationManager(projectRoot: string, mgr: SimulationManager | null): void {
    const service = this.services.get(projectRoot);
    if (service) {
      service.setSimulationManager(mgr);
    }
    // 同步管理 Listener 生命周期
    if (mgr) {
      this.attachListener(projectRoot, mgr);
    } else {
      this.detachListener(projectRoot);
    }
  }

  /**
   * 创建并启动 SimulationRunListener，监听 run:completed 事件并写入 DB。
   * 如果该项目已存在 Listener，先停止旧的再创建新的。
   */
  private attachListener(projectRoot: string, mgr: SimulationManager): void {
    this.detachListener(projectRoot);
    const db = this.getOrCreateDb(projectRoot);
    const listener = new SimulationRunListener(mgr, db);
    listener.start();
    this.listeners.set(projectRoot, listener);
  }

  /** 停止并移除指定项目的 SimulationRunListener。 */
  private detachListener(projectRoot: string): void {
    const listener = this.listeners.get(projectRoot);
    if (listener) {
      listener.stop();
      this.listeners.delete(projectRoot);
    }
  }

  get(projectRoot: string): CaseStatsService | null {
    return this.services.get(projectRoot) ?? null;
  }

  /** 获取指定项目的 DB 实例（若已创建）。 */
  getDb(projectRoot: string): CaseDatabase | null {
    return this.dbs.get(projectRoot) ?? null;
  }

  /** 获取指定项目的 Scanner 实例（若已创建）。 */
  getScanner(projectRoot: string): CaseScanner | null {
    return this.scanners.get(projectRoot) ?? null;
  }

  /** 清除指定项目 discovery 内部缓存（case_cfg 修改后刷新用）。
   * 传入 subsys 时仅清除该子系统的用例缓存；不传时清除全部缓存。 */
  clearDiscoveryCache(projectRoot: string, subsys?: string): void {
    const service = this.services.get(projectRoot);
    if (service) service.clearDiscoveryCache(subsys);
  }

  remove(projectRoot: string): void {
    // Stop simulation run listener
    this.detachListener(projectRoot);
    // Close DB connection
    const db = this.dbs.get(projectRoot);
    if (db) {
      closeDatabase(db);
      this.dbs.delete(projectRoot);
    }
    this.services.delete(projectRoot);
    this.scanners.delete(projectRoot);
  }

  clearAll(): void {
    // Stop all listeners
    for (const listener of this.listeners.values()) {
      listener.stop();
    }
    this.listeners.clear();
    // Close all DB connections
    for (const db of this.dbs.values()) {
      closeDatabase(db);
    }
    this.dbs.clear();
    this.services.clear();
    this.scanners.clear();
  }
}

export const caseStatsRegistry = new CaseStatsRegistryImpl();
