/**
 * Case Scanner — 调用 SubsysDiscoveryPlugin + CaseParserPlugin 全量扫描并写入 DB
 *
 * 参考 docs/adr/0017-case-database-architecture.md → 决策 2/3
 * 参考 docs/prd/prd-case-database.md → Case Scanner
 *
 * 项目打开时后台调用插件全量扫描，结果写入 DB。
 * 用户点「刷新」按钮时重新调用插件扫描并更新 DB。
 * RTL 目录变更时通过 fs.watch 自动触发增量扫描。
 */

import type Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { watch, type FSWatcher } from 'node:fs';
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

/** fs.watch debounce 时间（ms），避免短时间内多次触发扫描 */
const WATCH_DEBOUNCE_MS = 1000;

/** 判断当前平台是否支持原生递归 watch */
function supportsRecursiveWatch(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

export class CaseScanner {
  private projectRoot: string;
  private registry: PluginRegistry;
  private db: Database.Database;
  private watcher: FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private watchActive = false;

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

  // ── fs.watch 文件监控 ────────────────────────────────

  /**
   * 开始监听 RTL 目录变更，自动触发增量扫描。
   *
   * 设计要点：
   * - 使用 fs.watch recursive 模式（Win/macOS 原生支持）
   * - debounce 1000ms，避免连续文件变更触发频繁扫描
   * - 过滤 .socverify / .git 目录变更
   * - 监听失败不抛异常，降级为手动刷新（console.warn）
   * - 重复调用安全：先 stop 再 start
   *
   * @param rtlDir  $PROJ_RTL 目录绝对路径
   */
  startWatch(rtlDir: string): void {
    // 先停止旧监听
    this.stopWatch();

    if (!existsSync(rtlDir)) {
      console.warn(`[case-scanner] Cannot watch: directory does not exist: ${rtlDir}`);
      return;
    }

    const recursive = supportsRecursiveWatch(process.platform);

    try {
      this.watcher = watch(
        rtlDir,
        { recursive, persistent: false },
        (_eventType, filename) => {
          if (!filename) return;
          // 过滤应用内部目录变更
          if (filename.includes('.socverify') || filename.includes('.git')) return;
          this.scheduleDebouncedScan();
        },
      );

      this.watcher.on('error', (err) => {
        console.warn(`[case-scanner] fs.watch error for ${rtlDir}:`, err);
      });

      this.watchActive = true;
      console.log(`[case-scanner] Started watching ${rtlDir} (recursive=${recursive})`);
    } catch (err) {
      console.warn(`[case-scanner] fs.watch failed for ${rtlDir}:`, err);
      this.watcher = null;
      this.watchActive = false;
    }
  }

  /**
   * 停止文件监控。
   */
  stopWatch(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.watchActive = false;
  }

  /** watch 是否处于活跃状态 */
  get isWatching(): boolean {
    return this.watchActive;
  }

  /**
   * debounce 后触发增量扫描。
   * 多次文件变更只在最后一次变更后 1s 触发一次扫描。
   */
  private scheduleDebouncedScan(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      // 增量扫描（sync=false），只更新不删除
      void this.fullScan().catch((err) => {
        console.warn('[case-scanner] Incremental scan failed:', err);
      });
    }, WATCH_DEBOUNCE_MS);
  }
}
