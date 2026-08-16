/**
 * Broadcast helper — 向所有渲染窗口发送 IPC 消息。
 *
 * 此前「向所有窗口 webContents.send」的循环在 3+ 个 router 里各写一份
 * （kb / coverage / violation / sysbase-gen / git-manager / coverage-merger 等），
 * 每份实现都小但重复。本助手收拢为单一实现。
 *
 * 单用户桌面应用通常只有一个窗口，但多窗口场景（如 DevTools 分离）
 * 也能正确广播。
 */

import { BrowserWindow } from 'electron';

/**
 * 向所有未销毁的渲染窗口广播 IPC 消息。
 *
 * @param channel IPC 通道名
 * @param payload 消息体（自动序列化，与 webContents.send 一致）
 */
export function broadcastToWindows(channel: string, ...payload: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, ...payload);
    }
  }
}
