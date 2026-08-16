/**
 * draw.io desktop CLI 导出器 —— 把 .drawio 导出为 PNG / SVG / PDF / JPG。
 *
 * 命令形态：`drawio -x -f <fmt> -o <out> <in>`。
 * Linux（含内置 AppImage 解压产物）追加 `--no-sandbox --disable-gpu`，
 * 避免 headless / root 环境下 Electron sandbox 崩溃。
 *
 * draw.io CLI 不支持并发导出（同一用户数据目录下多实例会相互干扰），
 * 用串行队列保证同一时刻只有一条导出命令在跑。
 */

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolveDrawioPath } from './binary';

/** 支持的导出格式（与 draw.io CLI -f 参数一致） */
export type DrawioExportFormat = 'png' | 'svg' | 'pdf' | 'jpg';

export type DrawioExportOptions = {
  /** 输入 .drawio 文件绝对路径 */
  inputPath: string;
  /** 导出格式 */
  format: DrawioExportFormat;
  /** 输出文件绝对路径（调用方已确认扩展名） */
  outputPath: string;
  /** PNG/JPG 放大倍数（默认 1；2 即 2x 分辨率） */
  scale?: number;
  /** PNG 透明背景（仅 png 有效） */
  transparent?: boolean;
  /** 裁掉画布空白边（pdf/svg 推荐） */
  crop?: boolean;
  /** 超时毫秒数（默认 60s） */
  timeoutMs?: number;
};

export type DrawioExportResult = {
  success: boolean;
  outputPath: string;
  sizeBytes: number;
  stderr?: string;
};

/** CLI 不可用 / 参数非法 / 导出失败 */
export class DrawioNotAvailableError extends Error {
  constructor() {
    super('draw.io CLI not available');
    this.name = 'DrawioNotAvailableError';
  }
}

export class DrawioExportError extends Error {
  constructor(
    message: string,
    readonly stderr?: string,
  ) {
    super(message);
    this.name = 'DrawioExportError';
  }
}

/** 格式对应的文件扩展名 */
export function formatExtension(format: DrawioExportFormat): string {
  return format === 'jpg' ? 'jpg' : format;
}

/** 构造 CLI 参数（导出器内部使用，导出便于测试） */
export function buildExportArgs(options: DrawioExportOptions): string[] {
  const args = ['-x', '-f', options.format, '-o', options.outputPath, options.inputPath];
  if (options.scale !== undefined && (options.format === 'png' || options.format === 'jpg')) {
    args.push('-s', String(options.scale));
  }
  if (options.transparent === true && options.format === 'png') {
    args.push('-t');
  }
  if (options.crop === true && (options.format === 'pdf' || options.format === 'svg')) {
    args.push('--crop');
  }
  if (process.platform === 'linux') {
    args.push('--no-sandbox', '--disable-gpu');
  }
  return args;
}

// ── 串行队列：同一时刻只跑一条导出命令 ─────────────────────

let queueTail: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queueTail.then(task, task);
  // 队列尾部吞掉错误，避免影响后续任务
  queueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 单次导出执行（spawn CLI，等待退出并校验产物） */
function runExport(options: DrawioExportOptions): Promise<DrawioExportResult> {
  const binaryPath = resolveDrawioPath();
  if (!binaryPath) {
    return Promise.reject(new DrawioNotAvailableError());
  }

  return new Promise<DrawioExportResult>((resolvePromise, rejectPromise) => {
    const child = spawn(binaryPath, buildExportArgs(options), {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' },
    });

    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new DrawioExportError(`export timeout after ${options.timeoutMs ?? 60_000}ms`, stderr));
    }, options.timeoutMs ?? 60_000);

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      // 防止极端情况下 stderr 无限增长
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      rejectPromise(new DrawioExportError(`spawn failed: ${err.message}`, stderr));
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        rejectPromise(new DrawioExportError(`drawio exited with code ${code}`, stderr));
        return;
      }
      if (!existsSync(options.outputPath) || statSync(options.outputPath).size === 0) {
        rejectPromise(new DrawioExportError('output file missing or empty', stderr));
        return;
      }
      resolvePromise({
        success: true,
        outputPath: options.outputPath,
        sizeBytes: statSync(options.outputPath).size,
      });
    });
  });
}

/** 导出 .drawio 文件（串行队列包装）。CLI 缺失抛 DrawioNotAvailableError。 */
export function exportDiagram(options: DrawioExportOptions): Promise<DrawioExportResult> {
  return enqueue(() => runExport(options));
}
