/**
 * RegressionRunTracker 测试（Issue #8）：
 *   - parseRegressionProgress：多形态进度解析 + 噪声排除（日期/时间/越界值）
 *   - track → terminal data → exit 全生命周期：regression:event 推送与 getActive 查询
 *
 * mock 共享状态全部经 vi.hoisted 提供（vi.mock factory 提升到模块加载前求值，
 * 不能引用普通顶层 const；EventEmitter import 绑定在 hoisted 阶段不可用，
 * 故用自实现的 FakeEmitter）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegressionEvent } from '@shared/types/regression';

const h = vi.hoisted(() => {
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
  }
  const terminal = new FakeEmitter() as FakeEmitter & { destroy: ReturnType<typeof vi.fn> };
  terminal.destroy = vi.fn();
  return {
    sent: [] as Array<{ channel: string; payload: unknown }>,
    terminal,
  };
});

// ── electron mock：BrowserWindow.getAllWindows 返回捕获 send 的假窗口 ──
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => {
            h.sent.push({ channel, payload });
          },
        },
      },
    ],
  },
}));

// ── terminalManager mock：FakeEmitter（tracker 在首次 track 时安装监听）──
vi.mock('../../src/main/terminal/terminal-manager', () => ({
  terminalManager: h.terminal,
}));

import {
  parseRegressionProgress,
  regressionRunTracker,
} from '../../src/main/regression/regression-run-tracker';

function regressionEvents(): RegressionEvent[] {
  return h.sent.filter((e) => e.channel === 'regression:event').map((e) => e.payload as RegressionEvent);
}

beforeEach(() => {
  h.sent.length = 0;
  h.terminal.destroy.mockClear();
  // 单例无法重置内部 runs；用唯一 runId 避免跨测试污染
});

describe('parseRegressionProgress', () => {
  it('解析方括号形态 [312/480]', () => {
    expect(parseRegressionProgress('case_081 [312/480] PASS')).toEqual({ completed: 312, total: 480 });
  });

  it('解析带上下文关键词形态', () => {
    expect(parseRegressionProgress('Progress: 312/480 cases done')).toEqual({ completed: 312, total: 480 });
    expect(parseRegressionProgress('cases 312/480')).toEqual({ completed: 312, total: 480 });
    expect(parseRegressionProgress('case 312 of 480 tests remaining')).toEqual({ completed: 312, total: 480 });
    expect(parseRegressionProgress('已完成 312/480')).toEqual({ completed: 312, total: 480 });
  });

  it('同一文本取最后一次匹配（进度单调递增）', () => {
    expect(parseRegressionProgress('1/480 ok\n[312/480]\n[313/480]')).toEqual({ completed: 313, total: 480 });
  });

  it('裸 x/y 无上下文关键词时拒绝（防日期/时间误判）', () => {
    expect(parseRegressionProgress('build at 2026/08/22 10:24')).toBeNull();
    expect(parseRegressionProgress('312/480')).toBeNull();
  });

  it('越界与非法值拒绝', () => {
    expect(parseRegressionProgress('480/312 cases')).toBeNull(); // completed > total
    expect(parseRegressionProgress('0/0 cases')).toBeNull(); // total = 0
    expect(parseRegressionProgress('312/999999 cases')).toBeNull(); // total 超上限
  });

  it('空文本返回 null', () => {
    expect(parseRegressionProgress('')).toBeNull();
  });
});

describe('RegressionRunTracker 生命周期', () => {
  it('track 登记 → started 事件 → getActive 可查', () => {
    regressionRunTracker.track({
      runId: 'run-track-1',
      terminalId: 'term-1',
      projectId: 'proj-1',
      subsys: 'alu',
      filePath: '/env/alu/regression/alu_mini.lst',
    });

    const events = regressionEvents();
    expect(events.at(-1)).toMatchObject({
      type: 'started',
      run: { runId: 'run-track-1', subsys: 'alu' },
    });
    // started 载荷不含 terminalId / projectId（主进程内部字段剥离）
    expect((events.at(-1) as { run: Record<string, unknown> }).run.terminalId).toBeUndefined();

    const active = regressionRunTracker.getActive('proj-1');
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ runId: 'run-track-1', subsys: 'alu' });
  });

  it('getTerminalId 查运行中回归的终端 ID；未知 runId 返回 null（按需开终端，ADR 0029）', () => {
    expect(regressionRunTracker.getTerminalId('run-track-1')).toBe('term-1');
    expect(regressionRunTracker.getTerminalId('no-such-run')).toBeNull();
  });

  it('terminal data 解析出进度 → progress 事件 + getActive 含 completed/total', () => {
    regressionRunTracker.track({
      runId: 'run-track-2',
      terminalId: 'term-2',
      projectId: 'proj-1',
      subsys: 'uart',
      filePath: '/env/uart/regression.lst',
    });
    h.sent.length = 0;

    h.terminal.emit('data', { id: 'term-2', data: 'case_002 [120/480] PASS\n' });

    const events = regressionEvents();
    expect(events.at(-1)).toMatchObject({
      type: 'progress',
      run: { runId: 'run-track-2', completed: 120, total: 480 },
    });
    expect(regressionRunTracker.getActive('proj-1').find((r) => r.runId === 'run-track-2')).toMatchObject({
      completed: 120,
      total: 480,
    });
  });

  it('terminal data 无进度信息 → 不发 progress 事件', () => {
    h.sent.length = 0;
    h.terminal.emit('data', { id: 'term-2', data: 'compiling rtl modules...\n' });
    expect(regressionEvents().filter((e) => e.type === 'progress')).toHaveLength(0);
  });

  it('exit 0 → finished completed 事件并移除运行', () => {
    h.sent.length = 0;
    h.terminal.emit('exit', { id: 'term-2', exitCode: 0 });

    const events = regressionEvents();
    expect(events.at(-1)).toMatchObject({
      type: 'finished',
      run: { runId: 'run-track-2' },
      status: 'completed',
    });
    expect(regressionRunTracker.getActive('proj-1').find((r) => r.runId === 'run-track-2')).toBeUndefined();
  });

  it('exit 非 0 → failed', () => {
    regressionRunTracker.track({
      runId: 'run-track-3',
      terminalId: 'term-3',
      projectId: 'proj-1',
      subsys: 'i2c',
      filePath: '/env/i2c/regression.lst',
    });
    h.terminal.emit('exit', { id: 'term-3', exitCode: 1 });
    expect(regressionEvents().at(-1)).toMatchObject({ type: 'finished', status: 'failed' });
  });

  it('abort 销毁关联终端会话', () => {
    regressionRunTracker.track({
      runId: 'run-track-4',
      terminalId: 'term-4',
      projectId: 'proj-1',
      subsys: 'spi',
      filePath: '/env/spi/regression.lst',
    });
    expect(regressionRunTracker.abort('run-track-4')).toBe(true);
    expect(h.terminal.destroy).toHaveBeenCalledWith('term-4');
    expect(regressionRunTracker.abort('run-not-exist')).toBe(false);
  });

  it('getActive 按 projectId 过滤', () => {
    regressionRunTracker.track({
      runId: 'run-track-5',
      terminalId: 'term-5',
      projectId: 'proj-2',
      subsys: 'dma',
      filePath: '/env/dma/regression.lst',
    });
    expect(regressionRunTracker.getActive('proj-2').some((r) => r.runId === 'run-track-5')).toBe(true);
    expect(regressionRunTracker.getActive('proj-1').some((r) => r.runId === 'run-track-5')).toBe(false);
    // 无 projectId → 全量
    expect(regressionRunTracker.getActive().some((r) => r.runId === 'run-track-5')).toBe(true);
  });
});
