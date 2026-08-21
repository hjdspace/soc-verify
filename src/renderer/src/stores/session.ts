import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from './toast';
import { useUiStore } from './ui';
import { useSettingsStore } from './settings';
import { tRPCError } from '@renderer/lib/trpc-utils';
import { DEFAULT_CONTEXT_WINDOW, type ContextBreakdown, type ContextUsage } from '@shared/context-management';
import type { AskAnswer, AskQuestion } from '@shared/ask-types';

export type SessionStatus = 'creating' | 'idle' | 'streaming' | 'tool_executing' | 'error';

export type ApprovalMode = 'always-ask' | 'write' | 'yolo';

export interface ApprovalRequest {
  requestId: string;
  sessionId: string;
  toolName: string;
  args: unknown;
  timestamp: number;
}

export interface AskRequest {
  requestId: string;
  sessionId: string;
  questions: AskQuestion[];
  timestamp: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  timestamp: number;
  toolName?: string;
  toolCallId?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  /** Snapshot captured before a file-writing tool starts. */
  toolFileExistedBefore?: boolean;
  toolBeforeContent?: string;
  toolStartTime?: number;
  toolEndTime?: number;
  images?: string[];
  isStreaming?: boolean;
  /** LLM thinking/reasoning content, separated from the main response text. */
  thinking?: string;
  /** Skills attached to a user message — used to render skill chips in the message bubble. */
  skills?: SelectedSkill[];
}

/**
 * task 工具派遣的 subagent 实时状态（瞬态，不持久化）。
 * 由 omp 引擎经 runner → 主进程 → session:event 转发的
 * subagent_lifecycle / subagent_progress 帧驱动更新。
 */
export interface SubagentActivity {
  /** subagent registry id */
  id: string;
  index: number;
  /** 角色（agent 定义名，如 coverage-analyzer） */
  agent: string;
  description?: string;
  /** 完整工作指令（progress 帧携带） */
  assignment?: string;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  /** 关联的 task 工具调用 id — 用于挂载到对应 tool card */
  parentToolCallId?: string;
  currentTool?: string;
  currentToolArgs?: string;
  lastIntent?: string;
  /**
   * 累积输出日志（正序，[length-1] 为最新）。
   * omp 的 progress 帧只携带"当前轮 assistant 流式输出的尾部 8 行"预览窗口
   * （倒序，且每轮 message_start 会被引擎清空），这里经滚动窗口合并成
   * 完整运行日志，避免新一轮开始时旧内容被冲掉。
   */
  recentOutput: string[];
  toolCount: number;
  tokens: number;
  requests: number;
  /** token 增量历史（sparkline 用，保留尾部若干个） */
  tokenHistory: number[];
  startedAt: number;
  endedAt?: number;
}

export interface AvailableModel {
  provider: string;
  id: string;
  name: string;
  description?: string;
}

export interface SessionModel {
  provider: string;
  id: string;
  name: string;
  /** The credential ID used to look up apiKey/baseUrl for this model.
   *  When set, switching to this model also switches the full provider config. */
  providerId?: string;
}

const MODEL_STORAGE_KEY = 'socverify:lastModel';
const APPROVAL_MODE_STORAGE_KEY = 'socverify:approvalMode';

export interface SelectedSkill {
  name: string;
  description: string;
  filePath: string;
  source: 'project' | 'user' | 'builtin';
}

export interface ContextFile {
  name: string;
  path: string;
  type: 'file' | 'directory';
}

export type SessionComposer = {
  inputMessage: string;
  selectedSkills: SelectedSkill[];
  contextFiles: ContextFile[];
};

export interface SessionEntry {
  id: string;
  /** Live backend agent session ID. Empty until the agent process is started. */
  runtimeSessionId?: string;
  /** The original persisted sessionId — used to match against history entries */
  persistedSessionId?: string;
  projectId: string;
  /** Project root used when a lazy UI session needs to start/restore its agent. */
  cwd?: string;
  name: string;
  status: SessionStatus;
  messages: ChatMessage[];
  composer: SessionComposer;
  createdAt: number;
  model?: SessionModel;
  contextUsage?: ContextUsage;
  contextBreakdown?: ContextBreakdown;
  isCompacting?: boolean;
  contextCompacted?: boolean;
  autoCompactionEnabled?: boolean;
  /** TV AI session: the violation ID this session is analyzing. */
  tvViolationId?: number;
  /** 工具审批模式 */
  approvalMode?: ApprovalMode;
  /** task 工具派遣的 subagent 实时状态（key = subagent id，瞬态不持久化） */
  subagents?: Record<string, SubagentActivity>;
}

/** subagent 累积日志上限：引擎完整输出可达数千行，UI 只保留尾部即可 */
const SUBAGENT_LOG_MAX_LINES = 500;

/**
 * 将 omp progress 帧的滚动输出窗口合并进累积日志。
 *
 * 引擎侧 recentOutput 是"当前轮流式输出的尾部 8 行"倒序窗口：
 * - 每轮 message_start 会清空（新一轮开始）；
 * - 同一轮内窗口向后滑动，新窗口头部与旧窗口尾部重叠。
 * 合并策略：正序化窗口后，与累积日志尾部按最长重叠去重，只追加新行；
 * 无重叠（新一轮输出）视为全部新行追加；空窗口（轮次切换瞬间）保留原日志。
 */
export function mergeSubagentOutputWindow(accumulated: string[], windowReversed: string[]): string[] {
  if (windowReversed.length === 0) return accumulated;
  const windowFwd = [...windowReversed].reverse();
  if (accumulated.length === 0) return windowFwd;
  const maxOverlap = Math.min(accumulated.length, windowFwd.length);
  for (let k = maxOverlap; k >= 1; k--) {
    let match = true;
    for (let i = 0; i < k; i++) {
      if (accumulated[accumulated.length - k + i] !== windowFwd[i]) {
        match = false;
        break;
      }
    }
    if (match) {
      const added = windowFwd.slice(k);
      return added.length > 0 ? [...accumulated, ...added] : accumulated;
    }
  }
  return [...accumulated, ...windowFwd];
}

export interface HistorySession {
  sessionId: string;
  ompSessionId?: string;
  name: string;
  projectId: string;
  createdAt: number;
  lastActivityAt: number;
  model?: { provider: string; id: string; name: string };
  isActive: boolean;
  contextUsage?: ContextUsage;
  contextBreakdown?: ContextBreakdown;
}

interface SessionStoreState {
  sessions: SessionEntry[];
  currentSessionId: string | null;
  historySessions: HistorySession[];
  historyLoading: boolean;
  /** Last user-selected model, persisted to localStorage so new sessions reuse it. */
  lastModel: SessionModel | null;
  /** Pending approval requests awaiting user decision */
  approvalRequests: ApprovalRequest[];
  /** Pending ask requests awaiting user answers */
  askRequests: AskRequest[];

  initLastModel: () => void;
  registerEventListeners: () => void;
  addErrorAnalysisSession: (event: {
    sessionId: string;
    projectId: string;
    caseName?: string;
    errorType?: string;
    initialMessage?: string;
  }) => void;

  createSession: (projectId: string, cwd: string) => Promise<string | null>;
  destroySession: (sessionId: string, projectId?: string) => Promise<void>;
  closeSession: (sessionId: string) => void;
  switchSession: (sessionId: string) => void;
  sendMessage: (message: string, images?: string[]) => Promise<void>;
  abortSession: () => Promise<void>;
  compactSession: () => Promise<boolean>;
  renameSession: (sessionId: string, projectId: string, name: string) => Promise<void>;
  setInputMessage: (msg: string) => void;
  handleSessionEvent: (sessionId: string, event: unknown) => void;
  restoreSessions: (projectId: string, cwd: string, lastSessionIds?: string[]) => Promise<boolean>;
  setModel: (sessionId: string, provider: string, modelId: string, modelName?: string, providerId?: string) => Promise<void>;
  /** Holistically switch the entire model config (provider + apiKey + baseUrl + model)
   *  to the given credential. The backend destroys + recreates the runtime session
   *  with the new credential's config, auto-picking the first model if needed. */
  applyCredential: (sessionId: string, providerId: string) => Promise<void>;
  steerSession: (message: string) => Promise<void>;
  addSkill: (skill: SelectedSkill) => void;
  removeSkill: (name: string) => void;
  addContextFile: (file: ContextFile) => void;
  removeContextFile: (path: string) => void;
  fetchHistorySessions: (projectId: string) => Promise<void>;
  loadHistorySession: (historySession: HistorySession, projectId: string, cwd: string) => Promise<void>;
  deleteHistorySession: (sessionId: string, projectId: string) => Promise<void>;
  setApprovalMode: (mode: ApprovalMode) => void;
  resolveApproval: (requestId: string, approved: boolean) => Promise<void>;
  resolveAsk: (requestId: string, answers: AskAnswer[]) => Promise<void>;
}

let eventListenerRegistered = false;
let errorAnalysisListenerRegistered = false;
const historySessionLoads = new Map<string, Promise<void>>();
const runtimeSessionStarts = new Map<string, Promise<string>>();
const pendingSessionEvents = new Map<string, unknown[]>();

function emptyContextUsage(): ContextUsage {
  const configured = useSettingsStore.getState().contextWindow;
  const contextWindow = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_CONTEXT_WINDOW;
  return { tokens: 0, contextWindow, percent: 0 };
}

function readContextUsage(value: unknown, fallback: ContextUsage): ContextUsage {
  if (typeof value !== 'object' || value === null) return fallback;
  const usage = value as Record<string, unknown>;
  if (typeof usage.tokens !== 'number' || typeof usage.contextWindow !== 'number') return fallback;
  const percent = typeof usage.percent === 'number'
    ? usage.percent
    : usage.contextWindow > 0 ? (usage.tokens / usage.contextWindow) * 100 : 0;
  return { tokens: usage.tokens, contextWindow: usage.contextWindow, percent };
}

function readContextBreakdown(value: unknown, fallback?: ContextBreakdown): ContextBreakdown | undefined {
  if (typeof value !== 'object' || value === null) return fallback;
  const breakdown = value as Record<string, unknown>;
  const keys: Array<keyof ContextBreakdown> = [
    'systemPromptTokens',
    'systemToolsTokens',
    'systemContextTokens',
    'skillsTokens',
    'messagesTokens',
  ];
  if (!keys.every((key) => typeof breakdown[key] === 'number')) return fallback;
  return Object.fromEntries(keys.map((key) => [key, breakdown[key]])) as ContextBreakdown;
}

// ─── 流式 message_update 节流 ────────────────────────────
//
// 问题：LLM 流式输出期间 message_update 事件可能每数十毫秒就触发一次，
// 每次都会通过 Zustand set() 触发 React 重渲染。当窗口被最小化到后台时，
// 浏览器会把 RAF/setTimeout 严重降频，导致状态更新被批量缓存；窗口恢复时
// 所有累积的重渲染一次性 flush，表现为「卡一下然后突然刷出全部输出」。
//
// 解决：把 message_update 事件本身节流——只保留最新一份 snapshot，
// 用 setTimeout 调度应用。可见时 50ms 节流（人眼几乎无感），后台时
// 500ms 节流（大幅减少累积更新）。其它事件（message_start/end、tool_*、
// agent_end）依然立即应用。当窗口重新可见时立即 flush 挂起的更新。
let pendingMessageUpdate: { sessionId: string; message: unknown } | null = null;
let messageUpdateTimer: ReturnType<typeof setTimeout> | null = null;
let lastMessageUpdateFlush = 0;
let visibilityListenerRegistered = false;
// 持有最新的 flush 函数引用，供模块级 visibilitychange 监听器调用
let flushPendingMessageUpdateRef: (() => void) | null = null;

const MESSAGE_UPDATE_THROTTLE_VISIBLE_MS = 50;
const MESSAGE_UPDATE_THROTTLE_HIDDEN_MS = 500;

// ─── 持久化节流 ──────────────────────────────────────────
// 原 handleSessionEvent 在每个事件后都调用 persistSessionMessages（一次
// tRPC mutate），流式期间频率过高。改为 1s 节流，agent_end 等关键事件
// 仍会立即触发一次（通过 flushPersist 强制刷新）。
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let lastPersistAt = 0;
let flushPersistRef: (() => void) | null = null;
const PERSIST_THROTTLE_MS = 1000;

let cwdChangedListenerRegistered = false;

function registerCwdChangedListener(get: () => SessionStoreState): void {
  if (cwdChangedListenerRegistered || !window.eventBridge?.onCwdChanged) return;
  cwdChangedListenerRegistered = true;
  window.eventBridge.onCwdChanged((data: { projectId: string; cwd: string; dirId: string }) => {
    const state = get();
    // Only rebuild sessions for the currently active project
    if (state.currentSessionId) {
      const session = state.sessions.find((s) => sessionMatchesId(s, state.currentSessionId!));
      if (!session || session.projectId !== data.projectId) return;

      // Only rebuild the active (main) session — background sessions
      // (error-analysis, coverage-closure) are not in the sessions array
      // and should not be affected by cwd changes.
      const runtimeSessionId = session.runtimeSessionId;
      if (!runtimeSessionId) {
        // No runtime session yet — just update cwd so the next create uses it
        setSessionCwd(session.id, data.cwd);
        return;
      }

      // Destroy the runtime session and clear the cached runtimeSessionId.
      // The next message send will trigger ensureRuntimeSession to recreate
      // the session with the new cwd (and updated multi-dir system prompt).
      void trpc.session.destroy.mutate({ sessionId: runtimeSessionId }).catch(() => {
        // Best-effort: if destroy fails, still clear the cached ID so
        // the stale session isn't reused.
      }).finally(() => {
        setSessionCwdAndClearRuntime(session.id, data.cwd, get);
      });
    }
  });
}

function setSessionCwd(sessionId: string, cwd: string): void {
  useSessionStore.setState((s) => ({
    sessions: s.sessions.map((sess) =>
      sess.id === sessionId ? { ...sess, cwd } : sess,
    ),
  }));
}

function setSessionCwdAndClearRuntime(sessionId: string, cwd: string, _get: () => SessionStoreState): void {
  useSessionStore.setState((s) => ({
    sessions: s.sessions.map((sess) =>
      sess.id === sessionId
        ? { ...sess, cwd, runtimeSessionId: undefined }
        : sess,
    ),
  }));
}

function registerSessionEventListener(get: () => SessionStoreState): void {
  if (eventListenerRegistered || !window.eventBridge) return;
  eventListenerRegistered = true;
  window.eventBridge.onSessionEvent(({ sessionId, event }) => {
    get().handleSessionEvent(sessionId, event);
  });
}

function registerErrorAnalysisEventListener(get: () => SessionStoreState): void {
  if (errorAnalysisListenerRegistered || !window.eventBridge?.onErrorAnalysisEvent) return;
  errorAnalysisListenerRegistered = true;
  window.eventBridge.onErrorAnalysisEvent((event: { type: string; [key: string]: unknown }) => {
    if (event.type === 'started' && typeof event.sessionId === 'string' && typeof event.projectId === 'string') {
      get().addErrorAnalysisSession({
        sessionId: event.sessionId,
        projectId: event.projectId,
        caseName: typeof event.caseName === 'string' ? event.caseName : undefined,
        errorType: typeof event.errorType === 'string' ? event.errorType : undefined,
        initialMessage: typeof event.initialMessage === 'string' ? event.initialMessage : undefined,
      });
      useToastStore.getState().info(
        `AI 分析已启动: ${String(event.caseName ?? '')} (${String(event.errorType ?? '')})`,
      );
    } else if (event.type === 'retrying') {
      useToastStore.getState().info(
        `AI 正在重新仿真: ${String(event.caseName ?? '')} (重试 ${String(event.retryCount ?? 0)}/${String(event.maxRetries ?? 3)})`,
      );
    } else if (event.type === 'stopped') {
      useToastStore.getState().info(
        `AI 分析已停止: ${String(event.caseName ?? '')} (达到最大重试次数)`,
      );
    } else if (event.type === 'failed') {
      const error = String(event.error ?? '');
      const hint = error.includes('No models available') || error.includes('OpenAI') || error.includes('endpoint')
        ? '请在设置中检查 API 凭据配置（Provider、API Key、Base URL），确保端点可用且有可用模型。'
        : error;
      useToastStore.getState().error(
        `AI 分析失败: ${String(event.caseName ?? '')}`,
        hint,
      );
    }
  });
}

let approvalRequestListenerRegistered = false;
let askRequestListenerRegistered = false;

function registerApprovalRequestListener(_get: () => SessionStoreState): void {
  if (approvalRequestListenerRegistered || !window.eventBridge?.onApprovalRequest) return;
  approvalRequestListenerRegistered = true;
  window.eventBridge.onApprovalRequest((data: { sessionId: string; requestId: string; toolName: string; args: unknown }) => {
    const request: ApprovalRequest = {
      requestId: data.requestId,
      sessionId: data.sessionId,
      toolName: data.toolName,
      args: data.args,
      timestamp: Date.now(),
    };
    useSessionStore.setState((s) => ({ approvalRequests: [...s.approvalRequests, request] }));

    // Auto-expand the right panel if collapsed so the user sees the request
    if (useUiStore.getState().rightPanelCollapsed) {
      useUiStore.getState().toggleRightPanel();
    }
  });
}

function registerAskRequestListener(_get: () => SessionStoreState): void {
  if (askRequestListenerRegistered || !window.eventBridge?.onAskRequest) return;
  askRequestListenerRegistered = true;
  window.eventBridge.onAskRequest((data: { sessionId: string; requestId: string; questions: unknown[] }) => {
    const questions = (data.questions as AskQuestion[]).map((q) => ({
      id: typeof q.id === 'string' ? q.id : `q_${Math.random().toString(36).slice(2, 8)}`,
      question: typeof q.question === 'string' ? q.question : '',
      options: Array.isArray(q.options) ? q.options.map((o) => {
        if (typeof o === 'string') return { label: o };
        return {
          label: typeof o.label === 'string' ? o.label : String(o.label ?? ''),
          ...(typeof o.description === 'string' && o.description.trim() ? { description: o.description.trim() } : {}),
        };
      }) : [],
      ...(q.multi === true ? { multi: true } : {}),
      ...(typeof q.recommended === 'number' ? { recommended: q.recommended } : {}),
    }));
    const request: AskRequest = {
      requestId: data.requestId,
      sessionId: data.sessionId,
      questions,
      timestamp: Date.now(),
    };
    useSessionStore.setState((s) => ({ askRequests: [...s.askRequests, request] }));

    // Auto-expand the right panel if collapsed so the user sees the question
    if (useUiStore.getState().rightPanelCollapsed) {
      useUiStore.getState().toggleRightPanel();
    }
  });
}

function sessionMatchesId(session: SessionEntry, sessionId: string): boolean {
  return (
    session.id === sessionId ||
    session.runtimeSessionId === sessionId ||
    session.persistedSessionId === sessionId
  );
}

function emptyComposer(): SessionComposer {
  return { inputMessage: '', selectedSkills: [], contextFiles: [] };
}

function sessionComposer(session: SessionEntry | undefined): SessionComposer {
  return session?.composer ?? emptyComposer();
}

/**
 * Extract text and thinking content separately from an agent message object.
 *
 * agent message events (message_start, message_update, message_end) carry a
 * `message` field which is an AssistantMessage with a `content` array of
 * content blocks. TextContent blocks have `{ type: "text", text: "..." }`.
 * ThinkingContent blocks have `{ type: "thinking", thinking: "..." }`.
 *
 * Returns text and thinking as separate strings so the UI can render them
 * in distinct sections (collapsible thinking block + main response).
 */
type ExtractedContent = { text: string; thinking: string };

function extractTextFromMessage(message: unknown): ExtractedContent {
  if (typeof message !== 'object' || message === null) return { text: '', thinking: '' };
  const msg = message as Record<string, unknown>;
  const content = msg.content;
  if (!Array.isArray(content)) return { text: '', thinking: '' };

  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') {
      textParts.push(b.text);
    } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
      thinkingParts.push(b.thinking);
    }
  }
  return { text: textParts.join('\n'), thinking: thinkingParts.join('\n') };
}

/**
 * Extract tool-call blocks from an agent message's content array.
 *
 * When the LLM decides to call a tool, the assistant message's `content`
 * array includes `ToolCallContent` blocks (`{ type: "toolCall", id, name, arguments }`).
 * These appear during `message_update` (streaming) and are finalized in
 * `message_end` — BEFORE the omp engine actually executes the tool and emits
 * `tool_execution_start`.
 *
 * By extracting these blocks here, we can show tool cards with a loading
 * state immediately while the LLM is still generating arguments or waiting
 * for the engine to start execution, rather than waiting for
 * `tool_execution_start` which only fires after the entire assistant
 * message is complete.
 */
interface PendingToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

function extractToolCallsFromMessage(message: unknown): PendingToolCall[] {
  if (typeof message !== 'object' || message === null) return [];
  const msg = message as Record<string, unknown>;
  const content = msg.content;
  if (!Array.isArray(content)) return [];

  const calls: PendingToolCall[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type !== 'toolCall') continue;
    if (typeof b.id !== 'string' || typeof b.name !== 'string') continue;
    const args = typeof b.arguments === 'object' && b.arguments !== null
      ? b.arguments as Record<string, unknown>
      : {};
    calls.push({ id: b.id, name: b.name, args });
  }
  return calls;
}

function upsertPendingToolMessages(
  messages: ChatMessage[],
  toolCalls: PendingToolCall[],
): ChatMessage[] {
  let updated = messages;
  for (const toolCall of toolCalls) {
    const existingIdx = updated.findIndex(
      (message) => message.role === 'tool' && message.toolCallId === toolCall.id,
    );
    if (existingIdx >= 0) {
      updated = updated.map((message, index) =>
        index === existingIdx && !message.toolResult
          ? { ...message, toolName: toolCall.name, toolArgs: toolCall.args }
          : message,
      );
      continue;
    }
    updated = [...updated, {
      id: `tool_${toolCall.id}`,
      role: 'tool',
      content: '',
      timestamp: Date.now(),
      toolName: toolCall.name,
      toolCallId: toolCall.id,
      toolArgs: toolCall.args,
      toolStartTime: Date.now(),
    }];
  }
  return updated;
}

/**
 * Check if a message object represents an error response.
 * Returns the error message if found, null otherwise.
 * Provides user-friendly messages for common API errors.
 */
function extractErrorFromMessage(message: Record<string, unknown>): string | null {
  if (typeof message.errorMessage === 'string' && message.errorMessage) {
    const errMsg = message.errorMessage;
    // Parse common API errors and provide actionable guidance
    if (errMsg.includes('403') || /forbidden/i.test(errMsg)) {
      return `API 返回 403 Forbidden：${errMsg}\n\n可能原因：\n1. API Key 无权限访问该模型\n2. 当前模型不支持工具调用（Agent 功能需要支持 function calling 的模型，如 GPT-4o、Claude 3.5 Sonnet）\n3. API 端点（Base URL）不支持工具调用请求\n4. API 代理/网关限制了请求类型\n\n请检查设置中的凭据和模型配置。`;
    }
    if (errMsg.includes('401') || /unauthorized/i.test(errMsg)) {
      return `API 认证失败（401）：请检查 API Key 是否正确\n\n错误详情：${errMsg}`;
    }
    if (errMsg.includes('429') || /rate.limit/i.test(errMsg)) {
      return `API 请求频率超限（429）：请稍后重试\n\n错误详情：${errMsg}`;
    }
    if (/model.not.found|does.not.exist/i.test(errMsg)) {
      return `模型不存在：请检查模型 ID 是否正确\n\n错误详情：${errMsg}`;
    }
    return errMsg;
  }
  if (message.stopReason === 'error') {
    return 'LLM 返回错误（请检查 API Key、Base URL 和模型配置）';
  }
  return null;
}

/**
 * Generate a meaningful session name from the user's first message.
 * Takes the first non-empty line, truncated to 40 characters.
 * Used as an immediate placeholder before the AI-generated title arrives.
 */
function generateSessionName(message: string): string {
  const firstLine = message.trim().split('\n')[0].trim();
  if (!firstLine) return '新会话';
  if (firstLine.length <= 40) return firstLine;
  return firstLine.slice(0, 40) + '...';
}

/**
 * Check if a session name is an auto-generated placeholder
 * (e.g. "新会话" or "Session <random>").
 * Used to decide whether to overwrite the name with a backend-returned value.
 */
function isPlaceholderName(name: string): boolean {
  return name === '新会话' || /^Session [A-Za-z0-9_-]+$/.test(name);
}

/**
 * Track which sessions have already been sent for AI title generation.
 * Prevents duplicate title generation when multiple agent_end events fire.
 */
const titleGenerationPending = new Set<string>();

async function loadStoredSessionMessages(projectId: string, persistedSessionId: string): Promise<ChatMessage[]> {
  try {
    const stored = await trpc.session.getStoredMessages.query({
      projectId,
      sessionId: persistedSessionId,
    });
    return normalizeStoredMessages(stored);
  } catch {
    return [];
  }
}

/**
 * Compact agent notice text for display as a system chip.
 *
 * MCP mount notices arrive as multi-line noise like:
 *   "xd:///: mounted mcp_codegraph_callees, mcp_codegraph_callers, ..."
 * Tool tokens are extracted globally so any phrasing/separator works, then
 * collapsed into a single-line summary (server names derived from the
 * mcp_<server>_<tool> naming). Other notices are whitespace-collapsed as-is.
 */
function formatNoticeText(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const mcpTools = collapsed.match(/\bmcp_[A-Za-z0-9][\w.-]*/g) ?? [];
  if (/mounted/i.test(collapsed) && mcpTools.length > 0) {
    const servers = [
      ...new Set(mcpTools.map((t) => t.replace(/^mcp_/i, '').split('_')[0])),
    ].filter(Boolean);
    return servers.length > 0
      ? `已挂载 MCP 工具 ${mcpTools.length} 个（${servers.join('、')}）`
      : `已挂载 MCP 工具 ${mcpTools.length} 个`;
  }
  return collapsed;
}

function normalizeStoredMessages(messages: unknown): ChatMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages.filter((msg): msg is ChatMessage => {
    if (typeof msg !== 'object' || msg === null) return false;
    const m = msg as Record<string, unknown>;
    return (
      typeof m.id === 'string' &&
      (m.role === 'user' || m.role === 'assistant' || m.role === 'tool' || m.role === 'system') &&
      typeof m.content === 'string' &&
      typeof m.timestamp === 'number'
    );
  });
}

function persistSessionMessages(session: SessionEntry | undefined): void {
  if (!session || session.status === 'creating') return;
  const persistedSessionId = session.persistedSessionId ?? session.runtimeSessionId;
  if (!persistedSessionId) return;
  void trpc.session.saveStoredMessages.mutate({
    projectId: session.projectId,
    sessionId: persistedSessionId,
    messages: session.messages,
  }).catch(() => {
    // Message persistence is best-effort; live chat state remains authoritative.
  });
  // Also persist context usage to sessions.json so the indicator shows the
  // correct value immediately when the app is reopened.
  if (session.contextUsage) {
    void trpc.session.updateContextUsage.mutate({
      projectId: session.projectId,
      sessionId: persistedSessionId,
      contextUsage: session.contextUsage,
      contextBreakdown: session.contextBreakdown,
    }).catch(() => {
      // Best-effort; context usage will be refreshed on next event.
    });
  }
}

type SessionStoreSet = (
  partial: Partial<SessionStoreState> | ((state: SessionStoreState) => Partial<SessionStoreState>),
) => void;

// ─── 流式 message_update 节流辅助 ────────────────────────
// 上述模块级状态变量配合以下函数实现：
//  - applyMessageUpdateSnapshot: 把单次 snapshot 写入 store
//  - flushPendingMessageUpdate: 立刻应用挂起的最新 snapshot
//  - scheduleMessageUpdateFlush: 节流调度（可见 50ms / 后台 500ms）
//  - registerVisibilityListener: 窗口重新可见时立即 flush
//
// 注意：handleSessionEvent 每次被调用时都会把 `set`/`get` 闭包赋给
// `flushPendingMessageUpdateRef` / `flushPersistRef`，因为同一个 store
// 的 set/get 是稳定引用，所以即使多次赋值也指向同一个闭包。
let pendingPersistSessionId: string | null = null;

function applyMessageUpdateSnapshot(
  set: SessionStoreSet,
  sessionId: string,
  message: unknown,
): void {
  const msg = message as Record<string, unknown> | undefined;
  if (msg?.role && msg.role !== 'assistant') return;
  const { text: updateText, thinking: updateThinking } = extractTextFromMessage(msg);
  const toolCalls = extractToolCallsFromMessage(msg);
  if (!updateText && !updateThinking && toolCalls.length === 0) return;
  set((s) => ({
    sessions: s.sessions.map((sess) => {
      if (!sessionMatchesId(sess, sessionId)) return sess;
      // Find the last streaming assistant message
      let lastAssistantIdx = -1;
      for (let i = sess.messages.length - 1; i >= 0; i--) {
        if (sess.messages[i].role === 'assistant' && sess.messages[i].isStreaming) {
          lastAssistantIdx = i;
          break;
        }
      }
      let messages = sess.messages;
      if (lastAssistantIdx !== -1 && (updateText || updateThinking)) {
        messages = messages.map((message, index) =>
          index === lastAssistantIdx
            ? {
                ...message,
                content: updateText || message.content,
                thinking: updateThinking || message.thinking,
              }
            : message,
        );
      }
      messages = upsertPendingToolMessages(messages, toolCalls);
      return {
        ...sess,
        messages,
      };
    }),
  }));
}

function flushPendingMessageUpdate(set: SessionStoreSet): void {
  if (messageUpdateTimer) {
    clearTimeout(messageUpdateTimer);
    messageUpdateTimer = null;
  }
  if (!pendingMessageUpdate) return;
  const { sessionId, message } = pendingMessageUpdate;
  pendingMessageUpdate = null;
  lastMessageUpdateFlush = Date.now();
  applyMessageUpdateSnapshot(set, sessionId, message);
}

function scheduleMessageUpdateFlush(set: SessionStoreSet): void {
  // 已有挂起 timer 时无需新建——pendingMessageUpdate 始终持有最新 snapshot
  if (messageUpdateTimer) return;
  const delay = document.hidden
    ? MESSAGE_UPDATE_THROTTLE_HIDDEN_MS
    : MESSAGE_UPDATE_THROTTLE_VISIBLE_MS;
  const elapsed = Date.now() - lastMessageUpdateFlush;
  const wait = Math.max(0, delay - elapsed);
  messageUpdateTimer = setTimeout(() => {
    messageUpdateTimer = null;
    flushPendingMessageUpdate(set);
  }, wait);
}

function flushPersist(get: () => SessionStoreState): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!pendingPersistSessionId) return;
  const sid = pendingPersistSessionId;
  pendingPersistSessionId = null;
  lastPersistAt = Date.now();
  const session = get().sessions.find((sess) => sessionMatchesId(sess, sid));
  persistSessionMessages(session);
}

function schedulePersist(get: () => SessionStoreState, sessionId: string): void {
  pendingPersistSessionId = sessionId; // 始终记下最新需要持久化的 session
  if (persistTimer) return;
  const elapsed = Date.now() - lastPersistAt;
  const wait = Math.max(0, PERSIST_THROTTLE_MS - elapsed);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flushPersist(get);
  }, wait);
}

function registerVisibilityListener(): void {
  if (visibilityListenerRegistered) return;
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  visibilityListenerRegistered = true;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    // 窗口重新可见——立刻应用挂起的状态，避免恢复时大量积压一次性 flush
    flushPendingMessageUpdateRef?.();
    flushPersistRef?.();
  });
}

/**
 * Trigger AI title generation for a session based on the first user message.
 *
 * Sends the user's first message to the backend generateTitle procedure,
 * which generates a concise title without waiting for the assistant's
 * response. Guards against duplicate generation via the
 * titleGenerationPending set.
 *
 * This function is fire-and-forget — failures are silently ignored, and the
 * session keeps its immediate placeholder name (generated from the first
 * message line).
 */
async function triggerAiTitleGeneration(
  sessionId: string,
  userMessage: string,
  get: () => SessionStoreState,
): Promise<void> {
  // Find the session by matching against all possible IDs
  const session = get().sessions.find((s) => sessionMatchesId(s, sessionId));
  if (!session) {
    console.warn('[session:title-generation] session not found, skipping', { sessionId });
    return;
  }

  // Prevent duplicate generation
  if (titleGenerationPending.has(session.id)) {
    console.log('[session:title-generation] already pending, skipping', { sessionId: session.id });
    return;
  }
  titleGenerationPending.add(session.id);

  console.log('[session:title-generation] requesting AI title', {
    sessionId: session.id,
    messagePreview: userMessage.slice(0, 60),
  });

  try {
    const result = await trpc.session.generateTitle.mutate({
      userMessage,
    });

    console.log('[session:title-generation] response', {
      sessionId: session.id,
      hasTitle: !!result.title,
      title: result.title,
    });

    if (result.title) {
      // Only rename if the session still exists and hasn't been manually renamed
      const current = get().sessions.find((s) => s.id === session.id);
      if (!current) {
        console.warn('[session:title-generation] session gone after response', { sessionId: session.id });
      } else if (isPlaceholderName(current.name) || current.name === generateSessionName(userMessage)) {
        await get().renameSession(session.id, current.projectId, result.title);
        console.log('[session:title-generation] renamed', { sessionId: session.id, title: result.title });
      } else {
        console.log('[session:title-generation] skipping rename (name changed)', {
          sessionId: session.id,
          currentName: current.name,
        });
      }
    }
  } catch (err) {
    console.warn('[session:title-generation] failed:', err instanceof Error ? err.message : String(err));
  } finally {
    titleGenerationPending.delete(session.id);
  }
}

async function ensureRuntimeSession(
  sessionId: string,
  set: SessionStoreSet,
  get: () => SessionStoreState,
): Promise<string> {
  const session = get().sessions.find((s) => sessionMatchesId(s, sessionId));
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  if (session.runtimeSessionId) return session.runtimeSessionId;

  // Legacy/test sessions created before lazy runtime support already use their id as the backend id.
  if (!session.cwd) return session.id;
  const cwd = session.cwd;

  const pending = runtimeSessionStarts.get(session.id);
  if (pending) return pending;

  const start = (async () => {
    registerSessionEventListener(get);

    const latest = get().sessions.find((s) => s.id === session.id);
    if (!latest) throw new Error(`Session not found: ${session.id}`);

    const result = latest.persistedSessionId
      ? await trpc.session.restore.mutate({
          projectId: latest.projectId,
          cwd: latest.cwd ?? cwd,
          sessionId: latest.persistedSessionId,
          name: latest.name,
          providerId: latest.model?.providerId,
          approvalMode: latest.approvalMode,
        })
      : await trpc.session.create.mutate({
          projectId: latest.projectId,
          cwd: latest.cwd ?? cwd,
          provider: latest.model?.provider,
          model: latest.model?.id,
          providerId: latest.model?.providerId,
          approvalMode: latest.approvalMode,
        });

    const runtimeSessionId = result.sessionId;
    const persistedSessionId = latest.persistedSessionId ?? runtimeSessionId;
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === latest.id
          ? {
              ...sess,
              runtimeSessionId,
              persistedSessionId,
              // Only overwrite the name if the backend returned a non-placeholder
              // name AND the current name is also a placeholder. This prevents
              // the backend's default "新会话" from clobbering a name that was
              // already set (e.g. by a previous renameSession or restore).
              name: isPlaceholderName(sess.name) && (result as { name?: string }).name && !isPlaceholderName((result as { name?: string }).name!)
                ? (result as { name?: string }).name!
                : sess.name,
              model: (result as { model?: SessionModel }).model ?? sess.model,
            }
          : sess,
      ),
    }));
    const pendingEvents = pendingSessionEvents.get(runtimeSessionId);
    if (pendingEvents) {
      pendingSessionEvents.delete(runtimeSessionId);
      for (const pendingEvent of pendingEvents) {
        get().handleSessionEvent(runtimeSessionId, pendingEvent);
      }
    }
    persistSessionMessages(get().sessions.find((sess) => sess.id === latest.id));

    // Fire-and-forget: fetch the current context usage from the omp engine so
    // the UI reflects the real token count immediately after session
    // create/restore — not just 0% until the next context_usage event arrives
    // during an active conversation. This is especially important for restored
    // history sessions that already have many messages.
    void (async () => {
      try {
        const state = await trpc.session.getState.query({ sessionId: runtimeSessionId });
        const stateObj = state as Record<string, unknown> | null;
        if (!stateObj || typeof stateObj !== 'object') return;
        const usage = stateObj.contextUsage;
        if (usage === undefined || usage === null) return;
        set((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.id === latest.id
              ? {
                  ...sess,
                  contextUsage: readContextUsage(usage, sess.contextUsage ?? emptyContextUsage()),
                  autoCompactionEnabled: stateObj.autoCompactionEnabled !== false,
                }
              : sess,
          ),
        }));
      } catch {
        // Best-effort: context usage will be updated on the next context_usage
        // event during active conversation.
      }
    })();

    return runtimeSessionId;
  })();

  runtimeSessionStarts.set(session.id, start);
  try {
    return await start;
  } finally {
    runtimeSessionStarts.delete(session.id);
  }
}

export const useSessionStore = create<SessionStoreState>((set, get) => ({
  sessions: [],
  currentSessionId: null,
  historySessions: [],
  historyLoading: false,
  lastModel: null,
  approvalRequests: [],
  askRequests: [],

  initLastModel: () => {
    try {
      const saved = localStorage.getItem(MODEL_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as SessionModel;
        if (parsed && typeof parsed.provider === 'string' && typeof parsed.id === 'string' && typeof parsed.name === 'string') {
          set({ lastModel: parsed });
        }
      }
    } catch {
      // Corrupted localStorage — ignore silently
    }
  },

  registerEventListeners: () => {
    registerSessionEventListener(get);
    registerCwdChangedListener(get);
    registerErrorAnalysisEventListener(get);
    registerApprovalRequestListener(get);
    registerAskRequestListener(get);
  },

  addErrorAnalysisSession: (event) => {
    const existing = get().sessions.find((session) => sessionMatchesId(session, event.sessionId));
    if (existing) {
      set({ currentSessionId: existing.id });
      return;
    }

    const caseName = event.caseName?.trim() || '仿真用例';
    const name = event.errorType === 'compile_error'
      ? `[编译修复] ${caseName}`
      : `[仿真分析] ${caseName}`;
    const userMessage: ChatMessage = {
      id: `msg_${event.sessionId}_initial`,
      role: 'user',
      content: event.initialMessage ?? `请分析 ${caseName} 的${event.errorType === 'compile_error' ? '编译' : '仿真'}错误。`,
      timestamp: Date.now(),
    };
    const session: SessionEntry = {
      id: event.sessionId,
      runtimeSessionId: event.sessionId,
      persistedSessionId: event.sessionId,
      projectId: event.projectId,
      name,
      status: 'streaming',
      messages: [userMessage],
      composer: emptyComposer(),
      createdAt: Date.now(),
      model: get().lastModel ?? undefined,
      contextUsage: emptyContextUsage(),
    };

    set((state) => ({
      sessions: [...state.sessions, session],
      currentSessionId: event.sessionId,
    }));

    const pending = pendingSessionEvents.get(event.sessionId);
    if (pending) {
      pendingSessionEvents.delete(event.sessionId);
      for (const pendingEvent of pending) {
        get().handleSessionEvent(event.sessionId, pendingEvent);
      }
    }

    if (useUiStore.getState().rightPanelCollapsed) {
      useUiStore.getState().toggleRightPanel();
    }
  },

  createSession: async (projectId, cwd) => {
    const sessionId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const lastModel = get().lastModel;
    let storedApprovalMode: ApprovalMode | undefined;
    try {
      const saved = localStorage.getItem(APPROVAL_MODE_STORAGE_KEY);
      if (saved === 'always-ask' || saved === 'write' || saved === 'yolo') {
        storedApprovalMode = saved;
      }
    } catch {
      // Corrupted localStorage — ignore
    }
    const session: SessionEntry = {
      id: sessionId,
      projectId,
      cwd,
      name: '新会话',
      status: 'idle',
      messages: [],
      composer: emptyComposer(),
      createdAt: Date.now(),
      model: lastModel ?? undefined,
      contextUsage: emptyContextUsage(),
      approvalMode: storedApprovalMode ?? 'yolo',
    };
    set((s) => ({
      sessions: [...s.sessions, session],
      currentSessionId: sessionId,
    }));
    return sessionId;
  },

  destroySession: async (sessionId, projectId) => {
    try {
      const session = get().sessions.find((sess) => sessionMatchesId(sess, sessionId));
      await trpc.session.destroy.mutate({
        sessionId: session?.runtimeSessionId ?? sessionId,
        projectId,
      });
      set((s) => ({
        sessions: s.sessions.filter((sess) => !sessionMatchesId(sess, sessionId)),
        currentSessionId: s.currentSessionId === sessionId || (session && s.currentSessionId === session.id)
          ? null
          : s.currentSessionId,
      }));
    } catch (err) {
      useToastStore.getState().error('销毁会话失败', tRPCError(err));
    }
  },

  closeSession: (sessionId) => {
    // Just remove from UI without destroying the backend session
    set((s) => ({
      sessions: s.sessions.filter((sess) => !sessionMatchesId(sess, sessionId)),
      currentSessionId: s.currentSessionId === sessionId
        ? (s.sessions.find((sess) => !sessionMatchesId(sess, sessionId))?.id ?? null)
        : s.currentSessionId,
    }));
  },

  switchSession: (sessionId) => {
    set({ currentSessionId: sessionId });
  },

  sendMessage: async (message, images) => {
    const sessionId = get().currentSessionId;
    if (!sessionId || !message.trim()) return;

    // Check if this is the first message (for auto-naming)
    const sessionBeforeSend = get().sessions.find((s) => s.id === sessionId);
    const isFirstMessage = sessionBeforeSend && sessionBeforeSend.messages.length === 0;
    const firstMessageText = message; // Capture for AI title generation later

    // Build the full message with skill and context prefixes
    const composer = sessionComposer(sessionBeforeSend);
    const skills = composer.selectedSkills;
    const contextFiles = composer.contextFiles;
    let fullMessage = message;

    // Prepend skill invocations
    if (skills.length > 0) {
      const skillPrefix = skills.map((s) => `skill://${s.name}`).join('\n');
      fullMessage = `${skillPrefix}\n\n${fullMessage}`;
    }

    // Prepend file context
    if (contextFiles.length > 0) {
      const contextPrefix = contextFiles.map((f) => {
        if (f.type === 'directory') {
          return `Context directory: ${f.path}`;
        }
          return `Context file: ${f.path}`;
      }).join('\n');
      fullMessage = `${contextPrefix}\n\n${fullMessage}`;
    }

    const userMsg: ChatMessage = {
      id: `msg_${Date.now()}`,
      role: 'user',
      content: message,
      timestamp: Date.now(),
      images,
      skills: skills.length > 0 ? skills : undefined,
    };

    const assistantMsg: ChatMessage = {
      id: `msg_${Date.now() + 1}`,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    };

    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId
          ? {
              ...sess,
              status: 'streaming',
              messages: [...sess.messages, userMsg, assistantMsg],
              composer: emptyComposer(),
              contextCompacted: false,
            }
          : sess,
      ),
    }));
    persistSessionMessages(get().sessions.find((sess) => sess.id === sessionId));

    try {
      let runtimeSessionId = await ensureRuntimeSession(sessionId, set, get);
      persistSessionMessages(get().sessions.find((sess) => sess.id === sessionId));
      // Images are passed as full data URLs (data:image/png;base64,...).
      // The runner parses these to extract MIME type + base64 data for the SDK.
      try {
        await trpc.session.send.mutate({ sessionId: runtimeSessionId, message: fullMessage, images });
      } catch (sendErr) {
        // If the backend session was destroyed (e.g. idle timeout), reset the
        // cached runtimeSessionId and retry once with a fresh runtime session.
        const sendErrMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
        if (/Session not found/i.test(sendErrMsg)) {
          set((s) => ({
            sessions: s.sessions.map((sess) =>
              sess.id === sessionId
                ? { ...sess, runtimeSessionId: undefined }
                : sess,
            ),
          }));
          runtimeSessionId = await ensureRuntimeSession(sessionId, set, get);
          await trpc.session.send.mutate({ sessionId: runtimeSessionId, message: fullMessage, images });
        } else {
          throw sendErr;
        }
      }

      // Auto-rename session based on the first user message — immediate placeholder.
      // Only overwrite if the current name is still a placeholder ("新会话"),
      // so we don't clobber a name the user manually set before sending.
      //
      // The AI title generation is triggered for ALL non-low-signal first
      // messages (mirrors omp's behavior: only greetings/acks/empty are
      // skipped). Even a short but substantive message like "启动三个
      // subagent 分析当前项目" benefits from an AI-summarized title.
      if (isFirstMessage && sessionBeforeSend) {
        if (isPlaceholderName(sessionBeforeSend.name)) {
          const autoName = generateSessionName(firstMessageText);
          void get().renameSession(sessionId, sessionBeforeSend.projectId, autoName);
        }

        // Fire-and-forget AI title generation from the first user message
        // alone — no need to wait for the assistant's response.
        void triggerAiTitleGeneration(sessionId, firstMessageText, get);
      }
    } catch (err) {
      const errMsg = tRPCError(err);
      set((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.id === sessionId
            ? {
                ...sess,
                status: 'error',
                messages: sess.messages.map((m) =>
                  m.id === assistantMsg.id
                    ? { ...m, content: `错误: ${errMsg}`, isStreaming: false }
                    : m,
                ),
              }
            : sess,
        ),
      }));
      useToastStore.getState().error('发送消息失败', errMsg);
    }
  },

  abortSession: async () => {
    const sessionId = get().currentSessionId;
    if (!sessionId) return;
    const session = get().sessions.find((s) => sessionMatchesId(s, sessionId));
    const runtimeSessionId = session?.runtimeSessionId ?? (!session?.cwd ? sessionId : null);
    if (!runtimeSessionId) {
      set((s) => ({
        sessions: s.sessions.map((sess) =>
          sessionMatchesId(sess, sessionId) ? { ...sess, status: 'idle' } : sess,
        ),
      }));
      return;
    }
    try {
      await trpc.session.abort.mutate({ sessionId: runtimeSessionId });
    } catch (err) {
      const errMsg = tRPCError(err);
      // If the backend session is already gone (e.g. idle timeout destroyed it
      // during a long-running agent turn), treat it as "already aborted" —
      // reset the stale runtimeSessionId and silently set status to idle.
      // The desired outcome (stop the session) is already achieved.
      if (/Session not found/i.test(errMsg)) {
        set((s) => ({
          sessions: s.sessions.map((sess) =>
            sessionMatchesId(sess, sessionId)
              ? { ...sess, status: 'idle', runtimeSessionId: undefined }
              : sess,
          ),
        }));
        // Also stop any streaming assistant messages
        set((s) => ({
          sessions: s.sessions.map((sess) =>
            sessionMatchesId(sess, sessionId)
              ? {
                  ...sess,
                  messages: sess.messages.map((m) =>
                    m.isStreaming ? { ...m, isStreaming: false } : m,
                  ),
                }
              : sess,
          ),
        }));
        return;
      }
      useToastStore.getState().error('中止会话失败', errMsg);
    }
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sessionMatchesId(sess, sessionId) ? { ...sess, status: 'idle' } : sess,
      ),
    }));
    // Stop any streaming assistant messages on successful abort
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sessionMatchesId(sess, sessionId)
          ? {
              ...sess,
              messages: sess.messages.map((m) =>
                m.isStreaming ? { ...m, isStreaming: false } : m,
              ),
            }
          : sess,
      ),
    }));
  },

  compactSession: async () => {
    const sessionId = get().currentSessionId;
    if (!sessionId) return false;
    const session = get().sessions.find((candidate) => candidate.id === sessionId);
    if (
      !session
      || session.status !== 'idle'
      || (session.contextUsage?.tokens ?? 0) <= 0
      || session.isCompacting
      || session.contextCompacted
    ) return false;

    set((state) => ({
      sessions: state.sessions.map((candidate) =>
        candidate.id === sessionId ? { ...candidate, isCompacting: true } : candidate,
      ),
    }));

    try {
      const runtimeSessionId = await ensureRuntimeSession(sessionId, set, get);
      const result = await trpc.session.compact.mutate({ sessionId: runtimeSessionId });
      set((state) => ({
        sessions: state.sessions.map((candidate) =>
          candidate.id === sessionId
            ? {
                ...candidate,
                isCompacting: false,
                contextCompacted: true,
                contextUsage: readContextUsage(result.contextUsage, candidate.contextUsage ?? emptyContextUsage()),
                contextBreakdown: readContextBreakdown(result.contextBreakdown, candidate.contextBreakdown),
              }
            : candidate,
        ),
      }));
      useToastStore.getState().success('上下文压缩完成');
      return true;
    } catch (err) {
      set((state) => ({
        sessions: state.sessions.map((candidate) =>
          candidate.id === sessionId ? { ...candidate, isCompacting: false } : candidate,
        ),
      }));
      useToastStore.getState().error('上下文压缩失败', tRPCError(err));
      return false;
    }
  },

  renameSession: async (sessionId, projectId, name) => {
    try {
      const session = get().sessions.find((sess) => sessionMatchesId(sess, sessionId));
      await trpc.session.rename.mutate({
        sessionId: session?.persistedSessionId ?? sessionId,
        projectId,
        name,
      });
      set((s) => ({
        sessions: s.sessions.map((sess) =>
          sessionMatchesId(sess, sessionId) ? { ...sess, name } : sess,
        ),
      }));
    } catch (err) {
      useToastStore.getState().error('重命名会话失败', tRPCError(err));
    }
  },

  setInputMessage: (msg) => set((state) => ({
    sessions: state.sessions.map((session) => session.id === state.currentSessionId
      ? { ...session, composer: { ...sessionComposer(session), inputMessage: msg } }
      : session),
  })),

  handleSessionEvent: (sessionId, event) => {
    const evt = event as Record<string, unknown>;
    const type = evt.type as string;

    // Error-analysis sessions are created in the main process. Their first
    // agent events can arrive before the separate `started` notification, so
    // retain those events until the renderer creates the matching tab.
    if (!get().sessions.some((session) => sessionMatchesId(session, sessionId)) && sessionId.startsWith('session_')) {
      const pending = pendingSessionEvents.get(sessionId) ?? [];
      if (pending.length < 100) pending.push(event);
      pendingSessionEvents.set(sessionId, pending);
      return;
    }

    // Log event type for debugging (avoid dumping full event object — it can be very large)
    console.log(`[session:event] sessionId=${sessionId}, type="${type}"`);

    // 注册 visibilitychange 监听器（幂等）；同步刷新函数引用，供后台→前台时调用
    registerVisibilityListener();
    flushPendingMessageUpdateRef = () => flushPendingMessageUpdate(set);
    flushPersistRef = () => flushPersist(get);

    // ── message_update 走节流路径 ───────────────────────────
    // 流式期间 message_update 可能每数十毫秒触发一次，直接 set() 会让
    // React 高频重渲染，并在窗口隐藏时大量积压。这里只保留最新 snapshot，
    // 由 setTimeout 按可见 50ms / 后台 500ms 节流应用。
    if (type === 'message_update') {
      pendingMessageUpdate = { sessionId, message: evt.message };
      scheduleMessageUpdateFlush(set);
      // 持久化也走节流，避免每次 message_update 都触发一次 tRPC mutate
      schedulePersist(get, sessionId);
      return;
    }

    // ── 其它事件：先强制 flush 挂起的 message_update ─────────
    // 例如 message_end 到来时，必须先把最新的流式文本写进 store，
    // 否则最终消息可能丢失最后一段流式内容。
    if (pendingMessageUpdate) {
      flushPendingMessageUpdate(set);
    }

    set((s) => ({
      sessions: s.sessions.map((sess) => {
        if (!sessionMatchesId(sess, sessionId)) return sess;

        switch (type) {
          case 'subagent_lifecycle': {
            // task 工具派遣的 subagent 生命周期帧（started/completed/failed/aborted）
            const p = evt.payload as Record<string, unknown> | undefined;
            const id = typeof p?.id === 'string' ? p.id : '';
            console.log(`[store] subagent_lifecycle id=${id} status=${p?.status} parentToolCallId=${p?.parentToolCallId}`);
            if (!p || !id) return sess;
            const rawStatus = p.status;
            const status: SubagentActivity['status'] =
              rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'aborted'
                ? rawStatus
                : 'running';
            const prev = sess.subagents?.[id];
            const next: SubagentActivity = {
              id,
              index: typeof p.index === 'number' ? p.index : (prev?.index ?? 0),
              agent: typeof p.agent === 'string' ? p.agent : (prev?.agent ?? 'subagent'),
              description: typeof p.description === 'string' ? p.description : prev?.description,
              assignment: prev?.assignment,
              status,
              parentToolCallId:
                typeof p.parentToolCallId === 'string' ? p.parentToolCallId : prev?.parentToolCallId,
              currentTool: status === 'running' ? prev?.currentTool : undefined,
              currentToolArgs: status === 'running' ? prev?.currentToolArgs : undefined,
              lastIntent: prev?.lastIntent,
              recentOutput: prev?.recentOutput ?? [],
              toolCount: prev?.toolCount ?? 0,
              tokens: prev?.tokens ?? 0,
              requests: prev?.requests ?? 0,
              tokenHistory: prev?.tokenHistory ?? [],
              startedAt: prev?.startedAt ?? Date.now(),
              endedAt: status !== 'running' ? Date.now() : undefined,
            };
            return { ...sess, subagents: { ...sess.subagents, [id]: next } };
          }

          case 'subagent_progress': {
            // subagent 实时进度帧（~150ms 节流合并，含 currentTool/recentOutput/tokens）
            const p = evt.payload as Record<string, unknown> | undefined;
            const prog = p?.progress as Record<string, unknown> | undefined;
            const id = typeof p?.id === 'string' ? p.id : (typeof prog?.id === 'string' ? prog.id : '');
            console.log(`[store] subagent_progress id=${id} tokens=${prog?.tokens} tool=${prog?.currentTool} parentToolCallId=${p?.parentToolCallId}`);
            if (!p || !id) return sess;
            const prev = sess.subagents?.[id];
            // 终态不回退：lifecycle 已判定完成后忽略残余 progress 帧
            if (prev && prev.status !== 'running') return sess;
            const tokens = typeof prog?.tokens === 'number' ? prog.tokens : (prev?.tokens ?? 0);
            const delta = prev ? Math.max(0, tokens - prev.tokens) : tokens;
            const tokenHistory = [...(prev?.tokenHistory ?? []), delta].slice(-16);
            // 引擎窗口（倒序）→ 合并成累积日志（正序）。
            // 空窗口 = 新一轮 message_start 清空瞬间：保留旧日志不回退。
            const rawWindow = Array.isArray(prog?.recentOutput)
              ? prog.recentOutput.filter((l): l is string => typeof l === 'string')
              : [];
            const recentOutput = rawWindow.length > 0
              ? mergeSubagentOutputWindow(prev?.recentOutput ?? [], rawWindow).slice(-SUBAGENT_LOG_MAX_LINES)
              : (prev?.recentOutput ?? []);
            const next: SubagentActivity = {
              id,
              index: typeof p.index === 'number' ? p.index : (prev?.index ?? 0),
              agent: typeof p.agent === 'string' ? p.agent : (prev?.agent ?? 'subagent'),
              description: prev?.description,
              assignment: typeof p.assignment === 'string' ? p.assignment : prev?.assignment,
              status: 'running',
              parentToolCallId:
                typeof p.parentToolCallId === 'string' ? p.parentToolCallId : prev?.parentToolCallId,
              currentTool: typeof prog?.currentTool === 'string' ? prog.currentTool : prev?.currentTool,
              currentToolArgs:
                typeof prog?.currentToolArgs === 'string' ? prog.currentToolArgs : prev?.currentToolArgs,
              lastIntent: typeof prog?.lastIntent === 'string' ? prog.lastIntent : prev?.lastIntent,
              recentOutput,
              toolCount: typeof prog?.toolCount === 'number' ? prog.toolCount : (prev?.toolCount ?? 0),
              tokens,
              requests: typeof prog?.requests === 'number' ? prog.requests : (prev?.requests ?? 0),
              tokenHistory,
              startedAt: prev?.startedAt ?? Date.now(),
            };
            return { ...sess, subagents: { ...sess.subagents, [id]: next } };
          }

          case 'context_usage':
            return {
              ...sess,
              contextUsage: readContextUsage(evt.contextUsage, sess.contextUsage ?? emptyContextUsage()),
              contextBreakdown: readContextBreakdown(evt.contextBreakdown, sess.contextBreakdown),
              isCompacting: evt.isCompacting === true,
              autoCompactionEnabled: evt.autoCompactionEnabled !== false,
            };

          case 'compaction_start':
          case 'auto_compaction_start':
            return { ...sess, isCompacting: true };

          case 'compaction_end':
          case 'auto_compaction_end':
            return { ...sess, isCompacting: false };

          case 'message_start': {
            const message = evt.message as Record<string, unknown> | undefined;
            if (message?.role && message.role !== 'assistant') return sess;
            // Extract text and thinking separately from message.content
            const { text: startText, thinking: startThinking } = extractTextFromMessage(message);
            // Check if there's already a streaming assistant message
            const hasStreaming = sess.messages.some((m) => m.role === 'assistant' && m.isStreaming);
            if (hasStreaming) {
              return {
                ...sess,
                status: 'streaming',
                messages: sess.messages.map((m) =>
                  m.role === 'assistant' && m.isStreaming && (startText || startThinking)
                    ? { ...m, content: startText, thinking: startThinking || m.thinking }
                    : m,
                ),
              };
            }
            // No streaming assistant message — create a new one
            // (this happens when the agent sends multiple messages in one turn)
            const newMsg: ChatMessage = {
              id: `msg_${Date.now()}`,
              role: 'assistant',
              content: startText,
              thinking: startThinking || undefined,
              timestamp: Date.now(),
              isStreaming: true,
            };
            return {
              ...sess,
              status: 'streaming',
              messages: [...sess.messages, newMsg],
            };
          }

          case 'message_end': {
            // Extract final text and thinking from message.content — this is the
            // authoritative source for the assistant's response, especially when
            // there are no message_update events (non-streaming or empty streaming).
            const msg = evt.message as Record<string, unknown> | undefined;
            if (msg?.role && msg.role !== 'assistant') return sess;
            const { text: endText, thinking: endThinking } = extractTextFromMessage(msg);
            const errMsg = msg ? extractErrorFromMessage(msg) : null;
            // Extract tool calls from the final message content so we can show
            // pending tool cards BEFORE the engine emits tool_execution_start.
            const endToolCalls = extractToolCallsFromMessage(msg);
            // Do NOT set status to 'idle' here — the agent may still be working
            // (e.g. multiple messages, tool calls). Only 'agent_end' sets idle.
            return {
              ...sess,
              status: 'streaming',
              messages: (() => {
                // First, finalize the streaming assistant message
                const updated = sess.messages.map((m) => {
                  if (m.role !== 'assistant' || !m.isStreaming) return m;
                  return {
                    ...m,
                    isStreaming: false,
                    content: errMsg ? `[错误] ${errMsg}` : (endText || m.content),
                    thinking: endThinking || m.thinking,
                  };
                });
                return upsertPendingToolMessages(updated, endToolCalls);
              })(),
            };
          }

                    case 'tool_execution_start': {
            const toolCallId = (evt.toolCallId as string) ?? `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            // Check if a pending tool card was already created from message_end
            // tool-call blocks. If so, update it with the authoritative args and
            // snapshot data; otherwise create a new tool message.
            const hasPendingTool = sess.messages.some(
              (m) => m.role === 'tool' && m.toolCallId === toolCallId,
            );
            if (hasPendingTool) {
              return {
                ...sess,
                status: 'tool_executing',
                messages: sess.messages.map((m) =>
                  m.role === 'tool' && m.toolCallId === toolCallId && !m.toolResult
                    ? {
                        ...m,
                        toolName: evt.toolName as string,
                        toolArgs: evt.args,
                        toolFileExistedBefore: evt.fileExistedBefore as boolean | undefined,
                        toolBeforeContent: evt.beforeContent as string | undefined,
                        toolStartTime: m.toolStartTime ?? Date.now(),
                      }
                    : m,
                ),
              };
            }
            const toolMsg: ChatMessage = {
              id: `tool_${toolCallId}`,
              role: 'tool',
              content: '',
              timestamp: Date.now(),
              toolName: evt.toolName as string,
              toolCallId,
              toolArgs: evt.args,
              toolFileExistedBefore: evt.fileExistedBefore as boolean | undefined,
              toolBeforeContent: evt.beforeContent as string | undefined,
              toolStartTime: Date.now(),
            };
            return {
              ...sess,
              status: 'tool_executing',
              messages: [...sess.messages, toolMsg],
            };
          }

          case 'tool_execution_end': {
            const endToolCallId = evt.toolCallId as string | undefined;
            const endToolName = evt.toolName as string;
            // Check if there's a matching pending tool message from tool_execution_start
            const hasMatch = sess.messages.some((m) => {
              if (m.role !== 'tool' || m.toolResult) return false;
              if (endToolCallId && m.toolCallId) return m.toolCallId === endToolCallId;
              return m.toolName === endToolName;
            });
            if (hasMatch) {
              return {
                ...sess,
                status: 'streaming',
                messages: sess.messages.map((m) => {
                  if (m.role !== 'tool' || m.toolResult) return m;
                  if (endToolCallId && m.toolCallId) {
                    return m.toolCallId === endToolCallId
                      ? { ...m, toolResult: evt.result, toolEndTime: Date.now() }
                      : m;
                  }
                  return m.toolName === endToolName && !m.toolResult
                    ? { ...m, toolResult: evt.result, toolEndTime: Date.now() }
                    : m;
                }),
              };
            }
            // Fallback: no matching tool message found (tool_execution_start was missed).
            // Create a completed tool message so the tool card is always visible.
            const fallbackToolCallId = endToolCallId ?? `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const toolMsg: ChatMessage = {
              id: `tool_${fallbackToolCallId}`,
              role: 'tool',
              content: '',
              timestamp: Date.now(),
              toolName: endToolName,
              toolCallId: fallbackToolCallId,
              toolArgs: evt.args,
              toolResult: evt.result,
              toolStartTime: Date.now(),
              toolEndTime: Date.now(),
            };
            return {
              ...sess,
              status: 'streaming',
              messages: [...sess.messages, toolMsg],
            };
          }

          case 'agent_start':
            return { ...sess, status: 'streaming' };

          case 'agent_end':
            return {
              ...sess,
              status: 'idle',
              messages: sess.messages.map((m) =>
                m.isStreaming ? { ...m, isStreaming: false } : m,
              ),
            };

          case 'notice': {
            // Agent notices (MCP mounts, warnings) are rendered as standalone
            // system messages. They must NOT be appended to the streaming
            // assistant content — message_update snapshots replace that
            // content wholesale, which made notices flash and disappear.
            const rawNoticeText = (evt.message as string) || (evt.text as string);
            if (!rawNoticeText) return sess;
            const noticeText = formatNoticeText(rawNoticeText);
            // Dedupe: repeated identical notices (e.g. MCP remount on reconnect)
            const lastMsg = sess.messages[sess.messages.length - 1];
            if (lastMsg?.role === 'system' && lastMsg.content === noticeText) return sess;
            const noticeMsg: ChatMessage = {
              id: `sys_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              role: 'system',
              content: noticeText,
              timestamp: Date.now(),
            };
            return {
              ...sess,
              messages: [...sess.messages, noticeMsg],
            };
          }

          case 'irc_message': {
            const ircText = (evt.message as string) || (evt.text as string) || '';
            if (!ircText) return sess;
            return {
              ...sess,
              messages: sess.messages.map((m) =>
                m.role === 'assistant' && m.isStreaming
                  ? { ...m, content: m.content + ircText }
                  : m,
              ),
            };
          }

          default: {
            // For unknown event types, check if it looks like an error
            const isErr = type === 'error' || type?.includes('error') || evt.error;
            if (isErr) {
              const errText = (evt.error as string) || (evt.message as string) || JSON.stringify(evt);
              return {
                ...sess,
                status: 'error' as SessionStatus,
                messages: sess.messages.map((m) =>
                  m.role === 'assistant' && m.isStreaming
                    ? { ...m, content: `[错误] ${errText}`, isStreaming: false }
                    : m,
                ),
              };
            }
            return sess;
          }
        }
      }),
    }));

    // ── 持久化策略 ────────────────────────────────────────
    // 流式过程中的事件走节流（避免每次都触发一次 tRPC mutate）；
    // 但终止性事件（message_end / tool_execution_end / agent_end）需要
    // 立刻 flush 持久化挂起的内容，保证最终状态被写入。
    if (
      type === 'message_start' ||
      type === 'message_end' ||
      type === 'tool_execution_start' ||
      type === 'tool_execution_end' ||
      type === 'agent_end' ||
      type === 'notice' ||
      type === 'irc_message' ||
      type === 'context_usage'
    ) {
      schedulePersist(get, sessionId);
    }
    if (type === 'message_end' || type === 'tool_execution_end' || type === 'agent_end') {
      flushPersist(get);
    }

  },

  restoreSessions: async (projectId, cwd, lastSessionIds) => {
    try {
      const persisted = await trpc.session.getPersistedSessions.query({ projectId });
      if (persisted.length === 0) return false;

      // Only restore sessions whose IDs are in lastSessionIds — the set of
      // tabs that were open when the GUI was last closed. The caller is
      // responsible for creating a fresh session when lastSessionIds is empty.
      const openIdSet = lastSessionIds && lastSessionIds.length > 0
        ? new Set(lastSessionIds)
        : null;
      const filtered = openIdSet
        ? persisted.filter((p) => openIdSet.has(p.sessionId))
        : persisted;
      if (filtered.length === 0) return false;

      // Sort by lastActivityAt desc so the most recently active session becomes current.
      const sorted = [...filtered].sort((a, b) => b.lastActivityAt - a.lastActivityAt);

      // Skip sessions that are already open in the store (e.g. user switched back to the project).
      const existingIds = new Set(
        get().sessions
          .map((s) => s.persistedSessionId ?? s.id)
          .filter((id): id is string => Boolean(id)),
      );
      const toRestore = sorted.filter((p) => !existingIds.has(p.sessionId));
      if (toRestore.length === 0) {
        // All persisted sessions are already open — just switch to the most recent one.
        const latestExisting = get().sessions.find(
          (s) => sessionMatchesId(s, sorted[0].sessionId),
        );
        if (latestExisting) set({ currentSessionId: latestExisting.id });
        return true;
      }

      const newEntries: SessionEntry[] = toRestore.map((p) => ({
        id: p.sessionId,
        persistedSessionId: p.sessionId,
        projectId,
        cwd,
        name: p.name,
        status: 'idle',
        messages: [],
        composer: emptyComposer(),
        createdAt: p.createdAt,
        model: p.model,
        contextUsage: p.contextUsage ?? emptyContextUsage(),
        contextBreakdown: p.contextBreakdown,
      }));

      // The most recently active session among ALL persisted (not just newly added)
      // becomes the current tab. If that one is already open, fall back to the most
      // recent newly-restored one.
      const latestPersistedId = sorted[0].sessionId;
      const latestAlreadyOpen = get().sessions.find(
        (s) => sessionMatchesId(s, latestPersistedId),
      );
      const nextCurrentId = latestAlreadyOpen
        ? latestAlreadyOpen.id
        : newEntries[0].id;

      set((s) => ({
        sessions: [...s.sessions, ...newEntries],
        currentSessionId: nextCurrentId,
      }));

      // Load stored messages for each newly restored session in parallel.
      // Messages are best-effort — failures leave the session empty without blocking restore.
      await Promise.all(
        newEntries.map(async (entry) => {
          const chatMessages = await loadStoredSessionMessages(projectId, entry.id);
          if (chatMessages.length === 0) return;
          set((s) => ({
            sessions: s.sessions.map((sess) =>
              sess.id === entry.id
                ? { ...sess, messages: chatMessages }
                : sess,
            ),
          }));
        }),
      );
      return true;
    } catch {
      return false;
    }
  },

  setModel: async (sessionId, provider, modelId, modelName, providerId) => {
    const model: SessionModel = { provider, id: modelId, name: modelName ?? modelId, providerId };

    // 1. Optimistically update UI immediately — store + localStorage are synchronous
    localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(model));
    set((s) => ({
      lastModel: model,
      sessions: s.sessions.map((sess) =>
        sessionMatchesId(sess, sessionId)
          ? { ...sess, model }
          : sess,
      ),
    }));

    // 2. Fire backend model switch in the background (non-blocking).
    //    If providerId is provided, the backend destroys + recreates the runtime
    //    session with the new credential's full config (apiKey/baseUrl/model).
    //    If the runtime session doesn't exist yet, the model will be applied
    //    when the session is created (ensureRuntimeSession passes model info).
    void (async () => {
      try {
        const runtimeSessionId = await ensureRuntimeSession(sessionId, set, get);
        const result = await trpc.session.setModel.mutate({
          sessionId: runtimeSessionId,
          provider,
          modelId,
          modelName,
          providerId,
        });
        // If the backend swapped the runtime session (destroy + recreate),
        // update the stored runtimeSessionId so future calls target the new session.
        if (result.sessionId && result.sessionId !== runtimeSessionId) {
          set((s) => ({
            sessions: s.sessions.map((sess) =>
              sessionMatchesId(sess, sessionId)
                ? { ...sess, runtimeSessionId: result.sessionId }
                : sess,
            ),
          }));
        }
        // If the backend resolved a different model (e.g. auto-picked the first
        // model from the API), update the store so the UI shows the real model.
        if (result.model) {
          const resolved: SessionModel = {
            provider: result.model.provider,
            id: result.model.id ?? '',
            name: result.model.name ?? result.model.id ?? '',
            providerId: result.model.providerId,
          };
          localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(resolved));
          set((s) => ({
            lastModel: resolved,
            sessions: s.sessions.map((sess) =>
              sessionMatchesId(sess, sessionId)
                ? { ...sess, model: resolved }
                : sess,
            ),
          }));
        }
      } catch (err) {
        useToastStore.getState().error('切换模型失败', tRPCError(err));
      }
    })();
  },

  applyCredential: async (sessionId, providerId) => {
    // Holistic config switch: the backend will destroy + recreate the runtime
    // session with the new credential's full config (provider + apiKey +
    // baseUrl + model). We don't know the model id ahead of time — the backend
    // auto-picks the first model from the credential's API and returns it.
    try {
      const runtimeSessionId = await ensureRuntimeSession(sessionId, set, get);
      const result = await trpc.session.setModel.mutate({
        sessionId: runtimeSessionId,
        providerId,
      });
      if (result.sessionId && result.sessionId !== runtimeSessionId) {
        set((s) => ({
          sessions: s.sessions.map((sess) =>
            sessionMatchesId(sess, sessionId)
              ? { ...sess, runtimeSessionId: result.sessionId }
              : sess,
          ),
        }));
      }
      if (result.model) {
        const resolved: SessionModel = {
          provider: result.model.provider,
          id: result.model.id ?? '',
          name: result.model.name ?? result.model.id ?? '',
          providerId: result.model.providerId,
        };
        localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(resolved));
        set((s) => ({
          lastModel: resolved,
          sessions: s.sessions.map((sess) =>
            sessionMatchesId(sess, sessionId)
              ? { ...sess, model: resolved }
              : sess,
          ),
        }));
      }
    } catch (err) {
      useToastStore.getState().error('切换供应商配置失败', tRPCError(err));
    }
  },

  addSkill: (skill) => set((state) => ({
    sessions: state.sessions.map((session) => {
      if (session.id !== state.currentSessionId) return session;
      const composer = sessionComposer(session);
      if (composer.selectedSkills.some((selected) => selected.name === skill.name)) return session;
      return { ...session, composer: { ...composer, selectedSkills: [...composer.selectedSkills, skill] } };
    }),
  })),

  removeSkill: (name) => set((state) => ({
    sessions: state.sessions.map((session) => {
      if (session.id !== state.currentSessionId) return session;
      const composer = sessionComposer(session);
      return { ...session, composer: { ...composer, selectedSkills: composer.selectedSkills.filter((skill) => skill.name !== name) } };
    }),
  })),

  addContextFile: (file) => set((state) => ({
    sessions: state.sessions.map((session) => {
      if (session.id !== state.currentSessionId) return session;
      const composer = sessionComposer(session);
      if (composer.contextFiles.some((contextFile) => contextFile.path === file.path)) return session;
      return { ...session, composer: { ...composer, contextFiles: [...composer.contextFiles, file] } };
    }),
  })),

  removeContextFile: (path) => set((state) => ({
    sessions: state.sessions.map((session) => {
      if (session.id !== state.currentSessionId) return session;
      const composer = sessionComposer(session);
      return { ...session, composer: { ...composer, contextFiles: composer.contextFiles.filter((file) => file.path !== path) } };
    }),
  })),

  steerSession: async (message) => {
    const sessionId = get().currentSessionId;
    if (!sessionId || !message.trim()) return;
    try {
      const runtimeSessionId = await ensureRuntimeSession(sessionId, set, get);
      await trpc.session.steer.mutate({ sessionId: runtimeSessionId, message });
    } catch (err) {
      useToastStore.getState().error('引导会话失败', tRPCError(err));
    }
  },

  fetchHistorySessions: async (projectId) => {
    set({ historyLoading: true });
    try {
      const result = await trpc.session.listHistory.query({ projectId });
      set({ historySessions: result as HistorySession[], historyLoading: false });
    } catch (err) {
      set({ historyLoading: false });
      useToastStore.getState().error('加载历史会话失败', tRPCError(err));
    }
  },

  loadHistorySession: async (historySession, projectId, cwd) => {
    // Check if the session is already active in the store
    const existing = get().sessions.find(
      (s) => sessionMatchesId(s, historySession.sessionId),
    );
    if (existing) {
      // Session is already active — just switch to it
      set({ currentSessionId: existing.id });
      return;
    }

    const pending = historySessionLoads.get(historySession.sessionId);
    if (pending) {
      await pending;
      const loaded = get().sessions.find(
        (s) => sessionMatchesId(s, historySession.sessionId),
      );
      if (loaded) set({ currentSessionId: loaded.id });
      return;
    }

    const load = (async () => {
      try {
        const session: SessionEntry = {
          id: historySession.sessionId,
          persistedSessionId: historySession.sessionId,
          projectId,
          cwd,
          name: historySession.name,
          status: 'idle',
          messages: [],
          composer: emptyComposer(),
          createdAt: historySession.createdAt,
          model: historySession.model,
          contextUsage: historySession.contextUsage ?? emptyContextUsage(),
          contextBreakdown: historySession.contextBreakdown,
        };
        set((s) => ({
          sessions: [...s.sessions, session],
          currentSessionId: historySession.sessionId,
        }));

        const chatMessages = await loadStoredSessionMessages(projectId, historySession.sessionId);
        if (chatMessages.length > 0) {
          set((s) => ({
            sessions: s.sessions.map((sess) =>
              sess.id === historySession.sessionId
                ? { ...sess, messages: chatMessages }
                : sess,
            ),
          }));
        }
      } catch (err) {
        useToastStore.getState().error('加载历史会话失败', tRPCError(err));
      }
    })();

    historySessionLoads.set(historySession.sessionId, load);
    try {
      await load;
    } finally {
      historySessionLoads.delete(historySession.sessionId);
    }
  },

  deleteHistorySession: async (sessionId, projectId) => {
    try {
      await trpc.session.deleteHistorySession.mutate({ sessionId, projectId });
      // Remove from store if active
      set((s) => ({
        sessions: s.sessions.filter((sess) => sess.id !== sessionId && sess.persistedSessionId !== sessionId),
        currentSessionId: s.currentSessionId === sessionId ? null : s.currentSessionId,
        historySessions: s.historySessions.filter((h) => h.sessionId !== sessionId),
      }));
      useToastStore.getState().success('历史会话已删除');
    } catch (err) {
      useToastStore.getState().error('删除历史会话失败', tRPCError(err));
    }
  },

  setApprovalMode: (mode) => {
    const sessionId = get().currentSessionId;
    if (!sessionId) return;
    try {
      localStorage.setItem(APPROVAL_MODE_STORAGE_KEY, mode);
    } catch {
      // localStorage might be unavailable — ignore
    }
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId
          ? { ...sess, approvalMode: mode }
          : sess,
      ),
    }));
    // Fire-and-forget: backend dynamically re-wraps tools on the running session.
    // If the session is not yet running, the mode will be applied on creation.
    const session = get().sessions.find((sess) => sess.id === sessionId);
    const runtimeSessionId = session?.runtimeSessionId ?? sessionId;
    void trpc.session.setApprovalMode.mutate({ sessionId: runtimeSessionId, approvalMode: mode }).catch(() => {});
  },

  resolveApproval: async (requestId, approved) => {
    // Remove from pending list immediately
    set((s) => ({
      approvalRequests: s.approvalRequests.filter((r) => r.requestId !== requestId),
    }));
    try {
      await trpc.session.resolveApproval.mutate({ requestId, approved });
    } catch (err) {
      useToastStore.getState().error('审批响应失败', tRPCError(err));
    }
  },

  resolveAsk: async (requestId, answers) => {
    // Remove from pending list immediately
    set((s) => ({
      askRequests: s.askRequests.filter((r) => r.requestId !== requestId),
    }));
    try {
      await trpc.session.resolveAsk.mutate({ requestId, answers });
    } catch (err) {
      useToastStore.getState().error('提交答案失败', tRPCError(err));
    }
  },
}));
