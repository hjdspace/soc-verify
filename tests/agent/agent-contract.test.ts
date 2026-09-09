import { describe, it, expect, vi } from 'vitest';
import { expectTypeOf } from 'vitest';
import type { ApprovalMode, InitConfig } from '../../src/main/agent/types';
import type { ThinkingLevelSetting } from '../../src/shared/types';
import type { AgentEngine } from '../../src/shared/agent-events';
import type { IAgentClient, AgentClientFactory } from '../../src/main/agent/agent-contract';
import { AgentClient } from '../../src/main/agent/agent-client';
import { SessionManagerImpl } from '../../src/main/agent/session-manager';

// ─── Mock heavy dependencies of session-manager (same pattern as
// ─── tests/session/session-manager.test.ts) ──────────────────────────

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

vi.mock('../../src/main/host/host-tools', () => ({
  HostToolsRegistry: class {
    setSimulationAdapter() {}
    setCoverageAdapter() {}
    setCoverageManager() {}
    setCaseStatsService() {}
    getDefinitions() { return []; }
    handleToolCall = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  },
}));

vi.mock('../../src/main/host/host-uris', () => ({
  HostUriRouter: class {
    setCoverageManager() {}
  },
}));

// ─── Neutral mock client (engine-neutral contract implementation) ────

class MockEngineClient implements IAgentClient {
  readonly engine: AgentEngine;
  started = false;
  stopped = false;
  destroyed = false;
  lastPrompt: string | undefined;
  toolCallHandler: ((toolName: string, args: unknown) => Promise<unknown>) | null = null;
  approvalHandler: ((requestId: string, toolName: string, args: unknown) => Promise<boolean>) | null = null;
  eventListeners: Array<(event: unknown) => void> = [];

  constructor(engine: AgentEngine, private engineSessionId: string) {
    this.engine = engine;
  }

  start(): Promise<void> {
    this.started = true;
    return Promise.resolve();
  }
  stop(): void {
    this.stopped = true;
  }
  isRunning(): boolean {
    return this.started && !this.stopped;
  }
  getStderr(): string {
    return '';
  }
  init(_config: InitConfig): Promise<{ engineSessionId: string }> {
    return Promise.resolve({ engineSessionId: this.engineSessionId });
  }
  prompt(message: string, _images?: string[]): Promise<void> {
    this.lastPrompt = message;
    return Promise.resolve();
  }
  steer(_message: string): Promise<void> {
    return Promise.resolve();
  }
  abort(): Promise<void> {
    this.stop();
    return Promise.resolve();
  }
  regenerate(): Promise<{ engineSessionId: string }> {
    return Promise.resolve({ engineSessionId: `${this.engineSessionId}-regen` });
  }
  setModel(_provider: string, _modelId: string): Promise<void> {
    return Promise.resolve();
  }
  setApprovalMode(_approvalMode: ApprovalMode): Promise<void> {
    return Promise.resolve();
  }
  setThinkingLevel(_level: ThinkingLevelSetting): Promise<void> {
    return Promise.resolve();
  }
  setToolFilter(_disabledTools: string[]): Promise<void> {
    return Promise.resolve();
  }
  listAgentTools(): Promise<Array<{ name: string; description: string }>> {
    return Promise.resolve([]);
  }
  getMessages(): Promise<unknown[]> {
    return Promise.resolve([]);
  }
  getState(): Promise<unknown> {
    return Promise.resolve({});
  }
  compact(): Promise<{ result: unknown }> {
    return Promise.resolve({ result: null });
  }
  getMcpStatus(): Promise<Record<string, { status: string; toolCount: number }>> {
    return Promise.resolve({});
  }
  getMcpServerTools(
    _serverName: string,
  ): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    return Promise.resolve([]);
  }
  reloadMcp(): Promise<Record<string, { status: string; toolCount: number }>> {
    return Promise.resolve({});
  }
  destroy(): Promise<void> {
    this.stop();
    this.destroyed = true;
    return Promise.resolve();
  }
  onEvent(listener: (event: unknown) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      const i = this.eventListeners.indexOf(listener);
      if (i !== -1) this.eventListeners.splice(i, 1);
    };
  }
  setToolCallHandler(handler: (toolName: string, args: unknown) => Promise<unknown>): void {
    this.toolCallHandler = handler;
  }
  setApprovalHandler(
    handler: (requestId: string, toolName: string, args: unknown) => Promise<boolean>,
  ): void {
    this.approvalHandler = handler;
  }
  sendApprovalResponse(_requestId: string, _approved: boolean): void {}
}

// ─── Type-level contract checks ──────────────────────────────────────

describe('IAgentClient type contract', () => {
  it('the omp AgentClient satisfies the contract', () => {
    expectTypeOf<AgentClient>().toExtend<IAgentClient>();
  });

  it('an engine-neutral mock satisfies the contract', () => {
    expectTypeOf<MockEngineClient>().toExtend<IAgentClient>();
  });

  it('a factory maps client options to IAgentClient', () => {
    expectTypeOf<AgentClientFactory>().toBeCallableWith({
      mode: 'binary',
      runnerPath: '/fake/runner',
      cwd: '/tmp',
    });
  });
});

// ─── Runtime: SessionManager works through the injected factory ──────

describe('SessionManager — engine-neutral client factory injection', () => {
  function createManagerWithFactory(
    client: IAgentClient,
  ): { manager: SessionManagerImpl; factory: ReturnType<typeof vi.fn> } {
    const factory = vi.fn(() => client) as unknown as AgentClientFactory;
    const factorySpy = vi.fn((...args: unknown[]) => (factory as (...a: unknown[]) => IAgentClient)(...args));
    const manager = new SessionManagerImpl(60_000, factorySpy as unknown as AgentClientFactory);
    return { manager, factory: factorySpy };
  }

  it('creates sessions through the injected factory instead of hard-coding AgentClient', async () => {
    const client = new MockEngineClient('pi', 'pi-engine-session-1');
    const { manager, factory } = createManagerWithFactory(client);

    const id = await manager.createSession({
      projectId: 'proj_contract',
      cwd: '/tmp/contract',
      provider: 'test-provider',
      model: 'test-model',
      apiKey: 'test-key',
      baseUrl: 'http://localhost:1234/v1',
      enableMCP: false,
    });

    expect(factory).toHaveBeenCalled();
    expect(manager.getSession(id)?.client).toBe(client);
    expect(client.started).toBe(true);
    expect(client.toolCallHandler).not.toBeNull();
    expect(client.approvalHandler).not.toBeNull();
    expect(client.eventListeners.length).toBeGreaterThan(0);
  });

  it('records the engine identity and engineSessionId on the session entry', async () => {
    const client = new MockEngineClient('pi', 'pi-engine-session-1');
    const { manager } = createManagerWithFactory(client);

    const id = await manager.createSession({
      projectId: 'proj_contract',
      cwd: '/tmp/contract',
      provider: 'test-provider',
      model: 'test-model',
      apiKey: 'test-key',
      baseUrl: 'http://localhost:1234/v1',
      enableMCP: false,
    });

    expect(manager.getEngine(id)).toBe('pi');
    expect(manager.getEngineSessionId(id)).toBe('pi-engine-session-1');
    // Deprecated alias still resolves to the same value.
    expect(manager.getOmpSessionId(id)).toBe('pi-engine-session-1');
  });

  it('updates engineSessionId when regenerate forks the engine session', async () => {
    const client = new MockEngineClient('pi', 'pi-engine-session-1');
    const { manager } = createManagerWithFactory(client);

    const id = await manager.createSession({
      projectId: 'proj_contract',
      cwd: '/tmp/contract',
      provider: 'test-provider',
      model: 'test-model',
      apiKey: 'test-key',
      baseUrl: 'http://localhost:1234/v1',
      enableMCP: false,
    });

    const result = await manager.regenerateSession(id);
    expect(result.engineSessionId).toBe('pi-engine-session-1-regen');
    expect(manager.getEngineSessionId(id)).toBe('pi-engine-session-1-regen');
  });

  it('prompts and destroys through the contract without knowing the engine', async () => {
    const client = new MockEngineClient('pi', 'pi-engine-session-1');
    const { manager } = createManagerWithFactory(client);

    const id = await manager.createSession({
      projectId: 'proj_contract',
      cwd: '/tmp/contract',
      provider: 'test-provider',
      model: 'test-model',
      apiKey: 'test-key',
      baseUrl: 'http://localhost:1234/v1',
      enableMCP: false,
    });

    await manager.promptFireAndForget(id, 'hello');
    expect(client.lastPrompt).toBe('hello');

    await manager.destroySession(id);
    expect(client.destroyed).toBe(true);
    expect(client.stopped).toBe(true);
  });
});
