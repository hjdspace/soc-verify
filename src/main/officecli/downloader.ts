/**
 * officecli 二进制下载器（开发模式专用）。
 *
 * 通过 spawn('node', ['scripts/download-officecli.mjs']) 调用下载脚本，
 * 解析 stdout 提取进度信息，通过 BrowserWindow 广播 'officecli:download-progress'
 * IPC 事件供前端显示进度条。
 *
 * 生产模式不可用——用户应通过应用安装包获取 officecli。
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolveOfficecliPath } from './binary';

const lazyRequire = createRequire(import.meta.url);

/** 下载进度事件载荷 */
export type DownloadProgress = {
  stage: 'start' | 'fetching' | 'downloading' | 'verifying' | 'done' | 'error';
  message: string;
  percent?: number;
};

/** 下载结果 */
export type DownloadResult = {
  success: boolean;
  path?: string;
  error?: string;
};

/** 解析脚本输出，提取进度信息 */
function parseProgress(line: string): DownloadProgress | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // [OfficeCLI] Fetching release info: v1.0.0 from ...
  if (trimmed.includes('Fetching release info')) {
    return { stage: 'fetching', message: '正在获取 release 信息...' };
  }
  // [OfficeCLI] Downloading: https://...
  if (trimmed.includes('Downloading:')) {
    return { stage: 'downloading', message: '正在下载二进制...' };
  }
  // [OfficeCLI] File size: 12.3 MB
  if (trimmed.includes('File size:')) {
    return { stage: 'downloading', message: trimmed.replace('[OfficeCLI] ', '') };
  }
  // [OfficeCLI] Download complete.
  if (trimmed.includes('Download complete.')) {
    return { stage: 'downloading', message: '下载完成', percent: 100 };
  }
  // [OfficeCLI] Verification OK.
  if (trimmed.includes('Verification OK')) {
    return { stage: 'verifying', message: '验证通过' };
  }
  // [OfficeCLI] Binary already exists
  if (trimmed.includes('Binary already exists')) {
    return { stage: 'done', message: '二进制已存在' };
  }
  return null;
}

/** 广播进度事件到所有窗口 */
function broadcastProgress(progress: DownloadProgress): void {
  try {
    const electron = lazyRequire('electron') as unknown;
    if (typeof electron !== 'object' || electron === null || !('BrowserWindow' in electron)) {
      return;
    }
    const { BrowserWindow } = electron as { BrowserWindow: { getAllWindows: () => Array<{ isDestroyed: () => boolean; webContents: { send: (channel: string, ...args: unknown[]) => void } }> } };
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('officecli:download-progress', progress);
      }
    }
  } catch {
    // electron 不可用（测试环境）——忽略
  }
}

/**
 * 判断是否处于开发模式（非打包应用）。
 *
 * 在测试环境中 require('electron') 返回字符串路径，视为开发模式；
 * 在打包应用中 app.isPackaged === true。
 */
function isDevMode(): boolean {
  try {
    const electron = lazyRequire('electron') as unknown;
    if (typeof electron === 'object' && electron !== null && 'app' in electron) {
      const app = (electron as { app: { isPackaged: boolean } }).app;
      return !app.isPackaged;
    }
    return true;
  } catch {
    return true;
  }
}

/**
 * 下载 officecli 二进制（仅开发模式可用）。
 *
 * 调用 `node scripts/download-officecli.mjs`，解析 stdout 推送进度。
 * 完成后通过 resolveOfficecliPath() 验证二进制可用。
 *
 * @param scriptPath download-officecli.mjs 的绝对路径
 * @returns 下载结果
 */
export function downloadOfficeCliBinary(scriptPath: string): Promise<DownloadResult> {
  return new Promise<DownloadResult>((resolve) => {
    if (!isDevMode()) {
      resolve({
        success: false,
        error: '生产模式不支持下载，请通过应用安装包获取 officecli。',
      });
      return;
    }

    broadcastProgress({ stage: 'start', message: '开始下载 officecli 二进制...' });

    let child;
    try {
      child = spawn(process.execPath, [scriptPath], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      broadcastProgress({ stage: 'error', message: `启动下载脚本失败: ${errorMsg}` });
      resolve({ success: false, error: errorMsg });
      return;
    }

    let stderrBuffer = '';

    child.stdout?.on('data', (data: Buffer) => {
      const output = data.toString();
      for (const line of output.split('\n')) {
        const progress = parseProgress(line);
        if (progress) {
          broadcastProgress(progress);
        }
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderrBuffer += data.toString();
    });

    child.on('error', (err: Error) => {
      broadcastProgress({ stage: 'error', message: `下载失败: ${err.message}` });
      resolve({ success: false, error: err.message });
    });

    child.on('close', (exitCode: number) => {
      if (exitCode === 0) {
        const binaryPath = resolveOfficecliPath();
        if (binaryPath) {
          broadcastProgress({ stage: 'done', message: 'officecli 下载完成', percent: 100 });
          resolve({ success: true, path: binaryPath });
        } else {
          broadcastProgress({
            stage: 'error',
            message: '下载脚本退出但二进制未找到，请检查 resources/binaries/ 目录。',
          });
          resolve({
            success: false,
            error: 'Binary not found after download',
          });
        }
      } else {
        const errorMsg = `下载脚本退出码 ${exitCode}${stderrBuffer ? `: ${stderrBuffer.trim()}` : ''}`;
        broadcastProgress({ stage: 'error', message: errorMsg });
        resolve({ success: false, error: errorMsg });
      }
    });
  });
}
