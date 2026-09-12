/**
 * host 侧模型/上下文 parity 契约（issue 06）。
 *
 * - AgentClient.getSystemPrompt：pi runner 返回生效系统提示词；
 *   runner 对未知命令返回失败响应时优雅降级为 null，
 *   UI 可以无差别调用。
 * - ContextUsage.approximate：shared 类型带近似标记（pi 原生值为
 *   false，runner 估算值为 true），renderer 据此展示。
 */
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  spawnImpl: null as ((...args: unknown[]) => unknown) | null,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => h.spawnImpl!(...args),
    execFileSync: vi.fn(() => ''),
  };
});

const { PiAgentClient } = await import('../../src/main/agent/pi-agent-client');

// ─── Fake runner 子进程 ─────────────────────────────────

type FakeChild = {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number;
  killed: boolean;
};

function makeFakeChild(): FakeChild & {
  on: (event: string, cb: (...args: unknown[]) => void) => unknown;
  emit: (event: string, ...args: unknown[]) => void;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const child = {
    stdin,
    stdout,
    stderr,
    pid: 4242,
    killed: false,
    on: (event: string, cb: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(cb);
      return child;
    },
    emit: (event: string, ...args: unknown[]) => {
      for (const cb of listeners.get(event) ?? []) cb(...args);
    },
  };
  return child;
}

let currentChild: ReturnType<typeof makeFakeChild>;

function fromRunner(frame: unknown): void {
  currentChild.stdout.write(`${JSON.stringify(frame)}\n`);
}

async function startPiClient(): Promise<InstanceType<typeof PiAgentClient>> {
  const client = new PiAgentClient({ runnerPath: join('resources', 'runner-pi', 'index.ts'), cwd: tmpdir() });
  const startPromise = client.start();
  fromRunner({ type: 'ready' });
  await startPromise;
  return client;
}

beforeEach(() => {
  currentChild = makeFakeChild();
  h.spawnImpl = () => currentChild;
});

afterEach(() => {
  h.spawnImpl = null;
});

// ─── getSystemPrompt ────────────────────────────────────

describe('AgentClient.getSystemPrompt', () => {
  it('pi runner 成功响应时返回生效系统提示词', async () => {
    const client = await startPiClient();
    const promise = client.getSystemPrompt();
    // getSystemPrompt 是该客户端发出的第一个命令 → id 固定为 req_1
    fromRunner({
      id: 'req_1',
      type: 'response',
      success: true,
      data: { systemPrompt: 'pi default\n+ SoC Verify rules' },
    });

    await expect(promise).resolves.toBe('pi default\n+ SoC Verify rules');
    client.stop();
  });

  it('runner 对未知命令返回失败响应时优雅返回 null', async () => {
    const client = await startPiClient();
    const promise = client.getSystemPrompt();
    fromRunner({ id: 'req_1', type: 'response', success: false, error: 'Unknown command type: getSystemPrompt' });

    await expect(promise).resolves.toBeNull();
    client.stop();
  });

  it('runner 异常退出时也返回 null（不向调用方抛错）', async () => {
    const client = await startPiClient();
    const promise = client.getSystemPrompt();
    currentChild.emit('exit', 1, null);

    await expect(promise).resolves.toBeNull();
  });
});

// ─── shared ContextUsage.approximate ────────────────────

describe('ContextUsage.approximate 契约', () => {
  it('shared 类型包含可选 approximate 标记', async () => {
    const mod = await import('../../src/shared/context-management');
    // 类型层验证（编译期）+ 运行时字段自由度验证
    const usage: import('../../src/shared/context-management').ContextUsage = {
      tokens: 100,
      contextWindow: 1000,
      percent: 10,
      approximate: true,
    };
    expect(mod.DEFAULT_CONTEXT_WINDOW).toBeGreaterThan(0);
    expect(usage.approximate).toBe(true);
  });
});
