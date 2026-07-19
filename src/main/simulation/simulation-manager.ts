import { EventEmitter } from 'node:events';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SimulationRunOptions, SimulationRunHandle, SimulationRunStatus, CompileError } from '@shared/plugin-types';
import type { SimulationHistoryEntry, SimulationStatus } from '@shared/types';
import type { PluginBackedSimulation } from '../host/plugin-discovery';

const SOCVERIFY_DIR = '.socverify';
const SIM_HISTORY_FILE = 'sim-history.json';
const MAX_HISTORY_ENTRIES = 200;
const POLL_INTERVAL_MS = 2000;

/**
 * Opaque handle returned by a PollerFactory. The only operation is `stop()`,
 * which cancels the recurring callback. This abstraction lets tests drive
 * polling synchronously instead of waiting for real `setInterval` ticks.
 */
export type PollerHandle = { stop: () => void };

/**
 * Factory that schedules `callback` to run every `intervalMs` milliseconds.
 *
 * The default implementation wraps `setInterval`; tests can inject a fake
 * that fires callbacks on demand.
 */
export type PollerFactory = (callback: () => void, intervalMs: number) => PollerHandle;

const defaultPollerFactory: PollerFactory = (callback, intervalMs) => {
  const timer = setInterval(callback, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
};

export interface SimulationRunRecord {
  runId: string;
  projectId: string;
  options: SimulationRunOptions;
  status: SimulationRunStatus;
  startTime: number;
  endTime?: number;
  compileErrors?: CompileError[];
}

export interface SimulationManagerOptions {
  projectRoot: string;
  projectId: string;
  simulationAdapter: PluginBackedSimulation;
  /** Optional override for the polling mechanism (defaults to setInterval). */
  pollerFactory?: PollerFactory;
}

/**
 * Manages simulation runs for a single project.
 * Tracks active runs, polls status, records history, and emits events.
 */
export class SimulationManager extends EventEmitter {
  private projectRoot: string;
  private projectId: string;
  private adapter: PluginBackedSimulation;
  private activeRuns = new Map<string, SimulationRunRecord>();
  private pollTimers = new Map<string, PollerHandle>();
  private history: SimulationHistoryEntry[] = [];
  private readonly pollerFactory: PollerFactory;

  constructor(opts: SimulationManagerOptions) {
    super();
    this.projectRoot = opts.projectRoot;
    this.projectId = opts.projectId;
    this.adapter = opts.simulationAdapter;
    this.pollerFactory = opts.pollerFactory ?? defaultPollerFactory;
  }

  async run(opts: SimulationRunOptions): Promise<SimulationRunHandle> {
    if (!this.adapter.hasRunner()) {
      throw new Error('No simulation-runner plugin loaded');
    }

    const handle = await this.adapter.run(opts);
    const record: SimulationRunRecord = {
      runId: handle.runId,
      projectId: this.projectId,
      options: opts,
      status: { runId: handle.runId, status: 'pending', startTime: Date.now() },
      startTime: Date.now(),
    };

    this.activeRuns.set(handle.runId, record);
    this.emit('run:started', record);
    this.startPolling(handle.runId);

    return handle;
  }

  async getStatus(runId: string): Promise<SimulationRunStatus> {
    if (!this.adapter.hasRunner()) {
      throw new Error('No simulation-runner plugin loaded');
    }
    return this.adapter.getStatus(runId);
  }

  async getCompileErrors(runId: string): Promise<CompileError[]> {
    if (!this.adapter.hasRunner()) {
      throw new Error('No simulation-runner plugin loaded');
    }
    return this.adapter.getCompileErrors(runId);
  }

  async abort(runId: string): Promise<void> {
    if (!this.adapter.hasRunner()) {
      throw new Error('No simulation-runner plugin loaded');
    }
    await this.adapter.abort(runId);
    const record = this.activeRuns.get(runId);
    if (record) {
      record.status = { ...record.status, status: 'aborted', endTime: Date.now() };
      record.endTime = Date.now();
      this.emit('run:aborted', record);
      this.finalizeRun(runId);
    }
  }

  getActiveRuns(): SimulationRunRecord[] {
    return Array.from(this.activeRuns.values());
  }

  getRun(runId: string): SimulationRunRecord | null {
    return this.activeRuns.get(runId) ?? null;
  }

  hasRunner(): boolean {
    return this.adapter.hasRunner();
  }

  // ─── Status polling ──────────────────────────────────

  private startPolling(runId: string): void {
    const handle = this.pollerFactory(() => {
      void this.pollStatus(runId);
    }, POLL_INTERVAL_MS);
    this.pollTimers.set(runId, handle);
  }

  private async pollStatus(runId: string): Promise<void> {
    const record = this.activeRuns.get(runId);
    if (!record) return;

    try {
      const status = await this.adapter.getStatus(runId);
      const prevStatus = record.status.status;
      record.status = status;

      if (status.status !== prevStatus) {
        this.emit('run:statusChanged', record);
      }

      // Check if simulation has completed (terminal states)
      if (status.status === 'pass' || status.status === 'fail' || status.status === 'error') {
        record.status = { ...status, endTime: status.endTime ?? Date.now() };
        record.endTime = record.status.endTime;

        // Try to fetch compile errors for failed runs
        if (status.status === 'fail' || status.status === 'error') {
          try {
            record.compileErrors = await this.adapter.getCompileErrors(runId);
          } catch {
            // best-effort
          }
        }

        this.emit('run:completed', record);
        this.finalizeRun(runId);
      }
    } catch {
      // Polling error — keep trying
    }
  }

  private finalizeRun(runId: string): void {
    const handle = this.pollTimers.get(runId);
    if (handle) {
      handle.stop();
      this.pollTimers.delete(runId);
    }

    const record = this.activeRuns.get(runId);
    if (record) {
      this.recordHistory(record);
      this.activeRuns.delete(runId);
    }
  }

  // ─── History ─────────────────────────────────────────

  private async recordHistory(record: SimulationRunRecord): Promise<void> {
    const entry: SimulationHistoryEntry = {
      runId: record.runId,
      caseId: record.options.caseId,
      caseName: record.options.caseName ?? record.options.caseId,
      subsys: record.options.subsys,
      options: record.options.options ?? {},
      status: record.status.status as SimulationStatus,
      startTime: record.startTime,
      endTime: record.endTime ?? Date.now(),
      duration: (record.endTime ?? Date.now()) - record.startTime,
      compileErrors: record.compileErrors,
    };

    this.history.unshift(entry);
    if (this.history.length > MAX_HISTORY_ENTRIES) {
      this.history = this.history.slice(0, MAX_HISTORY_ENTRIES);
    }

    await this.saveHistory();
  }

  getHistory(): SimulationHistoryEntry[] {
    return this.history;
  }

  getRunDetail(runId: string): SimulationHistoryEntry | null {
    return this.history.find((h) => h.runId === runId) ?? null;
  }

  compareRuns(runIdA: string, runIdB: string): {
    runA: SimulationHistoryEntry | null;
    runB: SimulationHistoryEntry | null;
    differences: Array<{ field: string; valueA: unknown; valueB: unknown }>;
  } {
    const runA = this.getRunDetail(runIdA);
    const runB = this.getRunDetail(runIdB);
    const differences: Array<{ field: string; valueA: unknown; valueB: unknown }> = [];

    if (runA && runB) {
      if (runA.status !== runB.status) {
        differences.push({ field: 'status', valueA: runA.status, valueB: runB.status });
      }
      if (runA.duration !== runB.duration) {
        differences.push({ field: 'duration', valueA: runA.duration, valueB: runB.duration });
      }
      const optsA = JSON.stringify(runA.options);
      const optsB = JSON.stringify(runB.options);
      if (optsA !== optsB) {
        differences.push({ field: 'options', valueA: runA.options, valueB: runB.options });
      }
    }

    return { runA, runB, differences };
  }

  async loadHistory(): Promise<void> {
    const historyPath = join(this.projectRoot, SOCVERIFY_DIR, SIM_HISTORY_FILE);
    try {
      const content = await readFile(historyPath, 'utf-8');
      this.history = JSON.parse(content) as SimulationHistoryEntry[];
    } catch {
      this.history = [];
    }
  }

  async saveHistory(): Promise<void> {
    const dir = join(this.projectRoot, SOCVERIFY_DIR);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    const historyPath = join(dir, SIM_HISTORY_FILE);
    await writeFile(historyPath, JSON.stringify(this.history, null, 2), 'utf-8');
  }

  destroy(): void {
    for (const [, handle] of this.pollTimers) {
      handle.stop();
    }
    this.pollTimers.clear();
    this.activeRuns.clear();
  }
}
