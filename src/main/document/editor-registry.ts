/**
 * 文档编辑器注册表 + flush 机制。
 *
 * 主进程追踪哪些文件在前端被 XlsxEditor 编辑，AI 调用细粒度编辑工具前
 * 通过此模块触发前端 flush，避免覆盖前端未保存的修改。
 *
 * 流程：
 *   1. 前端 XlsxEditor mount → 调用 document.registerEditor(filePath)
 *   2. AI 调用 append_xlsx_row/update_xlsx_cell 前，主进程检查文件是否在注册表中
 *   3. 若在注册表中：通过 BrowserWindow.send('document:flush-request', path) 通知前端
 *   4. 前端立即 flush Fortune-sheet 状态到文件，回复 'document:flush-done'（通过 tRPC）
 *   5. 主进程收到 flush-done（或 3 秒超时）后继续执行 AI 修改
 *   6. AI 修改完成后，通过 BrowserWindow.send('document:file-changed', path) 通知前端重载
 */

import { ipcMain, BrowserWindow } from 'electron';

/** 正在被前端编辑的文件路径集合（不绑定窗口，flush 时广播所有窗口） */
const documentEditors = new Set<string>();

/** flush 请求的超时时间（毫秒） */
const FLUSH_TIMEOUT_MS = 3000;

/** flush 请求的待处理 Promise 解析器 */
type PendingFlush = {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};
const pendingFlushes = new Map<string, PendingFlush>();

/**
 * 注册文件正在前端编辑。
 * flush-request 和 file-changed 事件会广播到所有窗口。
 */
export function registerEditor(filePath: string): void {
  documentEditors.add(filePath);
}

/** 注销文件的前端编辑状态。 */
export function unregisterEditor(filePath: string): void {
  documentEditors.delete(filePath);
}

/** 文件是否正在前端编辑。 */
export function isEditing(filePath: string): boolean {
  return documentEditors.has(filePath);
}

/**
 * 通知前端 flush 指定文件，等待 flush-done 回复（或 3 秒超时）。
 *
 * 超时后强制继续，记录警告日志。
 * 若文件不在编辑中，立即 resolve。
 */
export function requestFlush(filePath: string): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!documentEditors.has(filePath)) {
      resolve();
      return;
    }

    // 若已有 pending flush，复用其 Promise（避免重复请求）
    const existing = pendingFlushes.get(filePath);
    if (existing) {
      existing.resolve();
      pendingFlushes.delete(filePath);
      clearTimeout(existing.timer);
    }

    const timer = setTimeout(() => {
      console.warn(
        `[editor-registry] flush timeout for ${filePath}, continuing anyway (front-end may have unsaved changes)`,
      );
      const pending = pendingFlushes.get(filePath);
      if (pending) {
        pending.resolve();
        pendingFlushes.delete(filePath);
      }
    }, FLUSH_TIMEOUT_MS);

    pendingFlushes.set(filePath, {
      resolve: () => {
        resolve();
      },
      reject: () => {
        resolve(); // flush 失败也继续，避免阻塞 AI
      },
      timer,
    });

    // 广播到所有窗口（单窗口应用，通常只有一个）
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('document:flush-request', filePath);
      }
    }
  });
}

/**
 * 前端 flush 完成后调用此方法回复主进程。
 * 由 document-router 的 flushDone procedure 调用。
 */
export function notifyFlushDone(filePath: string): void {
  const pending = pendingFlushes.get(filePath);
  if (pending) {
    clearTimeout(pending.timer);
    pending.resolve();
    pendingFlushes.delete(filePath);
  }
}

/**
 * 通知所有窗口文件已被 AI 修改。
 * 前端收到 file-changed 事件后重载该文件。
 */
export function notifyFileChanged(filePath: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('document:file-changed', filePath);
    }
  }
}

/**
 * 注册 IPC handlers（在 app.whenReady 时调用）。
 *
 * - 'document:flush-done' 由前端在 flush 完成后发送
 */
export function registerDocumentIpcHandlers(): void {
  ipcMain.on('document:flush-done', (_event, filePath: string) => {
    if (typeof filePath === 'string') {
      notifyFlushDone(filePath);
    }
  });
}

/** 清理所有 pending flush 和编辑器注册（应用退出时调用）。 */
export function cleanupEditorRegistry(): void {
  for (const pending of pendingFlushes.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error('application shutting down'));
  }
  pendingFlushes.clear();
  documentEditors.clear();
}
