/**
 * RegressionRunTracker — 运行中回归的单例跟踪器（TitleBar 回归徽章数据源）。
 *
 * 背景：RegressionRunner 由 regression-router 按请求实例化（run/abort/getHistory
 * 各建一个实例），activeRuns 状态分散在临时实例里，跨请求不可见——徽章与通知
 * 需要一个进程级单例。本模块不改 RegressionRunner 的历史持久化行为，只做旁路
 * 跟踪（模式参照 simTerminalLinker）：
 *
 *   1. regression-router.run 提交后调用 track() 登记 terminalId ↔ runId
 *   2. 监听 terminalManager 'data' 事件，从 runsim -regr 输出解析 x/y 进度
 *   3. 监听 terminalManager 'exit' 事件，映射终态（0→completed、null→aborted、
 *      其余→failed）并移除运行
 *   4. 每次状态变化经 regression:event IPC 通道（webContents.send）推送到渲染进程
 *
 * 进度解析是尽力而为：解析不到时 completed/total 缺省，徽章降级为「运行中」
 * 不显示 x/y（与 SimulationView 的占位降级同一原则，不伪造数据）。
 */

import { EventEmitter } from 'node:events';
import { BrowserWindow } from 'electron';
import { terminalManager } from '../terminal/terminal-manager';
import type {
  ActiveRegressionRun,
  RegressionEvent,
  RegressionRunFinalStatus,
} from '@shared/types/regression';

/** 进度文本解析上限（单次 data 事件扫描的字符数） */
const SCAN_MAX_CHARS = 2000;
/** 总数合理上限，过滤误匹配（如日期 2026/08、比例 3/4 视为噪声的概率场景） */
const TOTAL_MAX = 100_000;

/**
 * 从一段回归输出文本解析 `已完成/总数` 进度。
 *
 * 匹配 runsim -regr 及常见回归工具的输出形态（取最后一次匹配，进度单调递增）：
 *   - `[312/480]`、`312/480`、`(312/480)`
 *   - `312 of 480 cases` / `case 312 of 480`
 *   - `已完成 312/480`
 *
 * 约束：0 ≤ completed ≤ total ≤ TOTAL_MAX；日期（2026/08/22）、时间（10/24）等
 * 噪声通过上下文关键词或数值范围约束排除（见各 pattern）。
 *
 * @returns `{ completed, total }` 或 null（未解析到）
 */
export function parseRegressionProgress(text: string): { completed: number; total: number } | null {
  if (!text) return null;
  // 只扫尾部，早期编译输出中偶发的 x/y 不代表当前进度
  const chunk = text.length > SCAN_MAX_CHARS ? text.slice(-SCAN_MAX_CHARS) : text;

  // 按可靠性排序：带上下文关键词的优先，仅带包裹符的裸 x/y 兜底。
  // 同一 pattern 取最后一次匹配（进度单调递增）；首个有有效匹配的 pattern 生效。
  const patterns: RegExp[] = [
    /(\d{1,5})\s*\/\s*(\d{1,5})\s*(?:cases?|tests?|用例)/i,
    /(?:cases?|tests?|用例)[^\d\n]{0,12}(\d{1,5})\s*\/\s*(\d{1,5})/i,
    /(\d{1,5})\s+of\s+(\d{1,5})\s+(?:cases?|tests?)/i,
    /(?:已完成|passed|done)\s*[:(\s]?(\d{1,5})\s*\/\s*(\d{1,5})/i,
    /[[(](\d{1,5})\s*\/\s*(\d{1,5})[\])]/,
  ];
  for (const re of patterns) {
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    const matches = [...chunk.matchAll(global)];
    for (let i = matches.length - 1; i >= 0; i--) {
      const completed = Number(matches[i][1]);
      const total = Number(matches[i][2]);
      if (isValidProgress(completed, total)) return { completed, total };
    }
  }
  // 无上下文形态的裸 x/y 不接受，避免把日期 2026/08 之类误判为进度。
  return null;
}

function isValidProgress(completed: number, total: number): boolean {
  return (
    Number.isInteger(completed) && Number.isInteger(total) &&
    completed >= 0 && total > 0 && completed <= total && total <= TOTAL_MAX
  );
}

/** 运行登记信息（含 terminal 关联，不外发给渲染进程） */
type TrackedRun = ActiveRegressionRun & {
  terminalId: string;
  projectId: string;
};

class RegressionRunTrackerImpl extends EventEmitter {
  private runs = new Map<string, TrackedRun>(); // runId → run
  private terminalToRun = new Map<string, string>(); // terminalId → runId
  private listenersInstalled = false;

  /** 登记一次回归提交（regression-router.run 调用）。 */
  track(run: {
    runId: string;
    terminalId: string;
    projectId: string;
    subsys: string;
    filePath: string;
  }): void {
    this.installListeners();
    const tracked: TrackedRun = {
      runId: run.runId,
      subsys: run.subsys,
      filePath: run.filePath,
      submittedAt: Date.now(),
      terminalId: run.terminalId,
      projectId: run.projectId,
    };
    this.runs.set(run.runId, tracked);
    this.terminalToRun.set(run.terminalId, run.runId);
    this.emit('run:started', tracked);
    this.broadcast({ type: 'started', run: toActiveRun(tracked) });
  }

  /** 当前运行中的回归（渲染进程 getActiveRuns 查询 / 徽章数据）。 */
  getActive(projectId?: string): ActiveRegressionRun[] {
    const all = [...this.runs.values()];
    const scoped = projectId ? all.filter((r) => r.projectId === projectId) : all;
    return scoped.map(toActiveRun).sort((a, b) => a.submittedAt - b.submittedAt);
  }

  /** 中止运行中的回归：销毁终端会话，终态由 exit 监听统一判定。 */
  abort(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    terminalManager.destroy(run.terminalId);
    return true;
  }

  // ── 终端事件监听 ────────────────────────────────────────

  private installListeners(): void {
    if (this.listenersInstalled) return;
    this.listenersInstalled = true;

    terminalManager.on('data', ({ id, data }) => {
      this.handleTerminalData(id, data);
    });
    terminalManager.on('exit', ({ id, exitCode }) => {
      this.handleTerminalExit(id, exitCode);
    });
  }

  private handleTerminalData(terminalId: string, data: string): void {
    const runId = this.terminalToRun.get(terminalId);
    if (!runId) return;
    const run = this.runs.get(runId);
    if (!run) return;

    const progress = parseRegressionProgress(data);
    if (!progress) return;
    // 进度单调递增；total 漂移（罕见）取最新值
    if (run.completed !== undefined && progress.completed < run.completed) return;
    if (run.completed === progress.completed && run.total === progress.total) return;

    run.completed = progress.completed;
    run.total = progress.total;
    this.emit('run:progress', run);
    this.broadcast({ type: 'progress', run: toActiveRun(run) });
  }

  private handleTerminalExit(terminalId: string, exitCode: number | null): void {
    const runId = this.terminalToRun.get(terminalId);
    if (!runId) return;
    const run = this.runs.get(runId);
    if (!run) return;

    const status: RegressionRunFinalStatus =
      exitCode === 0 ? 'completed' : exitCode === null ? 'aborted' : 'failed';

    this.runs.delete(runId);
    this.terminalToRun.delete(terminalId);
    this.emit('run:finished', run, status);
    this.broadcast({ type: 'finished', run: toActiveRun(run), status });
  }

  /** regression:event → 所有 BrowserWindow（与 coverage-router 同模式）。 */
  private broadcast(event: RegressionEvent): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('regression:event', event);
      }
    }
  }
}

/** 剥离 terminalId/projectId 等主进程内部字段 */
function toActiveRun(run: TrackedRun): ActiveRegressionRun {
  return {
    runId: run.runId,
    subsys: run.subsys,
    filePath: run.filePath,
    submittedAt: run.submittedAt,
    completed: run.completed,
    total: run.total,
  };
}

export const regressionRunTracker = new RegressionRunTrackerImpl();
