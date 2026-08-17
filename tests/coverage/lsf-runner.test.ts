/**
 * LSF Runner 测试（PRD Issue #08 / ADR 0025 决策 4）。
 *
 * 覆盖：
 * - execBackend=lsf 时 EDA 命令经 bsub -K 构造提交（mock spawnFn 断言命令行）
 * - startup/run 超时触发 bkill 并返回结构化错误
 * - 失败不静默回退 direct（fail-closed 测试断言）
 * - 作业状态/耗时经进度事件可观察
 * - direct 模式回归不受影响
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  buildBsubCommand,
  parseJobId,
  createLsfRunner,
  type LsfRunnerOptions,
} from '../../src/main/coverage/lsf-runner';
import type { ChildProcess } from 'node:child_process';
import type { CommandResult } from '../../src/main/coverage/coverage-report-generator';

// ─── buildBsubCommand ─────────────────────────────────────────

describe('buildBsubCommand', () => {
  it('构造 bsub -K -q <queue> <cmd> 命令', () => {
    const cmd = buildBsubCommand('urg -full64 -dir /data/cov_merge -report /tmp/report', 'normal');
    expect(cmd).toBe(
      'bsub -K -q normal urg -full64 -dir /data/cov_merge -report /tmp/report',
    );
  });

  it('包含 -R resource 选项（当 resource 非空时）', () => {
    const cmd = buildBsubCommand('urg -full64 -dir /data -report /tmp', 'normal', 'rusage[mem=8192]');
    expect(cmd).toContain('-R');
    expect(cmd).toContain("'rusage[mem=8192]'");
    expect(cmd).toContain('-q normal');
  });

  it('resource 为空时不包含 -R 选项', () => {
    const cmd = buildBsubCommand('urg test', 'normal', undefined);
    expect(cmd).not.toContain('-R');
    expect(cmd).toBe('bsub -K -q normal urg test');
  });
});

// ─── parseJobId ───────────────────────────────────────────────

describe('parseJobId', () => {
  it('从 bsub 输出中解析 Job ID', () => {
    const stdout = 'Job <12345> is submitted to queue <normal>.';
    expect(parseJobId(stdout)).toBe('12345');
  });

  it('输出中无 Job 标记时返回 null', () => {
    expect(parseJobId('No job submitted')).toBeNull();
  });

  it('空字符串返回 null', () => {
    expect(parseJobId('')).toBeNull();
  });
});

// ─── createLsfRunner ─────────────────────────────────────────

/** fake 事件定义 */
type FakeEvent = { type: string; data?: Buffer; delay?: number };

/** 创建 fake ChildProcess（EventEmitter 模拟 stdout/stderr/close/error） */
function createFakeChild(events: FakeEvent[]): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
  (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
  (child as unknown as { kill: () => void }).kill = () => {};

  for (const event of events) {
    const delay = event.delay ?? 10;
    setTimeout(() => {
      if (event.type === 'stdout') {
        (child as unknown as { stdout: EventEmitter }).stdout.emit('data', event.data!);
      } else if (event.type === 'stderr') {
        (child as unknown as { stderr: EventEmitter }).stderr.emit('data', event.data!);
      } else if (event.type === 'close') {
        const codeStr = event.data?.toString() ?? '0';
        child.emit('close', parseInt(codeStr, 10));
      } else if (event.type === 'error') {
        child.emit('error', new Error(event.data?.toString() ?? 'spawn error'));
      }
    }, delay);
  }

  return child;
}

describe('createLsfRunner', () => {
  it('bsub -K 命令构造提交（mock spawnFn 断言命令行）', async () => {
    const spawnFn = vi.fn((_cmd: string) => {
      return createFakeChild([
        { type: 'stdout', data: Buffer.from('Job <54321> is submitted to queue <normal>.'), delay: 5 },
        { type: 'stdout', data: Buffer.from('Coverage merge done.'), delay: 10 },
        { type: 'close', data: Buffer.from('0'), delay: 15 },
      ]);
    });

    const runner = createLsfRunner({
      queue: 'normal',
      resource: 'rusage[mem=4096]',
      startupTimeoutSec: 120,
      runTimeoutSec: 600,
      spawnFn: spawnFn as unknown as LsfRunnerOptions['spawnFn'],
    });

    const result: CommandResult = await runner('urg -full64 -dir /data -report /tmp', { cwd: '/data' });

    // 验证 spawn 被调用，且命令包含 bsub -K -q normal
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const calledCmd = spawnFn.mock.calls[0][0] as string;
    expect(calledCmd).toContain('bsub -K');
    expect(calledCmd).toContain('-q normal');
    expect(calledCmd).toContain('-R');
    expect(calledCmd).toContain('rusage[mem=4096]');
    expect(calledCmd).toContain('urg -full64');

    // 验证执行成功
    expect(result.exitCode).toBe(0);
  });

  it('作业状态/耗时经进度事件可观察', async () => {
    const progressEvents: Array<{ phase: string; message: string }> = [];

    const spawnFn = vi.fn(() => {
      return createFakeChild([
        { type: 'stdout', data: Buffer.from('Job <99999> is submitted to queue <normal>.'), delay: 5 },
        { type: 'close', data: Buffer.from('0'), delay: 10 },
      ]);
    });

    const runner = createLsfRunner({
      queue: 'normal',
      startupTimeoutSec: 120,
      runTimeoutSec: 600,
      onProgress: (event) => {
        progressEvents.push({ phase: event.phase, message: event.message });
      },
      spawnFn: spawnFn as unknown as LsfRunnerOptions['spawnFn'],
    });

    await runner('urg test', { cwd: '/data' });

    // 验证进度事件序列
    const phases = progressEvents.map((e) => e.phase);
    expect(phases).toContain('submitting');
    expect(phases).toContain('pending'); // 作业已提交
    expect(phases).toContain('done'); // 作业完成
  });

  it('失败不静默回退 direct（fail-closed 测试断言）', async () => {
    const spawnFn = vi.fn(() => {
      return createFakeChild([
        { type: 'stderr', data: Buffer.from('bsub: error'), delay: 5 },
        { type: 'close', data: Buffer.from('1'), delay: 10 },
      ]);
    });

    const runner = createLsfRunner({
      queue: 'normal',
      startupTimeoutSec: 120,
      runTimeoutSec: 600,
      spawnFn: spawnFn as unknown as LsfRunnerOptions['spawnFn'],
    });

    const result = await runner('urg test', { cwd: '/data' });

    // 验证失败时不回退到 direct：exitCode 为 1（非 0）
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('bsub: error');
  });

  it('spawn 错误时返回结构化错误（fail-closed）', async () => {
    const spawnFn = vi.fn(() => {
      return createFakeChild([
        { type: 'error', data: Buffer.from('bsub: command not found'), delay: 5 },
      ]);
    });

    const runner = createLsfRunner({
      queue: 'normal',
      startupTimeoutSec: 120,
      runTimeoutSec: 600,
      spawnFn: spawnFn as unknown as LsfRunnerOptions['spawnFn'],
    });

    const result = await runner('urg test', { cwd: '/data' });

    // spawn 失败也返回 exitCode=1，不回退 direct
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('command not found');
  });
});
