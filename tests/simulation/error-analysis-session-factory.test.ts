import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ErrorAnalysisSessionFactory } from '../../src/main/simulation/error-analysis-session-factory';

// ─── Mock factories ─────────────────────────────────────

function createMockSessionManager() {
  const sessions = new Map<string, { hostTools: { registerCustom: ReturnType<typeof vi.fn> } }>();
  return {
    createSession: vi.fn(async (..._args: unknown[]) => {
      const id = `session_${Date.now()}`;
      sessions.set(id, { hostTools: { registerCustom: vi.fn() } });
      return id;
    }),
    getSession: vi.fn((id: string) => sessions.get(id) ?? null),
    getClient: vi.fn(() => ({
      prompt: vi.fn(async () => {}),
    })),
    _sessions: sessions,
  };
}

function createMockPluginLoader() {
  return {
    getRegistry: vi.fn(() => ({
      caseParsers: [],
      subsysDiscoverers: [],
      coverageParsers: [],
      simulationRunners: [],
      simOptionSchemaProviders: [],
    })),
  };
}

function createMockCredentialManager() {
  return {
    buildEnvForAgent: vi.fn(async () => ({ API_KEY: 'test-key' })),
    getDefaultCredential: vi.fn(async () => ({
      providerId: 'openai',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com',
    })),
    get: vi.fn(async (providerId: string) => ({
      providerId,
      apiKey: 'sk-selected',
      baseUrl: 'https://selected.example/v1',
    })),
    mapProviderForAgent: vi.fn(() => 'openai'),
  };
}

// ─── Tests ──────────────────────────────────────────────

describe('ErrorAnalysisSessionFactory', () => {
  let factory: ErrorAnalysisSessionFactory;
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let mockPluginLoader: ReturnType<typeof createMockPluginLoader>;
  let mockCredentialManager: ReturnType<typeof createMockCredentialManager>;
  let tempProject: string | undefined;

  beforeEach(() => {
    mockSessionManager = createMockSessionManager();
    mockPluginLoader = createMockPluginLoader();
    mockCredentialManager = createMockCredentialManager();
    factory = new ErrorAnalysisSessionFactory({
      sessionManager: mockSessionManager as never,
      pluginLoader: mockPluginLoader as never,
      credentialManager: mockCredentialManager as never,
    });
  });

  afterEach(async () => {
    if (tempProject) await rm(tempProject, { recursive: true, force: true });
    tempProject = undefined;
  });

  it('creates a session and returns sessionId', async () => {
    const sessionId = await factory.createSession({
      projectId: 'proj1',
      caseName: 'test_case',
      errorType: 'compile_error',
      cwd: '/tmp/project',
      errorContext: 'Error: missing semicolon',
      maxRetries: 3,
    });

    expect(sessionId).toBeTruthy();
    expect(mockSessionManager.createSession).toHaveBeenCalledOnce();
  });

  it('passes correct system prompt for compile errors', async () => {
    await factory.createSession({
      projectId: 'proj1',
      caseName: 'test_case',
      errorType: 'compile_error',
      cwd: '/tmp/project',
      errorContext: 'Error: missing semicolon',
      maxRetries: 3,
    });

    const callArgs = mockSessionManager.createSession.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(callArgs.systemPrompt).toContain('compilation errors');
  });

  it('passes correct system prompt for sim errors', async () => {
    await factory.createSession({
      projectId: 'proj1',
      caseName: 'test_case',
      errorType: 'sim_error',
      cwd: '/tmp/project',
      errorContext: 'UVM_ERROR',
      maxRetries: 3,
    });

    const callArgs = mockSessionManager.createSession.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(callArgs.systemPrompt).toContain('simulation errors');
  });

  it('registers runsim_retry tool for compile errors', async () => {
    const sessionId = await factory.createSession({
      projectId: 'proj1',
      caseName: 'test_case',
      errorType: 'compile_error',
      cwd: '/tmp/project',
      errorContext: 'Error',
      maxRetries: 3,
    });

    const session = mockSessionManager._sessions.get(sessionId);
    expect(session?.hostTools.registerCustom).toHaveBeenCalledWith(
      'runsim_retry',
      expect.any(String),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('does NOT register runsim_retry for sim errors', async () => {
    const sessionId = await factory.createSession({
      projectId: 'proj1',
      caseName: 'test_case',
      errorType: 'sim_error',
      cwd: '/tmp/project',
      errorContext: 'UVM_ERROR',
      maxRetries: 3,
    });

    const session = mockSessionManager._sessions.get(sessionId);
    expect(session?.hostTools.registerCustom).not.toHaveBeenCalled();
  });

  it('sends initial prompt message to the agent', async () => {
    const mockPrompt = vi.fn(async (_msg: string) => {});
    mockSessionManager.getClient.mockReturnValue({ prompt: mockPrompt } as never);

    await factory.createSession({
      projectId: 'proj1',
      caseName: 'test_uart',
      errorType: 'compile_error',
      cwd: '/tmp/project',
      errorContext: 'Error details here',
      maxRetries: 3,
    });

    expect(mockPrompt).toHaveBeenCalledOnce();
    const promptText = mockPrompt.mock.calls[0][0] as unknown as string;
    expect(promptText).toContain('test_uart');
    expect(promptText).toContain('Error details here');
  });

  it('exposes the exact initial prompt to the coordinator before sending it', async () => {
    let initialPrompt = '';
    await factory.createSession({
      projectId: 'proj1',
      caseName: 'test_uart',
      errorType: 'compile_error',
      cwd: '/tmp/project',
      errorContext: 'Error details here',
      maxRetries: 3,
      onPrompt: (message) => { initialPrompt = message; },
    });

    expect(initialPrompt).toContain('test_uart');
    expect(initialPrompt).toContain('Error details here');
  });

  it('loads credentials and passes them to session creation', async () => {
    await factory.createSession({
      projectId: 'proj1',
      caseName: 'test_case',
      errorType: 'sim_error',
      cwd: '/tmp/project',
      errorContext: 'Error',
      maxRetries: 3,
    });

    expect(mockCredentialManager.buildEnvForAgent).toHaveBeenCalled();
    expect(mockCredentialManager.getDefaultCredential).toHaveBeenCalled();

    const callArgs = mockSessionManager.createSession.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(callArgs.provider).toBe('openai');
    expect(callArgs.apiKey).toBe('sk-test');
  });

  it('reuses the most recently selected persisted model and its credential', async () => {
    tempProject = await mkdtemp(join(tmpdir(), 'socverify-error-analysis-'));
    await mkdir(join(tempProject, '.socverify'));
    await writeFile(join(tempProject, '.socverify', 'sessions.json'), JSON.stringify([
      {
        sessionId: 'session-1',
        name: 'AI',
        projectId: 'proj1',
        createdAt: 1,
        lastActivityAt: 2,
        model: {
          provider: 'openai',
          id: 'selected-model',
          name: 'selected-model',
          providerId: 'selected-provider',
        },
      },
    ]));

    await factory.createSession({
      projectId: 'proj1',
      caseName: 'test_case',
      errorType: 'sim_error',
      cwd: tempProject,
      errorContext: 'Error',
      maxRetries: 3,
    });

    expect(mockCredentialManager.get).toHaveBeenCalledWith('selected-provider');
    const callArgs = mockSessionManager.createSession.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(callArgs.model).toBe('selected-model');
    expect(callArgs.apiKey).toBe('sk-selected');
    expect(callArgs.baseUrl).toBe('https://selected.example/v1');
  });
});
