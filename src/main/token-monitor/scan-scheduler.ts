/**
 * Scan Scheduler — 外部日志定时 + 增量扫描调度器。
 *
 * 职责：
 * - 5 分钟定时扫描 claude-code / codex 的 JSONL 日志
 * - 增量扫描：通过 mtime + byte_offset 跳过未变化文件
 * - 文件截断检测：文件大小 < byte_offset 时重置
 * - 去重：解析的记录通过 recordUsage INSERT OR IGNORE
 * - 手动触发：scanOnce() 立即执行一次扫描
 *
 * 性能约束（GUI 卡顿修复）：
 * 扫描全程不允许长时间霸占事件循环 —— Electron 主进程同时承担所有
 * tRPC 查询 / IPC / 窗口管理，被同步扫描阻塞十几秒就是 Token 视图
 * 首开卡顿的根因。因此：
 * 1. 文件用 readline 流式读取（createReadStream({ start: offset }) 只读新字节）
 * 2. 每解析若干行 setImmediate 让出事件循环
 * 3. 每文件解析结果在单个事务中批量写入（见 recordUsageBatch）
 * 参考 ADR 0013（violation 解析的流式方案）。
 */

import type { TokenMonitorDb } from './token-monitor-db';
import {
  recordUsageBatch,
  getScanState,
  upsertScanState,
} from './token-monitor-db';
import {
  getAllScanDirs,
  discoverJsonlFilesAsync,
  getFileStat,
  lastCompleteLineOffset,
} from './log-scanner-paths';
import { parseClaudeJsonlFileStream } from './claude-log-parser';
import { parseCodexJsonlFileStream } from './codex-log-parser';

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

/** setImmediate 的 Promise 包装 */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

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
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastScanAt: number | null = null;
  /** 进行中的扫描 Promise（防重入：并发触发时复用同一次扫描） */
  private inflight: Promise<ScanResult> | null = null;

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
   * 异步流式实现：readline 逐行读取 + 事务批量写入 + 周期性让出事件循环，
   * 扫描期间主进程保持响应（tRPC/IPC 不冻结）。文件多、I/O 慢时总时长
   * 不变，但 GUI 不再卡顿。
   *
   * 防重入：扫描进行中再次调用返回同一个 Promise（手动刷新连点、
   * 定时扫描与视图打开自动扫描并发时，不会叠加多个全量扫描）。
   *
   * 内部 catch 保证不抛出异常（静默降级）。
   */
  scanOnce(): Promise<ScanResult> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doScan().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doScan(): Promise<ScanResult> {
    const startTime = Date.now();
    let filesScanned = 0;
    let filesSkipped = 0;
    let recordsInserted = 0;

    try {
      const scanDirs = getAllScanDirs();

      for (const { engine, dir } of scanDirs) {
        const files = await discoverJsonlFilesAsync(dir);
        await yieldToEventLoop();

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

            // 流式解析（只读 byteOffset 之后的新字节，行间让出事件循环）
            const records =
              engine === 'claude-code'
                ? await parseClaudeJsonlFileStream(filePath, byteOffset)
                : await parseCodexJsonlFileStream(filePath, byteOffset);

            // 单事务批量写入（INSERT OR IGNORE 去重，.changes 统计插入数）
            recordsInserted += recordUsageBatch(this.db, records);

            // 更新 scan_state —— 偏移推进到最后一个完整行边界（而非文件末尾）：
            // writer 追加写日志时，尾部无换行符的半行尚未写完，
            // 推进到末尾会让写完后的剩余字节永远落在偏移之前（记录丢失）
            const safeOffset = await lastCompleteLineOffset(filePath);

            upsertScanState(this.db, {
              filePath,
              lastMtime: stat.mtimeMs,
              byteOffset: safeOffset,
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
}
