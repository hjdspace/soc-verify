import { EventEmitter } from 'node:events';
import { OmpRpcClient } from './rpc-client';
import { HostToolsRegistry } from './host-tools';
import { HostUriRouter } from './host-uris';
import { NoopDiscovery } from './discovery';
import type { SubsysDiscovery } from './discovery';
import type { PluginBackedSimulation, PluginBackedCoverage } from './plugin-discovery';
import { resolveOmpRuntime } from './paths';
import type { OmpRpcClientOptions } from './types';

const MAX_CONCURRENT_SESSIONS = 10;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export interface CreateSessionOptions {
  projectId: string;
  cwd: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  sessionDir?: string;
  resumePrefix?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
  discovery?: SubsysDiscovery;
  simulationAdapter?: PluginBackedSimulation | null;
  coverageAdapter?: PluginBackedCoverage | null;
}

export interface SessionEntry {
  id: string;
  projectId: string;
  client: OmpRpcClient;
  hostTools: HostToolsRegistry;
  hostUris: HostUriRouter;
  createdAt: number;
  lastActivityAt: number;
  idleTimer: NodeJS.Timeout | null;
}

export interface SessionEventData {
  sessionId: string;
  event: unknown;
}

class SessionManagerImpl extends EventEmitter {
  private sessions = new Map<string, SessionEntry>();
  private projectSessions = new Map<string, Set<string>>();
  private idleTimeoutMs: number;

  constructor(idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS) {
    super();
    this.idleTimeoutMs = idleTimeoutMs;
  }

  async createSession(options: CreateSessionOptions): Promise<string> {
    if (this.sessions.size >= MAX_CONCURRENT_SESSIONS) {
      throw new Error(`Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached`);
    }

    const runtime = resolveOmpRuntime();
    if (!runtime) {
      throw new Error('omp runtime not found (need prebuilt omp binary or bun + engine/oh-my-pi)');
    }
    if (!runtime.ompBinaryPath && !runtime.bunVersionOk) {
      throw new Error(
        `Bun runtime must be >= ${'1.3.14'} (found v${runtime.bunVersion}). ` +
        'Please upgrade: bun upgrade',
      );
    }

    const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const clientOptions: OmpRpcClientOptions = {
      ompBinaryPath: runtime.ompBinaryPath,
      bunPath: runtime.bunPath,
      ompEntryPath: runtime.ompEntryPath,
      cwd: options.cwd,
      provider: options.provider,
      model: options.model,
      apiKey: options.apiKey,
      sessionDir: options.sessionDir,
      extraArgs: options.extraArgs,
      env: options.env,
    };

    if (options.resumePrefix) {
      clientOptions.extraArgs = [...(options.extraArgs ?? []), '--resume', options.resumePrefix];
    }

    const client = new OmpRpcClient(clientOptions);
    const hostTools = new HostToolsRegistry(options.discovery ?? new NoopDiscovery());
    if (options.simulationAdapter) hostTools.setSimulationAdapter(options.simulationAdapter);
    if (options.coverageAdapter) hostTools.setCoverageAdapter(options.coverageAdapter);
    const hostUris = new HostUriRouter();

    client.registerHostTool('*', (req) => hostTools.handleToolCall(req));
    client.registerHostUriHandler('*', (req) => hostUris.handleUriRequest(req));

    client.onSessionEvent((event) => {
      const evtType = (event as Record<string, unknown>)?.type;
      console.log(`[omp:session:${sessionId}] event type="${evtType}"`);
      this.emit('sessionEvent', { sessionId, event } satisfies SessionEventData);
    });

    // Forward prompt_result as a session event so the UI knows when the
    // agent was/wasn't invoked (agentInvoked=false means the message was
    // handled as a slash command or the agent couldn't start).
    client.onPromptResult((frame) => {
      console.log(`[omp:session:${sessionId}] prompt_result agentInvoked=${frame.agentInvoked}`);
      if (!frame.agentInvoked) {
        this.emit('sessionEvent', {
          sessionId,
          event: { type: 'notice', message: 'Agent was not invoked for this prompt. Check API key and model configuration.' },
        } satisfies SessionEventData);
        // Also emit agent_end to stop the streaming indicator
        this.emit('sessionEvent', {
          sessionId,
          event: { type: 'agent_end' },
        } satisfies SessionEventData);
      }
    });

    // Log env vars being passed (mask API keys)
    if (options.env) {
      const maskedEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(options.env)) {
        maskedEnv[k] = k.includes('KEY') || k.includes('SECRET') ? `${v.slice(0, 4)}***` : v;
      }
      console.log(`[omp:session:${sessionId}] env vars:`, maskedEnv);
    } else {
      console.log(`[omp:session:${sessionId}] WARNING: no env vars passed to omp`);
    }
    console.log(`[omp:session:${sessionId}] provider=${options.provider ?? '(default)'}, model=${options.model ?? '(default)'}`);

    await client.start();
    console.log(`[omp:session:${sessionId}] omp process started successfully`);

    await client.setHostTools(hostTools.getDefinitions());
    await client.setHostUriSchemes(hostUris.getSchemeDefinitions());

    const entry: SessionEntry = {
      id: sessionId,
      projectId: options.projectId,
      client,
      hostTools,
      hostUris,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      idleTimer: null,
    };

    this.sessions.set(sessionId, entry);

    if (!this.projectSessions.has(options.projectId)) {
      this.projectSessions.set(options.projectId, new Set());
    }
    this.projectSessions.get(options.projectId)!.add(sessionId);

    this.scheduleIdleRetirement(sessionId);

    return sessionId;
  }

  getSession(sessionId: string): SessionEntry | null {
    return this.sessions.get(sessionId) ?? null;
  }

  getClient(sessionId: string): OmpRpcClient | null {
    return this.sessions.get(sessionId)?.client ?? null;
  }

  listSessions(): Array<{ id: string; projectId: string; createdAt: number; lastActivityAt: number }> {
    return Array.from(this.sessions.values()).map((e) => ({
      id: e.id,
      projectId: e.projectId,
      createdAt: e.createdAt,
      lastActivityAt: e.lastActivityAt,
    }));
  }

  listSessionsByProject(projectId: string): string[] {
    return Array.from(this.projectSessions.get(projectId) ?? []);
  }

  // ─── 动态 Host Tool 注册/注销 ─────────────────────────

  async registerHostTool(
    sessionId: string,
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    handler: (args: Record<string, unknown>) => Promise<unknown>,
  ): Promise<void> {
    const entry = this.requireSessionEntry(sessionId);
    entry.hostTools.registerCustom(name, description, parameters, async (args) => {
      const result = await handler(args);
      if (typeof result === 'string') return result;
      return result as import('./types').AgentToolResult;
    });
    await entry.client.setHostTools(entry.hostTools.getDefinitions());
    this.touchActivity(sessionId);
  }

  async unregisterHostTool(sessionId: string, name: string): Promise<void> {
    const entry = this.requireSessionEntry(sessionId);
    entry.hostTools.unregister(name);
    await entry.client.setHostTools(entry.hostTools.getDefinitions());
    this.touchActivity(sessionId);
  }

  // ─── 动态 Host URI Scheme 注册/注销 ───────────────────

  async registerHostUriScheme(
    sessionId: string,
    scheme: string,
    description: string,
    writable: boolean,
    immutable: boolean,
    handler: (request: import('./types').RpcHostUriRequest) => Promise<import('./types').RpcHostUriResult>,
  ): Promise<void> {
    const entry = this.requireSessionEntry(sessionId);
    entry.hostUris.register(scheme, description, writable, immutable, handler);
    await entry.client.setHostUriSchemes(entry.hostUris.getSchemeDefinitions());
    this.touchActivity(sessionId);
  }

  async unregisterHostUriScheme(sessionId: string, scheme: string): Promise<void> {
    const entry = this.requireSessionEntry(sessionId);
    entry.hostUris.unregister(scheme);
    await entry.client.setHostUriSchemes(entry.hostUris.getSchemeDefinitions());
    this.touchActivity(sessionId);
  }

  // ─── 动态 provider/model 切换 ─────────────────────────

  async setModel(sessionId: string, provider: string, modelId: string): Promise<void> {
    const client = this.requireClient(sessionId);
    await client.setModel(provider, modelId);
    this.touchActivity(sessionId);
  }

  async getAvailableModels(sessionId: string): Promise<unknown[]> {
    const client = this.requireClient(sessionId);
    const models = await client.getAvailableModels();
    this.touchActivity(sessionId);
    return models;
  }

  // ─── 内部辅助 ─────────────────────────────────────────

  private requireSessionEntry(sessionId: string): SessionEntry {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return entry;
  }

  private requireClient(sessionId: string): OmpRpcClient {
    const client = this.sessions.get(sessionId)?.client;
    if (!client) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return client;
  }

  async destroySession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
    }

    entry.client.stop();
    this.sessions.delete(sessionId);

    const projectSet = this.projectSessions.get(entry.projectId);
    if (projectSet) {
      projectSet.delete(sessionId);
      if (projectSet.size === 0) {
        this.projectSessions.delete(entry.projectId);
      }
    }
  }

  async destroyAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    await Promise.all(ids.map((id) => this.destroySession(id)));
  }

  touchActivity(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.lastActivityAt = Date.now();
    this.scheduleIdleRetirement(sessionId);
  }

  getIdleTimeoutMs(): number {
    return this.idleTimeoutMs;
  }

  setIdleTimeoutMs(ms: number): void {
    this.idleTimeoutMs = ms;
    for (const id of this.sessions.keys()) {
      this.scheduleIdleRetirement(id);
    }
  }

  private scheduleIdleRetirement(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
    }

    entry.idleTimer = setTimeout(() => {
      void this.destroySession(sessionId).catch(() => {});
    }, this.idleTimeoutMs);
    entry.idleTimer.unref();
  }
}

export const sessionManager = new SessionManagerImpl();
