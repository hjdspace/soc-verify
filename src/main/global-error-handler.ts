/**
 * Global Error Handler — 主进程级 uncaughtException / unhandledRejection 处理。
 *
 * 设计要点（codebase-design: deep module）:
 * - Interface: installGlobalErrorHandlers() — 一个函数，零参数，零返回值
 * - Implementation: 捕获全局异常 → 格式化日志 → 发送到渲染进程（eventBridge）
 * - 写日志失败不抛异常（console.error 降级），保证处理器本身不会引发二次崩溃
 * - 不退出进程：桌面应用需要保持运行，用户可在 UI 中看到错误提示后自行决定操作
 */

import { BrowserWindow } from 'electron';
import { GLOBAL_ERROR_CHANNEL } from '@shared/ipc-channels';

type ErrorPayload = {
  type: 'uncaughtException' | 'unhandledRejection';
  message: string;
  stack?: string;
  timestamp: string;
};

/** 格式化 Error 为可序列化的 payload */
function toPayload(
  type: ErrorPayload['type'],
  error: unknown,
): ErrorPayload {
  const err = error instanceof Error
    ? error
    : { message: String(error), stack: undefined };

  return {
    type,
    message: err.message,
    stack: err.stack,
    timestamp: new Date().toISOString(),
  };
}

/** 将错误 payload 发送给所有渲染窗口（通过 webContents） */
function notifyRenderer(payload: ErrorPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send(GLOBAL_ERROR_CHANNEL, payload);
    } catch {
      // 窗口可能已销毁，忽略
    }
  }
}

/**
 * 安装全局异常处理器。
 * 在 app.whenReady() 之前调用，确保所有异步路径都被捕获。
 *
 * 处理策略：
 * 1. 记录到 stderr（开发可见）
 * 2. 发送给渲染进程（UI 可展示给用户）
 * 3. 不退出进程（桌面应用保持可用状态）
 */
export function installGlobalErrorHandlers(): void {
  process.on('uncaughtException', (error: unknown) => {
    const payload = toPayload('uncaughtException', error);
    console.error('[global-error] uncaughtException:', payload.message, payload.stack);
    notifyRenderer(payload);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    const payload = toPayload('unhandledRejection', reason);
    console.error('[global-error] unhandledRejection:', payload.message, payload.stack);
    notifyRenderer(payload);
  });
}
