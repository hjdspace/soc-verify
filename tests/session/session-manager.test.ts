import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { AskAnswer } from '@shared/ask-types';

// ─── Mock path resolvers and heavy dependencies ────────────────────
// createSession() calls resolveAgentRuntime(), which checks for the
// runner binary or Bun + engine submodule. In the test environment these
// are not available, so we mock the resolver to return a fake runtime.

vi.mock('../../src/main/agent/paths', () => ({
  resolveAgentRuntime: vi.fn(() => ({
    mode: 'binary' as const,
    runnerPath: '/fake/runner',
    bunVersionOk: true,
  })),
  resolveRunnerBinary: vi.fn(() => '/fake/runner'),
  resolveRunnerScript: vi.fn(() => null),
  resolveBunPath: vi.fn(() => null),
  resolveBuiltInExtensionDir: vi.fn(() => null),
  checkBunVersion: vi.fn(() => ({ ok: true, version: '1.3.14', required: '1.3.14' })),
}));

vi.mock('../../src/main/agent/officecli-paths', () => ({
  ensureOfficecliOnPath: vi.fn(async () => {}),
}));

vi.mock('../../src/main/mcp/mcp-config', () => ({
  ensureBuiltinMcpServers: vi.fn(async () => false),
}));

vi.mock('../../src/main/mcp/traceweave-paths', () => ({
  ensureTraceweaveDefaultMcp: vi.fn(() => null),
}));

vi.mock('../../src/main/agent/context-settings', () => ({
  contextSettings: {
    getContextWindow: vi.fn(async () => 128000),
  },
}));

// Mock AgentClient — it would otherwise spawn a child process
const { MockAgentClient } = vi.hoisted(() => {
  const { EventEmitter } = require('node:events') as typeof import('node:events');

  class MockAgentClient extends EventEmitter {
    started = false;
    stopped = false;
    destroyed = false;
    initResult = { sessionId: 'omp-session-test' };
    eventListeners: Array<(event: unknown) => void> = [];
    toolCallHandler: unknown = null;
    approvalHandler: unknown = null;
    lastPrompt: string | undefined;
    lastImages: unknown = undefined;
    /** Captures the env passed to the constructor so tests can assert on it. */
    capturedEnv: Record<string, string> | undefined;

    constructor(opts: unknown) {
      super();
      this.capturedEnv = (opts as { env?: Record<string, string> })?.env;
    }

    setToolCallHandler(handler: unknown) { this.toolCallHandler = handler; }
    setApprovalHandler(handler: unknown) { this.approvalHandler = handler; }
    onEvent(listener: (event: unknown) => void) { this.eventListeners.push(listener); }

    async start() { this.started = true; }
    async init(_config: unknown) { return this.initResult; }
    async prompt(message: string, images?: unknown) { this.lastPrompt = message; this.lastImages = images; }
    async abort() { this.stop(); }
    async steer(_message: string) {}
    async setModel(_provider: string, _modelId: string) {}
    async setApprovalMode(_mode: string) {}
    async compact() { return {}; }
    async getMessages() { return []; }
    async getState() { return {}; }
    async getMcpStatus() { return {}; }
    async getMcpServerTools(_name: string) { return []; }
    async reloadMcp() { return {}; }
    stop() { this.started = false; this.stopped = true; }
    async destroy() { this.stop(); this.destroyed = true; }
  }

  return { MockAgentClient };
});

vi.mock('../../src/main/agent/agent-client', () => ({
  AgentClient: MockAgentClient,
  ToolCallHandler: {},
}));

// Mock HostToolsRegistry and HostUriRouter (they do real file system operations)
vi.mock('../../src/main/host/host-tools', () => ({
  HostToolsRegistry: class {
    constructor() {}
    setSimulationAdapter() {}
    setCoverageAdapter() {}
    setCoverageManager() {}
    setCaseStatsService() {}
    getDefinitions() { return []; }
    handleToolCall = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    registerCustom() {}
  },
}));

vi.mock('../../src/main/host/host-uris', () => ({
  HostUriRouter: class {
    constructor() {}
    setCoverageManager() {}
  },
}));

// Import AFTER mocks — only SessionManagerImpl is needed; contextSettings
// and resolveAgentRuntime are mocked above.
const { SessionManagerImpl } = await import('../../src/main/agent/session-manager');

// ─── Helpers ────────────────────────────────────────────────────────

async function createTestSession(
  manager: InstanceType<typeof SessionManagerImpl>,
  overrides?: { projectId?: string; cwd?: string },
): Promise<string> {
  return manager.createSession({
    projectId: overrides?.projectId ?? 'test_project',
    cwd: overrides?.cwd ?? '/tmp/test',
    provider: 'test-provider',
    model: 'test-model',
    apiKey: 'test-key',
    baseUrl: 'http://localhost:1234/v1',
    enableMCP: false,
  });
}

describe('SessionManager — concurrency limit', () => {
  let manager: InstanceType<typeof SessionManagerImpl>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManagerImpl(60_000);
  });

  afterEach(async () => {
    await manager.destroyAll();
  });

  it('throws when exceeding max concurrent sessions (10)', async () => {
    // Create 10 sessions (the max)
    for (let i = 0; i < 10; i++) {
      await createTestSession(manager, { projectId: `proj_${i}` });
    }

    // The 11th should fail
    await expect(createTestSession(manager, { projectId: 'proj_11' }))
      .rejects.toThrow('Maximum concurrent sessions (10) reached');
  });

  it('allows creating a new session after one is destroyed', async () => {
    for (let i = 0; i < 10; i++) {
      await createTestSession(manager, { projectId: `proj_${i}` });
    }

    const firstSession = manager.listSessions()[0];
    await manager.destroySession(firstSession.id);

    // Now there's room for one more
    const newId = await createTestSession(manager, { projectId: 'proj_new' });
    expect(newId).toBeTruthy();
  });
});

describe('SessionManager — session lifecycle', () => {
  let manager: InstanceType<typeof SessionManagerImpl>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManagerImpl(60_000);
  });

  afterEach(async () => {
    await manager.destroyAll();
  });

  it('creates a session and tracks it', async () => {
    const id = await createTestSession(manager);

    expect(id).toMatch(/^session_/);
    expect(manager.getSession(id)).not.toBeNull();
    expect(manager.listSessions()).toHaveLength(1);
  });

  it('stores the model ID on the session entry', async () => {
    const id = await createTestSession(manager);

    expect(manager.getModel(id)).toBe('test-model');
  });

  it('stores the omp session ID', async () => {
    const id = await createTestSession(manager);

    expect(manager.getOmpSessionId(id)).toBe('omp-session-test');
  });

  it('returns null for unknown session', () => {
    expect(manager.getSession('nonexistent')).toBeNull();
    expect(manager.getClient('nonexistent')).toBeNull();
    expect(manager.getOmpSessionId('nonexistent')).toBeUndefined();
    expect(manager.getModel('nonexistent')).toBeUndefined();
  });

  it('destroys a session and removes it from tracking', async () => {
    const id = await createTestSession(manager);
    expect(manager.listSessions()).toHaveLength(1);

    await manager.destroySession(id);

    expect(manager.getSession(id)).toBeNull();
    expect(manager.listSessions()).toHaveLength(0);
  });

  it('destroySession is a no-op for unknown sessionId', async () => {
    await expect(manager.destroySession('nonexistent')).resolves.toBeUndefined();
  });

  it('destroyAll removes all sessions', async () => {
    await createTestSession(manager, { projectId: 'proj_1' });
    await createTestSession(manager, { projectId: 'proj_2' });
    expect(manager.listSessions()).toHaveLength(2);

    await manager.destroyAll();

    expect(manager.listSessions()).toHaveLength(0);
  });
});

describe('SessionManager — project session tracking', () => {
  let manager: InstanceType<typeof SessionManagerImpl>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManagerImpl(60_000);
  });

  afterEach(async () => {
    await manager.destroyAll();
  });

  it('lists sessions by project', async () => {
    await createTestSession(manager, { projectId: 'proj_a' });
    await createTestSession(manager, { projectId: 'proj_a' });
    await createTestSession(manager, { projectId: 'proj_b' });

    const projASessions = manager.listSessionsByProject('proj_a');
    expect(projASessions).toHaveLength(2);

    const projBSessions = manager.listSessionsByProject('proj_b');
    expect(projBSessions).toHaveLength(1);
  });

  it('returns empty array for unknown project', () => {
    expect(manager.listSessionsByProject('nonexistent')).toEqual([]);
  });

  it('removes project from tracking when last session is destroyed', async () => {
    const id = await createTestSession(manager, { projectId: 'proj_solo' });
    expect(manager.listSessionsByProject('proj_solo')).toHaveLength(1);

    await manager.destroySession(id);

    expect(manager.listSessionsByProject('proj_solo')).toEqual([]);
  });
});

describe('SessionManager — idle retirement', () => {
  let manager: InstanceType<typeof SessionManagerImpl>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    manager = new SessionManagerImpl(1000); // 1 second idle timeout
  });

  afterEach(async () => {
    vi.useRealTimers();
    await manager.destroyAll();
  });

  it('schedules idle retirement timer on session creation', async () => {
    const id = await createTestSession(manager);
    const entry = manager.getSession(id);
    expect(entry?.idleTimer).not.toBeNull();
  });

  it('destroys the session after idle timeout elapses', async () => {
    const id = await createTestSession(manager);
    expect(manager.getSession(id)).not.toBeNull();

    // Advance past the idle timeout — the timer fires destroySession()
    // asynchronously (fire-and-forget via `void`), so we must wait for
    // the async cleanup to complete.
    await vi.advanceTimersByTimeAsync(1100);
    await vi.waitFor(() => {
      expect(manager.getSession(id)).toBeNull();
    });
  });

  it('does not destroy an active session (agent_start cancels timer)', async () => {
    const id = await createTestSession(manager);

    // Simulate agent_start → session becomes active
    manager['setActive'](id, true);

    // Advance past the idle timeout — should NOT be destroyed
    await vi.advanceTimersByTimeAsync(2000);

    expect(manager.getSession(id)).not.toBeNull();
  });

  it('reschedules idle timer after agent_end', async () => {
    const id = await createTestSession(manager);

    // agent_start → cancel timer
    manager['setActive'](id, true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(manager.getSession(id)).not.toBeNull();

    // agent_end → reschedule timer
    manager['setActive'](id, false);

    // Should still exist before timeout
    await vi.advanceTimersByTimeAsync(500);
    expect(manager.getSession(id)).not.toBeNull();

    // After full timeout → destroyed (wait for async destroy)
    await vi.advanceTimersByTimeAsync(600);
    await vi.waitFor(() => {
      expect(manager.getSession(id)).toBeNull();
    });
  });

  it('touchActivity reschedules the idle timer', async () => {
    const id = await createTestSession(manager);

    // Advance partway through the timeout
    await vi.advanceTimersByTimeAsync(500);

    // Touch activity → resets the timer
    manager.touchActivity(id);

    // Advance past the original timeout — should still exist
    await vi.advanceTimersByTimeAsync(700);
    expect(manager.getSession(id)).not.toBeNull();

    // After the full new timeout → destroyed (wait for async destroy)
    await vi.advanceTimersByTimeAsync(400);
    await vi.waitFor(() => {
      expect(manager.getSession(id)).toBeNull();
    });
  });

  it('touchActivity does NOT reschedule when session is active', async () => {
    const id = await createTestSession(manager);

    manager['setActive'](id, true);
    const entryBefore = manager.getSession(id);
    const timerBefore = entryBefore?.idleTimer;

    manager.touchActivity(id);

    const entryAfter = manager.getSession(id);
    // Timer should still be null (active session has no timer)
    expect(entryAfter?.idleTimer).toBeNull();
    expect(timerBefore).toBeNull();
  });

  it('getIdleTimeoutMs returns the configured timeout', () => {
    expect(manager.getIdleTimeoutMs()).toBe(1000);
  });

  it('setIdleTimeoutMs updates the timeout and reschedules all sessions', async () => {
    const id = await createTestSession(manager);

    manager.setIdleTimeoutMs(5000);

    expect(manager.getIdleTimeoutMs()).toBe(5000);

    // Advance past the old timeout — should still exist with new timeout
    await vi.advanceTimersByTimeAsync(1500);
    expect(manager.getSession(id)).not.toBeNull();
  });
});

describe('SessionManager — ask tool routing', () => {
  let manager: InstanceType<typeof SessionManagerImpl>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManagerImpl(60_000);
  });

  afterEach(async () => {
    await manager.destroyAll();
  });

  it('emits askRequest event when ask tool is called', async () => {
    const id = await createTestSession(manager);
    const entry = manager.getSession(id)!;

    const askEvents: unknown[] = [];
    manager.on('askRequest', (data) => askEvents.push(data));

    // Invoke the tool call handler for 'ask'
    const handler = entry.client['toolCallHandler'] as (toolName: string, args: unknown) => Promise<unknown>;

    // The handler is set on the client — we need to access it through the client
    // Since MockAgentClient stores it, we can invoke it directly
    const askPromise = handler('ask', {
      questions: [{
        id: 'q1',
        question: 'Which approach?',
        options: [{ label: 'Option A' }, { label: 'Option B' }],
      }],
    });

    // Wait for the askRequest event to be emitted
    await new Promise((r) => setTimeout(r, 10));

    expect(askEvents).toHaveLength(1);
    expect(askEvents[0]).toMatchObject({
      sessionId: id,
      requestId: expect.stringMatching(/^ask_/),
      questions: [{
        id: 'q1',
        question: 'Which approach?',
        options: [{ label: 'Option A' }, { label: 'Option B' }],
      }],
    });

    // Resolve the ask with answers
    const requestId = (askEvents[0] as { requestId: string }).requestId;
    const resolved = manager.resolveAsk(requestId, [{
      questionId: 'q1',
      selectedOptions: ['Option A'],
    }] as AskAnswer[]);

    expect(resolved).toBe(true);

    // The ask promise should resolve
    const result = await askPromise;
    expect(result).toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining('Option A') }],
    });
  });

  it('returns false when resolving an unknown ask request', () => {
    expect(manager.resolveAsk('unknown_id', [])).toBe(false);
  });

  it('handles empty questions gracefully', async () => {
    const id = await createTestSession(manager);
    const entry = manager.getSession(id)!;

    const handler = entry.client['toolCallHandler'] as (toolName: string, args: unknown) => Promise<unknown>;

    const result = await handler('ask', { questions: [] });

    expect(result).toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining('Error') }],
    });
  });

  it('handles malformed questions gracefully', async () => {
    const id = await createTestSession(manager);
    const entry = manager.getSession(id)!;

    const handler = entry.client['toolCallHandler'] as (toolName: string, args: unknown) => Promise<unknown>;

    const result = await handler('ask', { questions: 'not an array' });

    expect(result).toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining('Error') }],
    });
  });

  it('normalizes malformed question options', async () => {
    const id = await createTestSession(manager);
    const entry = manager.getSession(id)!;

    const askEvents: unknown[] = [];
    manager.on('askRequest', (data) => askEvents.push(data));

    const handler = entry.client['toolCallHandler'] as (toolName: string, args: unknown) => Promise<unknown>;

    const askPromise = handler('ask', {
      questions: [{
        id: 'q1',
        question: 'Pick one',
        options: ['StringOption', { label: 'ObjectOption' }],
      }],
    });

    await new Promise((r) => setTimeout(r, 10));

    const askEvent = askEvents[0] as { questions: Array<{ options: Array<{ label: string }> }> };
    expect(askEvent.questions[0].options).toEqual([
      { label: 'StringOption' },
      { label: 'ObjectOption' },
    ]);

    // Resolve to unblock the promise
    const requestId = (askEvents[0] as { requestId: string }).requestId;
    manager.resolveAsk(requestId, [{
      questionId: 'q1',
      selectedOptions: ['StringOption'],
    }] as AskAnswer[]);

    await askPromise;
  });
});

describe('SessionManager — approval routing', () => {
  let manager: InstanceType<typeof SessionManagerImpl>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManagerImpl(60_000);
  });

  afterEach(async () => {
    await manager.destroyAll();
  });

  it('emits approvalRequest event when approval handler is invoked', async () => {
    const id = await createTestSession(manager);
    const entry = manager.getSession(id)!;

    const approvalEvents: unknown[] = [];
    manager.on('approvalRequest', (data) => approvalEvents.push(data));

    // Invoke the approval handler (set on MockAgentClient)
    const approvalHandler = entry.client['approvalHandler'] as (
      requestId: string,
      toolName: string,
      args: unknown,
    ) => Promise<boolean>;

    const approvalPromise = approvalHandler('req_1', 'edit', { path: 'test.ts' });

    // Wait for the event
    await new Promise((r) => setTimeout(r, 10));

    expect(approvalEvents).toHaveLength(1);
    expect(approvalEvents[0]).toMatchObject({
      sessionId: id,
      requestId: 'req_1',
      toolName: 'edit',
      args: { path: 'test.ts' },
    });

    // Resolve the approval
    expect(manager.resolveApproval('req_1', true)).toBe(true);

    const approved = await approvalPromise;
    expect(approved).toBe(true);
  });

  it('resolveApproval returns false for unknown request', () => {
    expect(manager.resolveApproval('unknown_req', true)).toBe(false);
  });
});

describe('SessionManager — session events', () => {
  let manager: InstanceType<typeof SessionManagerImpl>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManagerImpl(60_000);
  });

  afterEach(async () => {
    await manager.destroyAll();
  });

  it('forwards session events to listeners', async () => {
    const id = await createTestSession(manager);
    const entry = manager.getSession(id)!;

    const events: unknown[] = [];
    manager.on('sessionEvent', (data) => events.push(data));

    // Simulate the agent emitting an event
    const eventListener = entry.client['eventListeners'] as Array<(event: unknown) => void>;
    eventListener[0]({ type: 'message_start', message: { role: 'assistant' } });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sessionId: id,
      event: { type: 'message_start' },
    });
  });

  it('sets active=true on agent_start event', async () => {
    const id = await createTestSession(manager);
    const entry = manager.getSession(id)!;

    // Before agent_start, session is not active
    expect(manager.getSession(id)?.isActive).toBe(false);

    const eventListener = entry.client['eventListeners'] as Array<(event: unknown) => void>;
    eventListener[0]({ type: 'agent_start' });

    expect(manager.getSession(id)?.isActive).toBe(true);
  });

  it('sets active=false on agent_end event and schedules idle timer', async () => {
    const id = await createTestSession(manager);
    const entry = manager.getSession(id)!;

    // Set active first
    manager['setActive'](id, true);

    const eventListener = entry.client['eventListeners'] as Array<(event: unknown) => void>;
    eventListener[0]({ type: 'agent_end' });

    expect(manager.getSession(id)?.isActive).toBe(false);
    expect(manager.getSession(id)?.idleTimer).not.toBeNull();
  });
});

describe('SessionManager — MCP delegation', () => {
  let manager: InstanceType<typeof SessionManagerImpl>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManagerImpl(60_000);
  });

  afterEach(async () => {
    await manager.destroyAll();
  });

  it('getMcpStatus returns undefined for unknown session', async () => {
    expect(await manager.getMcpStatus('nonexistent')).toBeUndefined();
  });

  it('getMcpServerTools returns undefined for unknown session', async () => {
    expect(await manager.getMcpServerTools('nonexistent', 'server')).toBeUndefined();
  });

  it('reloadMcp returns undefined for unknown session', async () => {
    expect(await manager.reloadMcp('nonexistent')).toBeUndefined();
  });

  it('getMcpStatus returns status for a known session', async () => {
    const id = await createTestSession(manager);
    const status = await manager.getMcpStatus(id);
    expect(status).toEqual({});
  });

  it('getAvailableModels returns empty array', async () => {
    const id = await createTestSession(manager);
    const models = await manager.getAvailableModels(id);
    expect(models).toEqual([]);
  });
});

describe('SessionManager — env var propagation for OpenAI-compatible provider', () => {
  let manager: InstanceType<typeof SessionManagerImpl>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManagerImpl(60_000);
  });

  afterEach(async () => {
    await manager.destroyAll();
  });

  it('sets OPENAI_API_KEY and OPENAI_BASE_URL to match the provided credential', async () => {
    const id = await manager.createSession({
      projectId: 'proj_env',
      cwd: '/tmp/test',
      apiKey: 'sk-target-key',
      baseUrl: 'https://api.target.example/v1',
      model: 'target-model',
      enableMCP: false,
    });

    const entry = manager.getSession(id)!;
    const env = (entry.client as unknown as { capturedEnv: Record<string, string> }).capturedEnv;

    expect(env.SOCVERIFY_AGENT_API_KEY).toBe('sk-target-key');
    expect(env.OPENAI_API_KEY).toBe('sk-target-key');
    expect(env.OPENAI_BASE_URL).toBe('https://api.target.example/v1');
  });

  it('overwrites stale OPENAI_API_KEY and OPENAI_BASE_URL from buildEnvForAgent when a different credential is used', async () => {
    // Simulate the scenario where buildEnvForAgent set OPENAI_API_KEY
    // and OPENAI_BASE_URL from the FIRST credential (cred A), but the
    // session is being created with a DIFFERENT credential (cred B).
    // The session's apiKey/baseUrl must win — not the stale env values.
    const staleEnv: Record<string, string> = {
      OPENAI_API_KEY: 'sk-stale-from-cred-a',
      OPENAI_BASE_URL: 'https://api.stale.example/v1',
      API_KEY: 'sk-stale-from-cred-a',
      API_BASE_URL: 'https://api.stale.example/v1',
    };

    const id = await manager.createSession({
      projectId: 'proj_env_stale',
      cwd: '/tmp/test',
      apiKey: 'sk-fresh-from-cred-b',
      baseUrl: 'https://api.fresh.example/v1',
      model: 'fresh-model',
      env: staleEnv,
      enableMCP: false,
    });

    const entry = manager.getSession(id)!;
    const env = (entry.client as unknown as { capturedEnv: Record<string, string> }).capturedEnv;

    // The session's credential must override any stale values from buildEnvForAgent
    expect(env.OPENAI_API_KEY).toBe('sk-fresh-from-cred-b');
    expect(env.OPENAI_BASE_URL).toBe('https://api.fresh.example/v1');
    expect(env.SOCVERIFY_AGENT_API_KEY).toBe('sk-fresh-from-cred-b');
  });
});

describe('SessionManager — credential tracking for holistic-swap no-op detection', () => {
  let manager: InstanceType<typeof SessionManagerImpl>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManagerImpl(60_000);
  });

  afterEach(async () => {
    await manager.destroyAll();
  });

  it('stores providerId and credentialSnapshot on the session entry', async () => {
    const id = await manager.createSession({
      projectId: 'proj_cred',
      cwd: '/tmp/test',
      providerId: 'unisoc',
      apiKey: 'sk-unisoc',
      baseUrl: 'http://maas.unisoc.com/v1',
      model: 'deepseek-v4-flash',
      enableMCP: false,
    });

    const entry = manager.getSession(id)!;
    expect(entry.providerId).toBe('unisoc');
    expect(entry.credentialSnapshot).toBe('unisoc|sk-unisoc|http://maas.unisoc.com/v1|');
  });

  it('credentialSnapshot changes when the credential is edited (same providerId)', async () => {
    const { credentialSnapshot } = await import('../../src/main/agent/session-manager');

    const before = credentialSnapshot('unisoc', 'sk-old-key', 'http://maas.unisoc.com/v1');
    const after = credentialSnapshot('unisoc', 'sk-new-key', 'http://maas.unisoc.com/v1');

    // Same providerId but a rotated API key must produce a different
    // fingerprint so setModel still performs a real destroy/recreate.
    expect(before).not.toBe(after);
  });
});
