import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AgentClient, type ToolCallHandler } from './agent-client';
import { resolveAgentRuntime, resolveBuiltInExtensionDir, resolveRunnerBinary } from './paths';
import type { CustomToolDefinition, InitConfig } from './types';
import {
  buildModelInputOverrideConfig,
  buildOpenAICompatibleModelsConfig,
  ensureV1Prefix,
  fetchOpenAICompatibleModels,
  OPENAI_COMPATIBLE_API_KEY_ENV,
  OPENAI_COMPATIBLE_PROVIDER,
  type OpenAICompatibleModel,
} from './openai-compatible';
import type { SubsysDiscovery } from '../host/discovery';
import type { PluginBackedSimulation, PluginBackedCoverage } from '../host/plugin-discovery';
import { HostToolsRegistry } from '../host/host-tools';
import { HostUriRouter } from '../host/host-uris';
import type { CoverageManager } from '../coverage/coverage-manager';

const MAX_CONCURRENT_SESSIONS = 10;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

// High-frequency streaming events excluded from the terminal log to avoid
// flooding the console — content is still emitted via the 'sessionEvent' stream.
const SILENT_EVENT_TYPES = new Set(['message_update', 'message_chunk', 'message_delta']);

// Maximum length of content snippets printed to the terminal log. Full content
// remains available via the 'sessionEvent' stream consumed by the renderer.
const LOG_SNIPPET_LEN = 200;

/**
 * Build a single-line debug summary for an agent event, extracting the most
 * useful payload (LLM text, tool args/result, errors). Returns an empty string
 * for events with no useful payload — callers should skip logging in that case.
 */
function summarizeEvent(event: unknown): string {
  if (typeof event !== 'object' || event === null) return '';
  const evt = event as Record<string, unknown>;
  const type = typeof evt.type === 'string' ? evt.type : 'unknown';
  const snippet = (s: string, n = LOG_SNIPPET_LEN): string =>
    s.length > n ? `${s.slice(0, n)}…(+${s.length - n} chars)` : s;

  switch (type) {
    case 'message_start':
    case 'message_end': {
      const msg = evt.message as Record<string, unknown> | undefined;
      if (!msg) return '';
      const role = typeof msg.role === 'string' ? msg.role : '?';
      // content may be a string or an array of content blocks
      let text = '';
      const content = msg.content;
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const block of content) {
          if (typeof block !== 'object' || block === null) continue;
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
          else if (b.type === 'thinking' && typeof b.thinking === 'string') {
            parts.push(`[thinking] ${b.thinking}`);
          }
        }
        text = parts.join('\n');
      }
      const errMsg = typeof msg.errorMessage === 'string' ? msg.errorMessage : '';
      if (errMsg) return `role=${role} ERROR=${snippet(errMsg)}`;
      if (text) return `role=${role} text=${snippet(text)}`;
      return `role=${role}`;
    }
    case 'tool_execution_start': {
      const toolName = typeof evt.toolName === 'string' ? evt.toolName : '?';
      let argsStr = '';
      try {
        argsStr = evt.args === undefined ? '' : JSON.stringify(evt.args);
      } catch {
        argsStr = String(evt.args);
      }
      return `tool=${toolName} args=${snippet(argsStr)}`;
    }
    case 'tool_execution_end': {
      const toolName = typeof evt.toolName === 'string' ? evt.toolName : '?';
      let resultStr = '';
      try {
        resultStr = evt.result === undefined ? '' : JSON.stringify(evt.result);
      } catch {
        resultStr = String(evt.result);
      }
      return `tool=${toolName} result=${snippet(resultStr)}`;
    }
    case 'notice': {
      const text = typeof evt.text === 'string' ? evt.text : (typeof evt.message === 'string' ? evt.message : '');
      return text ? snippet(text) : '';
    }
    default:
      return '';
  }
}

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
  coverageManager?: CoverageManager | null;
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
  /** The model ID that the runtime session was actually initialized with
   *  (may differ from the requested model when createSession auto-fetched
   *  the first model from the API). */
  model?: string;
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
    if (options.coverageManager) hostTools.setCoverageManager(options.coverageManager);

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
      // Fetch ALL models from the API so we can write the complete list to
      // models.json. This is essential for runtime model switching via the
      // omp engine's `set_model` RPC — if a model isn't in models.json,
      // `set_model` silently fails and messages are still sent with the old
      // model (causing 503 errors when the user switches models in RightPanel).
      let allModels: OpenAICompatibleModel[] = [];
      try {
        allModels = await fetchOpenAICompatibleModels({
          baseUrl: options.baseUrl,
          apiKey: options.apiKey,
        });
      } catch (err) {
        console.warn(`[agent:session:${sessionId}] failed to fetch model list: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!model) {
        model = allModels[0]?.id;
      }
      if (!model) {
        throw new Error('The OpenAI-compatible endpoint returned no models');
      }

      runtimeDir = await mkdtemp(join(tmpdir(), 'socverify-agent-'));
      const modelsConfig = buildOpenAICompatibleModelsConfig({
        baseUrl: options.baseUrl,
        modelId: model,
        models: allModels,
        apiKeyEnvVar: OPENAI_COMPATIBLE_API_KEY_ENV,
      });
      const modelsJson = JSON.stringify(modelsConfig);
      // Write both models.json (legacy) and models.yml (preferred by ConfigFile).
      // JSON is valid YAML (YAML is a superset of JSON), so the ConfigFile's
      // YAML parser will read it correctly without any migration step.
      await writeFile(join(runtimeDir, 'models.json'), modelsJson, 'utf-8');
      await writeFile(join(runtimeDir, 'models.yml'), modelsJson, 'utf-8');
      console.log(`[agent:session:${sessionId}] models config: ${modelsJson.slice(0, 500)}`);
      console.log(`[agent:session:${sessionId}] runtimeDir: ${runtimeDir}`);
      env.PI_CODING_AGENT_DIR = runtimeDir;
      env.XDG_STATE_HOME = join(runtimeDir, 'state');
      env[OPENAI_COMPATIBLE_API_KEY_ENV] = options.apiKey;
      // Also set OPENAI_API_KEY / OPENAI_BASE_URL so the omp engine's
      // openai-completions provider can resolve the key via $env fallback
      // (resolveOpenAIRequestSetup checks options.apiKey, then $env.OPENAI_API_KEY).
      // This is critical for packaged builds where the env var might not be
      // propagated through other paths.
      if (!env.OPENAI_API_KEY) env.OPENAI_API_KEY = options.apiKey;
      if (options.baseUrl && !env.OPENAI_BASE_URL) env.OPENAI_BASE_URL = ensureV1Prefix(options.baseUrl);
      provider = OPENAI_COMPATIBLE_PROVIDER;
    } else if (provider && model) {
      // Built-in provider path (e.g. user supplied only an API key, no baseUrl).
      // Write a models.json with modelOverrides so omp's vision-guard does not
      // silently drop images when the internal catalog marks the model as
      // text-only.  Only the `input` field is patched; all other catalog
      // properties (api, cost, contextWindow, ...) remain intact.
      runtimeDir = await mkdtemp(join(tmpdir(), 'socverify-agent-'));
      const modelsConfig = buildModelInputOverrideConfig({ provider, modelId: model });
      const modelsJson = JSON.stringify(modelsConfig);
      await writeFile(join(runtimeDir, 'models.json'), modelsJson, 'utf-8');
      await writeFile(join(runtimeDir, 'models.yml'), modelsJson, 'utf-8');
      console.log(`[agent:session:${sessionId}] models.yml (override): ${modelsJson.slice(0, 500)}`);
      env.PI_CODING_AGENT_DIR = runtimeDir;
      env.XDG_STATE_HOME = join(runtimeDir, 'state');
    }

    // Ensure ~/.omp/natives/ exists so the omp engine's native-addon search
    // doesn't fail with "open dir error: No such file or directory" on first run.
    try {
      const ompNativesDir = join(homedir(), '.omp', 'natives');
      if (!existsSync(ompNativesDir)) {
        mkdirSync(ompNativesDir, { recursive: true });
      }
    } catch {
      // Best-effort: the runner also searches the binaries directory.
    }

    // Tell the runner where to find pi_natives.*.node so it doesn't have to
    // search ~/.omp/natives/<version>/ (which may not exist).
    const runnerBinary = resolveRunnerBinary();
    if (runnerBinary) {
      env.OMP_NATIVES_DIR = dirname(runnerBinary);
    }

    // On Linux, detect the system CA certificate bundle path and set
    // NODE_EXTRA_CA_CERTS so Bun's fetch can verify TLS connections.
    // Bun's compiled binary may not always find the system's CA store,
    // especially in packaged environments like AppImage. The omp engine's
    // `withExtraCaFetch` wrapper reads this env var and merges the CA
    // bundle into Bun's TLS config.
    if (process.platform === 'linux' && !env.NODE_EXTRA_CA_CERTS && !process.env.NODE_EXTRA_CA_CERTS) {
      const caCandidates = [
        '/etc/ssl/certs/ca-certificates.crt',   // Debian/Ubuntu
        '/etc/pki/tls/certs/ca-bundle.crt',       // RHEL/CentOS/Fedora
        '/etc/ssl/cert.pem',                       // OpenSUSE/Arch
        '/etc/ca-certificates/ca-certificates.crt', // Alpine
      ];
      for (const caPath of caCandidates) {
        if (existsSync(caPath)) {
          env.NODE_EXTRA_CA_CERTS = caPath;
          console.log(`[agent:session:${sessionId}] detected system CA bundle: ${caPath}`);
          break;
        }
      }
    }

    // Build init config
    const additionalExtensionPaths: string[] = [];
    const builtInExtDir = resolveBuiltInExtensionDir();
    if (builtInExtDir) {
      additionalExtensionPaths.push(builtInExtDir);
      console.log(`[agent:session:${sessionId}] built-in extension dir: ${builtInExtDir}`);
    } else {
      console.warn(`[agent:session:${sessionId}] built-in extension dir not found — built-in skills/agents will not be loaded`);
    }

    const initConfig: InitConfig = {
      cwd: options.cwd,
      apiKey: options.apiKey,
      baseUrl: options.baseUrl ? ensureV1Prefix(options.baseUrl) : undefined,
      provider,
      model,
      sessionDir: options.sessionDir,
      env,
      enableMCP: options.enableMCP ?? true,
      resumeSessionId: options.resumeSessionId,
      systemPrompt: options.systemPrompt,
      customToolDefinitions,
      additionalExtensionPaths,
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
    // High-frequency streaming events (message_update/chunk/delta) are excluded
    // from the terminal log to avoid flooding; other events print a one-line
    // summary with the most useful payload (LLM text, tool args/result, errors).
    //
    // When SOCVERIFY_DEBUG_EVENTS is set, ALL events (including streaming)
    // are logged — this is invaluable for diagnosing empty-response issues
    // in packaged builds where the omp engine's own file logs are ephemeral.
    const debugAllEvents = !!process.env.SOCVERIFY_DEBUG_EVENTS;
    client.onEvent((event) => {
      const evtType = (event as Record<string, unknown>)?.type as string | undefined;
      if (debugAllEvents || !SILENT_EVENT_TYPES.has(evtType ?? '')) {
        const summary = summarizeEvent(event);
        console.log(
          `[agent:session:${sessionId}] event type="${evtType}"${summary ? ` ${summary}` : ''}`,
        );
      }
      // Detect empty assistant responses for diagnostic logging.
      // An assistant message_end with no text and no error is the signature
      // of an empty LLM completion — typically caused by TLS failures, network
      // issues, or API key problems in packaged environments.
      if (evtType === 'message_end') {
        const msg = (event as Record<string, unknown>)?.message as Record<string, unknown> | undefined;
        if (msg?.role === 'assistant') {
          const hasText = Array.isArray(msg.content) &&
            (msg.content as unknown[]).some((b) =>
              typeof b === 'object' && b !== null &&
              (b as Record<string, unknown>).type === 'text' &&
              typeof (b as Record<string, unknown>).text === 'string' &&
              ((b as Record<string, unknown>).text as string).length > 0);
          if (!hasText && !msg.errorMessage) {
            console.warn(`[agent:session:${sessionId}] WARNING: empty assistant response (no text, no error). Possible causes: TLS/SSL certificate issues, network errors, or API key problems. Check [agent:stderr] lines above for omp engine errors.`);
          }
        }
      }
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

    const hostUris = new HostUriRouter();
    if (options.coverageManager) hostUris.setCoverageManager(options.coverageManager);

    const entry: SessionEntry = {
      id: sessionId,
      persistedSessionId: options.persistedSessionId,
      ompSessionId,
      projectId: options.projectId,
      client,
      hostTools,
      hostUris,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      idleTimer: null,
      runtimeDir,
      model,
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

  /** Get the model ID that the runtime session was actually initialized with. */
  getModel(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.model;
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
