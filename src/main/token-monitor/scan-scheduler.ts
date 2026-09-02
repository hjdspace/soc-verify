/**
 * Scan Scheduler — 外部日志定时 + 增量扫描调度器。
 *
 * 职责：
 * - 5 分钟定时扫描 claude-code / codex 的 JSONL 日志
 * - 增量扫描：通过 mtime + byte_offset 跳过未变化文件
 * - 文件截断检测：文件大小 < byte_offset 时重置
 * - 去重：解析的记录通过 recordUsage INSERT OR IGNORE
 * - 手动触发：scanOnce() 立即执行一次扫描
 */

import type { TokenMonitorDb } from './token-monitor-db';
import {
  recordUsage,
  getScanState,
  upsertScanState,
} from './token-monitor-db';
import {
  getAllScanDirs,
  discoverJsonlFiles,
  getFileStat,
} from './log-scanner-paths';
import { parseClaudeJsonlFile } from './claude-log-parser';
import { parseCodexJsonlFile } from './codex-log-parser';

// ─── Types ─────────────────────────────────────────────────

/** 扫描选项 */
export type ScanSchedulerOptions = {
  /** 扫描间隔（ms），默认 5 分钟 */
  intervalMs?: number;
};

/** 单次扫描结果 */
export type ScanResult = {
  /** 实际扫描的文件数（跳过的不算） */
  filesScanned: number;
  /** 跳过的文件数（mtime 未变） */
  filesSkipped: number;
  /** 成功插入的记录数 */
  recordsInserted: number;
  /** 扫描耗时（ms） */
  durationMs: number;
};

// ─── Scheduler ─────────────────────────────────────────────

/** 默认扫描间隔：5 分钟 */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 扫描调度器。
 *
 * 使用示例：
 * ```ts
 * const scheduler = new ScanScheduler(db);
 * scheduler.start();  // 启动定时扫描
 * // ...
 * await scheduler.scanOnce();  // 手动触发一次扫描
 * scheduler.stop();   // 停止定时扫描
 * ```
 */
export class ScanScheduler {
  private readonly db: TokenMonitorDb;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastScanAt: number | null = null;

  constructor(db: TokenMonitorDb, options: ScanSchedulerOptions = {}) {
    this.db = db;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  // ─── Public API ──────────────────────────────────────────

  /**
   * 启动定时扫描。
   * 立即执行一次扫描，然后按 intervalMs 间隔周期执行。
   */
  start(): void {
    if (this.timer) return; // 已在运行

    // 使用 setTimeout 链而非 setInterval 避免重叠执行
    this.scheduleNext();
  }

  /**
   * 停止定时扫描。
   */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * 是否在运行中。
   */
  isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * 获取当前扫描间隔（ms）。
   */
  getIntervalMs(): number {
    return this.intervalMs;
  }

  /**
   * 获取上次扫描时间（ms epoch），未扫描过返回 null。
   */
  getLastScanAt(): number | null {
    return this.lastScanAt;
  }

  /**
   * 执行一次完整扫描（所有目录、所有文件）。
   *
   * 内部 catch 保证不抛出异常（静默降级）。
   */
  async scanOnce(): Promise<ScanResult> {
    const startTime = Date.now();
    let filesScanned = 0;
    let filesSkipped = 0;
    let recordsInserted = 0;

    try {
      const scanDirs = getAllScanDirs();

      for (const { engine, dir } of scanDirs) {
        const files = discoverJsonlFiles(dir);

        for (const filePath of files) {
          try {
            const stat = getFileStat(filePath);
            if (!stat) continue;

            const prevState = getScanState(this.db, filePath);

            // 增量扫描判断：mtime 未变且文件未被截断 → 跳过
            if (
              prevState &&
              prevState.lastMtime === stat.mtimeMs &&
              prevState.byteOffset <= stat.size
            ) {
              filesSkipped++;
              continue;
            }

            // 文件截断检测：当前 byte_offset 超过文件大小 → 重置
            const byteOffset =
              prevState && prevState.byteOffset <= stat.size
                ? prevState.byteOffset
                : 0;

            // 解析文件
            const records =
              engine === 'claude-code'
                ? parseClaudeJsonlFile(filePath, byteOffset)
                : parseCodexJsonlFile(filePath, byteOffset);

            // 写入数据库（INSERT OR IGNORE 去重）
            let inserted = 0;
            for (const record of records) {
              const before = this.getTotalCount();
              recordUsage(this.db, record);
              const after = this.getTotalCount();
              if (after > before) inserted++;
            }
            recordsInserted += inserted;

            // 更新 scan_state
            upsertScanState(this.db, {
              filePath,
              lastMtime: stat.mtimeMs,
              byteOffset: stat.size,
              scannedAt: Date.now(),
            });

            filesScanned++;
          } catch {
            // 单个文件扫描失败不影响其他文件
          }
        }
      }
    } catch {
      // getAllScanDirs 失败等整体异常 → 静默降级
    }

    const durationMs = Date.now() - startTime;
    this.lastScanAt = Date.now();

    return { filesScanned, filesSkipped, recordsInserted, durationMs };
  }

  // ─── Private ─────────────────────────────────────────────

  /**
   * 调度下一次扫描。
   */
  private scheduleNext(): void {
    this.timer = setTimeout(async () => {
      await this.scanOnce();
      this.scheduleNext(); // 递归调度下一次
    }, this.intervalMs);
  }

  /**
   * 获取当前 token_usage 表的记录总数（用于判断实际插入数量）。
   */
  private getTotalCount(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as cnt FROM token_usage')
      .get() as { cnt: number };
    return row.cnt;
  }
}
