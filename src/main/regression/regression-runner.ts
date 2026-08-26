/**
 * Regression Runner — executes `runsim -regr` and tracks regression history.
 *
 * See ADR 0020 for design rationale.
 *
 * Execution flow:
 *   1. Build runsim command from filePath + options
 *   2. Execute via terminalManager.runCommand() (stream output to terminal panel)
 *   3. Listen for terminal exit → update history record with status + exitCode
 *   4. Persist history to .socverify/regressions/regr_<timestamp>.json
 *   5. Sync to simulation_runs table (if CaseDatabase available) — enables
 *      Dashboard regression tab + AI Agent historical regression awareness
 */

import { writeFile, readFile, readdir, mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { terminalManager, findSimShell } from '../terminal/terminal-manager';
import type { RegressionRunOptions, RegressionHistoryEntry } from '@shared/types/regression';
import { buildRegrCommand } from '@shared/regression-command';
import type { CaseDatabase } from '../case/db/case-database';
import { insertSimulationRun, type SimulationRunRow } from '../case/db/case-repository';

const SOCVERIFY_DIR = '.socverify';
const REGRESSION_DIR = 'regressions';
const STDOUT_TAIL_LINES = 50;

// 命令构造为共享纯函数（预览与执行同一实现，ADR 0029），此处 re-export 保持既有导入路径
export { buildRegrCommand };

// ── Runner ────────────────────────────────────────────

/** Active regression runs keyed by runId. */
type ActiveRun = {
  runId: string;
  terminalId: string;
  filePath: string;
  subsys: string;
  command: string;
  options: RegressionRunOptions;
  submittedAt: number;
  projectRoot: string;
};

export class RegressionRunner {
  private projectRoot: string;
  private activeRuns = new Map<string, ActiveRun>();
  private exitListenerInstalled = false;
  private db: CaseDatabase | null;

  constructor(projectRoot: string, db?: CaseDatabase | null) {
    this.projectRoot = projectRoot;
    this.db = db ?? null;
    this.installExitListener();
  }

  /**
   * Submit a regression run via `runsim -regr`.
   *
   * @param filePath   Path to the regression file
   * @param subsys     Subsystem name (for history record)
   * @param options    Execution options
   * @param cwd        Working directory (optional, defaults to project root)
   * @returns          The runId and terminalId
   */
  async run(
    filePath: string,
    subsys: string,
    options: RegressionRunOptions,
    cwd?: string,
  ): Promise<{ runId: string; terminalId: string; command: string }> {
    const command = buildRegrCommand(filePath, options);
    const runId = `regr_${Date.now()}`;
    const workingDir = cwd ?? this.projectRoot;

    // Execute via terminal manager (log-mode or PTY)
    const simShell = findSimShell();
    const session = await terminalManager.runCommand({
      command,
      cwd: workingDir,
      shell: simShell,
    });

    const activeRun: ActiveRun = {
      runId,
      terminalId: session.id,
      filePath,
      subsys,
      command,
      options,
      submittedAt: Date.now(),
      projectRoot: this.projectRoot,
    };

    this.activeRuns.set(runId, activeRun);

    // Persist initial history record
    await this.saveHistory({
      runId,
      filePath,
      subsys,
      command,
      options,
      submittedAt: activeRun.submittedAt,
      status: 'running',
      exitCode: null,
      stdoutTail: '',
    });

    return { runId, terminalId: session.id, command };
  }

  /**
   * Abort an active regression run by killing the terminal session.
   */
  abort(runId: string): boolean {
    const run = this.activeRuns.get(runId);
    if (!run) return false;

    terminalManager.destroy(run.terminalId);
    // The exit listener will handle status update
    return true;
  }

  /**
   * Get all history entries for this project.
   */
  async getHistory(): Promise<RegressionHistoryEntry[]> {
    const dir = join(this.projectRoot, SOCVERIFY_DIR, REGRESSION_DIR);
    try {
      const files = await readdir(dir);
      const entries: RegressionHistoryEntry[] = [];
      for (const f of files.filter((f) => f.startsWith('regr_') && f.endsWith('.json'))) {
        try {
          const data = await readFile(join(dir, f), 'utf-8');
          entries.push(JSON.parse(data) as RegressionHistoryEntry);
        } catch {
          // Skip unreadable files
        }
      }
      return entries.sort((a, b) => b.submittedAt - a.submittedAt);
    } catch {
      return [];
    }
  }

  /**
   * Get a specific history entry by runId.
   */
  async getHistoryEntry(runId: string): Promise<RegressionHistoryEntry | null> {
    const dir = join(this.projectRoot, SOCVERIFY_DIR, REGRESSION_DIR);
    const filePath = join(dir, `${runId}.json`);
    try {
      const data = await readFile(filePath, 'utf-8');
      return JSON.parse(data) as RegressionHistoryEntry;
    } catch {
      return null;
    }
  }

  // ── Internal ────────────────────────────────────────

  /** Install a one-time listener on terminalManager for exit events. */
  private installExitListener(): void {
    if (this.exitListenerInstalled) return;
    this.exitListenerInstalled = true;

    terminalManager.on('exit', ({ id, exitCode }) => {
      // Find the active run associated with this terminal session
      for (const [runId, run] of this.activeRuns) {
        if (run.terminalId === id) {
          // Get stdout tail
          const output = terminalManager.getOutputContent(id);
          const lines = output.split(/\r?\n/);
          const tail = lines.slice(-STDOUT_TAIL_LINES).join('\n');

          const status: RegressionHistoryEntry['status'] =
            exitCode === 0 ? 'completed' : exitCode === null ? 'aborted' : 'failed';

          // Update history record
          void this.saveHistory({
            runId,
            filePath: run.filePath,
            subsys: run.subsys,
            command: run.command,
            options: run.options,
            submittedAt: run.submittedAt,
            status,
            exitCode,
            stdoutTail: tail,
          });

          this.activeRuns.delete(runId);
          break;
        }
      }
    });
  }

  /** Persist a history entry to JSON file + sync to simulation_runs table. */
  private async saveHistory(entry: RegressionHistoryEntry): Promise<void> {
    const dir = join(this.projectRoot, SOCVERIFY_DIR, REGRESSION_DIR);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${entry.runId}.json`);
    await writeFile(filePath, JSON.stringify(entry, null, 2), 'utf-8');

    // Sync to simulation_runs table (enables Dashboard + AI Agent awareness)
    this.syncToCaseDb(entry);
  }

  /**
   * 将回归历史条目写入 simulation_runs 表。
   * 写 DB 失败只记 warning 日志，不抛异常，不影响回归流程。
   *
   * status 映射：running→running, completed→pass, failed→fail, aborted→aborted
   * case_name 使用回归文件名（basename of filePath）。
   */
  private syncToCaseDb(entry: RegressionHistoryEntry): void {
    if (!this.db) return;

    try {
      const statusMap: Record<RegressionHistoryEntry['status'], string> = {
        running: 'running',
        completed: 'pass',
        failed: 'fail',
        aborted: 'aborted',
      };

      const startTime = new Date(entry.submittedAt).toISOString();
      const endTime = entry.status !== 'running'
        ? new Date(entry.submittedAt).toISOString()
        : undefined;

      const row: SimulationRunRow = {
        caseName: basename(entry.filePath),
        subsys: entry.subsys,
        status: statusMap[entry.status],
        startTime,
        endTime,
        corner: undefined,
        seed: undefined,
        optionsJson: JSON.stringify(entry.options),
      };

      insertSimulationRun(this.db, row);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[regression-runner] Failed to sync to simulation_runs: ${msg}`);
    }
  }
}
