/**
 * NotificationManager — 全局通知中心的主进程实现。
 *
 * 职责：
 *   1. 通知 CRUD 与持久化：`userData/socverify-data/notifications.json`
 *      （与项目状态 state_*.json 同级，JSON 而非 SQLite——单用户桌面应用，
 *      通知量 ≤ 上限条，JSON 足够且零 schema 迁移成本）
 *   2. 事件源接线（wireNotificationSources）：订阅仿真失败 / 回归终态 /
 *      覆盖率导入完成三类已有主进程事件，转换为通知入库
 *   3. 任意变更后经 notification:event IPC 通道（webContents.send + preload
 *      eventBridge——tRPC subscription 不可用的硬约束）向所有窗口全量同步
 *
 * 主进程改动边界：仅事件补发与通知持久化，不触碰 omp。
 */

import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import type { AppNotification, NotificationType } from '@shared/types';
import { simulationRegistry } from '../simulation/simulation-registry';
import { simTerminalLinker } from '../simulation/sim-terminal-linker';
import { regressionRunTracker } from '../regression/regression-run-tracker';

const NOTIFICATIONS_FILE = 'notifications.json';
/** 持久化上限（超出丢弃最旧已读，再不足丢最旧） */
const MAX_NOTIFICATIONS = 100;

type NotificationInput = {
  type: NotificationType;
  title: string;
  detail?: string;
};

class NotificationManagerImpl {
  private notifications: AppNotification[] = [];
  private loaded = false;
  /** 写盘串行链：并发 add/markRead 交错 writeFile 可能落盘陈旧列表 */
  private persistChain: Promise<void> = Promise.resolve();

  private get dataDir(): string {
    return join(app.getPath('userData'), 'socverify-data');
  }

  private get filePath(): string {
    return join(this.dataDir, NOTIFICATIONS_FILE);
  }

  /** 启动时加载持久化通知（main/index.ts whenReady 调用）。 */
  async init(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const content = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(content) as AppNotification[];
      if (Array.isArray(parsed)) this.notifications = parsed;
    } catch {
      // 首次启动或文件损坏：从空列表开始
    }
  }

  list(): AppNotification[] {
    return this.notifications;
  }

  async add(input: NotificationInput): Promise<AppNotification> {
    const notification: AppNotification = {
      id: randomUUID(),
      type: input.type,
      title: input.title,
      detail: input.detail,
      createdAt: Date.now(),
      read: false,
    };
    // 新通知在前，超出上限丢最旧
    this.notifications = [notification, ...this.notifications].slice(0, MAX_NOTIFICATIONS);
    await this.persistAndSync();
    return notification;
  }

  async markRead(id: string): Promise<void> {
    const target = this.notifications.find((n) => n.id === id);
    if (!target || target.read) return;
    target.read = true;
    await this.persistAndSync();
  }

  async markAllRead(): Promise<void> {
    if (!this.notifications.some((n) => !n.read)) return;
    this.notifications = this.notifications.map((n) => ({ ...n, read: true }));
    await this.persistAndSync();
  }

  private async persistAndSync(): Promise<void> {
    // 广播立即发出（渲染端尽快看到变更），写盘串行排队（后写覆盖先写，最终一致）
    this.broadcast();
    const task = this.persistChain.then(async () => {
      try {
        await mkdir(this.dataDir, { recursive: true });
        await writeFile(this.filePath, JSON.stringify(this.notifications, null, 2), 'utf-8');
      } catch (err) {
        console.warn(`[notification] persist failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    this.persistChain = task;
    await task;
  }

  /** notification:event → 所有 BrowserWindow 全量同步（渲染端整体替换，幂等）。 */
  private broadcast(): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('notification:event', {
          type: 'sync',
          notifications: this.notifications,
        });
      }
    }
  }
}

export const notificationManager = new NotificationManagerImpl();

// ── 事件源接线 ────────────────────────────────────────────

/** 通知标题里的短 runId（与回归终端 Tab 标题「回归 xxxxxx」一致） */
function shortRunId(runId: string): string {
  return runId.slice(-6);
}

/**
 * 订阅三类已有主进程事件并转换为通知：
 *   - 仿真失败（插件通道 simulationRegistry + 终端通道 simTerminalLinker）
 *   - 回归终态（regressionRunTracker：failed → 失败，completed → 任务完成）
 *   - 覆盖率导入完成的补发在 coverage-router import 成功路径直接调用 add()
 *
 * aborted 不产生通知（用户主动中止，非异常事件）。
 */
export function wireNotificationSources(): void {
  // 插件通道仿真失败（SimulationManager 轮询驱动）
  simulationRegistry.on('run:completed', (record: {
    runId: string;
    status: string;
    options?: { caseName?: string; caseId?: string; subsys?: string };
  }) => {
    if (record.status !== 'fail' && record.status !== 'error') return;
    void notificationManager.add({
      type: 'failure',
      title: `仿真失败 · ${record.options?.caseName ?? record.options?.caseId ?? record.runId}`,
      detail: record.options?.subsys ? `${record.options.subsys} 子系统` : undefined,
    });
  });

  // 终端通道仿真失败（runsim -regr 之外的 runInTerminal 单用例）
  simTerminalLinker.on('run:completed', (run: {
    runId: string;
    status: string;
    caseName?: string;
    caseId: string;
    subsys: string;
  }) => {
    if (run.status !== 'fail' && run.status !== 'error') return;
    void notificationManager.add({
      type: 'failure',
      title: `仿真失败 · ${run.caseName ?? run.caseId}`,
      detail: `${run.subsys} 子系统`,
    });
  });

  // 回归终态
  regressionRunTracker.on('run:finished', (
    run: { runId: string; subsys: string },
    status: 'completed' | 'failed' | 'aborted',
  ) => {
    if (status === 'aborted') return;
    if (status === 'failed') {
      void notificationManager.add({
        type: 'failure',
        title: `回归失败 · #${shortRunId(run.runId)}`,
        detail: `${run.subsys} 子系统`,
      });
      return;
    }
    void notificationManager.add({
      type: 'success',
      title: `回归完成 · #${shortRunId(run.runId)}`,
      detail: `${run.subsys} 子系统`,
    });
  });
}
