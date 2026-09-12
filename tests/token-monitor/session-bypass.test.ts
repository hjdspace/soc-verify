/**
 * SessionManager 旁路拦截 message_end 事件测试。
 *
 * 测试缝：SessionManager 的 sessionEvent 事件流 + MockAgentClient。
 * 验证 message_end 事件中的 usage 被旁路写入 Token Monitor DB。
 * 先例：tests/session/session-manager.test.ts 的 MockAgentClient 模式
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mock path resolvers and heavy dependencies ────────────────────

vi.mock('../../src/main/agent/paths', () => ({
  resolveAgentRuntime: vi.fn(() => ({
    mode: 'binary' as const,
    runnerPath: '/fake/runner',
    bunVersionOk: true,
  })),
  resolvePiRunnerScript: vi.fn(() => '/fake/pi-runner/index.ts'),
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

// ─── Mock AgentClient ──────────────────────────────────────

const { MockAgentClient } = vi.hoisted(() => {
  const { EventEmitter } = require('node:events') as typeof import('node:events');

  class MockAgentClient extends EventEmitter {
    started = false;
    stopped = false;
    destroyed = false;
    engine = 'omp' as const;
    initResult = { engineSessionId: 'omp-session-test' };
    eventListeners: Array<(event: unknown) => void> = [];
    toolCallHandler: unknown = null;
    approvalHandler: unknown = null;
    lastPrompt: string | undefined;
    capturedEnv: Record<string, string> | undefined;

    constructor(opts: unknown) {
      super();
      this.capturedEnv = (opts as { env?: Record<string, string> })?.env;
    }

    setToolCallHandler(handler: unknown) { this.toolCallHandler = handler; }
    setApprovalHandler(handler: unknown) { this.approvalHandler = handler; }
    // issue 04：信任确认 handler（本测试不触发信任流，仅需可装配）
    setTrustHandler(handler: unknown) { this.trustHandler = handler; }
    trustHandler: unknown = null;
    onEvent(listener: (event: unknown) => void) { this.eventListeners.push(listener); }

    async start() { this.started = true; }
    async init(_config: unknown) { return this.initResult; }
    async prompt(message: string) { this.lastPrompt = message; }
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

// ─── Mock HostToolsRegistry and HostUriRouter ──────────────

vi.mock('../../src/main/host/host-tools', () => ({
  HostToolsRegistry: class {
    constructor() {}
    setSimulationAdapter() {}
    setCoverageAdapter() {}
    setCoverageManager() {}
    setCaseStatsService() {}
    getDefinitions() { return []; }
    handleToolCall = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    handleUri = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    destroy() {}
  },
}));

vi.mock('../../src/main/host/host-uris', () => ({
  HostUriRouter: class {
    handleUri = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  },
}));

vi.mock('../../src/main/agent/tool-settings', () => ({
  toolSettings: {
    getDisabledTools: vi.fn(async () => []),
  },
}));

vi.mock('../../src/main/notifications/notification-manager', () => ({
  notificationManager: { notify: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

// ─── Mock token-monitor-registry to capture DB writes ──────

const { mockRecordUsageFromEvent } = vi.hoisted(() => ({
  mockRecordUsageFromEvent: vi.fn(),
}));

vi.mock('../../src/main/token-monitor/token-usage-recorder', () => ({
  recordUsageFromEvent: mockRecordUsageFromEvent,
  extractUsageFromEvent: vi.fn(),
}));

// ─── Imports ───────────────────────────────────────────────

import { SessionManagerImpl } from '../../src/main/agent/session-manager';

// ─── Tests ─────────────────────────────────────────────────

describe('SessionManager — token monitor bypass', () => {
  let manager: InstanceType<typeof SessionManagerImpl>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManagerImpl(60_000);
  });

  afterEach(async () => {
    await manager.destroyAll();
  });

  it('message_end 事件触发旁路写入 token monitor', async () => {
    const id = await manager.createSession({
      projectId: 'proj-1',
      cwd: '/proj/test',
      provider: 'test',
      model: 'test-model',
      apiKey: 'test-key',
    });

    const entry = manager.getSession(id)!;

    // Simulate a message_end event with usage data
    const messageEndEvent = {
      type: 'message_end',
      message: {
        role: 'assistant',
        id: 'msg-123',
        content: [{ type: 'text', text: 'Hello' }],
        model: 'claude-sonnet-4-20250514',
        provider: 'anthropic',
        usage: {
          input: 1000,
          output: 500,
          cacheRead: 200,
          cacheWrite: 100,
          reasoningTokens: 50,
          totalTokens: 1850,
          cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.005, total: 0.038 },
        },
      },
    };

    const eventListener = (entry.client as unknown as Record<string, unknown>)['eventListeners'] as Array<(event: unknown) => void>;
    eventListener[0](messageEndEvent);

    // Verify recordUsageFromEvent was called
    expect(mockRecordUsageFromEvent).toHaveBeenCalledTimes(1);
    const [_dbArg, eventArg, ctxArg] = mockRecordUsageFromEvent.mock.calls[0];
    expect(eventArg).toEqual(messageEndEvent);
    expect(ctxArg).toMatchObject({
      sessionId: id,
      engine: 'omp',
      projectId: 'proj-1',
      cwd: '/proj/test',
    });
  });

  it('非 message_end 事件不触发旁路写入', async () => {
    const id = await manager.createSession({
      projectId: 'proj-1',
      cwd: '/proj/test',
      provider: 'test',
      model: 'test-model',
      apiKey: 'test-key',
    });

    const entry = manager.getSession(id)!;

    // Simulate a non-message_end event
    const eventListener = (entry.client as unknown as Record<string, unknown>)['eventListeners'] as Array<(event: unknown) => void>;
    eventListener[0]({ type: 'agent_start' });
    eventListener[0]({ type: 'message_update', message: { role: 'assistant' } });

    expect(mockRecordUsageFromEvent).not.toHaveBeenCalled();
  });

  it('旁路写入不阻塞事件转发到渲染进程', async () => {
    const id = await manager.createSession({
      projectId: 'proj-1',
      cwd: '/proj/test',
      provider: 'test',
      model: 'test-model',
      apiKey: 'test-key',
    });

    const entry = manager.getSession(id)!;

    const events: unknown[] = [];
    manager.on('sessionEvent', (data) => events.push(data));

    const messageEndEvent = {
      type: 'message_end',
      message: {
        role: 'assistant',
        id: 'msg-123',
        content: [{ type: 'text', text: 'Hello' }],
        usage: {
          input: 1000,
          output: 500,
          cacheRead: 200,
          cacheWrite: 100,
          totalTokens: 1850,
          cost: { total: 0.038 },
        },
      },
    };

    const eventListener = (entry.client as unknown as Record<string, unknown>)['eventListeners'] as Array<(event: unknown) => void>;
    eventListener[0](messageEndEvent);

    // Event should still be forwarded
    expect(events).toHaveLength(1);
    expect((events[0] as { event: { type: string } }).event.type).toBe('message_end');
  });
});
