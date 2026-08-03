/**
 * officecli 子进程封装。
 *
 * 使用 child_process.spawn（非 exec），shell: false 避免 shell 注入；
 * 默认超时 30 秒，超时触发跨平台进程树 kill
 * （Windows 用 taskkill /T /F，Unix 用进程组 SIGTERM）。
 *
 * 参考：SpaceCode electron/officeCliService.ts 第 140-217 行。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { resolveOfficecliPath } from './binary';

/** officecli 执行选项 */
export type OfficeCliExecOptions = {
  /** 命令行参数（如 ['view', filePath, 'html']） */
  args: string[];
  /** 工作目录，默认 homedir() */
  cwd?: string;
  /** 超时毫秒，默认 30000 */
  timeout?: number;
  /** 额外环境变量 */
  env?: Record<string, string>;
};

/** officecli 执行结果 */
export type OfficeCliExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
};

/**
 * officecli 不可用时抛出的错误。
 *
 * 使用 class 而非工厂函数：document-router 的 toTrpcError 依赖
 * `instanceof OfficeCliNotAvailableError` 判别错误类型以返回明确
 * 的"OfficeCLI not available"错误信息，需要 class 维持原型链。
 */
export class OfficeCliNotAvailableError extends Error {
  constructor() {
    super(
      'OfficeCLI not available. Place the binary in resources/binaries/ (dev) ' +
        'or run `npm run download:officecli`. Alternatively, install OfficeCLI globally.',
    );
    this.name = 'OfficeCliNotAvailableError';
  }
}

/**
 * 跨平台进程树终止（包括子进程）。
 *
 * Windows: taskkill /pid <pid> /T /F（SIGTERM 无法杀死子进程）
 * Unix: 进程组 kill（要求 spawn 时 detached: true）
 */
export function killProcessTree(pid: number, child?: ChildProcess): void {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      // 优先用 child.kill() 发送 SIGTERM 给进程组
      if (child?.pid) {
        try {
          process.kill(-child.pid, 'SIGTERM');
          return;
        } catch {
          /* 进程可能已退出，继续回退 */
        }
      }
      process.kill(-pid, 'SIGTERM');
    }
  } catch {
    // 进程可能已退出
  }
}

/**
 * 执行 officecli 命令。
 *
 * @param options 执行选项
 * @returns 执行结果（exitCode、stdout、stderr、duration）
 * @throws {OfficeCliNotAvailableError} officecli 二进制不可用
 * @throws {Error} 超时或执行失败
 */
export function execOfficeCli(options: OfficeCliExecOptions): Promise<OfficeCliExecResult> {
  const binaryPath = resolveOfficecliPath();

  if (!binaryPath) {
    return Promise.reject(new OfficeCliNotAvailableError());
  }

  const cwd = options.cwd ?? homedir();
  const timeout = options.timeout ?? 30000;
  const env = { ...process.env, ...options.env };
  const isWindows = process.platform === 'win32';

  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    // Unix 下 detached: true 创建进程组，便于 killProcessTree 用 process.kill(-pid)
    const child = spawn(binaryPath, options.args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      detached: !isWindows,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      if (child.pid) killProcessTree(child.pid, child);
      reject(
        new Error(`OfficeCLI timeout (${timeout}ms): officecli ${options.args.join(' ')}`),
      );
    }, timeout);

    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr,
        duration: Date.now() - startTime,
      });
    });

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(new Error(`OfficeCLI execution failed: ${err.message}`));
    });
  });
}
