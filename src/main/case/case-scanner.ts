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
  clearAllSubsystems,
  type SubsysRow,
  type CaseRow,
} from './db/case-repository';

export type ScanResult = {
  subsysCount: number;
  caseCount: number;
};

export type ScanOptions = {
  /** sync=true 时，清除 DB 中旧的 subsystems 和 cases 后再写入新扫描结果。
   * 用于环境变量变更（PROJ_RTL/PROJ_ENV）或手动刷新后确保 DB 与最新扫描一致。
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
      if (sync) {
        // In sync mode, clear all old subsystems and cases before inserting
        // new scan results. This ensures subsystems that no longer exist
        // (e.g. after PROJ_RTL / PROJ_ENV change) are removed from the DB.
        // Cases must be deleted before subsystems due to FOREIGN KEY constraint.
        clearAllCases(this.db);
        clearAllSubsystems(this.db);
      }

      insertSubsystems(this.db, subsysRows);
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

}
