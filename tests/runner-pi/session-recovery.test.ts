/**
 * runner-pi 会话恢复（issue 07）——原生 session 优先 + transcript 重建降级。
 *
 * 验收标准（.scratch/pi-engine-migration/issues/07）：
 *   - 原生 pi session 使用用户级目录和 canonical cwd bucket（SessionManager.list(cwd)
 *     不传 sessionDir → pi 默认根 + bucket），不新增项目级副本；
 *   - 恢复优先使用原生 session；仅在缺失、损坏或首条 user message 不匹配时
 *     从 UI transcript 重建；
 *   - 重建走 SessionManager.create(cwd)（新 bucket、新 sessionId），
 *     init response 带 recovered 标记供 host 更新 engineSessionId。
 *
 * 通过 vi.mock 隔离 pi SDK 与 protocol 层（同 session.test.ts 模式）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join as pathJoin } from 'node:path';
import type { PiRunnerContext } from '../../runner-pi/protocol';

const sendResponse = vi.fn();
const sendEvent = vi.fn();

vi.mock('../../runner-pi/protocol', async () => ({
  sendResponse: (...args: unknown[]) => sendResponse(...args),
  sendEvent: (...args: unknown[]) => sendEvent(...args),
  sendToolCall: vi.fn(),
  send: vi.fn(),
}));

// ─── pi SDK 受控 fake ─────────────────────────────────────

const sessionManagerList = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
const sessionManagerOpen = vi.fn();
const sessionManagerCreate = vi.fn();
const modelRuntimeCreate = vi.fn();

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: (...args: unknown[]) => createAgentSession(...args),
  SessionManager: {
    list: (...args: unknown[]) => sessionManagerList(...args),
    open: (...args: unknown[]) => sessionManagerOpen(...args),
    create: (...args: unknown[]) => sessionManagerCreate(...args),
  },
  ModelRuntime: { create: (...args: unknown[]) => modelRuntimeCreate(...args) },
  DefaultResourceLoader: class {
    constructor(_opts: unknown) {}
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

const createAgentSession = vi.fn();

const { handleInit } = await import('../../runner-pi/session');

// ─── 脚手架 ───────────────────────────────────────────────

type FakeManager = Record<string, unknown> & { sessionId?: string };

function makeOpenedManager(entries: unknown[] = [], sessionId = 'pi-native-0001'): FakeManager {
  return {
    sessionId,
    getEntries: vi.fn(() => entries),
  };
}

function makeNewManager(): FakeManager {
  return {
    sessionId: 'pi-new-0002',
    appendMessage: vi.fn(() => 'entry_1'),
    getEntries: vi.fn(() => []),
  };
}

function makeCtx(): PiRunnerContext {
  return {
    session: null,
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

function makeSession(): Record<string, unknown> {
  return {
    sessionId: 'pi-session-0001',
    modelRuntime: {
      setRuntimeApiKey: vi.fn(async () => undefined),
      getModel: vi.fn(() => undefined),
    },
    setModel: vi.fn(async () => undefined),
    subscribe: vi.fn(() => vi.fn()),
    dispose: vi.fn(),
  };
}

const SEED = [
  { role: 'user' as const, content: '第一条用户消息', timestamp: 1000 },
  { role: 'assistant' as const, content: '第一条助手回复', timestamp: 2000 },
];

function lastResponseData(): Record<string, unknown> {
  const call = sendResponse.mock.calls.at(-1);
  return call?.[2] as Record<string, unknown>;
}

beforeEach(() => {
  sendResponse.mockClear();
  sendEvent.mockClear();
  sessionManagerList.mockReset().mockResolvedValue([]);
  sessionManagerOpen.mockReset();
  sessionManagerCreate.mockReset().mockImplementation(() => makeNewManager());
  modelRuntimeCreate.mockReset();
  createAgentSession.mockReset().mockImplementation(async () => ({ session: makeSession() }));
});

// ─── 原生恢复优先 ─────────────────────────────────────────

describe('handleInit — 原生 session 恢复', () => {
  it('resumeSessionId 命中原生 session 时 open 复用，不创建新 session', async () => {
    const native = makeOpenedManager(
      [{ type: 'message', message: { role: 'user', content: '第一条用户消息' } }],
      'pi-native-0001',
    );
    sessionManagerList.mockResolvedValue([
      { id: 'other-session', path: '/sessions/other.jsonl' },
      { id: 'pi-native-0001', path: '/sessions/pi-native-0001.jsonl' },
    ]);
    sessionManagerOpen.mockReturnValue(native);

    await handleInit(
      { id: 'req_1', type: 'init', config: { cwd: '/proj/dv', resumeSessionId: 'pi-native-0001' } },
      makeCtx(),
    );

    // canonical cwd bucket：list 使用 cwd（默认根 + bucket），不传 sessionDir
    expect(sessionManagerList).toHaveBeenCalledWith('/proj/dv');
    expect(sessionManagerOpen).toHaveBeenCalledWith('/sessions/pi-native-0001.jsonl');
    expect(sessionManagerCreate).not.toHaveBeenCalled();
    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionManager: native }),
    );
    expect(lastResponseData()).toMatchObject({ sessionId: 'pi-session-0001', recovered: 'native' });
  });

  it('无 seedHistory 时跳过首条消息校验直接恢复', async () => {
    const native = makeOpenedManager(
      [{ type: 'message', message: { role: 'user', content: '任意历史' } }],
    );
    sessionManagerList.mockResolvedValue([{ id: 'pi-native-0001', path: '/s/x.jsonl' }]);
    sessionManagerOpen.mockReturnValue(native);

    await handleInit(
      { id: 'req_2', type: 'init', config: { cwd: '/p', resumeSessionId: 'pi-native-0001' } },
      makeCtx(),
    );

    expect(sessionManagerOpen).toHaveBeenCalled();
    expect(lastResponseData().recovered).toBe('native');
  });

  it('原生 session 首条 user message 与 transcript 一致时恢复', async () => {
    const native = makeOpenedManager(
      [{ type: 'message', message: { role: 'user', content: [{ type: 'text', text: '第一条用户消息\n' }] } }],
    );
    sessionManagerList.mockResolvedValue([{ id: 'pi-native-0001', path: '/s/x.jsonl' }]);
    sessionManagerOpen.mockReturnValue(native);

    await handleInit(
      {
        id: 'req_3',
        type: 'init',
        config: { cwd: '/p', resumeSessionId: 'pi-native-0001', seedHistory: SEED },
      },
      makeCtx(),
    );

    expect(lastResponseData().recovered).toBe('native');
  });
});

// ─── 重建降级 ─────────────────────────────────────────────

describe('handleInit — transcript 重建降级', () => {
  it('resumeSessionId 不在 list 中时用 create + seedHistory 重建', async () => {
    const fresh = makeNewManager();
    sessionManagerCreate.mockReturnValue(fresh);

    await handleInit(
      {
        id: 'req_4',
        type: 'init',
        config: { cwd: '/proj/dv', resumeSessionId: 'missing-id', seedHistory: SEED },
      },
      makeCtx(),
    );

    expect(sessionManagerOpen).not.toHaveBeenCalled();
    expect(sessionManagerCreate).toHaveBeenCalledWith('/proj/dv');
    expect(lastResponseData().recovered).toBe('rebuilt');
    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionManager: fresh }),
    );
  });

  it('原生 session 首条 user message 不匹配 transcript 时重建（只覆盖尾部的 omp 式半覆盖检测）', async () => {
    const tailOnly = makeOpenedManager(
      [{ type: 'message', message: { role: 'user', content: '只覆盖尾部的首条' } }],
    );
    sessionManagerList.mockResolvedValue([{ id: 'pi-native-0001', path: '/s/x.jsonl' }]);
    sessionManagerOpen.mockReturnValue(tailOnly);

    await handleInit(
      {
        id: 'req_5',
        type: 'init',
        config: { cwd: '/p', resumeSessionId: 'pi-native-0001', seedHistory: SEED },
      },
      makeCtx(),
    );

    // 不重绑定只覆盖尾部的原生文件 —— 用 transcript 全量重建
    expect(sessionManagerCreate).toHaveBeenCalledWith('/p');
    expect(lastResponseData().recovered).toBe('rebuilt');
  });

  it('原生 session 损坏（open/list 抛错）时降级重建', async () => {
    sessionManagerList.mockResolvedValue([{ id: 'pi-native-0001', path: '/s/x.jsonl' }]);
    sessionManagerOpen.mockImplementation(() => {
      throw new Error('corrupt session file');
    });

    await handleInit(
      {
        id: 'req_6',
        type: 'init',
        config: { cwd: '/p', resumeSessionId: 'pi-native-0001', seedHistory: SEED },
      },
      makeCtx(),
    );

    expect(sessionManagerCreate).toHaveBeenCalledWith('/p');
    expect(lastResponseData().recovered).toBe('rebuilt');
  });

  it('重建时按序写入 user/assistant 种子消息（完整 Message 形状）', async () => {
    const fresh = makeNewManager();
    sessionManagerCreate.mockReturnValue(fresh);

    await handleInit(
      {
        id: 'req_7',
        type: 'init',
        config: { cwd: '/p', resumeSessionId: 'missing', seedHistory: SEED },
      },
      makeCtx(),
    );

    expect(fresh.appendMessage).toHaveBeenCalledTimes(2);
    const [userMsg, assistantMsg] = (fresh.appendMessage as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as Record<string, unknown>,
    );
    expect(userMsg).toEqual({ role: 'user', content: '第一条用户消息', timestamp: 1000 });
    expect(assistantMsg).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: '第一条助手回复' }],
      stopReason: 'stop',
      timestamp: 2000,
    });
    expect((assistantMsg.usage as Record<string, unknown>).totalTokens).toBe(0);
  });

  it('无需重建（无 resume 也无 seed）时不写入任何种子消息，recovered=new', async () => {
    const fresh = makeNewManager();

    await handleInit({ id: 'req_8', type: 'init', config: { cwd: '/p' } }, makeCtx());

    expect(sessionManagerCreate).toHaveBeenCalledWith('/p');
    expect(fresh.appendMessage).not.toHaveBeenCalled();
    expect(lastResponseData().recovered).toBe('new');
  });
});

// ─── modelsPath 解耦（原生 session 归用户级目录的前置） ────

describe('handleInit — modelsPath 注入', () => {
  it('提供 modelsPath 时创建独立 ModelRuntime 并注入 createAgentSession', async () => {
    const fakeRuntime = { __fakeModelRuntime: true };
    modelRuntimeCreate.mockResolvedValue(fakeRuntime);

    await handleInit(
      {
        id: 'req_9',
        type: 'init',
        config: { cwd: '/p', modelsPath: '/tmp/runtime/models.json' },
      },
      makeCtx(),
    );

    expect(modelRuntimeCreate).toHaveBeenCalledWith({
      // join 在 win32 下产生反斜杠 —— 与实现同源构造，平台无关
      authPath: pathJoin('/fake/agent-dir', 'auth.json'),
      modelsPath: '/tmp/runtime/models.json',
    });
    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ modelRuntime: fakeRuntime }),
    );
  });

  it('未提供 modelsPath 时不创建 ModelRuntime（走 SDK 默认 agentDir 解析）', async () => {
    await handleInit({ id: 'req_10', type: 'init', config: { cwd: '/p' } }, makeCtx());

    expect(modelRuntimeCreate).not.toHaveBeenCalled();
    expect(createAgentSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ modelRuntime: expect.anything() }),
    );
  });
});
