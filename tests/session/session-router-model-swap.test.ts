/**
 * session-router 模型切换（holistic swap）与 send 竞态回归测试。
 *
 * 背景 bug：新会话 tab 切换 provider/model 后立即发消息，setModel 的
 * destroy+recreate 与 send 竞态 —— prompt 被投递到即将销毁的旧进程，
 * 消息永久丢失，UI 一直转圈收不到 LLM 响应。
 *
 * 测试缝：tRPC server-side caller（router.createCaller），重依赖全部 mock。
 * 先例：tests/dashboard-router.test.ts、tests/session/session-manager.test.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Hoisted mocks ──────────────────────────────────────────

const {
  sessionManagerMock,
  createSessionContextMock,
  credentialGetMock,
  requireSessionMock,
} = vi.hoisted(() => ({
  sessionManagerMock: {
    getSession: vi.fn(),
    getOmpSessionId: vi.fn((): string | undefined => undefined),
    destroySession: vi.fn(async () => {}),
    touchActivity: vi.fn(),
    promptFireAndForget: vi.fn(async () => {}),
    abortSession: vi.fn(async () => {}),
    getModel: vi.fn((): string | undefined => undefined),
    listSessions: vi.fn(() => []),
    setModel: vi.fn(async () => {}),
    setApprovalMode: vi.fn(async () => {}),
    resolveApproval: vi.fn(() => false),
    resolveAsk: vi.fn(() => false),
    getAvailableModels: vi.fn(async () => []),
  },
  createSessionContextMock: vi.fn(),
  credentialGetMock: vi.fn(),
  requireSessionMock: vi.fn(() => ({ isRunning: () => true })),
}));

vi.mock('../../src/main/services/project-service', () => ({
  requireProject: vi.fn(() => ({ id: 'proj_1', rootPath: '/tmp/proj', name: 'P' })),
  ensurePluginsLoaded: vi.fn(async () => {}),
}));

vi.mock('../../src/main/services/session-service', () => ({
  requireSession: requireSessionMock,
  storedMessagesPath: (rootPath: string, sessionId: string) => `${rootPath}/${sessionId}.json`,
  loadStoredMessages: vi.fn(async () => []),
  filterEmptyPlaceholderSessions: vi.fn(async (_root: string, sessions: unknown[]) => sessions),
}));

vi.mock('../../src/main/agent/session-manager', () => ({
  // Same format as the real implementation — consistency within this
  // process is all the guard relies on.
  credentialSnapshot: (providerId?: string, apiKey?: string, baseUrl?: string) =>
    `${providerId ?? ''}|${apiKey ?? ''}|${baseUrl ?? ''}`,
  sessionManager: sessionManagerMock,
}));

vi.mock('../../src/main/agent/session-context-factory', () => ({
  createSessionContext: createSessionContextMock,
}));

vi.mock('../../src/main/project/project-manager', () => ({
  projectManager: {
    getProject: vi.fn(() => ({ rootPath: '/tmp/proj' })),
  },
}));

vi.mock('../../src/main/plugins/loader', () => ({
  pluginLoader: {
    getRegistry: vi.fn(() => ({ subsysDiscoverers: [{}] })),
    getLoadResults: vi.fn(() => []),
  },
}));

vi.mock('../../src/main/credentials/credential-manager', () => ({
  credentialManager: {
    get: credentialGetMock,
    mapProviderForAgent: vi.fn((p: string) => p),
    buildEnvForAgent: vi.fn(async () => ({})),
    getDefaultCredential: vi.fn(async () => null),
  },
}));

vi.mock('../../src/main/agent/session-persistence', () => ({
  addSession: vi.fn(async () => {}),
  removeSession: vi.fn(async () => {}),
  loadSessions: vi.fn(async () => []),
  saveSessions: vi.fn(async () => {}),
  updateSessionModel: vi.fn(async () => {}),
  updateSessionActivity: vi.fn(async () => {}),
  updateSessionContextUsage: vi.fn(async () => {}),
}));

vi.mock('../../src/main/agent/skill-discovery', () => ({
  discoverSkills: vi.fn(async () => []),
  readSkillContent: vi.fn(async () => ''),
}));

vi.mock('../../src/main/agent/title-generator', () => ({
  generateSessionTitle: vi.fn(async () => null),
}));

vi.mock('../../src/main/simulation/error-analysis-coordinator', () => ({
  errorAnalysisCoordinator: {
    triggerAnalysis: vi.fn(async () => null),
  },
}));

// ─── Imports (after mocks) ──────────────────────────────────

import { sessionRouter } from '../../src/main/ipc/routers/session-router';

const caller = sessionRouter.createCaller({});

const OLD_ID = 'session_old_1';
const NEW_ID = 'session_new_1';

/** A runtime session entry created with credential unisoc/deepseek-v4-flash. */
function makeUnisocEntry() {
  return {
    id: OLD_ID,
    persistedSessionId: 'persisted_1',
    ompSessionId: 'omp_old',
    projectId: 'proj_1',
    client: { isRunning: () => true },
    hostTools: {},
    hostUris: {},
    createdAt: 0,
    lastActivityAt: 0,
    idleTimer: null,
    runtimeDir: '/tmp/runtime',
    model: 'deepseek-v4-flash',
    providerId: 'unisoc',
    credentialSnapshot: 'unisoc|sk-unisoc|http://maas.unisoc.com/v1',
    isActive: false,
  };
}

describe('session-router setModel — redundant holistic swap no-op guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    credentialGetMock.mockResolvedValue({
      providerId: 'unisoc',
      apiKey: 'sk-unisoc',
      baseUrl: 'http://maas.unisoc.com/v1',
    });
    sessionManagerMock.getSession.mockReturnValue(makeUnisocEntry());
  });

  it('skips destroy/recreate when the session already runs the requested provider+model', async () => {
    const result = await caller.setModel({
      sessionId: OLD_ID,
      provider: 'unisoc',
      modelId: 'deepseek-v4-flash',
      modelName: 'deepseek-v4-flash',
      providerId: 'unisoc',
    });

    expect(result.swapped).toBe(false);
    expect(result.sessionId).toBe(OLD_ID);
    expect(sessionManagerMock.destroySession).not.toHaveBeenCalled();
    expect(createSessionContextMock).not.toHaveBeenCalled();
  });

  it('performs a real swap when a different model is requested', async () => {
    createSessionContextMock.mockResolvedValue({
      sessionId: NEW_ID,
      provider: 'unisoc',
      model: 'glm-5.2',
      providerId: 'unisoc',
      apiKey: 'sk-unisoc',
      baseUrl: 'http://maas.unisoc.com/v1',
      credEnv: {},
    });

    const result = await caller.setModel({
      sessionId: OLD_ID,
      provider: 'unisoc',
      modelId: 'glm-5.2',
      providerId: 'unisoc',
    });

    expect(result.swapped).toBe(true);
    expect(result.sessionId).toBe(NEW_ID);
    expect(sessionManagerMock.destroySession).toHaveBeenCalledWith(OLD_ID);
    expect(createSessionContextMock).toHaveBeenCalledOnce();
  });

  it('performs a real swap when the same providerId was edited (credential snapshot differs)', async () => {
    // User rotated the API key — snapshot must differ even though provider+model match.
    credentialGetMock.mockResolvedValue({
      providerId: 'unisoc',
      apiKey: 'sk-new-key',
      baseUrl: 'http://maas.unisoc.com/v1',
    });
    createSessionContextMock.mockResolvedValue({
      sessionId: NEW_ID,
      provider: 'unisoc',
      model: 'deepseek-v4-flash',
      providerId: 'unisoc',
      apiKey: 'sk-new-key',
      baseUrl: 'http://maas.unisoc.com/v1',
      credEnv: {},
    });

    const result = await caller.setModel({
      sessionId: OLD_ID,
      providerId: 'unisoc',
      modelId: 'deepseek-v4-flash',
    });

    expect(result.swapped).toBe(true);
    expect(sessionManagerMock.destroySession).toHaveBeenCalledWith(OLD_ID);
  });
});

describe('session-router send — in-flight swap retargeting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    credentialGetMock.mockResolvedValue({
      providerId: 'other',
      apiKey: 'sk-other',
      baseUrl: 'http://other.example/v1',
    });
    sessionManagerMock.getSession.mockReturnValue(makeUnisocEntry());
    requireSessionMock.mockImplementation(() => ({ isRunning: () => true }));
  });

  it('delivers the prompt to the recreated session when send races a swap', async () => {
    // Swap hangs at session recreation — simulating the slow destroy/recreate window.
    let resolveCreate!: (value: unknown) => void;
    createSessionContextMock.mockImplementation(
      () => new Promise((resolve) => { resolveCreate = resolve; }),
    );

    const swapPromise = caller.setModel({
      sessionId: OLD_ID,
      providerId: 'other',
      modelId: 'glm-x',
    });
    await vi.waitFor(() => {
      expect(sessionManagerMock.destroySession).toHaveBeenCalledWith(OLD_ID);
    });

    // Message arrives while the old process is already destroyed but the new
    // one is not yet created — exactly the reported bug's interleaving.
    const sendPromise = caller.send({ sessionId: OLD_ID, message: '你是谁' });
    expect(sessionManagerMock.promptFireAndForget).not.toHaveBeenCalled();

    resolveCreate({
      sessionId: NEW_ID,
      provider: 'other',
      model: 'glm-x',
      providerId: 'other',
      apiKey: 'sk-other',
      baseUrl: 'http://other.example/v1',
      credEnv: {},
    });

    await swapPromise;
    const result = await sendPromise;
    expect(result.ok).toBe(true);
    expect(sessionManagerMock.promptFireAndForget).toHaveBeenCalledWith(NEW_ID, '你是谁', undefined);
  });

  it('coalesces concurrent setModel calls for the same session into one swap', async () => {
    let resolveCreate!: (value: unknown) => void;
    createSessionContextMock.mockImplementation(
      () => new Promise((resolve) => { resolveCreate = resolve; }),
    );

    const swap1 = caller.setModel({ sessionId: OLD_ID, providerId: 'other', modelId: 'glm-x' });
    const swap2 = caller.setModel({ sessionId: OLD_ID, providerId: 'other', modelId: 'glm-x' });
    await vi.waitFor(() => {
      expect(createSessionContextMock).toHaveBeenCalledTimes(1);
    });

    resolveCreate({
      sessionId: NEW_ID,
      provider: 'other',
      model: 'glm-x',
      providerId: 'other',
      apiKey: 'sk-other',
      baseUrl: 'http://other.example/v1',
      credEnv: {},
    });

    const [r1, r2] = await Promise.all([swap1, swap2]);
    expect(r1.sessionId).toBe(NEW_ID);
    expect(r2.sessionId).toBe(NEW_ID);
    // Only ONE destroy/recreate cycle despite two overlapping requests.
    expect(sessionManagerMock.destroySession).toHaveBeenCalledTimes(1);
    expect(createSessionContextMock).toHaveBeenCalledTimes(1);
  });

  it('sends normally when no swap is in flight', async () => {
    const result = await caller.send({ sessionId: OLD_ID, message: 'hi' });
    expect(result.ok).toBe(true);
    expect(sessionManagerMock.promptFireAndForget).toHaveBeenCalledWith(OLD_ID, 'hi', undefined);
  });
});
