import { describe, it, expect, vi } from 'vitest';
import type { AgentEngine } from '../../src/shared/agent-events';
import type { ThinkingLevelSetting } from '../../src/shared/types';
import type { ApprovalMode, InitConfig, TrustKind } from '../../src/main/agent/types';
import type {
  IAgentClient,
  AgentClientFactory,
  AgentClientFactoryOptions,
} from '../../src/main/agent/agent-contract';

// ─── Mock path resolvers（issue 10 后只存在 pi runner 解析）─────────
//
// 注意：这里刻意不提供 resolveAgentRuntime / resolveRunnerBinary /
// resolveRunnerScript / resolveBunPath —— 这些 omp 构建链解析器已在
// issue 10 删除。若 session-manager 仍引用它们，会在运行时得到
// undefined 并抛错，使本测试保持红灯。

vi.mock('../../src/main/agent/paths', () => ({
  resolvePiRunnerScript: vi.fn(() => '/fake/pi-runner/index.ts'),
  resolvePiSessionScanScript: vi.fn(() => '/fake/pi-runner/session-scan.ts'),
  resolveBuiltInExtensionDir: vi.fn(() => null),
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

vi.mock('../../src/main/agent/skill-discovery', () => ({
  resolveSkillLoadPaths: vi.fn(async () => []),
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

import { resolvePiRunnerScript } from '../../src/main/agent/paths';
import { resolveSkillLoadPaths } from '../../src/main/agent/skill-discovery';
import { defaultAgentClientFactory, SessionManagerImpl } from '../../src/main/agent/session-manager';
import { PiAgentClient } from '../../src/main/agent/pi-agent-client';

// ─── Neutral mock client（与 agent-contract.test.ts 同构）────────────

class MockEngineClient implements IAgentClient {
  readonly engine: AgentEngine;
  started = false;
  stopped = false;
  /** 最近一次 init 收到的配置（skillPaths 下发断言用，issue 09） */
  lastInitConfig: InitConfig | null = null;
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
    this.lastInitConfig = _config;
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

// ─── defaultAgentClientFactory（issue 10：单一 pi 引擎）──────────────

describe('defaultAgentClientFactory（issue 10）', () => {
  it('以 pi runner 脚本构造 PiAgentClient，options 不再携带 engine/mode/bunPath', () => {
    const client = defaultAgentClientFactory({
      runnerPath: '/fake/pi-runner/index.ts',
      cwd: '/tmp',
    });
    expect(client).toBeInstanceOf(PiAgentClient);
    expect(client.engine).toBe('pi');
  });
});

// ─── SessionManagerImpl.createSession（issue 10：仅 pi 路由）─────────

describe('SessionManagerImpl.createSession 引擎路由（issue 10）', () => {
  it('createSession 固定走 pi runner 脚本，会话引擎为 pi', async () => {
    vi.mocked(resolvePiRunnerScript).mockReturnValue('/fake/pi-runner/index.ts');
    const client = new MockEngineClient('pi', 'pi-engine-1');
    const { manager, factory } = createManagerWithFactory(client);

    const id = await manager.createSession({
      projectId: 'proj_pi',
      cwd: '/tmp/pi',
      enableMCP: false,
    });

    expect(resolvePiRunnerScript).toHaveBeenCalled();
    const opts = factory.mock.calls[0][0] as AgentClientFactoryOptions;
    expect(opts.runnerPath).toBe('/fake/pi-runner/index.ts');
    expect(opts.cwd).toBe('/tmp/pi');
    expect(manager.getEngine(id)).toBe('pi');
  });

  it('runner 脚本缺失时抛出可诊断错误', async () => {
    vi.mocked(resolvePiRunnerScript).mockReturnValue(null);
    const client = new MockEngineClient('pi', 'pi-engine-1');
    const { manager } = createManagerWithFactory(client);

    await expect(
      manager.createSession({ projectId: 'proj_pi', cwd: '/tmp/pi', enableMCP: false }),
    ).rejects.toThrow(/pi runner/i);
  });

  it('skillPaths 与 modelsPath 无条件下发（不再有 omp 专属发现路径）', async () => {
    vi.mocked(resolvePiRunnerScript).mockReturnValue('/fake/pi-runner/index.ts');
    vi.mocked(resolveSkillLoadPaths).mockResolvedValue([
      '/proj/.pi/skills',
      '/proj/.omp/skills',
      '/app/resources/built-in-extension/skills',
      '/home/.pi/agent/skills',
    ]);
    const client = new MockEngineClient('pi', 'pi-skill-1');
    const { manager } = createManagerWithFactory(client);

    await manager.createSession({
      projectId: 'proj_pi',
      cwd: '/tmp/pi',
      enableMCP: false,
    });

    expect(resolveSkillLoadPaths).toHaveBeenCalledWith('/tmp/pi');
    expect(client.lastInitConfig?.skillPaths).toEqual([
      '/proj/.pi/skills',
      '/proj/.omp/skills',
      '/app/resources/built-in-extension/skills',
      '/home/.pi/agent/skills',
    ]);
  });
});
