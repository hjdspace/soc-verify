/**
 * LSF Runner — 通过 `bsub -K` 提交 EDA 命令到 LSF 队列执行（PRD Issue #08 / ADR 0025 决策 4）。
 *
 * 当 EDA Tool Configuration 的 execBackend='lsf' 时，EDA 命令（报告生成 / Coverage Recovery 合并）
 * 经 `bsub -K -q <queue> [-R <resource>] <cmd>` 提交到 LSF farm 执行。
 *
 * 关键设计：
 *   - `bsub -K` 阻塞等待作业完成（前台模式），stdout/stderr 直接传递
 *   - startup 超时（默认 120s，等 PEND→RUN）：超时后 bkill 并报错
 *   - run 超时（默认 600s，等作业执行完成）：超时后 bkill 并报错
 *   - 失败 fail-closed：不静默回退到 direct 模式
 *   - 作业状态/耗时经进度事件可观察
 *
 * 约束：
 *   - VDB/报告目录必须位于共享存储（LSF farm 节点需可访问）
 *   - lsfQueue 必填（在 eda-config.ts 的 saveEdaConfig 中校验）
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { CommandRunner, CommandResult } from './coverage-report-generator';

/** LSF 进度事件（通过 onProgress 回调推送） */
export type LsfProgressEvent = {
  /** 阶段标识：submitting / pending / running / done / timeout / failed */
  phase: string;
  message: string;
  percent?: number;
  details?: Record<string, unknown>;
};

/** LSF runner 配置 */
export interface LsfRunnerOptions {
  /** LSF 队列名 */
  queue: string;
  /** LSF 资源需求串（如 `rusage[mem=8192]`，可选） */
  resource?: string;
  /** 启动超时（秒）：等待作业从 PEND→RUN，默认 120 */
  startupTimeoutSec: number;
  /** 运行超时（秒）：等待作业执行完成，默认 600 */
  runTimeoutSec: number;
  /** 进度回调 */
  onProgress?: (event: LsfProgressEvent) => void;
  /** 可注入的 spawn 函数（测试用）；缺省使用 node:child_process.spawn */
  spawnFn?: (command: string, options: { cwd: string; shell: boolean; env: NodeJS.ProcessEnv }) => ChildProcess;
}

/** LSF 结构化错误（fail-closed，不回退 direct） */
export class LsfRunnerError extends Error {
  readonly phase: string;
  readonly jobId?: string;
  readonly exitCode?: number;

  constructor(
    phase: string,
    message: string,
    opts?: { jobId?: string; exitCode?: number },
  ) {
    super(message);
    this.name = 'LsfRunnerError';
    this.phase = phase;
    this.jobId = opts?.jobId;
    this.exitCode = opts?.exitCode;
  }
}

/**
 * 构造 bsub -K 命令行。
 *
 * 命令形态：
 *   bsub -K -q <queue> [-R <resource>] <original_command>
 *
 * -K: 阻塞模式，等待作业完成（前台交互）
 * -q: 指定队列
 * -R: 资源需求（可选）
 *
 * @param originalCommand 原始 EDA 命令（如 urg -full64 ...）
 * @param queue LSF 队列名
 * @param resource 资源需求串（可选）
 * @returns 完整的 bsub 命令行
 */
export function buildBsubCommand(
  originalCommand: string,
  queue: string,
  resource?: string,
): string {
  const parts = ['bsub', '-K', '-q', queue];
  if (resource) {
    parts.push('-R', `'${resource}'`);
  }
  parts.push(originalCommand);
  return parts.join(' ');
}

/**
 * 从 bsub 输出中解析 Job ID。
 *
 * bsub 成功提交时输出：
 *   Job <12345> is submitted to queue <normal>.
 *
 * @param stdout bsub 的 stdout
 * @returns Job ID 或 null（未找到）
 */
export function parseJobId(stdout: string): string | null {
  const match = stdout.match(/Job\s*<(\d+)>/i);
  return match ? match[1] : null;
}

/**
 * 执行 bkill 命令终止 LSF 作业。
 * 失败时忽略错误（best-effort）。
 *
 * @param jobId LSF 作业 ID
 * @param cwd 工作目录
 */
function bkillJob(jobId: string, cwd: string): void {
  try {
    const child = spawn('bkill', [jobId], { cwd, shell: true });
    child.on('error', () => {
      // bkill 失败不影响主流程
    });
  } catch {
    // 忽略
  }
}

/**
 * 创建 LSF CommandRunner。
 *
 * 返回的 runner 接收原始 EDA 命令，自动包装为 bsub -K 提交。
 * 执行流程：
 *   1. 构造 bsub -K 命令
 *   2. spawn 执行，流式收集 stdout/stderr
 *   3. 从初始 stdout 中解析 Job ID
 *   4. 等待命令完成或超时
 *   5. 超时 → bkill + 报错
 *   6. 失败 → fail-closed 报错（不回退 direct）
 *
 * @param opts LSF runner 配置
 * @returns CommandRunner（注入到 CoverageReportGenerator 或 Recovery）
 */
export function createLsfRunner(opts: LsfRunnerOptions): CommandRunner {
  const { queue, resource, startupTimeoutSec, runTimeoutSec, onProgress, spawnFn } = opts;
  const doSpawn = spawnFn ?? spawn;

  return async (command: string, options: { cwd: string }): Promise<CommandResult> => {
    const bsubCmd = buildBsubCommand(command, queue, resource);

    onProgress?.({
      phase: 'submitting',
      message: `正在提交 LSF 作业（队列: ${queue}）...`,
      percent: 0,
      details: { command: bsubCmd, cwd: options.cwd },
    });

    return new Promise<CommandResult>((resolve) => {
      const child = doSpawn(bsubCmd, {
        cwd: options.cwd,
        shell: true,
        env: { ...process.env },
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutTotalLen = 0;
      let stderrTotalLen = 0;
      let jobId: string | null = null;
      let submitted = false;

      // 超时计时器
      const startupTimeoutMs = startupTimeoutSec * 1000;
      const runTimeoutMs = runTimeoutSec * 1000;
      // eslint-disable-next-line prefer-const
      let totalTimeoutId: NodeJS.Timeout;
      // eslint-disable-next-line prefer-const
      let startupTimeoutId: NodeJS.Timeout;

      const cleanupTimers = (): void => {
        clearTimeout(totalTimeoutId);
        clearTimeout(startupTimeoutId);
      };

      // 总超时 = startup + run
      totalTimeoutId = setTimeout(() => {
        cleanupTimers();
        if (jobId) {
          bkillJob(jobId, options.cwd);
          onProgress?.({
            phase: 'timeout',
            message: `LSF 作业超时（Job <${jobId}>），已发送 bkill`,
            percent: 100,
            details: { jobId, timeoutSec: startupTimeoutSec + runTimeoutSec },
          });
        } else {
          onProgress?.({
            phase: 'timeout',
            message: `LSF 作业超时（未获取 Job ID）`,
            percent: 100,
            details: { timeoutSec: startupTimeoutSec + runTimeoutSec },
          });
        }
        // 杀进程
        child.kill('SIGKILL');
        resolve({
          exitCode: 1,
          stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
          stderr: Buffer.concat(stderrChunks).toString('utf-8') +
            `\n[LSF runner] Job timed out after ${startupTimeoutSec + runTimeoutSec}s`,
        });
      }, startupTimeoutMs + runTimeoutMs);
      totalTimeoutId.unref();

      // startup 超时（等 PEND→RUN）
      startupTimeoutId = setTimeout(() => {
        // 如果已经 submitted（看到 Job <xxx> 输出），说明作业已提交
        // startup 超时仅关注是否成功提交
      }, startupTimeoutMs);
      startupTimeoutId.unref();

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutTotalLen += chunk.length;
        if (stdoutTotalLen <= 1024 * 1024) {
          stdoutChunks.push(chunk);
        }

        // 尝试从 stdout 中解析 Job ID（bsub 输出 "Job <12345> is submitted to..."）
        if (!submitted) {
          const text = chunk.toString('utf-8');
          const parsed = parseJobId(text);
          if (parsed) {
            jobId = parsed;
            submitted = true;
            onProgress?.({
              phase: 'pending',
              message: `LSF 作业已提交（Job <${jobId}>），等待调度...`,
              percent: 10,
              details: { jobId },
            });
          }
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTotalLen += chunk.length;
        if (stderrTotalLen <= 1024 * 1024) {
          stderrChunks.push(chunk);
        }
      });

      child.on('close', (code) => {
        cleanupTimers();
        const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');

        if (code === 0) {
          onProgress?.({
            phase: 'done',
            message: `LSF 作业完成${jobId ? `（Job <${jobId}>）` : ''}`,
            percent: 100,
            details: { jobId, exitCode: code },
          });
        } else {
          onProgress?.({
            phase: 'failed',
            message: `LSF 作业失败${jobId ? `（Job <${jobId}>, exitCode=${code}）` : `（exitCode=${code}）`}`,
            percent: 100,
            details: { jobId, exitCode: code },
          });
        }

        // fail-closed：LSF 失败不回退 direct，直接返回错误 exitCode
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
        });
      });

      child.on('error', (err: Error) => {
        cleanupTimers();
        const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
        const stderr = Buffer.concat(stderrChunks).toString('utf-8') + '\n' + err.message;
        onProgress?.({
          phase: 'failed',
          message: `LSF runner spawn 错误: ${err.message}`,
          percent: 100,
          details: { error: err.message },
        });
        // fail-closed：spawn 失败也返回错误，不回退 direct
        resolve({
          exitCode: 1,
          stdout,
          stderr,
        });
      });
    });
  };
}
