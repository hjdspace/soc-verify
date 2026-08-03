/**
 * editor-registry flush 机制测试（Issue #7）。
 *
 * 测试缝：editor-registry 模块的 registerEditor / unregisterEditor / isEditing /
 * requestFlush / notifyFlushDone / notifyFileChanged / cleanupEditorRegistry。
 *
 * mock electron（BrowserWindow + ipcMain），验证：
 *  - 注册/注销编辑器状态
 *  - requestFlush 在文件未编辑时立即 resolve
 *  - requestFlush 在文件编辑中时广播 flush-request 事件
 *  - notifyFlushDone 解析 pending flush promise
 *  - requestFlush 超时（3 秒）后强制 resolve
 *  - notifyFileChanged 广播 file-changed 事件
 *  - cleanupEditorRegistry 清理所有 pending flush 和编辑器
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── mock electron ─────────────────────────────────────────────
const { mockWindows, mockIpcMainOn, mockIpcMainRemoveListener } = vi.hoisted(() => {
  const windows: Array<{
    isDestroyed: () => boolean;
    webContents: { send: (channel: string, ...args: unknown[]) => void };
  }> = [];
  const ipcMainHandlers = new Map<string, ((event: unknown, ...args: unknown[]) => void) | undefined>();
  return {
    mockWindows: windows,
    mockIpcMainOn: ipcMainHandlers,
    mockIpcMainRemoveListener: ipcMainHandlers,
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, handler: (event: unknown, ...args: unknown[]) => void) => {
      mockIpcMainOn.set(channel, handler);
    },
    removeAllListeners: (channel: string) => {
      mockIpcMainRemoveListener.delete(channel);
    },
  },
  BrowserWindow: {
    getAllWindows: () => mockWindows,
  },
}));

import {
  registerEditor,
  unregisterEditor,
  isEditing,
  requestFlush,
  notifyFlushDone,
  notifyFileChanged,
  registerDocumentIpcHandlers,
  cleanupEditorRegistry,
} from '../src/main/document/editor-registry';

/** 创建模拟 BrowserWindow */
function makeMockWindow() {
  const sends: Array<{ channel: string; args: unknown[] }> = [];
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, ...args: unknown[]) => {
        sends.push({ channel, args });
      },
    },
    _sends: sends,
  };
  mockWindows.push(win);
  return win;
}

describe('editor-registry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockWindows.length = 0;
    mockIpcMainOn.clear();
    cleanupEditorRegistry();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanupEditorRegistry();
  });

  // ─── 注册/注销 ────────────────────────────────────────────

  describe('registerEditor / unregisterEditor / isEditing', () => {
    it('registerEditor 注册文件编辑状态', () => {
      registerEditor('/tmp/sheet.xlsx');
      expect(isEditing('/tmp/sheet.xlsx')).toBe(true);
    });

    it('未注册的文件 isEditing 返回 false', () => {
      expect(isEditing('/tmp/other.xlsx')).toBe(false);
    });

    it('unregisterEditor 注销文件编辑状态', () => {
      registerEditor('/tmp/sheet.xlsx');
      unregisterEditor('/tmp/sheet.xlsx');
      expect(isEditing('/tmp/sheet.xlsx')).toBe(false);
    });

    it('unregisterEditor 对未注册文件不报错', () => {
      expect(() => unregisterEditor('/tmp/never.xlsx')).not.toThrow();
    });
  });

  // ─── requestFlush ─────────────────────────────────────────

  describe('requestFlush', () => {
    it('文件未编辑时立即 resolve', async () => {
      const start = Date.now();
      const promise = requestFlush('/tmp/not-editing.xlsx');
      await expect(promise).resolves.toBeUndefined();
      expect(Date.now() - start).toBeLessThan(50);
    });

    it('文件编辑中时广播 flush-request 事件到所有窗口', async () => {
      const win1 = makeMockWindow();
      const win2 = makeMockWindow();
      registerEditor('/tmp/sheet.xlsx');

      const promise = requestFlush('/tmp/sheet.xlsx');
      // 不立即 resolve（等待 flush-done 或超时）
      let settled = false;
      void promise.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);

      // 两个窗口都应收到 flush-request 事件
      expect(win1._sends).toHaveLength(1);
      expect(win1._sends[0].channel).toBe('document:flush-request');
      expect(win1._sends[0].args).toEqual(['/tmp/sheet.xlsx']);
      expect(win2._sends).toHaveLength(1);
      expect(win2._sends[0].channel).toBe('document:flush-request');

      // 清理：回复 flush-done 解析 promise
      notifyFlushDone('/tmp/sheet.xlsx');
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
    });

    it('跳过已销毁的窗口', async () => {
      const win = makeMockWindow();
      win.isDestroyed = () => true;
      registerEditor('/tmp/sheet.xlsx');

      const promise = requestFlush('/tmp/sheet.xlsx');
      // 推进微任务让 send 执行
      await vi.advanceTimersByTimeAsync(0);
      expect(win._sends).toHaveLength(0);

      // 清理
      notifyFlushDone('/tmp/sheet.xlsx');
      await expect(promise).resolves.toBeUndefined();
    });

    it('3 秒超时后强制 resolve', async () => {
      makeMockWindow();
      registerEditor('/tmp/sheet.xlsx');

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const promise = requestFlush('/tmp/sheet.xlsx');
      await vi.advanceTimersByTimeAsync(0);

      // 超时前未 resolve
      let resolved = false;
      void promise.then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(2999);
      expect(resolved).toBe(false);

      // 超时后 resolve
      await vi.advanceTimersByTimeAsync(2);
      expect(resolved).toBe(true);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('flush timeout for /tmp/sheet.xlsx'),
      );
      consoleWarnSpy.mockRestore();
    });
  });

  // ─── notifyFlushDone ──────────────────────────────────────

  describe('notifyFlushDone', () => {
    it('解析 pending flush promise', async () => {
      makeMockWindow();
      registerEditor('/tmp/sheet.xlsx');

      const promise = requestFlush('/tmp/sheet.xlsx');
      await vi.advanceTimersByTimeAsync(0);

      notifyFlushDone('/tmp/sheet.xlsx');
      await expect(promise).resolves.toBeUndefined();
    });

    it('无 pending flush 时不报错', () => {
      expect(() => notifyFlushDone('/tmp/no-pending.xlsx')).not.toThrow();
    });
  });

  // ─── notifyFileChanged ────────────────────────────────────

  describe('notifyFileChanged', () => {
    it('广播 file-changed 事件到所有窗口', () => {
      const win1 = makeMockWindow();
      const win2 = makeMockWindow();

      notifyFileChanged('/tmp/sheet.xlsx');

      expect(win1._sends).toHaveLength(1);
      expect(win1._sends[0].channel).toBe('document:file-changed');
      expect(win1._sends[0].args).toEqual(['/tmp/sheet.xlsx']);
      expect(win2._sends).toHaveLength(1);
      expect(win2._sends[0].channel).toBe('document:file-changed');
    });

    it('跳过已销毁的窗口', () => {
      const win = makeMockWindow();
      win.isDestroyed = () => true;

      notifyFileChanged('/tmp/sheet.xlsx');

      expect(win._sends).toHaveLength(0);
    });
  });

  // ─── registerDocumentIpcHandlers ──────────────────────────

  describe('registerDocumentIpcHandlers', () => {
    it('注册 document:flush-done IPC handler', () => {
      registerDocumentIpcHandlers();
      expect(mockIpcMainOn.has('document:flush-done')).toBe(true);
    });

    it('收到 flush-done 事件时调用 notifyFlushDone', async () => {
      makeMockWindow();
      registerEditor('/tmp/sheet.xlsx');
      registerDocumentIpcHandlers();

      const promise = requestFlush('/tmp/sheet.xlsx');
      await vi.advanceTimersByTimeAsync(0);

      // 模拟前端发送 document:flush-done 事件
      const handler = mockIpcMainOn.get('document:flush-done');
      expect(handler).toBeDefined();
      handler?.({}, '/tmp/sheet.xlsx');

      await expect(promise).resolves.toBeUndefined();
    });

    it('flush-done 事件参数非字符串时忽略', () => {
      registerDocumentIpcHandlers();
      const handler = mockIpcMainOn.get('document:flush-done');
      // 不应抛错
      expect(() => handler?.({}, 12345)).not.toThrow();
    });
  });

  // ─── cleanupEditorRegistry ────────────────────────────────

  describe('cleanupEditorRegistry', () => {
    it('清理所有 pending flush', async () => {
      makeMockWindow();
      registerEditor('/tmp/sheet.xlsx');

      const promise = requestFlush('/tmp/sheet.xlsx');
      await vi.advanceTimersByTimeAsync(0);

      cleanupEditorRegistry();

      // promise 应被 reject（实际是 resolve，因为 flush 失败也继续）
      await expect(promise).resolves.toBeUndefined();
    });

    it('清理后 isEditing 返回 false', () => {
      registerEditor('/tmp/sheet.xlsx');
      expect(isEditing('/tmp/sheet.xlsx')).toBe(true);

      cleanupEditorRegistry();

      expect(isEditing('/tmp/sheet.xlsx')).toBe(false);
    });

    it('清理后 requestFlush 立即 resolve（无编辑器）', async () => {
      registerEditor('/tmp/sheet.xlsx');
      makeMockWindow();

      cleanupEditorRegistry();

      const start = Date.now();
      await expect(requestFlush('/tmp/sheet.xlsx')).resolves.toBeUndefined();
      expect(Date.now() - start).toBeLessThan(50);
    });
  });
});
