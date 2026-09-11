import { describe, it, expect, vi } from 'vitest';
import type { AgentEngine } from '../../src/shared/agent-events';
import type { ThinkingLevelSetting } from '../../src/shared/types';
import type { ApprovalMode, InitConfig, TrustKind } from '../../src/main/agent/types';
import type {
  IAgentClient,
  AgentClientFactory,
  AgentClientFactoryOptions,
} from '../../src/main/agent/agent-contract';

// ─── Mock path resolvers（默认 pi runner 可用、omp runtime 缺失）─────

vi.mock('../../src/main/agent/paths', () => ({
  resolveAgentRuntime: vi.fn(() => null),
  resolvePiRunnerScript: vi.fn(() => '/fake/pi-runner/index.ts'),
  resolveRunnerBinary: vi.fn(() => null),
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
  describeTraceweaveUnavailability: vi.fn(() => null),
  diagnoseTraceweave: vi.fn(async () => null),
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

import { resolveAgentRuntime, resolvePiRunnerScript } from '../../src/main/agent/paths';
import { defaultAgentClientFactory, SessionManagerImpl } from '../../src/main/agent/session-manager';
import { AgentClient } from '../../src/main/agent/agent-client';
import { PiAgentClient } from '../../src/main/agent/pi-agent-client';

// ─── Neutral mock client（与 agent-contract.test.ts 同构）────────────

class MockEngineClient implements IAgentClient {
  readonly engine: AgentEngine;
  started = false;
  stopped = false;
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
  prompt(_message: string, _images?: string[]): Promise<void> {
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
  getSystemPrompt(): Promise<string | null> {
    return Promise.resolve(null);
  }
  compact(): Promise<{ result: unknown }> {
    return Promise.resolve({ result: null });
  }
  getMcpStatus(): Promise<Record<string, { status: string; toolCount: number }>> {
    return Promise.resolve({});
  }
  getMcpServerTools(_serverName: string): Promise<Array<{ name: string; description?: string }>> {
    return Promise.resolve([]);
  }
  reloadMcp(): Promise<Record<string, { status: string; toolCount: number }>> {
    return Promise.resolve({});
  }
  destroy(): Promise<void> {
    this.stop();
    return Promise.resolve();
  }
  onEvent(_listener: (event: unknown) => void): () => void {
    return () => {};
  }
  setToolCallHandler(_handler: (toolName: string, args: unknown) => Promise<unknown>): void {}
  setApprovalHandler(_handler: (requestId: string, toolName: string, args: unknown) => Promise<boolean>): void {}
  sendApprovalResponse(_requestId: string, _approved: boolean): void {}
  setTrustHandler(
    _handler: (requestId: string, kind: TrustKind, name: string, path?: string) => Promise<boolean>,
  ): void {}
  sendTrustResponse(_requestId: string, _approved: boolean): void {}
}

function createManagerWithFactory(client: IAgentClient): {
  manager: SessionManagerImpl;
  factory: ReturnType<typeof vi.fn>;
} {
  const factory = vi.fn(() => client) as unknown as AgentClientFactory;
  const factorySpy = vi.fn((...args: unknown[]) => (factory as (...a: unknown[]) => IAgentClient)(...args));
  const manager = new SessionManagerImpl(60_000, factorySpy as unknown as AgentClientFactory);
  return { manager, factory: factorySpy };
}

// ─── defaultAgentClientFactory 引擎路由 ──────────────────────────────

describe('defaultAgentClientFactory engine routing', () => {
  it("engine 'pi' 构造 PiAgentClient", () => {
    const client = defaultAgentClientFactory({
      engine: 'pi',
      mode: 'script',
      runnerPath: '/fake/pi-runner/index.ts',
      cwd: '/tmp',
    });
    expect(client).toBeInstanceOf(PiAgentClient);
    expect(client.engine).toBe('pi');
  });

  it("engine 'omp'（binary 模式）构造 omp AgentClient", () => {
    const client = defaultAgentClientFactory({
      engine: 'omp',
      mode: 'binary',
      runnerPath: '/fake/runner',
      cwd: '/tmp',
    });
    expect(client).toBeInstanceOf(AgentClient);
    expect(client.engine).toBe('omp');
  });

  it("engine 'omp'（script 模式）构造 omp AgentClient", () => {
    const client = defaultAgentClientFactory({
      engine: 'omp',
      mode: 'script',
      runnerPath: '/fake/runner.ts',
      bunPath: '/fake/bun',
      cwd: '/tmp',
    });
    expect(client).toBeInstanceOf(AgentClient);
    expect(client.engine).toBe('omp');
  });
});

// ─── SessionManagerImpl.createSession 引擎路由 ───────────────────────

describe('SessionManagerImpl.createSession engine routing', () => {
  it("engine 'pi'：解析 pi runner 脚本并跳过 omp runtime 解析", async () => {
    vi.mocked(resolveAgentRuntime).mockReturnValue(null);
    vi.mocked(resolvePiRunnerScript).mockReturnValue('/fake/pi-runner/index.ts');
    const client = new MockEngineClient('pi', 'pi-engine-1');
    const { manager, factory } = createManagerWithFactory(client);

    const id = await manager.createSession({
      projectId: 'proj_pi',
      cwd: '/tmp/pi',
      enableMCP: false,
      engine: 'pi',
    });

    expect(resolveAgentRuntime).not.toHaveBeenCalled();
    expect(resolvePiRunnerScript).toHaveBeenCalled();
    expect(factory).toHaveBeenCalled();
    const opts = factory.mock.calls[0][0] as AgentClientFactoryOptions;
    expect(opts.engine).toBe('pi');
    expect(opts.mode).toBe('script');
    expect(opts.runnerPath).toBe('/fake/pi-runner/index.ts');
    expect(manager.getEngine(id)).toBe('pi');
  });

  it("engine 'pi'：runner 脚本缺失时抛出可诊断错误", async () => {
    vi.mocked(resolvePiRunnerScript).mockReturnValue(null);
    const client = new MockEngineClient('pi', 'pi-engine-1');
    const { manager } = createManagerWithFactory(client);

    await expect(
      manager.createSession({ projectId: 'proj_pi', cwd: '/tmp/pi', enableMCP: false, engine: 'pi' }),
    ).rejects.toThrow(/pi runner/i);
  });

  it('缺省 engine：走 omp runtime 解析并向 factory 传递 engine omp', async () => {
    vi.mocked(resolveAgentRuntime).mockReturnValue({ mode: 'binary', runnerPath: '/fake/runner' });
    vi.mocked(resolvePiRunnerScript).mockClear();
    const client = new MockEngineClient('omp', 'omp-engine-1');
    const { manager, factory } = createManagerWithFactory(client);

    const id = await manager.createSession({
      projectId: 'proj_omp',
      cwd: '/tmp/omp',
      enableMCP: false,
    });

    expect(resolvePiRunnerScript).not.toHaveBeenCalled();
    const opts = factory.mock.calls[0][0] as AgentClientFactoryOptions;
    expect(opts.engine).toBe('omp');
    expect(manager.getEngine(id)).toBe('omp');
  });
});
