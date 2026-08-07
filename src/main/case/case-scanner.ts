/**
 * Case Scanner — 调用 SubsysDiscoveryPlugin + CaseParserPlugin 全量扫描并写入 DB
 *
 * 参考 docs/adr/0017-case-database-architecture.md → 决策 2/3
 * 参考 docs/prd-case-database.md → Case Scanner
 *
 * 项目打开时后台调用插件全量扫描，结果写入 DB。
 * 用户点「刷新」按钮时重新调用插件扫描并更新 DB。
 */

import type Database from 'better-sqlite3';
import type { PluginRegistry } from '@shared/plugin-types';
import {
  insertSubsystems,
  insertCases,
  getSubsystems,
  setScanMetadata,
  clearAllCases,
  type SubsysRow,
  type CaseRow,
} from './db/case-repository';

export type ScanResult = {
  subsysCount: number;
  caseCount: number;
};

export type ScanOptions = {
  /** sync=true 时，清除 DB 中不再存在的 cases（stale removal）。
   * sync=false（默认），只插入/更新，不删除旧数据。 */
  sync?: boolean;
};

export class CaseScanner {
  private projectRoot: string;
  private registry: PluginRegistry;
  private db: Database.Database;

  constructor(projectRoot: string, registry: PluginRegistry, db: Database.Database) {
    this.projectRoot = projectRoot;
    this.registry = registry;
    this.db = db;
  }

  /**
   * 执行全量扫描：调用 SubsysDiscoveryPlugin 发现子系统，
   * 调用 CaseParserPlugin 解析每个子系统的用例，
   * 结果通过 transaction + INSERT OR REPLACE 写入 DB。
   *
   * @returns { subsysCount, caseCount } 扫描结果统计
   */
  async fullScan(opts?: ScanOptions): Promise<ScanResult> {
    const sync = opts?.sync ?? false;
    setScanMetadata(this.db, 'scanStatus', 'scanning');

    const subsysPlugin = this.registry.subsysDiscoverers[0];
    const casePlugin = this.registry.caseParsers[0];

    if (!subsysPlugin || !casePlugin) {
      setScanMetadata(this.db, 'scanStatus', 'complete');
      setScanMetadata(this.db, 'lastScanTime', new Date().toISOString());
      return { subsysCount: 0, caseCount: 0 };
    }

    // 1. 发现子系统
    const pluginSubsys = await subsysPlugin.discover(this.projectRoot);

    // 2. 并行解析每个子系统的用例
    const casesPerSubsys = await Promise.all(
      pluginSubsys.map(async (s) => ({
        subsys: s,
        cases: await casePlugin.parse(this.projectRoot, s.name),
      })),
    );

    // 3. 写入 DB（transaction + INSERT OR REPLACE）
    const subsysRows: SubsysRow[] = pluginSubsys.map((s) => ({
      name: s.name,
      path: s.path,
    }));

    const caseRows: CaseRow[] = [];
    for (const { subsys, cases } of casesPerSubsys) {
      for (const c of cases) {
        caseRows.push({
          name: c.name,
          subsys: subsys.name,
          path: c.path,
          filePath: c.filePath,
          baseCase: c.baseCase,
          base: c.base,
          block: c.block,
          phase: c.phase,
        });
      }
    }

    // Use transaction for atomic write
    const tx = this.db.transaction(() => {
      insertSubsystems(this.db, subsysRows);

      if (sync) {
        // In sync mode, clear stale cases not in current scan
        this.removeStaleCases(caseRows);
      }

      insertCases(this.db, caseRows);
    });
    tx();

    // 4. Record scan metadata
    setScanMetadata(this.db, 'scanStatus', 'complete');
    setScanMetadata(this.db, 'lastScanTime', new Date().toISOString());

    return {
      subsysCount: pluginSubsys.length,
      caseCount: caseRows.length,
    };
  }

  /**
   * 检查 DB 是否已有扫描数据。
   * 用于项目打开时判断是否可以秒开（有数据）还是需要全量扫描（无数据）。
   */
  hasExistingData(): boolean {
    const subsys = getSubsystems(this.db);
    return subsys.length > 0;
  }

  /**
   * 清除扫描数据（subsystems + cases），保留 simulation_runs。
   * 用于完全重新开始扫描。
   */
  clearScanData(): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM cases').run();
      this.db.prepare('DELETE FROM subsystems').run();
      this.db.prepare('DELETE FROM scan_metadata').run();
    });
    tx();
  }

  /**
   * 移除不再存在于当前扫描结果中的 stale cases。
   * 仅在 sync 模式下调用。
   */
  private removeStaleCases(currentCases: CaseRow[]): void {
    if (currentCases.length === 0) {
      clearAllCases(this.db);
      return;
    }

    // Build a set of (name, subsys) pairs from current scan
    const currentKeys = new Set(
      currentCases.map((c) => `${c.name}||${c.subsys}`),
    );

    // Get all existing cases from DB
    const existingCases = this.db.prepare(
      'SELECT name, subsys FROM cases',
    ).all() as { name: string; subsys: string }[];

    // Delete cases not in current scan
    const staleKeys = existingCases
      .filter((c) => !currentKeys.has(`${c.name}||${c.subsys}`))
      .map((c) => `(${c.name}, ${c.subsys})`);

    if (staleKeys.length > 0) {
      // Simple approach: delete all cases and re-insert
      // (more efficient than row-by-row deletion for large datasets)
      clearAllCases(this.db);
    }
  }
}
