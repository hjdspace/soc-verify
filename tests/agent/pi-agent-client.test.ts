/**
 * PiAgentClient 契约测试（spec 测试缝一）。
 *
 * 通过 vi.mock(node:child_process) 替换 spawn，用 PassThrough 流模拟
 * runner 子进程的 stdin/stdout/stderr，验证真实 JSONL 客户端机制：
 * ready 握手、请求/响应关联、fire-and-forget 命令、事件转发、
 * tool_call/approval 回调、stderr 诊断与退出处理。
 *
 * 覆盖 issue 03 验收项：PiAgentClient 实现 init/prompt/steer/abort/
 * setModel/compact/destroy；runner 异常与 stderr 进入诊断路径。
 */
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentClientOptions } from '../../src/main/agent/types';

// ─── child_process mock ─────────────────────────────────

const h = vi.hoisted(() => ({
  spawnImpl: null as ((...args: unknown[]) => unknown) | null,
  spawnCalls: [] as Array<{ cmd: unknown; args: unknown; opts: Record<string, unknown> | undefined }>,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      h.spawnCalls.push({ cmd: args[0], args: args[1], opts: args[2] as Record<string, unknown> });
      return h.spawnImpl!(...args);
    },
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
  emit: (event: string, ...args: unknown[]) => void;
};

const framesToRunner: unknown[] = [];

function makeFakeChild(): FakeChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  framesToRunner.length = 0;

  // 收集 client 写入 stdin 的 JSONL 帧
  let buffer = '';
  stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) framesToRunner.push(JSON.parse(line));
    }
  });

  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const child: FakeChild = {
    stdin,
    stdout,
    stderr,
    pid: 4242,
    killed: false,
    emit: (event, ...args) => {
      for (const cb of listeners.get(event) ?? []) cb(...args);
    },
  };
  // AgentClient 通过 child.on 注册 error/exit 监听
  (child as unknown as { on: (event: string, cb: (...args: unknown[]) => void) => void }).on = (
    event,
    cb,
  ) => {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event)!.push(cb);
    return child;
  };
  return child;
}

/** runner → host：向 stdout 写一行 JSONL 帧 */
function fromRunner(frame: unknown): void {
  currentChild.stdout.write(`${JSON.stringify(frame)}\n`);
}

/** 等待 client 向 runner 写出第 n 帧（stdin 流是异步投递的） */
async function waitForFrames(count: number): Promise<void> {
  await vi.waitFor(() => {
    if (framesToRunner.length < count) throw new Error(`only ${framesToRunner.length} frames`);
  });
}

let currentChild: FakeChild;

function makeOptions(overrides: Partial<AgentClientOptions> = {}): AgentClientOptions {
  return {
    runnerPath: join('resources', 'runner-pi', 'index.ts'),
    cwd: tmpdir(),
    ...overrides,
  };
}

beforeEach(() => {
  h.spawnCalls.length = 0;
  currentChild = makeFakeChild();
  h.spawnImpl = () => currentChild;
});

afterEach(() => {
  h.spawnImpl = null;
});

// ─── start / 引擎标识 ───────────────────────────────────

describe('PiAgentClient.start', () => {
  it('ready 握手：以 Node 脚本模式启动 runner，收到 ready 帧后就绪', async () => {
    const client = new PiAgentClient(makeOptions());
    const startPromise = client.start();
    fromRunner({ type: 'ready' });
    await startPromise;

    expect(client.engine).toBe('pi');
    expect(client.isRunning()).toBe(true);
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.spawnCalls[0].cmd).toBe(process.execPath);
    expect(h.spawnCalls[0].args).toEqual([join('resources', 'runner-pi', 'index.ts')]);
    client.stop();
  });

  it('注入 ELECTRON_RUN_AS_NODE=1（Electron 下复用内置 Node），显式 env 可覆盖', async () => {
    const client = new PiAgentClient(makeOptions({ env: { MY_VAR: 'x' } }));
    const startPromise = client.start();
    fromRunner({ type: 'ready' });
    await startPromise;

    const env = h.spawnCalls[0].opts?.env as Record<string, string>;
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(env.MY_VAR).toBe('x');
    client.stop();
  });

  it('进程在 ready 前退出 → start 拒绝并携带 stderr 诊断', async () => {
    const client = new PiAgentClient(makeOptions());
    const startPromise = client.start();
    currentChild.stderr.write('fatal: model registry exploded\n');
    currentChild.emit('exit', 1, null);

    await expect(startPromise).rejects.toThrow(/exited before ready/);
    expect(client.getStderr()).toContain('model registry exploded');
  });

  it('缺少 runnerPath 时报清晰错误', () => {
    expect(() => new PiAgentClient(makeOptions({ runnerPath: undefined }))).not.toThrow();
    const client = new PiAgentClient(makeOptions({ runnerPath: undefined }));
    void client.start().catch(() => {});
    // resolveSpawn 在 start 同步段抛错
    return expect(client.start()).rejects.toThrow(/runnerPath/);
  });
});

// ─── 会话命令 ───────────────────────────────────────────

describe('PiAgentClient 会话命令', () => {
  async function startClient(): Promise<InstanceType<typeof PiAgentClient>> {
    const client = new PiAgentClient(makeOptions());
    const startPromise = client.start();
    fromRunner({ type: 'ready' });
    await startPromise;
    return client;
  }

  it('init 发送 init 命令并把 sessionId 映射为 engineSessionId', async () => {
    const client = await startClient();
    const initPromise = client.init({ cwd: '/proj/dv', contextWindow: 128000, customToolDefinitions: [] });
    await waitForFrames(1);
    expect(framesToRunner[0]).toMatchObject({ type: 'init', id: 'req_1' });

    fromRunner({ id: 'req_1', type: 'response', success: true, data: { sessionId: 'pi-abc-123' } });
    await expect(initPromise).resolves.toEqual({ engineSessionId: 'pi-abc-123' });
    client.stop();
  });

  it('init 失败响应 → 拒绝并携带 runner 错误信息', async () => {
    const client = await startClient();
    const initPromise = client.init({ cwd: '/proj/dv', contextWindow: 128000, customToolDefinitions: [] });
    await waitForFrames(1);
    fromRunner({ id: 'req_1', type: 'response', success: false, error: 'model not configured' });

    await expect(initPromise).rejects.toThrow('model not configured');
    client.stop();
  });

  it('regenerate 发送 regenerate 命令并透传 runner 的 engineSessionId（issue 08）', async () => {
    const client = await startClient();
    const regenPromise = client.regenerate();
    await waitForFrames(1);
    expect(framesToRunner[0]).toMatchObject({ type: 'regenerate', id: 'req_1' });

    fromRunner({ id: 'req_1', type: 'response', success: true, data: { engineSessionId: 'pi-branch-9' } });
    await expect(regenPromise).resolves.toEqual({ engineSessionId: 'pi-branch-9' });
    client.stop();
  });

  it('regenerate 失败响应 → 拒绝并携带 runner 错误信息', async () => {
    const client = await startClient();
    const regenPromise = client.regenerate();
    await waitForFrames(1);
    fromRunner({ id: 'req_1', type: 'response', success: false, error: 'Session is streaming — wait until idle' });

    await expect(regenPromise).rejects.toThrow('wait until idle');
    client.stop();
  });

  it('prompt / steer 是 fire-and-forget（不等待响应帧）', async () => {
    const client = await startClient();
    await client.prompt('跑一下仿真', ['data:image/png;base64,AAA']);
    await client.steer('顺便更新文档');
    await waitForFrames(2);

    expect(framesToRunner[0]).toMatchObject({ type: 'prompt', message: '跑一下仿真', images: ['data:image/png;base64,AAA'] });
    expect(framesToRunner[1]).toMatchObject({ type: 'steer', message: '顺便更新文档' });
    client.stop();
  });

  it('setModel / compact / destroy 发送对应命令', async () => {
    const client = await startClient();

    const setModelPromise = client.setModel('zhipu', 'glm-5');
    await waitForFrames(1);
    expect(framesToRunner[0]).toMatchObject({ type: 'setModel', provider: 'zhipu', modelId: 'glm-5' });
    fromRunner({ id: 'req_1', type: 'response', success: true, data: { ok: true } });
    await setModelPromise;

    const compactPromise = client.compact();
    await waitForFrames(2);
    fromRunner({ id: 'req_2', type: 'response', success: true, data: { result: { summary: 'done' } } });
    await expect(compactPromise).resolves.toEqual({ result: { summary: 'done' } });

    await client.destroy();
    await waitForFrames(3);
    expect(framesToRunner[2]).toMatchObject({ type: 'destroy' });
    expect(client.isRunning()).toBe(false);
  });

  it('abort 发送 abort 命令并硬杀进程树', async () => {
    const client = await startClient();
    await client.abort();
    await waitForFrames(1);
    expect(framesToRunner[0]).toMatchObject({ type: 'abort' });
    expect(client.isRunning()).toBe(false);
  });

  it('runner 未启动时命令抛错', async () => {
    const client = new PiAgentClient(makeOptions());
    await expect(client.setModel('zhipu', 'glm-5')).rejects.toThrow('Client not started');
    await expect(client.compact()).rejects.toThrow('Client not started');
  });
});

// ─── 回调与事件 ─────────────────────────────────────────

describe('PiAgentClient 回调与事件', () => {
  async function startClient(): Promise<InstanceType<typeof PiAgentClient>> {
    const client = new PiAgentClient(makeOptions());
    const startPromise = client.start();
    fromRunner({ type: 'ready' });
    await startPromise;
    return client;
  }

  it('事件帧分发给所有监听者，退订后不再接收', async () => {
    const client = await startClient();
    const received: unknown[] = [];
    const unsubscribe = client.onEvent((event) => received.push(event));

    fromRunner({ type: 'event', event: { type: 'agent_start' } });
    fromRunner({ type: 'event', event: { type: 'message_end', message: {} } });
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received[0]).toEqual({ type: 'agent_start' });

    unsubscribe();
    fromRunner({ type: 'event', event: { type: 'agent_end' } });
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(2);
    client.stop();
  });

  it('tool_call 转发给 handler，字符串结果包装为 content 帧回流', async () => {
    const client = await startClient();
    const askArgs = { questions: [{ id: 'q1', question: '继续吗？', options: [] }] };
    const handler = vi.fn(async (toolName: string, args: unknown) => {
      expect(toolName).toBe('ask');
      expect(args).toEqual(askArgs);
      return '用户回答：继续';
    });
    client.setToolCallHandler(handler);

    fromRunner({ type: 'tool_call', id: 'tool_1', toolName: 'ask', args: askArgs });
    await waitForFrames(1);
    expect(framesToRunner[0]).toMatchObject({
      type: 'tool_result',
      id: 'tool_1',
      result: { content: [{ type: 'text', text: '用户回答：继续' }] },
    });
    client.stop();
  });

  it('tool handler 抛错 → isError 结果回流', async () => {
    const client = await startClient();
    client.setToolCallHandler(async () => {
      throw new Error('host tool crashed');
    });

    fromRunner({ type: 'tool_call', id: 'tool_2', toolName: 'coverage_report', args: {} });
    await waitForFrames(1);
    expect(framesToRunner[0]).toMatchObject({
      type: 'tool_result',
      id: 'tool_2',
      result: 'host tool crashed',
      isError: true,
    });
    client.stop();
  });

  it('未注册 tool handler → 错误结果回流，不挂起引擎', async () => {
    const client = await startClient();
    fromRunner({ type: 'tool_call', id: 'tool_3', toolName: 'ask', args: {} });
    await waitForFrames(1);
    expect(framesToRunner[0]).toMatchObject({
      type: 'tool_result',
      id: 'tool_3',
      isError: true,
    });
    client.stop();
  });

  it('approval_request 转发给 approvalHandler 并回传决策', async () => {
    const client = await startClient();
    const handler = vi.fn(async () => false);
    client.setApprovalHandler(handler);

    fromRunner({ type: 'approval_request', id: 'ap_1', toolName: 'bash', args: {} });
    await waitForFrames(1);
    expect(handler).toHaveBeenCalledWith('ap_1', 'bash', {});
    expect(framesToRunner[0]).toMatchObject({ type: 'approval_response', id: 'ap_1', approved: false });
    client.stop();
  });

  it('runner 退出时拒绝在途请求并标记非运行状态', async () => {
    const client = await startClient();
    const compactPromise = client.compact();
    currentChild.emit('exit', 0, null);

    await expect(compactPromise).rejects.toThrow(/Process exited/);
    expect(client.isRunning()).toBe(false);
  });

  it('ready 后进程崩溃（非主动 stop）→ 合成 error 事件分发给监听者（issue 08）', async () => {
    const client = await startClient();
    const received: Array<{ type?: string; error?: string }> = [];
    client.onEvent((event) => received.push(event as { type?: string; error?: string }));

    currentChild.emit('exit', 1, null);
    await vi.waitFor(() => expect(received).toHaveLength(1));

    expect(received[0].type).toBe('error');
    expect(received[0].error).toContain('code=1');
  });

  it('主动 stop 后的退出不合成 error 事件（用户发起的销毁不是崩溃）', async () => {
    const client = await startClient();
    const received: unknown[] = [];
    client.onEvent((event) => received.push(event));

    client.stop();
    currentChild.emit('exit', 0, null);
    await new Promise((r) => setTimeout(r, 20));

    expect(received).toHaveLength(0);
  });

  it('ready 前退出不合成 error 事件（start() 拒绝路径已处理）', async () => {
    const client = new PiAgentClient(makeOptions());
    const received: unknown[] = [];
    client.onEvent((event) => received.push(event));
    const startPromise = client.start();
    currentChild.emit('exit', 1, null);
    await expect(startPromise).rejects.toThrow(/exited before ready/);
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toHaveLength(0);
  });
});
