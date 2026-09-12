/**
 * session-router 恢复与 cwd 安全边界（issue 07）。
 *
 * 验收标准：
 *   - 恢复优先使用持久化 cwd 定位原生 session（engineSessionId 参与 resume，
 *     历史 ompSessionId 只读兼容、不再读取）；
 *   - 持久化 cwd 不存在或不可访问时只能查看 transcript（不创建运行时会话，
 *     返回 degraded 结果）；用户明确选择新 cwd（rebindCwd）后才能重建执行；
 *   - 项目移动/重命名后 holistic swap 不覆写持久化 cwd（不自动重绑定旧 session）。
 *
 * 测试缝：tRPC server-side caller（router.createCaller），重依赖全部 mock。
 * 先例：tests/session/session-router-model-swap.test.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Hoisted mocks ──────────────────────────────────────────

const {
  sessionManagerMock,
  createSessionContextMock,
  credentialGetMock,
  requireSessionMock,
  loadSessionsMock,
  saveSessionsMock,
  loadStoredMessagesMock,
  isCwdAccessibleMock,
} = vi.hoisted(() => ({
  sessionManagerMock: {
    getSession: vi.fn(),
    getEngineSessionId: vi.fn((): string | undefined => undefined),
    getEngine: vi.fn((): 'omp' | 'pi' => 'pi'),
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
  loadSessionsMock: vi.fn(async () => [] as unknown[]),
  saveSessionsMock: vi.fn(async () => {}),
  loadStoredMessagesMock: vi.fn(async () => [] as unknown[]),
  isCwdAccessibleMock: vi.fn((_cwd?: string) => true),
}));

vi.mock('../../src/main/services/project-service', () => ({
  requireProject: vi.fn(() => ({ id: 'proj_1', rootPath: '/tmp/proj', name: 'P' })),
  ensurePluginsLoaded: vi.fn(async () => {}),
}));

vi.mock('../../src/main/services/session-service', () => ({
  requireSession: requireSessionMock,
  storedMessagesPath: (rootPath: string, sessionId: string) => `${rootPath}/${sessionId}.json`,
  loadStoredMessages: loadStoredMessagesMock,
  filterEmptyPlaceholderSessions: vi.fn(async (_root: string, sessions: unknown[]) => sessions),
}));

vi.mock('../../src/main/agent/session-manager', () => ({
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
  loadSessions: loadSessionsMock,
  saveSessions: saveSessionsMock,
  updateSessionModel: vi.fn(async () => {}),
  updateSessionActivity: vi.fn(async () => {}),
  updateSessionContextUsage: vi.fn(async () => {}),
  updateSessionEngineId: vi.fn(async () => {}),
  isCwdAccessible: isCwdAccessibleMock,
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

const PERSISTED_ID = 'persisted_1';
const RUNTIME_ID = 'rt_new_1';

/** pi 持久化记录：原生 session id 与创建时 cwd 均已记录。 */
function makePiPersisted(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: PERSISTED_ID,
    engine: 'pi',
    engineSessionId: 'pi-native-0001',
    cwd: 'D:/proj/dv',
    name: 'pi 会话',
    projectId: 'proj_1',
    createdAt: 1,
    lastActivityAt: 1,
    model: { provider: 'socverify-openai-compatible', id: 'glm-5', name: 'GLM', providerId: 'cred_1' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isCwdAccessibleMock.mockReturnValue(true);
  loadSessionsMock.mockResolvedValue([makePiPersisted()]);
  loadStoredMessagesMock.mockResolvedValue([
    { role: 'user', content: '第一条用户消息', timestamp: 1000 },
    { role: 'assistant', content: '第一条助手回复', timestamp: 2000 },
  ]);
  credentialGetMock.mockResolvedValue({
    providerId: 'cred_1',
    apiKey: 'sk-1',
    baseUrl: 'http://llm.local/v1',
  });
  createSessionContextMock.mockResolvedValue({
    sessionId: RUNTIME_ID,
    provider: 'socverify-openai-compatible',
    model: 'glm-5',
    providerId: 'cred_1',
    apiKey: 'sk-1',
    baseUrl: 'http://llm.local/v1',
    credEnv: {},
  });
});

// ─── restore ────────────────────────────────────────────────

describe('session restore — 持久化 cwd 与原生 session 定位（issue 07）', () => {
  it('使用持久化 cwd 与 engineSessionId 恢复，seedHistory 来自 UI transcript', async () => {
    const result = await caller.restore({
      projectId: 'proj_1',
      cwd: '/tmp/proj',
      sessionId: PERSISTED_ID,
      name: 'pi 会话',
    });

    expect(result.sessionId).toBe(RUNTIME_ID);
    expect(createSessionContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: 'D:/proj/dv',
        resumeSessionId: 'pi-native-0001',
        persistedSessionId: PERSISTED_ID,
        seedHistory: [
          { role: 'user', content: '第一条用户消息', timestamp: 1000 },
          { role: 'assistant', content: '第一条助手回复', timestamp: 2000 },
        ],
      }),
    );
  });

  it('恢复后回写 engine/engineSessionId 且保持持久化 cwd 不被覆写', async () => {
    sessionManagerMock.getEngine.mockReturnValue('pi');
    sessionManagerMock.getEngineSessionId.mockReturnValue('pi-native-9999');

    await caller.restore({
      projectId: 'proj_1',
      cwd: '/tmp/proj',
      sessionId: PERSISTED_ID,
    });

    expect(saveSessionsMock).toHaveBeenCalledWith(
      '/tmp/proj',
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: PERSISTED_ID,
          engine: 'pi',
          engineSessionId: 'pi-native-9999',
          cwd: 'D:/proj/dv',
        }),
      ]),
    );
  });

  it('持久化 cwd 不可访问时返回 degraded，不创建运行时会话（仅可查看 transcript）', async () => {
    isCwdAccessibleMock.mockImplementation((cwd?: string) => cwd !== 'D:/proj/dv');

    const result = await caller.restore({
      projectId: 'proj_1',
      cwd: '/tmp/proj',
      sessionId: PERSISTED_ID,
    });

    expect(result.sessionId).toBeNull();
    expect(result.degraded).toEqual({ reason: 'cwd-unavailable', cwd: 'D:/proj/dv' });
    expect(createSessionContextMock).not.toHaveBeenCalled();
    expect(saveSessionsMock).not.toHaveBeenCalled();
  });

  it('legacy 记录缺 engineSessionId 时回退 runtime session id（omp 兼容路径不变）', async () => {
    loadSessionsMock.mockResolvedValue([
      makePiPersisted({ engine: 'omp', engineSessionId: undefined }),
    ]);

    await caller.restore({
      projectId: 'proj_1',
      cwd: '/tmp/proj',
      sessionId: PERSISTED_ID,
    });

    expect(createSessionContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ resumeSessionId: PERSISTED_ID }),
    );
  });
});

// ─── rebindCwd（用户显式选择新 cwd 后重建） ─────────────────

describe('session rebindCwd — 显式重绑工作目录（issue 07）', () => {
  it('新 cwd 可访问时：更新持久化 cwd 并以新 cwd 重建会话', async () => {
    sessionManagerMock.getEngine.mockReturnValue('pi');
    sessionManagerMock.getEngineSessionId.mockReturnValue('pi-rebuilt-0007');

    const result = await caller.rebindCwd({
      projectId: 'proj_1',
      sessionId: PERSISTED_ID,
      newCwd: 'D:/proj/dv-moved',
    });

    expect(result.rebound).toBe(true);
    expect(result.sessionId).toBe(RUNTIME_ID);
    // 重建路径：resumeSessionId 仍下发，但新 cwd bucket 中找不到旧原生 session
    // → runner 按 transcript 重建（安全降级，不重绑定旧文件）
    expect(createSessionContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: 'D:/proj/dv-moved',
        resumeSessionId: 'pi-native-0001',
        persistedSessionId: PERSISTED_ID,
      }),
    );
    expect(saveSessionsMock).toHaveBeenCalledWith(
      '/tmp/proj',
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: PERSISTED_ID,
          cwd: 'D:/proj/dv-moved',
          engineSessionId: 'pi-rebuilt-0007',
        }),
      ]),
    );
  });

  it('新 cwd 不可访问时拒绝重绑（BAD_REQUEST），不改动持久化记录', async () => {
    isCwdAccessibleMock.mockReturnValue(false);

    await expect(
      caller.rebindCwd({
        projectId: 'proj_1',
        sessionId: PERSISTED_ID,
        newCwd: 'D:/no-such-dir',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(createSessionContextMock).not.toHaveBeenCalled();
    expect(saveSessionsMock).not.toHaveBeenCalled();
  });

  it('会话不存在于项目时返回 NOT_FOUND', async () => {
    loadSessionsMock.mockResolvedValue([]);

    await expect(
      caller.rebindCwd({
        projectId: 'proj_1',
        sessionId: 'ghost',
        newCwd: 'D:/proj/dv-moved',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ─── holistic swap 不破坏持久化 cwd ─────────────────────────

describe('session setModel holistic swap — 持久化 cwd 保持（issue 07）', () => {
  it('swap 重建使用持久化 cwd（pi bucket 不漂移），持久化记录不覆写为项目根', async () => {
    const entry = {
      id: 'rt_old',
      persistedSessionId: PERSISTED_ID,
      engine: 'pi',
      projectId: 'proj_1',
      client: { isRunning: () => true },
      hostTools: {},
      hostUris: {},
      createdAt: 0,
      lastActivityAt: 0,
      idleTimer: null,
      model: 'glm-5',
      providerId: 'cred_1',
      credentialSnapshot: 'cred_1|sk-1|http://llm.local/v1',
      isActive: false,
    };
    sessionManagerMock.getSession.mockReturnValue(entry);
    sessionManagerMock.getEngine.mockReturnValue('pi');
    sessionManagerMock.getEngineSessionId.mockReturnValue('pi-native-0001');
    credentialGetMock.mockResolvedValue({
      providerId: 'cred_2',
      apiKey: 'sk-2',
      baseUrl: 'http://other.local/v1',
    });

    const result = await caller.setModel({
      sessionId: 'rt_old',
      providerId: 'cred_2',
      modelId: 'glm-x',
    });

    expect(result.swapped).toBe(true);
    expect(createSessionContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: 'D:/proj/dv' }),
    );
    expect(saveSessionsMock).toHaveBeenCalledWith(
      '/tmp/proj',
      expect.arrayContaining([
        expect.objectContaining({ sessionId: PERSISTED_ID, cwd: 'D:/proj/dv' }),
      ]),
    );
  });

  it('持久化 cwd 不可访问时 swap 回退项目根', async () => {
    const entry = {
      id: 'rt_old',
      persistedSessionId: PERSISTED_ID,
      engine: 'pi',
      projectId: 'proj_1',
      client: { isRunning: () => true },
      hostTools: {},
      hostUris: {},
      createdAt: 0,
      lastActivityAt: 0,
      idleTimer: null,
      model: 'glm-5',
      providerId: 'cred_1',
      credentialSnapshot: 'cred_1|sk-1|http://llm.local/v1',
      isActive: false,
    };
    sessionManagerMock.getSession.mockReturnValue(entry);
    sessionManagerMock.getEngine.mockReturnValue('pi');
    sessionManagerMock.getEngineSessionId.mockReturnValue('pi-native-0001');
    isCwdAccessibleMock.mockReturnValue(false);
    credentialGetMock.mockResolvedValue({
      providerId: 'cred_2',
      apiKey: 'sk-2',
      baseUrl: 'http://other.local/v1',
    });

    await caller.setModel({ sessionId: 'rt_old', providerId: 'cred_2', modelId: 'glm-x' });

    expect(createSessionContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/tmp/proj' }),
    );
  });
});
