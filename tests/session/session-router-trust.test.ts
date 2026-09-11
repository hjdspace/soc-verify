/**
 * session-router resolveTrust —— 信任请求决议（issue 04）。
 *
 * 测试缝：tRPC server-side caller（router.createCaller），sessionManager 全 mock。
 * 先例：tests/session/session-router-model-swap.test.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { sessionManagerMock } = vi.hoisted(() => ({
  sessionManagerMock: {
    resolveTrust: vi.fn(() => true),
  },
}));

vi.mock('../../src/main/agent/session-manager', () => ({
  credentialSnapshot: (providerId?: string, apiKey?: string, baseUrl?: string) =>
    `${providerId ?? ''}|${apiKey ?? ''}|${baseUrl ?? ''}`,
  sessionManager: sessionManagerMock,
}));

vi.mock('../../src/main/services/project-service', () => ({
  requireProject: vi.fn(() => ({ id: 'proj_1', rootPath: '/tmp/proj', name: 'P' })),
  ensurePluginsLoaded: vi.fn(async () => {}),
}));

vi.mock('../../src/main/services/session-service', () => ({
  requireSession: vi.fn(() => ({ isRunning: () => true })),
  storedMessagesPath: (rootPath: string, sessionId: string) => `${rootPath}/${sessionId}.json`,
  loadStoredMessages: vi.fn(async () => []),
  filterEmptyPlaceholderSessions: vi.fn(async (_root: string, sessions: unknown[]) => sessions),
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
    get: vi.fn(async () => null),
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
  updateSessionEngineId: vi.fn(async () => {}),
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

import { sessionRouter } from '../../src/main/ipc/routers/session-router';

const caller = sessionRouter.createCaller({});

describe('session-router resolveTrust（issue 04）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionManagerMock.resolveTrust.mockReturnValue(true);
  });

  it('合法 kind/name 透传到 sessionManager.resolveTrust 并返回 ok', async () => {
    const result = await caller.resolveTrust({
      requestId: 'trust_1',
      approved: true,
      kind: 'mcp-server',
      name: 'traceweave',
    });

    expect(result).toEqual({ ok: true });
    expect(sessionManagerMock.resolveTrust).toHaveBeenCalledWith('trust_1', true);
  });

  it('拒绝（approved=false）同样透传', async () => {
    await caller.resolveTrust({
      requestId: 'trust_2',
      approved: false,
      kind: 'project-extension',
      name: '.pi/extensions',
      path: '/proj/dv/.pi/extensions',
    });

    expect(sessionManagerMock.resolveTrust).toHaveBeenCalledWith('trust_2', false);
  });

  it('非法 kind 抛 BAD_REQUEST', async () => {
    await expect(
      caller.resolveTrust({
        requestId: 'trust_3',
        approved: true,
        // @ts-expect-error intentionally invalid kind
        kind: 'anything-else',
        name: 'x',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(sessionManagerMock.resolveTrust).not.toHaveBeenCalled();
  });

  it('requestId 不存在时抛 NOT_FOUND', async () => {
    sessionManagerMock.resolveTrust.mockReturnValue(false);
    await expect(
      caller.resolveTrust({ requestId: 'missing', approved: true, kind: 'mcp-server', name: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
