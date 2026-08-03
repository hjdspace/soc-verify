/**
 * officecli 高级服务 API。
 *
 * 在 executor.ts 之上提供：
 *  - viewHtml(filePath, outputDir?)：渲染文档为 HTML
 *  - viewScreenshot(filePath, outputDir, page?)：渲染为 PNG 截图
 *  - watchStart/watchStop/watchStopAll：watch 模式管理
 *  - readImageAsDataURL：主进程读图为 base64
 *  - checkInstalled/getVersion：二进制可用性查询
 *  - cleanupOfficeCli：清理所有 watch 进程
 *
 * 参考：SpaceCode electron/officeCliService.ts 第 508-655 行。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { execOfficeCli, killProcessTree, OfficeCliNotAvailableError } from './executor';
import { resolveOfficecliPath } from './binary';

/** watch 进程句柄 */
export type OfficeCliWatchHandle = {
  id: string;
  filePath: string;
  port: number;
  url: string;
  process: ChildProcess;
};

/** watch 启动结果（不含内部 ChildProcess，用于跨 IPC 返回） */
export type OfficeCliWatchInfo = {
  id: string;
  filePath: string;
  port: number;
  url: string;
};

/** watch 进程注册表（按 id 索引） */
const watchProcesses = new Map<string, OfficeCliWatchHandle>();

/** 默认 watch 端口（未指定时 officecli 选用的回退端口） */
const DEFAULT_WATCH_PORT = 26315;

/** watch 启动等待端口出现的超时（毫秒） */
const WATCH_STARTUP_TIMEOUT = 10000;

/**
 * 将文档渲染为 HTML。
 *
 * 调用 `officecli view <file> html [-o <dir>]`。
 * 若未指定 outputDir，将 stdout 写入临时文件并返回其路径。
 *
 * @returns 生成的 HTML 文件路径
 */
export async function viewHtml(filePath: string, outputDir?: string): Promise<string> {
  const args = ['view', filePath, 'html'];
  if (outputDir) {
    args.push('-o', outputDir);
  }
  const result = await execOfficeCli({
    args,
    cwd: dirname(filePath),
    timeout: 60000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`HTML render failed: ${result.stderr || result.stdout}`);
  }
  if (outputDir) {
    return join(outputDir, basename(filePath, extname(filePath)) + '.html');
  }
  // 无 outputDir：将 stdout 写入临时文件
  const tmpPath = join(tmpdir(), `officecli-${Date.now()}.html`);
  writeFileSync(tmpPath, result.stdout);
  return tmpPath;
}

/**
 * 将文档渲染为 PNG 截图。
 *
 * 调用 `officecli view <file> screenshot -o <file> [--page N]`。
 * 注意 officecli 的 -o 期望文件路径，不是目录。
 *
 * @returns 生成的 PNG 文件路径数组
 */
export async function viewScreenshot(
  filePath: string,
  outputDir: string,
  page?: number,
): Promise<string[]> {
  mkdirSync(outputDir, { recursive: true });

  const baseName = basename(filePath, extname(filePath));
  const pageLabel = page ? `page-${page}` : 'page-1';
  const outFile = join(outputDir, `${baseName}-${pageLabel}.png`);

  const args = ['view', filePath, 'screenshot', '-o', outFile];
  if (page) {
    args.push('--page', String(page));
  }
  const result = await execOfficeCli({
    args,
    cwd: dirname(filePath),
    timeout: 60000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Screenshot render failed: ${result.stderr || result.stdout}`);
  }

  // officecli 在 stdout 中回显生成的文件路径；若 stdout 为空则回退到构造路径
  const generatedPath = result.stdout.trim();
  const resolvedPath =
    generatedPath && existsSync(generatedPath)
      ? generatedPath
      : existsSync(outFile)
        ? outFile
        : '';

  if (!resolvedPath) {
    throw new Error(`Screenshot produced no output. ${result.stderr || result.stdout}`);
  }
  return [resolvedPath];
}

/**
 * 启动 watch 模式。
 *
 * 调用 `officecli watch <file> [--port N]`，从 stdout 正则提取端口。
 * 维护 watchProcesses Map，可用 watchStop/watchStopAll 停止。
 *
 * @returns watch 句柄信息（id、filePath、port、url）
 */
export async function watchStart(filePath: string, port?: number): Promise<OfficeCliWatchInfo> {
  const binaryPath = resolveOfficecliPath();
  if (!binaryPath) {
    throw new OfficeCliNotAvailableError();
  }

  const args = ['watch', filePath];
  if (port) {
    args.push('--port', String(port));
  }

  const child = spawn(binaryPath, args, {
    cwd: dirname(filePath),
    shell: false,
    windowsHide: true,
    // Unix 下 detached: true 创建进程组，便于 killProcessTree 用 process.kill(-pid)
    detached: process.platform !== 'win32',
  });

  return new Promise((resolve, reject) => {
    const id = `watch-${Date.now()}`;
    let resolvedPort = port ?? DEFAULT_WATCH_PORT;
    let outputBuffer = '';

    const timer = setTimeout(() => {
      // 超时后清理子进程
      if (child.pid) killProcessTree(child.pid, child);
      reject(new Error('watch startup timeout'));
    }, WATCH_STARTUP_TIMEOUT);

    child.stdout?.on('data', (data: Buffer) => {
      outputBuffer += data.toString();
      const urlMatch = outputBuffer.match(/http:\/\/localhost:(\d+)/);
      if (urlMatch) {
        resolvedPort = parseInt(urlMatch[1], 10);
        clearTimeout(timer);
        const handle: OfficeCliWatchHandle = {
          id,
          filePath,
          port: resolvedPort,
          url: `http://localhost:${resolvedPort}`,
          process: child,
        };
        watchProcesses.set(id, handle);
        resolve({ id, filePath, port: resolvedPort, url: handle.url });
      }
    });

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(new Error(`watch start failed: ${err.message}`));
    });

    child.on('close', () => {
      // 若 promise 未 resolve（端口未提取到），子进程提前退出应触发 reject
      watchProcesses.delete(id);
      clearTimeout(timer);
      reject(new Error('watch process exited before port was detected'));
    });
  });
}

/** 停止指定 watch 进程。返回是否成功停止（id 存在即返回 true）。 */
export function watchStop(watchId: string): boolean {
  const handle = watchProcesses.get(watchId);
  if (!handle) return false;
  if (handle.process.pid) killProcessTree(handle.process.pid, handle.process);
  watchProcesses.delete(watchId);
  return true;
}

/** 停止所有 watch 进程，返回停止的数量。 */
export function watchStopAll(): number {
  const count = watchProcesses.size;
  for (const handle of watchProcesses.values()) {
    if (handle.process.pid) killProcessTree(handle.process.pid, handle.process);
  }
  watchProcesses.clear();
  return count;
}

/** 列出当前活跃的 watch 进程（不含 ChildProcess，可跨 IPC 传递）。 */
export function listWatches(): OfficeCliWatchInfo[] {
  return Array.from(watchProcesses.values()).map((h) => ({
    id: h.id,
    filePath: h.filePath,
    port: h.port,
    url: h.url,
  }));
}

/**
 * 读取图片文件为 base64 data URL。
 *
 * 用于绕过渲染进程 file:// 的 CORS 限制（开发模式）。
 */
export function readImageAsDataURL(filePath: string): string {
  if (!filePath || !existsSync(filePath)) {
    throw new Error(`Image file not found: ${filePath}`);
  }
  const buffer = readFileSync(filePath);
  const ext = extname(filePath).slice(1).toLowerCase();
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  return `data:image/${mime};base64,${buffer.toString('base64')}`;
}

/** 检查 officecli 是否已安装且可用。 */
export function checkInstalled(): boolean {
  return resolveOfficecliPath() !== null;
}

/**
 * 获取 officecli 版本号。
 *
 * @returns stdout.trim() 的版本字符串
 * @throws {OfficeCliNotAvailableError} 二进制不可用
 * @throws {Error} 版本检查失败
 */
export async function getVersion(): Promise<string> {
  const result = await execOfficeCli({ args: ['--version'], timeout: 10000, cwd: homedir() });
  if (result.exitCode !== 0) {
    throw new Error(`Version check failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/** 清理所有 watch 进程（应用退出时调用）。复用 watchStopAll 避免逻辑重复。 */
export function cleanupOfficeCli(): void {
  watchStopAll();
}
