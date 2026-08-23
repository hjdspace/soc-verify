/**
 * NotificationManager 测试（Issue #8）：
 *   - 持久化往返（add / markRead / markAllRead → notifications.json → 重启重载）
 *   - 上限裁剪（100 条，新增丢弃最旧）
 *   - notification:event 全量同步广播
 *   - wireNotificationSources 事件源接线（仿真失败 / 回归终态；aborted 不产生通知）
 *
 * 单例 + `loaded` 幂等保护 → 每个用例 vi.resetModules() 后重新导入取新实例，
 * app.getPath 指向用例级临时目录。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppNotification } from '@shared/types';

// ── 共享 mock 状态（vi.hoisted：mock factory 在模块加载前求值；
//    EventEmitter import 绑定在 hoisted 阶段不可用，用自实现的 FakeEmitter）────
const state = vi.hoisted(() => {
  class FakeEmitter {
    private map = new Map<string, Array<(...args: unknown[]) => void>>();
    on(event: string, cb: (...args: unknown[]) => void): this {
      const arr = this.map.get(event) ?? [];
      arr.push(cb);
      this.map.set(event, arr);
      return this;
    }
    emit(event: string, ...args: unknown[]): boolean {
      for (const cb of this.map.get(event) ?? []) cb(...args);
      return true;
    }
    removeAllListeners(event?: string): this {
      if (event) this.map.delete(event);
      else this.map.clear();
      return this;
    }
  }
  return {
    dataDir: '',
    sent: [] as { channel: string; payload: unknown }[],
    simulationRegistry: new FakeEmitter(),
    simTerminalLinker: new FakeEmitter(),
    regressionRunTracker: new FakeEmitter(),
  };
});

vi.mock('electron', () => ({
  app: { getPath: () => state.dataDir },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: (channel: string, payload: unknown) => { state.sent.push({ channel, payload }); } } },
    ],
  },
}));

vi.mock('../../src/main/simulation/simulation-registry', () => ({
  simulationRegistry: state.simulationRegistry,
}));

vi.mock('../../src/main/simulation/sim-terminal-linker', () => ({
  simTerminalLinker: state.simTerminalLinker,
}));

vi.mock('../../src/main/regression/regression-run-tracker', () => ({
  regressionRunTracker: state.regressionRunTracker,
}));

type NotificationManagerModule = typeof import('../../src/main/notifications/notification-manager');

let mod: NotificationManagerModule;
let tempDir: string;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'notif-test-'));
  state.dataDir = tempDir;
  state.sent.length = 0;
  state.simulationRegistry.removeAllListeners();
  state.simTerminalLinker.removeAllListeners();
  state.regressionRunTracker.removeAllListeners();
  vi.resetModules();
  mod = await import('../../src/main/notifications/notification-manager');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function syncEvents(): { notifications: AppNotification[] }[] {
  return state.sent
    .filter((e) => e.channel === 'notification:event')
    .map((e) => e.payload as { notifications: AppNotification[] });
}

function persisted(): AppNotification[] {
  return JSON.parse(readFileSync(join(tempDir, 'socverify-data', 'notifications.json'), 'utf-8')) as AppNotification[];
}

describe('NotificationManager 持久化与广播', () => {
  it('add 入库（新通知在前）→ 写盘 + notification:event 全量同步', async () => {
    await mod.notificationManager.init();
    const n1 = await mod.notificationManager.add({ type: 'failure', title: '仿真失败 · case_a' });
    const n2 = await mod.notificationManager.add({ type: 'coverage', title: '覆盖率 87.3%', detail: '导入完成' });

    expect(n1.read).toBe(false);
    const last = syncEvents().at(-1);
    expect(last?.notifications.map((n) => n.id)).toEqual([n2.id, n1.id]);
    expect(persisted().map((n) => n.title)).toEqual(['覆盖率 87.3%', '仿真失败 · case_a']);
  });

  it('markRead / markAllRead 更新已读态并持久化', async () => {
    await mod.notificationManager.init();
    const a = await mod.notificationManager.add({ type: 'success', title: 'A' });
    const b = await mod.notificationManager.add({ type: 'review', title: 'B' });

    await mod.notificationManager.markRead(a.id);
    expect(mod.notificationManager.list().find((n) => n.id === a.id)?.read).toBe(true);

    await mod.notificationManager.markAllRead();
    expect(mod.notificationManager.list().every((n) => n.read)).toBe(true);
    expect(persisted().find((n) => n.id === b.id)?.read).toBe(true);
  });

  it('重启后从 notifications.json 重载（持久化不丢失）', async () => {
    await mod.notificationManager.init();
    await mod.notificationManager.add({ type: 'failure', title: '重启前通知' });

    // 模拟重启：新实例 + 同一 dataDir
    vi.resetModules();
    const reopened = await import('../../src/main/notifications/notification-manager');
    await reopened.notificationManager.init();
    expect(reopened.notificationManager.list().map((n) => n.title)).toEqual(['重启前通知']);
  });

  it('超出 100 条上限：丢弃最旧', async () => {
    await mod.notificationManager.init();
    for (let i = 0; i < 102; i++) {
      await mod.notificationManager.add({ type: 'success', title: `n${i}` });
    }
    const list = mod.notificationManager.list();
    expect(list).toHaveLength(100);
    expect(list.at(-1)?.title).toBe('n2'); // n0/n1 被裁剪
  });
});

describe('wireNotificationSources 事件源接线', () => {
  it('插件通道仿真失败（fail/error）→ failure 通知', async () => {
    await mod.notificationManager.init();
    mod.wireNotificationSources();

    state.simulationRegistry.emit('run:completed', {
      runId: 'r1',
      status: 'fail',
      options: { caseName: 'alu_add_test', subsys: 'alu' },
    });
    await vi.waitFor(() => {
      expect(mod.notificationManager.list()).toHaveLength(1);
      expect(persisted()).toHaveLength(1);
    });
    expect(mod.notificationManager.list()[0]).toMatchObject({
      type: 'failure',
      title: '仿真失败 · alu_add_test',
      detail: 'alu 子系统',
    });
  });

  it('插件通道仿真通过不产生通知', async () => {
    await mod.notificationManager.init();
    mod.wireNotificationSources();

    state.simulationRegistry.emit('run:completed', { runId: 'r2', status: 'pass' });
    expect(mod.notificationManager.list()).toHaveLength(0);
  });

  it('终端通道仿真失败 → failure 通知', async () => {
    await mod.notificationManager.init();
    mod.wireNotificationSources();

    state.simTerminalLinker.emit('run:completed', {
      runId: 'r3',
      status: 'error',
      caseId: 'uart_rx_001',
      subsys: 'uart',
    });
    // 等待落盘完成：add 为 fire-and-forget，若只等内存态，
    // afterEach 的 rmSync 会与异步写盘竞态产生 ENOENT stderr
    await vi.waitFor(() => {
      expect(mod.notificationManager.list()).toHaveLength(1);
      expect(persisted()).toHaveLength(1);
    });
    expect(mod.notificationManager.list()[0]).toMatchObject({ type: 'failure', title: '仿真失败 · uart_rx_001' });
  });

  it('回归 failed → failure 通知；completed → success 通知；aborted 不通知', async () => {
    await mod.notificationManager.init();
    mod.wireNotificationSources();

    state.regressionRunTracker.emit('run:finished', { runId: 'run-aaaaaa111111', subsys: 'alu' }, 'failed');
    state.regressionRunTracker.emit('run:finished', { runId: 'run-bbbbbb222222', subsys: 'uart' }, 'completed');
    state.regressionRunTracker.emit('run:finished', { runId: 'run-cccccc333333', subsys: 'i2c' }, 'aborted');

    await vi.waitFor(() => {
      expect(mod.notificationManager.list()).toHaveLength(2);
      expect(persisted()).toHaveLength(2);
    });
    const titles = mod.notificationManager.list().map((n) => n.title);
    expect(titles).toContain('回归失败 · #111111');
    expect(titles).toContain('回归完成 · #222222');
  });
});
