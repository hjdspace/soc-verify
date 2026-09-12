/**
 * runner-pi session.ts —— pi-subagents 扩展装配（issue 05）。
 *
 * 通过 vi.mock 隔离 jiti 模块加载（pi-subagents / capability-ceiling）与
 * pi SDK，验证 init 装配链路：扩展注册、能力不足显式阻断、审批继承
 * ceiling 注册与动态更新、cancelSubagent RPC stop 命令。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiRunnerContext } from '../../runner-pi/protocol';

const sendResponse = vi.fn();
const sendEvent = vi.fn();

vi.mock('../../runner-pi/protocol', async () => ({
  sendResponse: (...args: unknown[]) => sendResponse(...args),
  sendEvent: (...args: unknown[]) => sendEvent(...args),
  sendToolCall: vi.fn(),
  send: vi.fn(),
}));

// ─── jiti 模块加载 mock ─────────────────────────────────

type FakeEventBus = { emit: (ch: string, data: unknown) => void; on: (ch: string, cb: (d: unknown) => void) => () => void };

const fakeExtensionFactory = vi.fn();
const registerSubagentCapabilityCeiling = vi.fn(() => ({
  update: vi.fn(),
  dispose: vi.fn(),
}));

let subagentModuleError: Error | null = null;

vi.mock('jiti', () => ({
  createJiti: () => ({
    import: async (id: string) => {
      if (id === 'pi-subagents') {
        if (subagentModuleError) throw subagentModuleError;
        return { default: fakeExtensionFactory };
      }
      if (id === 'pi-subagents/capability-ceiling') {
        return { registerSubagentCapabilityCeiling };
      }
      throw new Error(`unexpected jiti import: ${id}`);
    },
  }),
}));

const createAgentSession = vi.fn();

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: (...args: unknown[]) => createAgentSession(...args),
  SessionManager: { create: () => ({ __fakeSessionManager: true }) },
  DefaultResourceLoader: class {
    extensionFactories: unknown[];
    constructor(opts: { extensionFactories?: unknown[] }) {
      this.extensionFactories = opts.extensionFactories ?? [];
    }
    async reload(_opts: unknown) {}
  },
  getAgentDir: () => '/fake/agent-dir',
  hasTrustRequiringProjectResources: () => false,
  SettingsManager: { create: () => ({ __fakeSettingsManager: true, applyOverrides: () => {} }) },
}));

const { handleInit, handleSetApprovalMode, handleCancelSubagent } = await import(
  '../../runner-pi/session'
);

// ─── 测试脚手架 ─────────────────────────────────────────

type FakeSession = Record<string, unknown> & { sessionId: string };

function makeSession(overrides: Record<string, unknown> = {}): FakeSession {
  return {
    sessionId: 'pi-session-0001',
    modelRuntime: {
      setRuntimeApiKey: vi.fn(async () => undefined),
      getModel: vi.fn(() => undefined),
    },
    setModel: vi.fn(async () => undefined),
    subscribe: vi.fn(() => vi.fn()),
    prompt: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    compact: vi.fn(async () => ({ summary: 'compacted' })),
    dispose: vi.fn(),
    ...overrides,
  };
}

function makeCtx(session: unknown = null): PiRunnerContext {
  return {
    session,
    unsubscribe: null,
    currentCwd: '',
    currentApprovalMode: 'always-ask',
    callHostTool: vi.fn(async () => ({})),
    requestApproval: vi.fn(async () => true),
    requestTrust: vi.fn(async () => true),
    mcpRuntime: null,
    subagentRuntime: null,
  } as PiRunnerContext;
}

const lastLoader = () => {
  const lastCall = createAgentSession.mock.calls.at(-1);
  return (lastCall?.[0] as { resourceLoader: { extensionFactories: unknown[] } })?.resourceLoader;
};

beforeEach(() => {
  sendResponse.mockClear();
  sendEvent.mockClear();
  fakeExtensionFactory.mockClear();
  registerSubagentCapabilityCeiling.mockClear();
  subagentModuleError = null;
  createAgentSession.mockReset();
  createAgentSession.mockImplementation(async () => ({ session: makeSession() }));
});

afterEach(() => {
  subagentModuleError = null;
});

// ─── init 装配 ──────────────────────────────────────────

describe('handleInit subagent 装配', () => {
  it('默认装配 pi-subagents 扩展，response 携带 subagent enabled 状态', async () => {
    const ctx = makeCtx();
    await handleInit({ id: 'req_1', type: 'init', config: { cwd: '/proj/dv' } }, ctx);

    const factories = lastLoader().extensionFactories as Array<{
      name: string;
      factory: (pi: unknown) => void;
    }>;
    const sub = factories.find((f) => f.name === 'socverify-subagents');
    expect(sub).toBeDefined();
    sub?.factory({});
    expect(fakeExtensionFactory).toHaveBeenCalled();
    expect(ctx.subagentRuntime).toMatchObject({ enabled: true, blockedReason: null });
    expect(sendResponse).toHaveBeenCalledWith(
      'req_1',
      true,
      expect.objectContaining({
        sessionId: 'pi-session-0001',
        subagent: { enabled: true, blockedReason: null },
      }),
    );
  });

  it('父会话审批模式为 always-ask 时按 sessionId 注册审批继承 ceiling', async () => {
    const ctx = makeCtx();
    ctx.currentApprovalMode = 'always-ask';
    await handleInit({ id: 'req_2', type: 'init', config: { cwd: '/p' } }, ctx);

    expect(registerSubagentCapabilityCeiling).toHaveBeenCalledWith({
      sessionId: 'pi-session-0001',
      source: 'socverify-approval-inheritance',
      ceiling: { denyExtensions: true },
    });
    expect(ctx.subagentRuntime?.ceilingHandle).not.toBeNull();
  });

  it('yolo 模式不注册 ceiling（单次审批放宽，信任边界独立）', async () => {
    const ctx = makeCtx();
    await handleInit(
      { id: 'req_3', type: 'init', config: { cwd: '/p', approvalMode: 'yolo' } },
      ctx,
    );
    expect(registerSubagentCapabilityCeiling).not.toHaveBeenCalled();
    expect(ctx.subagentRuntime?.ceilingHandle).toBeNull();
  });

  it('扩展加载失败时 init 不失败，显式报告 blockedReason 并发 notice（不静默降级）', async () => {
    subagentModuleError = new Error('pi-subagents not installed');
    const ctx = makeCtx();
    await handleInit({ id: 'req_4', type: 'init', config: { cwd: '/p' } }, ctx);

    expect(ctx.subagentRuntime).toMatchObject({
      enabled: false,
      blockedReason: expect.stringContaining('pi-subagents not installed'),
    });
    expect(sendResponse).toHaveBeenCalledWith(
      'req_4',
      true,
      expect.objectContaining({
        subagent: { enabled: false, blockedReason: expect.stringContaining('pi-subagents not installed') },
      }),
    );
    const notices = sendEvent.mock.calls.filter(
      ([event]) => (event as { type?: string })?.type === 'notice',
    );
    expect(notices.length).toBe(1);
  });

  it('enableSubagents=false 显式停用，无阻断原因', async () => {
    const ctx = makeCtx();
    await handleInit(
      { id: 'req_5', type: 'init', config: { cwd: '/p', enableSubagents: false } },
      ctx,
    );
    expect(fakeExtensionFactory).not.toHaveBeenCalled();
    expect(ctx.subagentRuntime).toMatchObject({ enabled: false, blockedReason: null });
  });
});

// ─── 审批模式动态更新 ───────────────────────────────────

describe('handleSetApprovalMode ceiling 同步', () => {
  it('ceiling 存在时 update 跟随新模式', () => {
    const ctx = makeCtx();
    const update = vi.fn();
    ctx.subagentRuntime = {
      enabled: true,
      blockedReason: null,
      registry: { runs: new Map() },
      events: null,
      ceilingHandle: { update, dispose: vi.fn() },
    };
    ctx.currentApprovalMode = 'write';

    handleSetApprovalMode({ id: 'c1', type: 'setApprovalMode', approvalMode: 'always-ask' }, ctx);
    expect(update).toHaveBeenCalledWith({ denyExtensions: true });
  });

  it('切到 yolo 时 dispose ceiling（不再收紧子会话）', () => {
    const ctx = makeCtx();
    const dispose = vi.fn();
    ctx.subagentRuntime = {
      enabled: true,
      blockedReason: null,
      registry: { runs: new Map() },
      events: null,
      ceilingHandle: { update: vi.fn(), dispose },
    };

    handleSetApprovalMode({ id: 'c2', type: 'setApprovalMode', approvalMode: 'yolo' }, ctx);
    expect(dispose).toHaveBeenCalled();
    expect(ctx.subagentRuntime?.ceilingHandle).toBeNull();
  });
});

// ─── cancelSubagent（取消传播 host 出口）────────────────

describe('handleCancelSubagent', () => {
  it('经 pi.events 发出 RPC stop 请求并在 reply 到达时响应', async () => {
    const ctx = makeCtx();
    const handlers = new Map<string, Set<(d: unknown) => void>>();
    const events: FakeEventBus = {
      emit: vi.fn((ch: string, data: unknown) => {
        for (const cb of handlers.get(ch) ?? []) cb(data);
      }),
      on: (ch: string, cb: (d: unknown) => void) => {
        if (!handlers.has(ch)) handlers.set(ch, new Set());
        handlers.get(ch)!.add(cb);
        return () => handlers.get(ch)!.delete(cb);
      },
    };
    ctx.subagentRuntime = {
      enabled: true,
      blockedReason: null,
      registry: { runs: new Map() },
      events,
      ceilingHandle: null,
    };

    const pending = handleCancelSubagent(
      { id: 'c3', type: 'cancelSubagent', target: { runId: 'run-9' } },
      ctx,
    );

    // reply 在微任务后到达
    await Promise.resolve();
    const emits = (events.emit as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown]>;
    const stopCall = emits.find(([ch]) => ch === 'subagents:rpc:v1:request');
    expect(stopCall).toBeDefined();
    const envelope = stopCall![1] as { requestId: string; method: string; params: unknown };
    expect(envelope.method).toBe('stop');
    expect(envelope.params).toEqual({ runId: 'run-9' });

    events.emit(`subagents:rpc:v1:reply:${envelope.requestId}`, {
      version: 1,
      requestId: envelope.requestId,
      success: true,
      data: { stopped: true },
    });
    await pending;

    expect(sendResponse).toHaveBeenCalledWith('c3', true, expect.objectContaining({ stopped: true }));
  });

  it('subagent 未启用时直接报错（router 兜底为 error response）', async () => {
    const ctx = makeCtx();
    ctx.subagentRuntime = { enabled: false, blockedReason: 'x', registry: { runs: new Map() }, events: null, ceilingHandle: null };
    await expect(
      handleCancelSubagent({ id: 'c4', type: 'cancelSubagent', target: {} }, ctx),
    ).rejects.toThrow('not available');
  });
});
