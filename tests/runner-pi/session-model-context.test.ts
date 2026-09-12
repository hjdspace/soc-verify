/**
 * runner-pi 会话命令的模型/上下文 parity 行为（issue 06）。
 *
 * 覆盖：
 *   - init 接线：thinkingLevel、contextWindow 模型覆盖、appendSystemPrompt
 *     组合、context_usage 初始推送与边界推送；
 *   - 新命令：setThinkingLevel / getState / getMessages / getSystemPrompt /
 *     setToolFilter / listAgentTools。
 *
 * 与 session.test.ts 相同的 mock 脚手架：SDK 与 protocol 层被替换，
 * context-usage / thinking-level / system-prompt 使用真实实现。
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
const loaderConstructorOpts: unknown[] = [];

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: (...args: unknown[]) => createAgentSession(...args),
  SessionManager: { create: () => ({ __fakeSessionManager: true }) },
  DefaultResourceLoader: class {
    constructor(opts: unknown) {
      loaderConstructorOpts.push(opts);
    }
    async reload(_opts: unknown) {}
  },
  getAgentDir: () => '/fake/agent-dir',
  hasTrustRequiringProjectResources: () => false,
  SettingsManager: { create: () => ({ __fakeSettingsManager: true, applyOverrides: () => {} }) },
}));

vi.mock('jiti', () => ({
  createJiti: () => ({
    import: async (id: string) => {
      if (id === 'pi-subagents') return { default: vi.fn() };
      if (id === 'pi-subagents/capability-ceiling') {
        return { registerSubagentCapabilityCeiling: vi.fn(() => ({ update: vi.fn(), dispose: vi.fn() })) };
      }
      throw new Error(`unexpected jiti import: ${id}`);
    },
  }),
}));

const {
  handleInit,
  handleSetModel,
  handleSetThinkingLevel,
  handleGetState,
  handleGetMessages,
  handleGetSystemPrompt,
  handleSetToolFilter,
  handleListAgentTools,
} = await import('../../runner-pi/session');

const { SOCVERIFY_APPEND_SYSTEM_PROMPT } = await import('../../runner-pi/system-prompt');

// ─── 测试脚手架 ─────────────────────────────────────────

type FakeSession = Record<string, unknown> & { sessionId: string };

function makeSession(overrides: Record<string, unknown> = {}): FakeSession {
  return {
    sessionId: 'pi-session-ctx',
    modelRuntime: {
      setRuntimeApiKey: vi.fn(async () => undefined),
      getModel: vi.fn(() => undefined),
      getProviderAuthStatus: vi.fn(() => ({ configured: true, source: 'runtime' })),
    },
    setModel: vi.fn(async () => undefined),
    subscribe: vi.fn(() => vi.fn()),
    prompt: vi.fn(async () => undefined),
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
  };
}

// ─── 运行时 setModel：contextWindow 覆盖不丢失 ──────────

describe('handleSetModel contextWindow 覆盖', () => {
  it('运行时切换模型时同样应用 min 覆盖（不丢 host 配置窗口）', async () => {
    const model = { id: 'glm-5', provider: 'zhipu', contextWindow: 200_000 };
    const session = makeSession({
      modelRuntime: { setRuntimeApiKey: vi.fn(), getModel: vi.fn(() => model) },
    });
    const ctx = makeCtx(session);
    ctx.configuredContextWindow = 128_000;

    await handleSetModel({ id: 'r1', type: 'setModel', provider: 'zhipu', modelId: 'glm-5' }, ctx);

    expect(session.setModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'zhipu', id: 'glm-5', contextWindow: 128_000 }),
    );
    expect(sendResponse).toHaveBeenCalledWith('r1', true, { ok: true });
  });

  it('未配置窗口时切换保持模型原样', async () => {
    const model = { id: 'glm-5', provider: 'zhipu', contextWindow: 200_000 };
    const session = makeSession({
      modelRuntime: { setRuntimeApiKey: vi.fn(), getModel: vi.fn(() => model) },
    });

    await handleSetModel(
      { id: 'r2', type: 'setModel', provider: 'zhipu', modelId: 'glm-5' },
      makeCtx(session),
    );

    expect(session.setModel).toHaveBeenCalledWith(model);
  });
});

beforeEach(() => {
  sendResponse.mockClear();
  sendEvent.mockClear();
  createAgentSession.mockReset();
  loaderConstructorOpts.length = 0;
  createAgentSession.mockImplementation(async () => ({ session: makeSession() }));
});

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
});

// ─── init：thinkingLevel 接线 ───────────────────────────

describe('handleInit thinkingLevel 接线', () => {
  it('具体强度透传给 createAgentSession.thinkingLevel', async () => {
    await handleInit(
      { id: 'r1', type: 'init', config: { cwd: '/p', thinkingLevel: 'high' } },
      makeCtx(),
    );
    const options = createAgentSession.mock.calls[0][0] as Record<string, unknown>;
    expect(options.thinkingLevel).toBe('high');
  });

  it("'default' 与 'auto' 不下发设置（跟随 pi 引擎默认）", async () => {
    await handleInit({ id: 'r2', type: 'init', config: { cwd: '/p', thinkingLevel: 'default' } }, makeCtx());
    await handleInit({ id: 'r3', type: 'init', config: { cwd: '/p', thinkingLevel: 'auto' } }, makeCtx());
    for (const call of createAgentSession.mock.calls) {
      expect((call[0] as Record<string, unknown>).thinkingLevel).toBeUndefined();
    }
  });
});

// ─── init：contextWindow 模型覆盖 ───────────────────────

describe('handleInit contextWindow 模型覆盖', () => {
  it('配置窗口小于模型声明窗口时取 min', async () => {
    const model = { id: 'glm-5', provider: 'zhipu', contextWindow: 200_000 };
    const session = makeSession({
      modelRuntime: { setRuntimeApiKey: vi.fn(), getModel: vi.fn(() => model) },
    });
    createAgentSession.mockResolvedValue({ session });

    await handleInit(
      { id: 'r4', type: 'init', config: { cwd: '/p', provider: 'zhipu', model: 'glm-5', contextWindow: 128_000 } },
      makeCtx(),
    );

    expect(session.setModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'zhipu', id: 'glm-5', contextWindow: 128_000 }),
    );
    // 不原地改写注册表里的模型对象
    expect(model.contextWindow).toBe(200_000);
  });

  it('模型未声明窗口时使用 host 配置窗口', async () => {
    const model = { id: 'glm-5', provider: 'zhipu' };
    const session = makeSession({
      modelRuntime: { setRuntimeApiKey: vi.fn(), getModel: vi.fn(() => model) },
    });
    createAgentSession.mockResolvedValue({ session });

    await handleInit(
      { id: 'r5', type: 'init', config: { cwd: '/p', provider: 'zhipu', model: 'glm-5', contextWindow: 96_000 } },
      makeCtx(),
    );

    expect(session.setModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'zhipu', id: 'glm-5', contextWindow: 96_000 }),
    );
  });

  it('未配置窗口时保持模型原样', async () => {
    const model = { id: 'glm-5', provider: 'zhipu', contextWindow: 200_000 };
    const session = makeSession({
      modelRuntime: { setRuntimeApiKey: vi.fn(), getModel: vi.fn(() => model) },
    });
    createAgentSession.mockResolvedValue({ session });

    await handleInit(
      { id: 'r6', type: 'init', config: { cwd: '/p', provider: 'zhipu', model: 'glm-5' } },
      makeCtx(),
    );

    expect(session.setModel).toHaveBeenCalledWith(model);
  });
});

// ─── init：Effective System Prompt 组合 ─────────────────

describe('handleInit system prompt 组合', () => {
  it('用户自定义提示词与 SoC Verify 应用规则一起附加到 loader', async () => {
    await handleInit(
      { id: 'r7', type: 'init', config: { cwd: '/p', systemPrompt: '总是用中文回复' } },
      makeCtx(),
    );
    const loaderOpts = loaderConstructorOpts[0] as { appendSystemPrompt?: string[] };
    expect(loaderOpts.appendSystemPrompt).toEqual(['总是用中文回复', SOCVERIFY_APPEND_SYSTEM_PROMPT]);
  });

  it('无自定义提示词时只附加应用规则', async () => {
    await handleInit({ id: 'r8', type: 'init', config: { cwd: '/p' } }, makeCtx());
    const loaderOpts = loaderConstructorOpts[0] as { appendSystemPrompt?: string[] };
    expect(loaderOpts.appendSystemPrompt).toEqual([SOCVERIFY_APPEND_SYSTEM_PROMPT]);
  });
});

// ─── init：context_usage 推送 ───────────────────────────

describe('handleInit context_usage 推送', () => {
  it('init 完成后立即推送一次 pi 原生用量（approximate=false）', async () => {
    createAgentSession.mockResolvedValue({
      session: makeSession({
        getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
      }),
    });

    await handleInit({ id: 'r9', type: 'init', config: { cwd: '/p' } }, makeCtx());

    expect(sendEvent).toHaveBeenCalledWith({
      type: 'context_usage',
      contextUsage: { tokens: 100, contextWindow: 1000, percent: 10, approximate: false },
      isCompacting: false,
      autoCompactionEnabled: true,
    });
  });

  it('订阅回调在 message_end 边界推送 context_usage，无增长事件不推送', async () => {
    const session = makeSession({
      getContextUsage: () => ({ tokens: 200, contextWindow: 1000, percent: 20 }),
    });
    createAgentSession.mockResolvedValue({ session });

    await handleInit({ id: 'r10', type: 'init', config: { cwd: '/p' } }, makeCtx());

    const listener = (session.subscribe as ReturnType<typeof vi.fn>).mock.calls[0][0] as (
      event: unknown,
    ) => void;

    sendEvent.mockClear();
    listener({ type: 'message_end', message: { role: 'assistant', content: [] } });
    const eventTypes = sendEvent.mock.calls.map(
      (c) => (c[0] as { type: string }).type,
    );
    expect(eventTypes).toContain('message_end');
    expect(eventTypes).toContain('context_usage');

    sendEvent.mockClear();
    listener({ type: 'message_update', message: {} });
    expect(sendEvent.mock.calls.map((c) => (c[0] as { type: string }).type)).not.toContain(
      'context_usage',
    );
  });

  it('pi 原生用量未知（tokens=null）时推送近似值', async () => {
    createAgentSession.mockResolvedValue({
      session: makeSession({
        getContextUsage: () => ({ tokens: null, contextWindow: 1000, percent: null }),
        messages: [{ role: 'user', content: 'a'.repeat(400) }],
      }),
    });

    await handleInit({ id: 'r11', type: 'init', config: { cwd: '/p' } }, makeCtx());

    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'context_usage',
        contextUsage: expect.objectContaining({ tokens: 100, approximate: true }),
      }),
    );
  });
});

// ─── setThinkingLevel ───────────────────────────────────

describe('handleSetThinkingLevel', () => {
  it('具体强度下发 session.setThinkingLevel', () => {
    const session = makeSession({ setThinkingLevel: vi.fn() });
    handleSetThinkingLevel({ id: 'r1', type: 'setThinkingLevel', level: 'high' }, makeCtx(session));
    expect(session.setThinkingLevel).toHaveBeenCalledWith('high');
    expect(sendResponse).toHaveBeenCalledWith('r1', true, { ok: true });
  });

  it("'default'/'auto' 重置回引擎默认（settings 默认值，缺省 'medium'）", () => {
    const session = makeSession({
      setThinkingLevel: vi.fn(),
      model: { provider: 'zhipu', id: 'glm-5' },
      settingsManager: {
        getModelThinkingLevel: vi.fn(() => undefined),
        getDefaultThinkingLevel: vi.fn(() => 'low'),
      },
    });
    handleSetThinkingLevel({ id: 'r2', type: 'setThinkingLevel', level: 'default' }, makeCtx(session));
    expect(session.setThinkingLevel).toHaveBeenCalledWith('low');

    const session2 = makeSession({
      setThinkingLevel: vi.fn(),
      model: { provider: 'zhipu', id: 'glm-5' },
      settingsManager: {
        getModelThinkingLevel: vi.fn(() => 'high'),
        getDefaultThinkingLevel: vi.fn(() => 'low'),
      },
    });
    handleSetThinkingLevel({ id: 'r3', type: 'setThinkingLevel', level: 'auto' }, makeCtx(session2));
    expect(session2.setThinkingLevel).toHaveBeenCalledWith('high');

    // 无 settingsManager（fake/降级场景）→ pi 兜底默认 'medium'
    const session3 = makeSession({ setThinkingLevel: vi.fn() });
    handleSetThinkingLevel({ id: 'r4', type: 'setThinkingLevel', level: 'default' }, makeCtx(session3));
    expect(session3.setThinkingLevel).toHaveBeenCalledWith('medium');
  });

  it('无会话时拒绝', () => {
    expect(() =>
      handleSetThinkingLevel({ id: 'r5', type: 'setThinkingLevel', level: 'high' }, makeCtx(null)),
    ).toThrow('Session not initialized');
  });
});

// ─── getState / getMessages / getSystemPrompt ──────────

describe('handleGetState', () => {
  it('返回模型、思考强度、原生用量、压缩状态与认证状态', () => {
    const session = makeSession({
      model: { provider: 'zhipu', id: 'glm-5' },
      thinkingLevel: 'high',
      getContextUsage: () => ({ tokens: 500, contextWindow: 4000, percent: 12.5 }),
      isCompacting: false,
      autoCompactionEnabled: true,
    });
    handleGetState({ id: 'r1', type: 'getState' }, makeCtx(session));

    expect(sendResponse).toHaveBeenCalledWith(
      'r1',
      true,
      {
        state: {
          model: { provider: 'zhipu', id: 'glm-5' },
          thinkingLevel: 'high',
          contextUsage: { tokens: 500, contextWindow: 4000, percent: 12.5, approximate: false },
          isCompacting: false,
          autoCompactionEnabled: true,
          authStatus: { configured: true, source: 'runtime' },
        },
      },
    );
  });

  it('未选模型时回退到 init provider 查询认证状态', () => {
    const ctx = makeCtx(makeSession());
    ctx.currentProvider = 'socverify-openai-compatible';
    handleGetState({ id: 'r2', type: 'getState' }, ctx);
    const [, success, data] = sendResponse.mock.calls[0] as [string, boolean, { state: Record<string, unknown> }];
    expect(success).toBe(true);
    expect(data.state.model).toBeUndefined();
    // 认证状态不因未选模型而缺失（issue 06：认证状态可查看）
    expect(data.state.authStatus).toEqual({ configured: true, source: 'runtime' });
  });

  it('无会话时拒绝', () => {
    expect(() => handleGetState({ id: 'r3', type: 'getState' }, makeCtx(null))).toThrow(
      'Session not initialized',
    );
  });
});

describe('handleGetMessages', () => {
  it('返回会话消息列表', () => {
    const messages = [{ role: 'user', content: 'hi' }];
    handleGetMessages({ id: 'r1', type: 'getMessages' }, makeCtx(makeSession({ messages })));
    expect(sendResponse).toHaveBeenCalledWith('r1', true, { messages });
  });

  it('无会话时拒绝', () => {
    expect(() => handleGetMessages({ id: 'r2', type: 'getMessages' }, makeCtx(null))).toThrow(
      'Session not initialized',
    );
  });
});

describe('handleGetSystemPrompt', () => {
  it('返回会话当前生效系统提示词（pi 默认 + 附加规则）', () => {
    const session = makeSession({
      // pi AgentSession.systemPrompt getter
      systemPrompt: 'pi default prompt\n+ SoC Verify rules',
    });
    handleGetSystemPrompt({ id: 'r1', type: 'getSystemPrompt' }, makeCtx(session));
    expect(sendResponse).toHaveBeenCalledWith('r1', true, {
      systemPrompt: 'pi default prompt\n+ SoC Verify rules',
    });
  });

  it('无会话时拒绝', () => {
    expect(() => handleGetSystemPrompt({ id: 'r2', type: 'getSystemPrompt' }, makeCtx(null))).toThrow(
      'Session not initialized',
    );
  });
});

// ─── setToolFilter / listAgentTools ─────────────────────

describe('handleSetToolFilter', () => {
  it('按禁用列表过滤活动工具并强制保留 ask', () => {
    const session = makeSession({
      getActiveToolNames: vi.fn(() => ['read', 'bash', 'ask', 'edit']),
      setActiveToolsByName: vi.fn(),
    });
    handleSetToolFilter({ id: 'r1', type: 'setToolFilter', disabledTools: ['bash', 'ask'] }, makeCtx(session));
    expect(session.setActiveToolsByName).toHaveBeenCalledWith(['read', 'ask', 'edit']);
    expect(sendResponse).toHaveBeenCalledWith('r1', true, { ok: true, disabledCount: 1 });
  });

  it('无会话时拒绝', () => {
    expect(() =>
      handleSetToolFilter({ id: 'r2', type: 'setToolFilter', disabledTools: ['bash'] }, makeCtx(null)),
    ).toThrow('Session not initialized');
  });
});

describe('handleListAgentTools', () => {
  it('返回全部注册工具的 name/description', () => {
    const session = makeSession({
      getAllTools: vi.fn(() => [
        { name: 'read', description: '读文件' },
        { name: 'ask', description: 42 },
      ]),
    });
    handleListAgentTools({ id: 'r1', type: 'listAgentTools' }, makeCtx(session));
    expect(sendResponse).toHaveBeenCalledWith('r1', true, {
      tools: [
        { name: 'read', description: '读文件' },
        { name: 'ask', description: '' },
      ],
    });
  });

  it('无会话时拒绝', () => {
    expect(() => handleListAgentTools({ id: 'r2', type: 'listAgentTools' }, makeCtx(null))).toThrow(
      'Session not initialized',
    );
  });
});
