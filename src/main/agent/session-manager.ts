import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentClient, type ToolCallHandler } from './agent-client';
import { resolveAgentRuntime } from './paths';
import type { CustomToolDefinition, InitConfig } from './types';
import {
  buildOpenAICompatibleModelsConfig,
  fetchOpenAICompatibleModels,
  OPENAI_COMPATIBLE_API_KEY_ENV,
  OPENAI_COMPATIBLE_PROVIDER,
} from './openai-compatible';
import type { SubsysDiscovery } from '../host/discovery';
import type { PluginBackedSimulation, PluginBackedCoverage } from '../host/plugin-discovery';
import { HostToolsRegistry } from '../host/host-tools';
import { HostUriRouter } from '../host/host-uris';

const MAX_CONCURRENT_SESSIONS = 10;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export interface CreateSessionOptions {
  projectId: string;
  cwd: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  sessionDir?: string;
  resumeSessionId?: string;
  persistedSessionId?: string;
  env?: Record<string, string>;
  enableMCP?: boolean;
  systemPrompt?: string;
  discovery?: SubsysDiscovery;
  simulationAdapter?: PluginBackedSimulation | null;
  coverageAdapter?: PluginBackedCoverage | null;
}

export interface SessionEntry {
  id: string;
  /** The SoC Verify session ID stored in .socverify/sessions.json, if this is a restored runtime session. */
  persistedSessionId?: string;
  /** The omp engine's session ID — needed to resume conversations */
  ompSessionId?: string;
  projectId: string;
  client: AgentClient;
  hostTools: HostToolsRegistry;
  hostUris: HostUriRouter;
  createdAt: number;
  lastActivityAt: number;
  idleTimer: NodeJS.Timeout | null;
  runtimeDir?: string;
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

    const runtime = resolveAgentRuntime();
    if (!runtime) {
      throw new Error(
        'Agent runtime not found. Please run `npm run setup:agent` to download the agent binary, ' +
        'or ensure Bun and the engine submodule are available.',
      );
    }
    // Version check only applies to script mode (binary mode has Bun embedded)
    if (runtime.mode === 'script' && !runtime.bunVersionOk) {
      throw new Error(
        `Bun runtime must be >= 1.3.14 (found v${runtime.bunVersion}). ` +
        'Please upgrade: bun upgrade',
      );
    }

    const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Set up SoC verification tools
    const hostTools = new HostToolsRegistry(options.discovery, options.cwd);
    if (options.simulationAdapter) hostTools.setSimulationAdapter(options.simulationAdapter);
    if (options.coverageAdapter) hostTools.setCoverageAdapter(options.coverageAdapter);

    // Build custom tool definitions for the runner
    const customToolDefinitions: CustomToolDefinition[] = hostTools.getDefinitions().map((def) => ({
      name: def.name,
      label: def.label,
      description: def.description,
      parameters: def.parameters,
      approval: 'read',
    }));

    // Tool call handler: when the runner calls a tool, delegate to HostToolsRegistry
    const toolCallHandler: ToolCallHandler = async (toolName, args) => {
      const result = await hostTools.handleToolCall({
        type: 'host_tool_call',
        id: '',
        toolCallId: '',
        toolName,
        arguments: (args as Record<string, unknown>) ?? {},
      });
      return result;
    };

    let provider = options.provider;
    let model = options.model;
    let runtimeDir: string | undefined;
    const env = { ...options.env };

    if (options.baseUrl && options.apiKey) {
      if (!model) {
        const models = await fetchOpenAICompatibleModels({
          baseUrl: options.baseUrl,
          apiKey: options.apiKey,
        });
        model = models[0]?.id;
      }
      if (!model) {
        throw new Error('The OpenAI-compatible endpoint returned no models');
      }

      runtimeDir = await mkdtemp(join(tmpdir(), 'socverify-agent-'));
      const modelsConfig = buildOpenAICompatibleModelsConfig({
        baseUrl: options.baseUrl,
        modelId: model,
        apiKeyEnvVar: OPENAI_COMPATIBLE_API_KEY_ENV,
      });
      await writeFile(join(runtimeDir, 'models.json'), JSON.stringify(modelsConfig), 'utf-8');
      env.PI_CODING_AGENT_DIR = runtimeDir;
      env.XDG_STATE_HOME = join(runtimeDir, 'state');
      env[OPENAI_COMPATIBLE_API_KEY_ENV] = options.apiKey;
      provider = OPENAI_COMPATIBLE_PROVIDER;
    }

    // Build init config
    const initConfig: InitConfig = {
      cwd: options.cwd,
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      provider,
      model,
      sessionDir: options.sessionDir,
      env,
      enableMCP: options.enableMCP ?? true,
      resumeSessionId: options.resumeSessionId,
      systemPrompt: options.systemPrompt,
      customToolDefinitions,
    };

    const client = new AgentClient(
      runtime.mode === 'binary'
        ? {
            runnerBinaryPath: runtime.runnerPath,
            cwd: options.cwd,
            env,
          }
        : {
            bunPath: runtime.bunPath,
            runnerPath: runtime.runnerPath,
            cwd: options.cwd,
            env,
          },
    );

    client.setToolCallHandler(toolCallHandler);

    // Forward events
    client.onEvent((event) => {
      const evtType = (event as Record<string, unknown>)?.type;
      console.log(`[agent:session:${sessionId}] event type="${evtType}"`);
      this.emit('sessionEvent', { sessionId, event } satisfies SessionEventData);
    });

    // Log env vars being passed (mask API keys)
    if (Object.keys(env).length > 0) {
      const maskedEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(env)) {
        maskedEnv[k] = k.includes('KEY') || k.includes('SECRET') ? `${v.slice(0, 4)}***` : v;
      }
      console.log(`[agent:session:${sessionId}] env vars:`, maskedEnv);
    } else {
      console.log(`[agent:session:${sessionId}] WARNING: no env vars passed to agent`);
    }
    console.log(`[agent:session:${sessionId}] provider=${provider ?? '(default)'}, model=${model ?? '(default)'}`);

    let ompSessionId: string | undefined;

    try {
      await client.start();
      console.log(`[agent:session:${sessionId}] agent process started successfully`);
      const initResult = await client.init(initConfig);
      ompSessionId = initResult.sessionId;
      console.log(`[agent:session:${sessionId}] omp sessionId=${ompSessionId}`);
    } catch (err) {
      client.stop();
      if (runtimeDir) {
        await rm(runtimeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
      throw new Error(`Failed to initialize agent session: ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log(`[agent:session:${sessionId}] agent session initialized`);

    const entry: SessionEntry = {
      id: sessionId,
      persistedSessionId: options.persistedSessionId,
      ompSessionId,
      projectId: options.projectId,
      client,
      hostTools,
      hostUris: new HostUriRouter(),
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      idleTimer: null,
      runtimeDir,
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

  /** Get the omp engine's session ID for a given SoC Verify session. */
  getOmpSessionId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.ompSessionId;
  }

  getClient(sessionId: string): AgentClient | null {
    return this.sessions.get(sessionId)?.client ?? null;
  }

  listSessions(): Array<{ id: string; persistedSessionId?: string; projectId: string; createdAt: number; lastActivityAt: number }> {
    return Array.from(this.sessions.values()).map((e) => ({
      id: e.id,
      persistedSessionId: e.persistedSessionId,
      projectId: e.projectId,
      createdAt: e.createdAt,
      lastActivityAt: e.lastActivityAt,
    }));
  }

  listSessionsByProject(projectId: string): string[] {
    return Array.from(this.projectSessions.get(projectId) ?? []);
  }

  // ─── 动态 provider/model 切换 ─────────────────────────

  async setModel(sessionId: string, provider: string, modelId: string): Promise<void> {
    const client = this.requireClient(sessionId);
    await client.setModel(provider, modelId);
    this.touchActivity(sessionId);
  }

  async getAvailableModels(_sessionId: string): Promise<unknown[]> {
    // The SDK discovers models via the ModelRegistry.
    // Model selection is handled via the settings.fetchModels API
    // which queries the OpenAI-compatible endpoint directly.
    return [];
  }

  private requireClient(sessionId: string): AgentClient {
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

    try {
      await entry.client.destroy();
    } catch {
      // best-effort cleanup
    } finally {
      if (entry.runtimeDir) {
        await rm(entry.runtimeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    }
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
