import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AgentClient, type ToolCallHandler } from './agent-client';
import { PiAgentClient } from './pi-agent-client';
import type {
  AgentClientFactory,
  AgentClientFactoryOptions,
  IAgentClient,
} from './agent-contract';
import { resolveAgentRuntime, resolveBuiltInExtensionDir, resolvePiRunnerScript, resolveRunnerBinary, resolveRunnerScript, resolveBunPath, checkBunVersion, type AgentRuntime } from './paths';
import { ensureOfficecliOnPath } from './officecli-paths';
import type { CustomToolDefinition, InitConfig, ApprovalMode, SeedHistoryMessage, TrustKind } from './types';
import { TrustStore } from './trust-store';
import {
  buildModelInputOverrideConfig,
  buildOpenAICompatibleModelsConfig,
  buildOpenAICompatibleModelsWithPerModelContext,
  ensureV1Prefix,
  fetchOpenAICompatibleModels,
  OPENAI_COMPATIBLE_API_KEY_ENV,
  OPENAI_COMPATIBLE_PROVIDER,
  type OpenAICompatibleModel,
} from './openai-compatible';
import type { ConfiguredModel, OpenAiApiFormat, ThinkingLevelSetting } from '@shared/types';
import type { SubsysDiscovery } from '../host/discovery';
import type { PluginBackedSimulation, PluginBackedCoverage } from '../plugin-adapters';
import { HostToolsRegistry } from '../host/host-tools';
import { HostUriRouter } from '../host/host-uris';
import type { CoverageManager } from '../coverage/coverage-manager';
import type { CaseStatsService } from '../case/case-stats-service';
import { contextSettings } from './context-settings';
import { toolSettings } from './tool-settings';
import { ensureBuiltinMcpServers } from '../mcp/mcp-config';
import {
  describeTraceweaveUnavailability,
  diagnoseTraceweave,
  ensureTraceweaveDefaultMcp,
} from '../mcp/traceweave-paths';
import { notificationManager } from '../notifications/notification-manager';
import type { AskAnswer, AskQuestion } from '@shared/ask-types';
import type { AgentEngine } from '@shared/agent-events';
import { recordSubagentUsageFromEvent, recordUsageFromEvent } from '../token-monitor/token-usage-recorder';
import { tokenMonitorRegistry } from '../token-monitor/token-monitor-registry';

const MAX_CONCURRENT_SESSIONS = 10;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

// High-frequency streaming events excluded from the terminal log to avoid
// flooding the console — content is still emitted via the 'sessionEvent' stream.
const SILENT_EVENT_TYPES = new Set(['message_update', 'message_chunk', 'message_delta', 'subagent_progress']);

// Maximum length of content snippets printed to the terminal log. Full content
// remains available via the 'sessionEvent' stream consumed by the renderer.
const LOG_SNIPPET_LEN = 200;

/** One-per-app-run guard for TraceWeave notification centre notices. */
let traceweaveNoticeSent = false;

/**
 * Push a TraceWeave notice to the notification centre at most once per app
 * run. Python/pip deps are user-machine prerequisites (ADR 0020), so a
 * broken environment is a user-actionable condition, not a silent one.
 */
function pushTraceweaveNoticeOnce(title: string, detail: string): void {
  if (traceweaveNoticeSent) return;
  traceweaveNoticeSent = true;
  notificationManager
    .add({ type: 'failure', title, detail })
    .catch((err: unknown) => console.warn(`[traceweave] notification failed: ${err instanceof Error ? err.message : String(err)}`));
}

/**
 * Diagnose the built-in TraceWeave MCP server (fire-and-forget); on the first
 * not-ready result of the app run, push a notification centre notice pointing
 * at the settings MCP tab. Never blocks session creation.
 */
async function notifyTraceweaveNotReadyOnce(): Promise<void> {
  if (traceweaveNoticeSent) return;
  try {
    const diag = await diagnoseTraceweave();
    if (diag.ready) return;
    const problems: string[] = [];
    if (!diag.pythonFound) problems.push('未找到 Python（需要 3.11+ 并加入 PATH）');
    else if (diag.pythonVersionOk === false) problems.push(`Python 版本过低（${diag.pythonVersion ?? '未知'}，需要 3.11+）`);
    else if (diag.depsInstalled === false) {
      problems.push(`缺少 pip 依赖${diag.missingDeps.length > 0 ? `：${diag.missingDeps.join(', ')}` : ''}`);
    }
    if (!diag.sourceDirFound) problems.push('内置 TraceWeave 源码缺失');
    pushTraceweaveNoticeOnce(
      'TraceWeave 仿真调试工具未就绪',
      `${problems.join('；')}。可在 设置 → MCP 查看诊断并复制修复命令${diag.installCommand ? `：${diag.installCommand}` : ''}。`,
    );
  } catch (err) {
    console.warn(`[traceweave] not-ready diagnostic failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

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

/**
 * Format the answer for a single-question `ask` call as a natural-language
 * response the AI can consume. Matches the omp engine's AskTool format.
 */
function formatSingleAnswer(question: AskQuestion, answers: AskAnswer[]): string {
  const ans = answers.find((a) => a.questionId === question.id);
  if (!ans) return 'User cancelled the selection';
  if (ans.customInput !== undefined && ans.customInput !== '') {
    return ans.customInput.includes('\n')
      ? `User provided custom input:\n${ans.customInput.split('\n').map((l) => `  ${l}`).join('\n')}`
      : `User provided custom input: ${ans.customInput}`;
  }
  if (ans.selectedOptions.length > 0) {
    const selected = question.multi
      ? `User selected: ${ans.selectedOptions.join(', ')}`
      : `User selected: ${ans.selectedOptions[0]}`;
    return selected;
  }
  return 'User cancelled the selection';
}

/**
 * Extract assistant text from a `message_end` event's `message` payload.
 *
 * Content may be a string or an array of content blocks. Non-assistant
 * messages return null. This is the single canonical implementation that
 * replaces the duplicated text-extraction logic previously found in
 * `tv-ai-advisor.ts`, `closure-orchestrator.ts`, and the `summarizeEvent`
 * debug helper above (which remains for terminal logging).
 */
function extractAssistantTextFromEvent(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const msg = message as Record<string, unknown>;
  if (msg.role !== 'assistant') return null;
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    let text = '';
    for (const block of msg.content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') text += b.text;
      }
    }
    return text;
  }
  return null;
}

/**
 * Stable fingerprint of the credential config a runtime session was created
 * with. session.setModel compares this against the requested credential to
 * skip redundant destroy/recreate swaps (same provider + same key + same
 * endpoint → the running session is already correct).
 */
export function credentialSnapshot(
  providerId: string | undefined,
  apiKey: string | undefined,
  baseUrl: string | undefined,
  apiFormat?: OpenAiApiFormat,
): string {
  return `${providerId ?? ''}|${apiKey ?? ''}|${baseUrl ?? ''}|${apiFormat ?? ''}`;
}

export interface CreateSessionOptions {
  projectId: string;
  cwd: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  /** OpenAI 兼容端点的 API wire 格式（来自凭据的 api 字段），写入 models.json provider 级 `api`。 */
  apiFormat?: OpenAiApiFormat;
  sessionDir?: string;
  resumeSessionId?: string;
  /** UI 存储对话历史，用于 omp 会话文件缺失/部分覆盖时的上下文种子 */
  seedHistory?: SeedHistoryMessage[];
  persistedSessionId?: string;
  /** 凭据 ID —— 记录会话由哪个凭据创建（setModel 冗余 swap 判定用） */
  providerId?: string;
  env?: Record<string, string>;
  enableMCP?: boolean;
  systemPrompt?: string;
  /** Model context window advertised to omp. Falls back to the global setting. */
  contextWindow?: number;
  /** User-configured models for this provider. When provided, createSession
   *  uses these instead of fetching from the API. Each model has its own contextWindow. */
  configuredModels?: ConfiguredModel[];
  discovery?: SubsysDiscovery;
  simulationAdapter?: PluginBackedSimulation | null;
  coverageAdapter?: PluginBackedCoverage | null;
  coverageManager?: CoverageManager | null;
  /** 用例聚合统计服务（UI 与 AI 共享，注入后启用 get_case_stats / get_project_overview） */
  caseStatsService?: CaseStatsService | null;
  /** 工具审批模式 */
  approvalMode?: ApprovalMode;
  /** 会话初始思考强度（'default'/缺省 = 跟随 omp 引擎默认） */
  thinkingLevel?: ThinkingLevelSetting;
  /** 会话绑定的引擎（'omp' | 'pi'）。缺省 'omp'。'pi' 走 runner-pi 脚本（Node 运行），
   *  不做 omp 的 Bun/engine 运行时解析与版本检查。 */
  engine?: AgentEngine;
}

export interface SessionEntry {
  id: string;
  /** The SoC Verify session ID stored in .socverify/sessions.json, if this is a restored runtime session. */
  persistedSessionId?: string;
  /** Which engine backs this session (e.g. 'omp', 'pi'). */
  engine: AgentEngine;
  /** The engine's session ID — needed to resume conversations (engine-neutral). */
  engineSessionId?: string;
  projectId: string;
  client: IAgentClient;
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
  /** The credential (providerId) this session was created with — used by
   *  session.setModel to detect redundant holistic swaps (same provider +
   *  same model → skip the destructive destroy/recreate cycle). */
  providerId?: string;
  /** Fingerprint of apiKey+baseUrl at creation time — detects edits to a
   *  credential that require an actual destroy/recreate to take effect. */
  credentialSnapshot?: string;
  /** Whether the agent is currently processing (between agent_start and agent_end).
   *  When true, the idle retirement timer is NOT scheduled — the session
   *  is actively working and must not be destroyed regardless of elapsed time. */
  isActive: boolean;
}

export interface SessionEventData {
  sessionId: string;
  event: unknown;
}

/**
 * Default client factory — routes on `options.engine`:
 * 'pi' builds the `PiAgentClient` (plain Node script runner), 'omp' builds
 * the omp-backed `AgentClient` from the resolved runtime mode. Tests and
 * other engines inject their own factory.
 */
export const defaultAgentClientFactory: AgentClientFactory = (options) => {
  if (options.engine === 'pi') {
    return new PiAgentClient({
      runnerPath: options.runnerPath,
      cwd: options.cwd,
      env: options.env,
    });
  }
  return new AgentClient(
    options.mode === 'binary'
      ? { runnerBinaryPath: options.runnerPath, cwd: options.cwd, env: options.env }
      : {
          bunPath: options.bunPath!,
          runnerPath: options.runnerPath,
          cwd: options.cwd,
          env: options.env,
        },
  );
};

export class SessionManagerImpl extends EventEmitter {
  private sessions = new Map<string, SessionEntry>();
  private projectSessions = new Map<string, Set<string>>();
  private idleTimeoutMs: number;
  /** Factory seam: creates engine clients so the manager stays engine-neutral. */
  private clientFactory: AgentClientFactory;
  /** Pending approval requests: requestId → { resolve, sessionId } */
  private pendingApprovals = new Map<string, { resolve: (approved: boolean) => void; sessionId: string }>();
  /** Pending ask requests: requestId → { resolve, sessionId } */
  private pendingAsks = new Map<string, { resolve: (answers: AskAnswer[]) => void; sessionId: string }>();
  /** Pending trust requests（issue 04）：requestId → 决策上下文（用于持久化） */
  private pendingTrusts = new Map<
    string,
    { resolve: (approved: boolean) => void; sessionId: string; cwd: string; kind: TrustKind; name: string }
  >();
  /** host 信任存储（userData/socverify-data/trust.json）；null = 不可用（不持久化） */
  private trustStore: TrustStore | null | undefined;

  constructor(idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS, clientFactory: AgentClientFactory = defaultAgentClientFactory) {
    super();
    this.idleTimeoutMs = idleTimeoutMs;
    this.clientFactory = clientFactory;
  }

  async createSession(options: CreateSessionOptions): Promise<string> {
    if (this.sessions.size >= MAX_CONCURRENT_SESSIONS) {
      throw new Error(`Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached`);
    }

    const contextWindow = options.contextWindow ?? await contextSettings.getContextWindow();

    // 引擎路由：'pi' 走 runner-pi 脚本（Node 运行，无需 Bun/engine）；
    // 'omp'（缺省）走 resolveAgentRuntime（预编译二进制 → Bun + 脚本）。
    const engine: AgentEngine = options.engine ?? 'omp';
    let runtime: AgentRuntime;
    if (engine === 'pi') {
      const piScript = resolvePiRunnerScript();
      if (!piScript) {
        throw new Error(
          'pi runner not found. Expected runner-pi/index.ts in the packaged resources or repository root.',
        );
      }
      runtime = { mode: 'script', runnerPath: piScript };
      console.log(`[agent:session] engine=pi, pi runner script: ${piScript}`);
    } else {
      const ompRuntime = resolveAgentRuntime();
      if (!ompRuntime) {
        throw new Error(
          'Agent runtime not found. Please run `npm run setup:agent` to download the agent binary, ' +
          'or ensure Bun and the engine submodule are available.',
        );
      }
      // Version check only applies to script mode (binary mode has Bun embedded)
      if (ompRuntime.mode === 'script' && !ompRuntime.bunVersionOk) {
        throw new Error(
          `Bun runtime must be >= 1.3.14 (found v${ompRuntime.bunVersion}). ` +
          'Please upgrade: bun upgrade',
        );
      }
      runtime = ompRuntime;
    }

    const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Set up SoC verification tools
    const hostTools = new HostToolsRegistry(options.discovery, options.cwd);
    if (options.simulationAdapter) hostTools.setSimulationAdapter(options.simulationAdapter);
    if (options.coverageAdapter) hostTools.setCoverageAdapter(options.coverageAdapter);
    if (options.coverageManager) hostTools.setCoverageManager(options.coverageManager);
    if (options.caseStatsService) hostTools.setCaseStatsService(options.caseStatsService);

    // 用户在设置页禁用的工具不暴露给 LLM（`ask` 是交互问答通道，始终保留）
    const disabledToolSet = new Set(await toolSettings.getDisabledTools());
    disabledToolSet.delete('ask');

    // Build custom tool definitions for the runner
    const customToolDefinitions: CustomToolDefinition[] = hostTools.getDefinitions()
      .filter((def) => !disabledToolSet.has(def.name))
      .map((def) => ({
      name: def.name,
      label: def.label,
      description: def.description,
      parameters: def.parameters,
      approval: 'read',
    }));

    // Register `ask` as a custom host tool so the omp engine routes it to the
    // host instead of using its built-in terminal-based AskTool (which requires
    // a TTY not available in the subprocess). The toolCallHandler below
    // intercepts `ask` calls and surfaces them as interactive UI in the renderer.
    customToolDefinitions.push({
      name: 'ask',
      label: 'Ask',
      description:
        'Ask the user a clarifying question with selectable options. Use this when you need to gather preferences, clarify ambiguous instructions, or get decisions on implementation choices. Each question has an id, question text, and a list of options (each with a label and optional description). Set multi:true to allow multiple selections. Set recommended to the index of the default option. Users can always choose "Other" to type a custom answer.',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: 'Questions to ask the user',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Question identifier' },
                question: { type: 'string', description: 'Question text' },
                options: {
                  type: 'array',
                  description: 'Available options',
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string', description: 'Display label' },
                      description: { type: 'string', description: 'Optional explanatory text' },
                    },
                    required: ['label'],
                  },
                },
                multi: { type: 'boolean', description: 'Allow multiple selections' },
                recommended: { type: 'number', description: 'Recommended option index (0-based)' },
              },
              required: ['id', 'question', 'options'],
            },
            minItems: 1,
          },
        },
        required: ['questions'],
      },
      approval: 'read',
    });

    // Tool call handler: when the runner calls a tool, delegate to HostToolsRegistry.
    // `ask` is intercepted here — instead of delegating to hostTools, it emits an
    // `askRequest` event to the renderer and waits for the user to submit answers.
    const toolCallHandler: ToolCallHandler = async (toolName, args) => {
      if (toolName === 'ask') {
        return this.handleAskToolCall(sessionId, args);
      }
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
    // Per-model contextWindow — resolved when configuredModels is available;
    // falls back to the global contextWindow. Declared at function scope so
    // the InitConfig below can reference it.
    let modelContextWindow: number | undefined;

    if (options.baseUrl && options.apiKey) {
      const baseUrlValue = options.baseUrl;
      const apiKeyValue = options.apiKey;
      // Use user-configured models when available; otherwise fetch from the API.
      // Each configured model has its own contextWindow — we write them all to
      // models.json so the omp engine's `set_model` RPC can switch to any of
      // them at runtime with the correct context window.
      let allModels: OpenAICompatibleModel[] = [];
      modelContextWindow = contextWindow;

      if (options.configuredModels && options.configuredModels.length > 0) {
        // Convert ConfiguredModel[] to OpenAICompatibleModel[] for models.json
        // (reasoning 随模型透传，决定 models.yml 的 thinking 能力声明)
        allModels = options.configuredModels.map((m) => ({
          id: m.id,
          name: m.name,
          reasoning: m.reasoning,
          input: m.input,
        }));
        // Use the selected model's contextWindow if available
        if (model) {
          const configured = options.configuredModels.find((m) => m.id === model);
          if (configured) {
            modelContextWindow = configured.contextWindow;
          }
        }
      } else {
        // Fallback: fetch ALL models from the API so we can write the complete
        // list to models.json. This is essential for runtime model switching via
        // the omp engine's `set_model` RPC — if a model isn't in models.json,
        // `set_model` silently fails and messages are still sent with the old
        // model (causing 503 errors when the user switches models in RightPanel).
        try {
          allModels = await fetchOpenAICompatibleModels({
            baseUrl: baseUrlValue,
            apiKey: apiKeyValue,
          });
        } catch (err) {
          console.warn(`[agent:session:${sessionId}] failed to fetch model list: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (!model) {
        model = allModels[0]?.id;
      }
      if (!model) {
        const detail = allModels.length === 0
          ? 'The endpoint did not return any models. Please check that the Base URL points to a valid OpenAI-compatible API (e.g. https://api.openai.com/v1) and the API key is correct.'
          : 'The endpoint returned models but none could be used as default. Please specify a model in the session settings.';
        throw new Error(`No models available from the configured endpoint. ${detail}`);
      }

      runtimeDir = await mkdtemp(join(tmpdir(), 'socverify-agent-'));
      // Build models config with per-model contextWindow when configuredModels is available
      const modelsConfig = options.configuredModels && options.configuredModels.length > 0
        ? buildOpenAICompatibleModelsWithPerModelContext({
            baseUrl: baseUrlValue,
            models: options.configuredModels,
            apiKeyEnvVar: OPENAI_COMPATIBLE_API_KEY_ENV,
            api: options.apiFormat,
          })
        : buildOpenAICompatibleModelsConfig({
            baseUrl: baseUrlValue,
            modelId: model,
            models: allModels,
            apiKeyEnvVar: OPENAI_COMPATIBLE_API_KEY_ENV,
            contextWindow: modelContextWindow,
            api: options.apiFormat,
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
      env[OPENAI_COMPATIBLE_API_KEY_ENV] = apiKeyValue;
      // Also set OPENAI_API_KEY / OPENAI_BASE_URL so the omp engine's
      // openai-completions provider can resolve the key via $env fallback
      // (resolveOpenAIRequestSetup checks options.apiKey, then $env.OPENAI_API_KEY).
      // This is critical for packaged builds where the env var might not be
      // propagated through other paths.
      //
      // FORCE overwrite: buildEnvForAgent() may have set these from the FIRST
      // credential in the list, but this session uses a SPECIFIC credential
      // (e.g. the user switched providers via setModel). If we don't overwrite,
      // the omp engine may resolve a stale key/baseUrl from a different provider,
      // causing silent failures (requests go to the wrong endpoint with the
      // wrong API key).
      env.OPENAI_API_KEY = apiKeyValue;
      if (baseUrlValue) env.OPENAI_BASE_URL = ensureV1Prefix(baseUrlValue);
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

    // 注入 officecli 二进制路径到子进程 PATH（Issue #6）
    // 同步内置 officecli 到 ~/.officecli/bin/ 并将该目录注入 env.PATH 前面，
    // 使 omp 子进程及其衍生的 Host Tool（create_docx 等）可直接调用 officecli。
    try {
      await ensureOfficecliOnPath(env);
    } catch (err) {
      console.warn(`[agent:session:${sessionId}] officecli PATH injection failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Ensure built-in MCP servers (TraceWeave) are registered in the
    // user-level MCP config so the omp engine discovers them on init.
    // This is idempotent: if the server is already in the config, it is
    // not overridden. If TraceWeave or Python is unavailable, it is
    // silently skipped (graceful degradation) with a one-time notification
    // centre notice per app run.
    try {
      const traceweave = ensureTraceweaveDefaultMcp();
      if (traceweave) {
        const modified = await ensureBuiltinMcpServers([traceweave]);
        if (modified) {
          console.log(`[agent:session:${sessionId}] registered built-in MCP server: ${traceweave.name}`);
        }
        // Registration can succeed while user-machine prerequisites (pip
        // deps, python version) are broken — the server would spawn and die.
        // Diagnose asynchronously and notify once; never blocks the session.
        void notifyTraceweaveNotReadyOnce();
      } else {
        // Skipped registration: source missing (nothing to report) or no
        // Python on the user machine (user-actionable → one-time notice).
        const unavailability = describeTraceweaveUnavailability();
        if (unavailability) {
          pushTraceweaveNoticeOnce(
            'TraceWeave 仿真调试工具未启用',
            `${unavailability} 可在 设置 → MCP 查看诊断。`,
          );
        }
      }
    } catch (err) {
      console.warn(`[agent:session:${sessionId}] built-in MCP registration failed: ${err instanceof Error ? err.message : String(err)}`);
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

    // Load host trust store once per manager — provides already-trusted
    // project dirs / MCP server names to the pi runner (issue 04).
    const trustStore = await this.getTrustStore();

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
      seedHistory: options.seedHistory,
      systemPrompt: options.systemPrompt,
      contextWindow: modelContextWindow ?? contextWindow,
      customToolDefinitions,
      additionalExtensionPaths,
      approvalMode: options.approvalMode,
      thinkingLevel: options.thinkingLevel,
      trustedMcpServers: trustStore?.getTrustedMcpServers(options.cwd),
      trustedProjectDirs: trustStore?.getTrustedProjectDirs(options.cwd),
    };

    // Helper: create an AgentClient configured for the given runtime mode
    const createClientForRuntime = (rt: { mode: 'binary' | 'script'; runnerPath: string; bunPath?: string }): IAgentClient => {
      const factoryOptions: AgentClientFactoryOptions = {
        engine,
        mode: rt.mode,
        runnerPath: rt.runnerPath,
        bunPath: rt.bunPath,
        cwd: options.cwd,
        env,
      };
      const c = this.clientFactory(factoryOptions);
      c.setToolCallHandler(toolCallHandler);
      c.setApprovalHandler(async (requestId, toolName, args) => {
        const { promise, resolve } = Promise.withResolvers<boolean>();
        this.pendingApprovals.set(requestId, { resolve, sessionId });
        this.emit('approvalRequest', { sessionId, requestId, toolName, args });
        return promise;
      });
      // Trust handler（issue 04）：extension/MCP 信任确认经 renderer 询问用户，
      // 批准结果由 resolveTrust 持久化到 host 信任存储（yolo 不跳过此流程）。
      c.setTrustHandler(async (requestId, kind, name, path) => {
        const { promise, resolve } = Promise.withResolvers<boolean>();
        this.pendingTrusts.set(requestId, { resolve, sessionId, cwd: options.cwd, kind, name });
        this.emit('trustRequest', { sessionId, requestId, kind, name, path });
        return promise;
      });
      return c;
    };

    // Helper: attach event forwarding to a client
    const debugAllEvents = !!process.env.SOCVERIFY_DEBUG_EVENTS;
    const attachEventForwarding = (c: IAgentClient) => {
      c.onEvent((event) => {
        const evtType = (event as Record<string, unknown>)?.type as string | undefined;
        if (debugAllEvents || !SILENT_EVENT_TYPES.has(evtType ?? '')) {
          const summary = summarizeEvent(event);
          console.log(
            `[agent:session:${sessionId}] event type="${evtType}"${summary ? ` ${summary}` : ''}`,
          );
        }
        // Track active processing state to gate the idle timer.
        // agent_start → session is actively working: cancel idle timer.
        // agent_end   → session finished: schedule idle timer.
        // This ensures a long-running agent turn (tool calls + LLM thinking
        // that takes many minutes) is never destroyed by the idle timeout.
        if (evtType === 'agent_start') {
          this.setActive(sessionId, true);
        } else if (evtType === 'agent_end') {
          this.setActive(sessionId, false);
        } else if (evtType && !SILENT_EVENT_TYPES.has(evtType)) {
          // Secondary safety net: refresh idle timer on other activity events.
          // Normally the timer is cancelled by agent_start, but if agent_start
          // was missed (e.g. session restored mid-turn), this keeps the session alive.
          this.touchActivity(sessionId);
        }
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
          // Token Monitor bypass: extract usage and write to Token Monitor DB.
          // Does not block event forwarding; write failure only logs a warning.
          try {
            const tokenDb = tokenMonitorRegistry.getOrCreateDb(options.cwd);
            recordUsageFromEvent(tokenDb, event, {
              sessionId,
              engine: c.engine,
              projectId: options.projectId,
              cwd: options.cwd,
            });
          } catch (err) {
            console.warn(`[agent:session:${sessionId}] token monitor bypass failed:`, err);
          }
        }
        // Diagnostic: log subagent frames to trace data flow
        if (evtType === 'subagent_lifecycle' || evtType === 'subagent_progress') {
          // Subagent 父子 Token 归属：终态事件带 usage 时旁路写入 Token Monitor
          //（messageId=subagent:<runId>，引擎/会话/父子关联均保留）。
          if (evtType === 'subagent_lifecycle') {
            try {
              const tokenDb = tokenMonitorRegistry.getOrCreateDb(options.cwd);
              recordSubagentUsageFromEvent(tokenDb, event, {
                sessionId,
                engine: c.engine,
                projectId: options.projectId,
                cwd: options.cwd,
              });
            } catch (err) {
              console.warn(`[agent:session:${sessionId}] subagent token bypass failed:`, err);
            }
          }
          const payload = (event as Record<string, unknown>)?.payload as Record<string, unknown> | undefined;
          const subId = payload?.id ?? (payload?.progress as Record<string, unknown> | undefined)?.id ?? '??';
          console.log(`[agent:session:${sessionId}] SUBAGENT ${evtType} id=${subId} — forwarding to renderer`);
        }
        this.emit('sessionEvent', { sessionId, event } satisfies SessionEventData);
      });
    };

    let client = createClientForRuntime(runtime);
    attachEventForwarding(client);

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

    let engineSessionId: string | undefined;

    try {
      await client.start();
      console.log(`[agent:session:${sessionId}] agent process started successfully`);
      const initResult = await client.init(initConfig);
      engineSessionId = initResult.engineSessionId;
      console.log(`[agent:session:${sessionId}] engine (${client.engine}) sessionId=${engineSessionId}`);
    } catch (err) {
      client.stop();

      // If binary mode failed, try script mode (Bun + engine) as fallback.
      // This handles the case where the pre-compiled runner binary exists
      // but can't execute (e.g., missing shared libraries on Linux AppImage).
      if (runtime.mode === 'binary') {
        const scriptPath = resolveRunnerScript();
        const bunPath = resolveBunPath();
        if (scriptPath && bunPath) {
          const versionCheck = checkBunVersion(bunPath);
          if (versionCheck.ok) {
            console.warn(
              `[agent:session:${sessionId}] Binary runner failed (${err instanceof Error ? err.message : String(err)}). ` +
              `Falling back to script mode (Bun ${versionCheck.version} + engine).`,
            );
            client = createClientForRuntime({
              mode: 'script',
              runnerPath: scriptPath,
              bunPath,
            });
            attachEventForwarding(client);
            try {
              await client.start();
              console.log(`[agent:session:${sessionId}] agent process started successfully (script mode)`);
              const initResult = await client.init(initConfig);
              engineSessionId = initResult.engineSessionId;
              console.log(`[agent:session:${sessionId}] engine (${client.engine}) sessionId=${engineSessionId} (script mode)`);
            } catch (scriptErr) {
              client.stop();
              if (runtimeDir) {
                await rm(runtimeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
              }
              throw new Error(
                `Failed to initialize agent session. ` +
                `Binary mode error: ${err instanceof Error ? err.message : String(err)}. ` +
                `Script mode error: ${scriptErr instanceof Error ? scriptErr.message : String(scriptErr)}.`,
              );
            }
          } else {
            // Bun version too old
            if (runtimeDir) {
              await rm(runtimeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
            }
            throw new Error(
              `Failed to initialize agent session: ${err instanceof Error ? err.message : String(err)}. ` +
              `Script mode fallback unavailable: Bun >= ${versionCheck.required} required (found ${versionCheck.version}).`,
            );
          }
        } else {
          // No script mode available
          if (runtimeDir) {
            await rm(runtimeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
          }
          throw new Error(
            `Failed to initialize agent session: ${err instanceof Error ? err.message : String(err)}. ` +
            `Script mode fallback unavailable: ${!scriptPath ? 'engine submodule not found' : 'Bun not found'}. ` +
            `On Linux AppImage, the runner binary may have missing shared libraries. ` +
            `Try running 'ldd <runner-binary>' to diagnose, or install Bun and initialize the engine submodule.`,
          );
        }
      } else {
        // Script mode failed (no fallback)
        if (runtimeDir) {
          await rm(runtimeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        }
        throw new Error(`Failed to initialize agent session: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log(`[agent:session:${sessionId}] agent session initialized`);

    const hostUris = new HostUriRouter();
    if (options.coverageManager) hostUris.setCoverageManager(options.coverageManager);

    const entry: SessionEntry = {
      id: sessionId,
      persistedSessionId: options.persistedSessionId,
      engine: client.engine,
      engineSessionId,
      projectId: options.projectId,
      client,
      hostTools,
      hostUris,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      idleTimer: null,
      runtimeDir,
      model,
      providerId: options.providerId,
      credentialSnapshot: credentialSnapshot(options.providerId, options.apiKey, options.baseUrl, options.apiFormat),
      isActive: false,
    };

    this.sessions.set(sessionId, entry);

    if (!this.projectSessions.has(options.projectId)) {
      this.projectSessions.set(options.projectId, new Set());
    }
    this.projectSessions.get(options.projectId)!.add(sessionId);

    // 将已禁用的内置工具同步到新会话（host 工具已在 initConfig 中过滤）
    const disabledArray = Array.from(disabledToolSet);
    if (disabledArray.length > 0) {
      try {
        await client.setToolFilter(disabledArray);
      } catch (err) {
        console.warn(`[agent:session:${sessionId}] failed to apply tool filter on new session: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.scheduleIdleRetirement(sessionId);

    return sessionId;
  }

  getSession(sessionId: string): SessionEntry | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /** Get which engine backs a given SoC Verify session. */
  getEngine(sessionId: string): AgentEngine | undefined {
    return this.sessions.get(sessionId)?.engine;
  }

  /** Get the engine's session ID for a given SoC Verify session (engine-neutral). */
  getEngineSessionId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.engineSessionId;
  }

  /**
   * Get the omp engine's session ID for a given SoC Verify session.
   *
   * @deprecated Use `getEngineSessionId` — kept as a deprecated alias while
   * callers migrate to the engine-neutral naming.
   */
  getOmpSessionId(sessionId: string): string | undefined {
    return this.getEngineSessionId(sessionId);
  }

  /** Get the model ID that the runtime session was actually initialized with. */
  getModel(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.model;
  }

  getClient(sessionId: string): IAgentClient | null {
    return this.sessions.get(sessionId)?.client ?? null;
  }

  /** Default timeout for sendPromptAndWait (10 minutes, matching closure orchestrator). */
  private static readonly DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;

  /**
   * Deep Agent Turn interface — sends a prompt and waits for the agent to
   * finish processing, returning the final assistant text.
   *
   * This method encapsulates the complete agent turn lifecycle that was
   * previously leaked across four domains (TV AI Advisor, Coverage Closure,
   * Deep Reindexer, Error Analysis):
   *   - Fire-and-forget prompt dispatch (omp's prompt() is async-but-completes-on-agent_end)
   *   - Completion detection via `agent_end` event
   *   - Final assistant text extraction from `message_end` events
   *   - Error detection via `error` events
   *   - Configurable timeout with sensible default
   *   - Optional cancellation via AbortSignal
   *
   * Callers should NOT call `getClient()` + `client.prompt()` + listen to
   * `sessionEvent` themselves — everything goes through this seam.
   *
   * @param sessionId Target session ID
   * @param message   Prompt text to send
   * @param images    Optional image attachments (base64 data URLs)
   * @param opts.timeoutMs  Override the default 10-minute timeout
   * @param opts.signal     Optional AbortSignal for cancellation
   * @returns The final assistant response text (empty string if no text was produced)
   * @throws if the session doesn't exist, times out, is aborted, or the agent reports an error
   */
  async sendPromptAndWait(
    sessionId: string,
    message: string,
    images: string[] | undefined,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<string> {
    const client = this.sessions.get(sessionId)?.client;
    if (!client) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const timeoutMs = opts.timeoutMs ?? SessionManagerImpl.DEFAULT_TURN_TIMEOUT_MS;
    let lastAssistantText = '';
    let settled = false;

    return new Promise<string>((resolve, reject) => {
      const cleanup = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        opts.signal?.removeEventListener('abort', onAbort);
        this.removeListener('sessionEvent', onSessionEvent);
      };

      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`Agent timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      timeoutId.unref();

      const onAbort = (): void => {
        cleanup();
        reject(new Error('Aborted'));
      };
      if (opts.signal) {
        if (opts.signal.aborted) {
          cleanup();
          reject(new Error('Aborted'));
          return;
        }
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      const onSessionEvent = (data: SessionEventData): void => {
        if (data.sessionId !== sessionId) return;
        const evt = data.event as Record<string, unknown> | null;
        if (!evt || typeof evt.type !== 'string') return;

        if (evt.type === 'message_end') {
          const text = extractAssistantTextFromEvent(evt.message);
          if (text !== null) lastAssistantText = text;
        } else if (evt.type === 'agent_end') {
          cleanup();
          resolve(lastAssistantText);
        } else if (evt.type === 'error') {
          cleanup();
          const errMsg = typeof evt.message === 'string'
            ? evt.message
            : typeof evt.error === 'string'
              ? evt.error
              : 'Agent reported an error';
          reject(new Error(errMsg));
        }
      };

      this.on('sessionEvent', onSessionEvent);

      // Fire-and-forget: prompt() resolves immediately; the actual response
      // arrives via event frames.
      void client.prompt(message, images).catch((err) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  /**
   * Fire-and-forget prompt — sends a prompt without waiting for completion.
   *
   * Use this when the caller streams events to the UI (e.g. RightPanel) and
   * doesn't need the final text. The agent's response arrives via the
   * `sessionEvent` EventEmitter stream.
   *
   * This replaces the pattern of `getClient(sessionId)?.prompt(message)`
   * that was duplicated across Deep Reindexer and Error Analysis.
   *
   * @throws if the session doesn't exist
   */
  async promptFireAndForget(
    sessionId: string,
    message: string,
    images?: string[],
  ): Promise<void> {
    const client = this.sessions.get(sessionId)?.client;
    if (!client) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    await client.prompt(message, images);
    this.touchActivity(sessionId);
  }

  /**
   * Abort the current agent turn for a session.
   *
   * Sends an `abort` command to the runner and hard-kills the process tree.
   * The session can be reused after a new prompt() call.
   *
   * This replaces the pattern of `getClient(sessionId)?.abort()` that was
   * scattered across multiple callers.
   */
  async abortSession(sessionId: string): Promise<void> {
    const client = this.sessions.get(sessionId)?.client;
    if (!client) return;
    await client.abort();
  }

  /**
   * Regenerate the last assistant response for a session.
   *
   * Engine-side this branches the session tree back to the latest user
   * message and re-prompts — the branch FORKS the engine session file, so
   * the entry's engineSessionId is updated in place (the caller persists it
   * with the project root it already has).  The regenerated turn streams
   * back through the normal sessionEvent channel.
   */
  async regenerateSession(sessionId: string): Promise<{ engineSessionId: string }> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (!entry.client.isRunning()) {
      throw new Error(`Client not started: ${sessionId}`);
    }
    const result = await entry.client.regenerate();
    if (result.engineSessionId && result.engineSessionId !== entry.engineSessionId) {
      entry.engineSessionId = result.engineSessionId;
      console.log(`[agent:session:${sessionId}] engine sessionId=${result.engineSessionId} (branched by regenerate)`);
    }
    return result;
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

  async setApprovalMode(sessionId: string, approvalMode: ApprovalMode): Promise<void> {
    const client = this.requireClient(sessionId);
    await client.setApprovalMode(approvalMode);
    this.touchActivity(sessionId);
  }

  /** 动态设置运行中会话的思考强度（'default' = 交还引擎默认）。 */
  async setThinkingLevel(sessionId: string, level: ThinkingLevelSetting): Promise<void> {
    const client = this.requireClient(sessionId);
    await client.setThinkingLevel(level);
    this.touchActivity(sessionId);
  }

  /**
   * 将工具开关设置推送到所有活跃会话（设置页切换开关时调用）。
   * 新会话在 createSession 时通过 InitConfig.disabledTools 获取同样设置。
   */
  async applyToolFilterToActiveSessions(disabledTools: string[]): Promise<void> {
    for (const { client } of this.sessions.values()) {
      try {
        await client.setToolFilter(disabledTools);
      } catch (err) {
        console.warn(`[agent:session-manager] failed to apply tool filter: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * 枚举某个会话当前可用的工具（名称 + 描述，含被禁用工具）。
   * 会话不存在时返回 undefined。
   */
  async listAgentTools(sessionId: string): Promise<Array<{ name: string; description: string }> | undefined> {
    const client = this.sessions.get(sessionId)?.client;
    if (!client) return undefined;
    try {
      return await client.listAgentTools();
    } catch {
      return undefined;
    }
  }

  async getAvailableModels(_sessionId: string): Promise<unknown[]> {
    // The SDK discovers models via the ModelRegistry.
    // Model selection is handled via the settings.fetchModels API
    // which queries the OpenAI-compatible endpoint directly.
    return [];
  }

  /**
   * Query the omp engine's MCPManager for all known MCP servers and their
   * runtime connection status. Returns a map of server name → { status, toolCount },
   * or undefined if the session doesn't exist.
   */
  async getMcpStatus(sessionId: string): Promise<Record<string, { status: string; toolCount: number }> | undefined> {
    const client = this.sessions.get(sessionId)?.client;
    if (!client) return undefined;
    try {
      return await client.getMcpStatus();
    } catch {
      return undefined;
    }
  }

  /**
   * Query the tools exposed by a specific MCP server in the given session.
   * Returns undefined if the session doesn't exist; an empty array if the
   * server is not connected or has no tools.
   */
  async getMcpServerTools(
    sessionId: string,
    serverName: string,
  ): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }> | undefined> {
    const client = this.sessions.get(sessionId)?.client;
    if (!client) return undefined;
    try {
      return await client.getMcpServerTools(serverName);
    } catch {
      return undefined;
    }
  }

  /**
   * Reload MCP configuration in the running session so newly saved
   * `.mcp.json` changes are picked up without restarting the session.
   * Returns the post-reload status map, or undefined if the session doesn't exist.
   */
  async reloadMcp(sessionId: string): Promise<Record<string, { status: string; toolCount: number }> | undefined> {
    const client = this.sessions.get(sessionId)?.client;
    if (!client) return undefined;
    try {
      return await client.reloadMcp();
    } catch {
      return undefined;
    }
  }

  private requireClient(sessionId: string): IAgentClient {
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
      // Ensure the process is dead even if destroy() threw before
      // reaching stop(). The stop() call is idempotent.
      entry.client.stop();
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

/**
   * Mark a session as actively processing or idle.
   *
   * When `active` is true, the idle retirement timer is cancelled — the
   * session is between agent_start and agent_end and must not be destroyed
   * regardless of how long the LLM takes. When `active` is false, the timer
   * is scheduled fresh from this moment.
   */
  private setActive(sessionId: string, active: boolean): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.isActive = active;
    entry.lastActivityAt = Date.now();
    if (active) {
      // Cancel any pending idle timer — the session is working.
      if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
      }
    } else {
      // Session finished — start the idle countdown.
      this.scheduleIdleRetirement(sessionId);
    }
  }

  touchActivity(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.lastActivityAt = Date.now();
    // Don't reschedule the timer if the session is actively processing.
    if (!entry.isActive) {
      this.scheduleIdleRetirement(sessionId);
    }
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

    // Never schedule idle retirement for an actively processing session.
    if (entry.isActive) return;

    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
    }

    entry.idleTimer = setTimeout(() => {
      void this.destroySession(sessionId).catch(() => {});
    }, this.idleTimeoutMs);
    entry.idleTimer.unref();
  }

  /**
   * Intercept `ask` tool calls: emit an `askRequest` event to the renderer
   * and block until the user submits answers via `resolveAsk`.
   * Returns an AgentToolResult with the formatted answers as text content.
   */
  private async handleAskToolCall(sessionId: string, args: unknown): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
    const rawQuestions = (args as Record<string, unknown>)?.questions;
    if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
      return { content: [{ type: 'text', text: 'Error: questions must not be empty' }] };
    }

    // Normalize questions — guard against malformed model output
    const questions: AskQuestion[] = rawQuestions.map((q: unknown) => {
      const qo = q as Record<string, unknown>;
      const rawOpts = Array.isArray(qo.options) ? qo.options : [];
      return {
        id: typeof qo.id === 'string' ? qo.id : `q_${Math.random().toString(36).slice(2, 8)}`,
        question: typeof qo.question === 'string' ? qo.question : '',
        options: rawOpts.map((o: unknown) => {
          const oo = o as Record<string, unknown>;
          if (typeof oo === 'string') return { label: oo };
          return {
            label: typeof oo.label === 'string' ? oo.label : String(oo.label ?? ''),
            ...(typeof oo.description === 'string' && oo.description.trim() ? { description: oo.description.trim() } : {}),
          };
        }),
        ...(qo.multi === true ? { multi: true } : {}),
        ...(typeof qo.recommended === 'number' ? { recommended: qo.recommended } : {}),
      };
    });

    const requestId = `ask_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const { promise, resolve } = Promise.withResolvers<AskAnswer[]>();
    this.pendingAsks.set(requestId, { resolve, sessionId });
    this.emit('askRequest', { sessionId, requestId, questions });

    try {
      const answers = await promise;
      // Format the response text for the AI
      const lines = questions.map((q) => {
        const ans = answers.find((a) => a.questionId === q.id);
        if (!ans) return `${q.id}: (no answer)`;
        if (ans.customInput !== undefined && ans.customInput !== '') {
          return `${q.id}: "${ans.customInput}"`;
        }
        if (ans.selectedOptions.length > 0) {
          return q.multi
            ? `${q.id}: [${ans.selectedOptions.join(', ')}]`
            : `${q.id}: ${ans.selectedOptions[0]}`;
        }
        return `${q.id}: (no answer)`;
      });
      const responseText = questions.length === 1
        ? formatSingleAnswer(questions[0], answers)
        : `User answers:\n${lines.join('\n')}`;
      return { content: [{ type: 'text', text: responseText }] };
    } finally {
      this.pendingAsks.delete(requestId);
    }
  }

  /** Resolve a pending ask request from the user. */
  resolveAsk(requestId: string, answers: AskAnswer[]): boolean {
    const pending = this.pendingAsks.get(requestId);
    if (!pending) return false;
    this.pendingAsks.delete(requestId);
    pending.resolve(answers);
    return true;
  }

  /** Resolve a pending approval request from the user. */
  resolveApproval(requestId: string, approved: boolean): boolean {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return false;
    this.pendingApprovals.delete(requestId);
    pending.resolve(approved);
    return true;
  }

  /**
   * Resolve a pending trust request from the user（issue 04）。
   * 批准时把决策持久化到 host 信任存储（best-effort），使后续会话的
   * init 直接携带该信任（不再询问）。拒绝则不记录 —— 下次仍会询问。
   */
  resolveTrust(requestId: string, approved: boolean): boolean {
    const pending = this.pendingTrusts.get(requestId);
    if (!pending) return false;
    this.pendingTrusts.delete(requestId);
    pending.resolve(approved);
    if (approved) {
      void this.persistTrustDecision(pending.cwd, pending.kind, pending.name);
    }
    return true;
  }

  /** 惰性创建信任存储（app.getPath 在应用 ready 后才可用；测试环境降级为 null）。 */
  private async getTrustStore(): Promise<TrustStore | null> {
    if (this.trustStore !== undefined) return this.trustStore;
    try {
      const { app } = await import('electron');
      const trustStore = new TrustStore(join(app.getPath('userData'), 'socverify-data'));
      await trustStore.load();
      this.trustStore = trustStore;
    } catch (err) {
      console.warn(`[agent:session-manager] trust store unavailable (${err instanceof Error ? err.message : String(err)}) — trust decisions will not persist`);
      this.trustStore = null;
    }
    return this.trustStore;
  }

  private async persistTrustDecision(cwd: string, kind: TrustKind, name: string): Promise<void> {
    try {
      const trustStore = await this.getTrustStore();
      if (!trustStore) return;
      if (kind === 'project-extension') {
        await trustStore.addTrustedProjectDir(cwd, name);
      } else {
        await trustStore.addTrustedMcpServer(cwd, name);
      }
      console.log(`[agent:session-manager] persisted trust decision: ${kind} "${name}" for ${cwd}`);
    } catch (err) {
      console.warn(`[agent:session-manager] failed to persist trust decision: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export const sessionManager = new SessionManagerImpl();
