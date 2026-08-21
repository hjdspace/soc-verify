/**
 * 共享 IPC 通道常量。
 *
 * 主进程（CJS）和渲染进程（ESM）都可以通过 @shared/ipc-channels 导入，
 * 确保通道名一致。
 */

/** 主进程 → 渲染进程：全局错误通知（uncaughtException / unhandledRejection） */
export const GLOBAL_ERROR_CHANNEL = 'global:error';
