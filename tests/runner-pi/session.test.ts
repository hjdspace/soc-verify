/**
 * runner-pi session.ts —— pi 会话命令处理（init/prompt/steer/abort/setModel/compact/destroy）。
 *
 * 通过 vi.mock 隔离 @earendil-works/pi-coding-agent SDK 与 protocol 层；
 * event-normalizer 使用真实实现，验证 init 订阅链路端到端的归一化行为。
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

const createAgentSession = vi.fn();
const sessionManagerCreate = vi.fn((..._args: unknown[]) => ({ __fakeSessionManager: true }));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: (...args: unknown[]) => createAgentSession(...args),
  SessionManager: { create: (...args: unknown[]) => sessionManagerCreate(...args) },
  // resource loader 装配与项目信任（issue 04）：测试中无需真实加载扩展
  DefaultResourceLoader: class {
    constructor(_opts: unknown) {}
    async reload(_opts: unknown) {}
  },
  getAgentDir: () => '/fake/agent-dir',
  hasTrustRequiringProjectResources: () => false,
  SettingsManager: { create: () => ({ __fakeSettingsManager: true, applyOverrides: () => {} }) },
}));

// issue 05：subagent 扩展经 jiti 加载，测试中替换为受控 fake
const fakeSubagentExtensionFactory = vi.fn();
const fakeRegisterCeiling = vi.fn(() => ({ update: vi.fn(), dispose: vi.fn() }));

vi.mock('jiti', () => ({
  createJiti: () => ({
    import: async (id: string) => {
      if (id === 'pi-subagents') return { default: fakeSubagentExtensionFactory };
      if (id === 'pi-subagents/capability-ceiling') {
        return { registerSubagentCapabilityCeiling: fakeRegisterCeiling };
      }
      throw new Error(`unexpected jiti import: ${id}`);
    },
  }),
}));

const {
  handleInit,
  handlePrompt,
  handleAbort,
  handleSteer,
  handleSetModel,
  handleCompact,
  handleDestroy,
} = await import('../../runner-pi/session');

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
    callHostTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'tool result' }] })),
    requestApproval: vi.fn(async () => true),
    requestTrust: vi.fn(async () => true),
    mcpRuntime: null,
    subagentRuntime: null,
  };
}

const ENV_KEYS = ['SOCV_TEST_VAR', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'] as const;

beforeEach(() => {
  sendResponse.mockClear();
  sendEvent.mockClear();
  fakeSubagentExtensionFactory.mockClear();
  fakeRegisterCeiling.mockClear();
  createAgentSession.mockReset();
  createAgentSession.mockImplementation(async () => ({ session: makeSession() }));
  sessionManagerCreate.mockClear();
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

// ─── handleInit ─────────────────────────────────────────

describe('handleInit', () => {
  it('用 cwd 创建 pi 会话（原生 session 根）并回传 sessionId', async () => {
    const ctx = makeCtx();
    await handleInit(
      { id: 'req_1', type: 'init', config: { cwd: '/proj/dv' } },
      ctx,
    );

    expect(sessionManagerCreate).toHaveBeenCalledWith('/proj/dv');
    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/proj/dv',
        sessionManager: { __fakeSessionManager: true },
      }),
    );
    expect(sendResponse).toHaveBeenCalledWith(
      'req_1',
      true,
      expect.objectContaining({ sessionId: 'pi-session-0001' }),
    );
  });

  it('应用 env 环境变量到进程', async () => {
    const ctx = makeCtx();
    await handleInit(
      { id: 'req_2', type: 'init', config: { cwd: '/p', env: { SOCV_TEST_VAR: 'yes' } } },
      ctx,
    );
    expect(process.env.SOCV_TEST_VAR).toBe('yes');
  });

  it('openai 兼容 provider 下发 OPENAI_API_KEY/OPENAI_BASE_URL 并写入 runtime apiKey', async () => {
    const session = makeSession();
    createAgentSession.mockResolvedValue({ session });
    const ctx = makeCtx();

    await handleInit(
      {
        id: 'req_3',
        type: 'init',
        config: {
          cwd: '/p',
          provider: 'socverify-openai-compatible',
          apiKey: 'sk-test',
          baseUrl: 'http://llm.local/v1',
        },
      },
      ctx,
    );

    expect(process.env.OPENAI_API_KEY).toBe('sk-test');
    expect(process.env.OPENAI_BASE_URL).toBe('http://llm.local/v1');
    expect(
      (session.modelRuntime as { setRuntimeApiKey: ReturnType<typeof vi.fn> }).setRuntimeApiKey,
    ).toHaveBeenCalledWith('socverify-openai-compatible', 'sk-test');
  });

  it('provider+model 命中时切换初始模型', async () => {
    const model = { id: 'glm-5', provider: 'zhipu' };
    const session = makeSession({
      modelRuntime: {
        setRuntimeApiKey: vi.fn(),
        getModel: vi.fn((_p: string, m: string) => (m === 'glm-5' ? model : undefined)),
      },
    });
    createAgentSession.mockResolvedValue({ session });
    const ctx = makeCtx();

    await handleInit(
      { id: 'req_4', type: 'init', config: { cwd: '/p', provider: 'zhipu', model: 'glm-5' } },
      ctx,
    );

    expect(session.setModel).toHaveBeenCalledWith(model);
  });

  it('provider+model 未命中时不切换模型', async () => {
    const session = makeSession();
    createAgentSession.mockResolvedValue({ session });
    const ctx = makeCtx();

    await handleInit(
      { id: 'req_5', type: 'init', config: { cwd: '/p', provider: 'zhipu', model: 'unknown' } },
      ctx,
    );

    expect(session.setModel).not.toHaveBeenCalled();
  });

  it('customToolDefinitions 注册为转发工具：execute 调用 callHostTool 并包装字符串结果', async () => {
    const ctx = makeCtx();
    await handleInit(
      {
        id: 'req_6',
        type: 'init',
        config: {
          cwd: '/p',
          customToolDefinitions: [
            { name: 'ask', label: 'Ask', description: '提问', parameters: { type: 'object' } },
          ],
        },
      },
      ctx,
    );

    const options = createAgentSession.mock.calls[0][0] as {
      customTools: Array<{
        name: string;
        label: string;
        description: string;
        parameters: Record<string, unknown>;
        execute: (
          id: string,
          params: unknown,
          signal: AbortSignal | undefined,
          onUpdate: unknown,
          extensionCtx: unknown,
        ) => Promise<unknown>;
      }>;
    };
    expect(options.customTools).toHaveLength(1);
    const tool = options.customTools[0];
    expect(tool.name).toBe('ask');
    expect(tool.label).toBe('Ask');

    const result = await tool.execute('call_1', { questions: [] }, undefined, undefined, undefined);
    expect(ctx.callHostTool).toHaveBeenCalledWith('ask', { questions: [] });
    expect(result).toEqual({
      content: [{ type: 'text', text: 'tool result' }],
    });
  });

  it('工具执行异常时返回 isError 结果（不向引擎抛出）', async () => {
    const ctx = makeCtx();
    (ctx.callHostTool as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('host down'));

    await handleInit(
      {
        id: 'req_7',
        type: 'init',
        config: {
          cwd: '/p',
          customToolDefinitions: [
            { name: 'ask', description: '提问', parameters: { type: 'object' } },
          ],
        },
      },
      ctx,
    );

    const options = createAgentSession.mock.calls[0][0] as {
      customTools: Array<{
        execute: () => Promise<{ isError?: boolean; content: unknown }>;
      }>;
    };
    const result = await options.customTools[0].execute();
    expect(result.isError).toBe(true);
  });

  it('订阅事件并转发归一化后的契约事件，契约外 pi 事件被丢弃', async () => {
    const session = makeSession();
    createAgentSession.mockResolvedValue({ session });
    const ctx = makeCtx();

    await handleInit({ id: 'req_8', type: 'init', config: { cwd: '/p' } }, ctx);

    expect(session.subscribe).toHaveBeenCalledTimes(1);
    const listener = (session.subscribe as ReturnType<typeof vi.fn>).mock.calls[0][0] as (
      event: unknown,
    ) => void;

    // 契约事件：透传
    listener({ type: 'agent_start' });
    expect(sendEvent).toHaveBeenCalledWith({ type: 'agent_start' });

    // 改写：agent_end.willRetry → willContinue
    sendEvent.mockClear();
    listener({ type: 'agent_end', messages: [], willRetry: true });
    expect(sendEvent).toHaveBeenCalledWith({ type: 'agent_end', messages: [], willContinue: true });

    // 契约外事件：丢弃
    sendEvent.mockClear();
    listener({ type: 'queue_update', steering: [], followUp: [] });
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it('createAgentSession 失败时向上抛出（由主循环转失败响应）', async () => {
    createAgentSession.mockRejectedValue(new Error('model not configured'));
    const ctx = makeCtx();

    await expect(
      handleInit({ id: 'req_9', type: 'init', config: { cwd: '/p' } }, ctx),
    ).rejects.toThrow('model not configured');
    expect(sendResponse).not.toHaveBeenCalled();
  });
});

// ─── handlePrompt ───────────────────────────────────────

describe('handlePrompt', () => {
  it('无会话时拒绝', async () => {
    await expect(
      handlePrompt({ id: 'req_1', type: 'prompt', message: 'hi' }, makeCtx(null)),
    ).rejects.toThrow('Session not initialized');
  });

  it('调用 session.prompt 并回传 ok', async () => {
    const session = makeSession();
    const ctx = makeCtx(session);

    await handlePrompt({ id: 'req_2', type: 'prompt', message: '跑仿真' }, ctx);

    expect(session.prompt).toHaveBeenCalledWith('跑仿真', undefined);
    expect(sendResponse).toHaveBeenCalledWith('req_2', true, { ok: true });
  });

  it('data URL 图片解析为 ImageContent', async () => {
    const session = makeSession();
    const ctx = makeCtx(session);

    await handlePrompt(
      { id: 'req_3', type: 'prompt', message: '看图', images: ['data:image/jpeg;base64,QUJD'] },
      ctx,
    );

    expect(session.prompt).toHaveBeenCalledWith('看图', {
      images: [{ type: 'image', data: 'QUJD', mimeType: 'image/jpeg' }],
    });
  });

  it('裸 base64 回退 image/png', async () => {
    const session = makeSession();
    const ctx = makeCtx(session);

    await handlePrompt({ id: 'req_4', type: 'prompt', message: '看图', images: ['QUJD'] }, ctx);

    expect(session.prompt).toHaveBeenCalledWith('看图', {
      images: [{ type: 'image', data: 'QUJD', mimeType: 'image/png' }],
    });
  });
});

// ─── handleAbort / handleSteer ──────────────────────────

describe('handleAbort', () => {
  it('无会话时拒绝', async () => {
    await expect(handleAbort({ id: 'req_1', type: 'abort' }, makeCtx(null))).rejects.toThrow(
      'Session not initialized',
    );
  });

  it('调用 session.abort 并回传 ok', async () => {
    const session = makeSession();
    await handleAbort({ id: 'req_2', type: 'abort' }, makeCtx(session));
    expect(session.abort).toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith('req_2', true, { ok: true });
  });
});

describe('handleSteer', () => {
  it('调用 session.steer 追加指令并回传 ok', async () => {
    const session = makeSession();
    await handleSteer({ id: 'req_1', type: 'steer', message: '顺便改下文档' }, makeCtx(session));
    expect(session.steer).toHaveBeenCalledWith('顺便改下文档');
    expect(sendResponse).toHaveBeenCalledWith('req_1', true, { ok: true });
  });
});

// ─── handleSetModel ─────────────────────────────────────

describe('handleSetModel', () => {
  it('命中模型时切换并回传 ok', async () => {
    const model = { id: 'glm-5', provider: 'zhipu' };
    const session = makeSession({
      modelRuntime: {
        setRuntimeApiKey: vi.fn(),
        getModel: vi.fn(() => model),
      },
    });
    await handleSetModel(
      { id: 'req_1', type: 'setModel', provider: 'zhipu', modelId: 'glm-5' },
      makeCtx(session),
    );
    expect(session.setModel).toHaveBeenCalledWith(model);
    expect(sendResponse).toHaveBeenCalledWith('req_1', true, { ok: true });
  });

  it('未命中模型时抛错（由主循环转失败响应）', async () => {
    const session = makeSession();
    await expect(
      handleSetModel(
        { id: 'req_2', type: 'setModel', provider: 'zhipu', modelId: 'nope' },
        makeCtx(session),
      ),
    ).rejects.toThrow('Model not found: zhipu/nope');
  });
});

// ─── handleCompact ──────────────────────────────────────

describe('handleCompact', () => {
  it('返回压缩结果', async () => {
    const session = makeSession();
    await handleCompact({ id: 'req_1', type: 'compact' }, makeCtx(session));
    expect(session.compact).toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith('req_1', true, {
      result: { summary: 'compacted' },
    });
  });
});

// ─── handleDestroy ──────────────────────────────────────

describe('handleDestroy', () => {
  it('取消订阅、dispose 会话并清空上下文', async () => {
    const unsubscribe = vi.fn();
    const session = makeSession();
    const ctx = makeCtx(session);
    ctx.unsubscribe = unsubscribe;

    await handleDestroy({ id: 'req_1', type: 'destroy' }, ctx);

    expect(unsubscribe).toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalled();
    expect(ctx.session).toBeNull();
    expect(sendResponse).toHaveBeenCalledWith('req_1', true, { ok: true });
  });

  it('无会话时也安全回传 ok（幂等）', async () => {
    await handleDestroy({ id: 'req_2', type: 'destroy' }, makeCtx(null));
    expect(sendResponse).toHaveBeenCalledWith('req_2', true, { ok: true });
  });
});
