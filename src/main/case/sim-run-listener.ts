/**
 * Simulation Run Listener — 监听 SimulationManager 的 run:completed 事件，
 * 将每次 run 的完整信息写入 simulation_runs 表。
 *
 * 参考 docs/adr/0017-case-database-architecture.md → 决策 4
 * 参考 docs/prd/prd-case-database.md → 仿真历史持久化
 *
 * 设计要点：
 * - 写 DB 失败只记 warning 日志，不抛异常，不影响仿真流程
 * - Listener 在项目打开时注册（start），项目关闭时注销（stop）
 * - options_json 序列化仿真选项（corner, seed, base, block 等）
 * - start_time / end_time 使用 ISO 格式存储
 */

import type { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import type { CaseDatabase } from './db/case-database';
import type { SimulationRunRecord } from '../simulation/simulation-manager';
import type { SimulationRunRow } from './db/case-repository';
import { insertSimulationRun } from './db/case-repository';
import type { TerminalSimRun } from '../simulation/sim-terminal-linker';

/**
 * 将 SimulationRunRecord 转换为 SimulationRunRow（DB 行类型）。
 *
 * - epoch ms → ISO 字符串
 * - duration_ms = endTime - startTime
 * - corner / seed 从 options.options 中提取
 * - options_json = JSON.stringify(options.options ?? {})
 */
function toRunRow(record: SimulationRunRecord): SimulationRunRow {
  const startTime = new Date(record.startTime).toISOString();
  const endTime = record.endTime != null
    ? new Date(record.endTime).toISOString()
    : undefined;

  const durationMs = record.endTime != null
    ? record.endTime - record.startTime
    : undefined;

  const opts = record.options.options ?? {};
  const corner = typeof opts['corner'] === 'string' ? opts['corner'] as string : undefined;
  const seed = typeof opts['seed'] === 'string' ? opts['seed'] as string : undefined;

  return {
    runId: record.runId,
    caseName: record.options.caseName ?? record.options.caseId,
    subsys: record.options.subsys,
    status: record.status.status,
    startTime,
    endTime,
    durationMs,
    corner,
    seed,
    optionsJson: JSON.stringify(opts),
  };
}

function toTerminalRunRow(record: TerminalSimRun): SimulationRunRow {
  const startTime = new Date(record.startTime).toISOString();
  const endTime = record.endTime != null ? new Date(record.endTime).toISOString() : undefined;
  return {
    runId: record.runId,
    caseName: record.caseName ?? record.caseId,
    subsys: record.subsys,
    status: record.status,
    startTime,
    endTime,
    durationMs: record.endTime != null ? record.endTime - record.startTime : undefined,
    seed: typeof record.options.seed === 'string' ? record.options.seed : undefined,
    optionsJson: JSON.stringify(record.options),
  };
}

/**
 * 监听 SimulationManager 的 run:completed 事件，
 * 将仿真运行记录持久化到 simulation_runs 表。
 */
export class SimulationRunListener {
  private readonly simManager: EventEmitter;
  private readonly db: Database.Database;
  private boundHandler: ((record: SimulationRunRecord) => void) | null = null;
  private boundAborted: ((record: SimulationRunRecord) => void) | null = null;

  constructor(simManager: EventEmitter, db: CaseDatabase) {
    this.simManager = simManager;
    this.db = db;
  }

  /**
   * 开始监听 run:completed 事件。
   * 重复调用 start() 是安全的——会先 stop 旧监听器再创建新的。
   */
  start(): void {
    if (this.boundHandler) {
      this.stop();
    }

    this.boundHandler = (record: SimulationRunRecord) => {
      this.handleRunCompleted(record);
    };
    this.boundAborted = (record: SimulationRunRecord) => {
      this.handleRunCompleted(record);
    };

    this.simManager.on('run:completed', this.boundHandler);
    this.simManager.on('run:aborted', this.boundAborted);
  }

  /**
   * 停止监听，移除事件监听器。
   */
  stop(): void {
    if (this.boundHandler) {
      this.simManager.off('run:completed', this.boundHandler);
      this.boundHandler = null;
    }
    if (this.boundAborted) {
      this.simManager.off('run:aborted', this.boundAborted);
      this.boundAborted = null;
    }
  }

  /**
   * 处理 run:completed 事件：将记录写入 DB。
   * 写 DB 失败时只记 warning 日志，不抛异常。
   */
  private handleRunCompleted(record: SimulationRunRecord): void {
    try {
      const row = toRunRow(record);
      insertSimulationRun(this.db, row);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[sim-run-listener] Failed to persist simulation run to DB: ${msg}`,
      );
    }
  }
}

/** 持久化终端仿真完成/中止事件。 */
export class TerminalSimulationRunListener {
  private readonly simTerminalLinker: EventEmitter;
  private readonly db: Database.Database;
  private readonly projectId: string;
  private boundCompleted: ((record: TerminalSimRun) => void) | null = null;
  private boundAborted: ((record: TerminalSimRun) => void) | null = null;

  constructor(simTerminalLinker: EventEmitter, db: CaseDatabase, projectId: string) {
    this.simTerminalLinker = simTerminalLinker;
    this.db = db;
    this.projectId = projectId;
  }

  start(): void {
    this.stop();
    this.boundCompleted = (record) => this.persist(record);
    this.boundAborted = (record) => this.persist(record);
    this.simTerminalLinker.on('run:completed', this.boundCompleted);
    this.simTerminalLinker.on('run:aborted', this.boundAborted);
  }

  stop(): void {
    if (this.boundCompleted) this.simTerminalLinker.off('run:completed', this.boundCompleted);
    if (this.boundAborted) this.simTerminalLinker.off('run:aborted', this.boundAborted);
    this.boundCompleted = null;
    this.boundAborted = null;
  }

  private persist(record: TerminalSimRun): void {
    if (record.projectId !== this.projectId) return;
    try {
      insertSimulationRun(this.db, toTerminalRunRow(record));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[sim-run-listener] Failed to persist terminal simulation run to DB: ${msg}`);
    }
  }
}
