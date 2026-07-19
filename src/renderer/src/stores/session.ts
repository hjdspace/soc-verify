import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from './toast';

export type SessionStatus = 'creating' | 'idle' | 'streaming' | 'tool_executing' | 'error';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: number;
  toolName?: string;
  toolCallId?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  toolStartTime?: number;
  toolEndTime?: number;
  images?: string[];
  isStreaming?: boolean;
  /** LLM thinking/reasoning content, separated from the main response text. */
  thinking?: string;
  /** Skills attached to a user message — used to render skill chips in the message bubble. */
  skills?: SelectedSkill[];
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
}

interface SessionStoreState {
  sessions: SessionEntry[];
  currentSessionId: string | null;
  historySessions: HistorySession[];
  historyLoading: boolean;
  /** Last user-selected model, persisted to localStorage so new sessions reuse it. */
  lastModel: SessionModel | null;

  initLastModel: () => void;

  createSession: (projectId: string, cwd: string) => Promise<string | null>;
  destroySession: (sessionId: string, projectId?: string) => Promise<void>;
  closeSession: (sessionId: string) => void;
  switchSession: (sessionId: string) => void;
  sendMessage: (message: string, images?: string[]) => Promise<void>;
  abortSession: () => Promise<void>;
  renameSession: (sessionId: string, projectId: string, name: string) => Promise<void>;
  setInputMessage: (msg: string) => void;
  handleSessionEvent: (sessionId: string, event: unknown) => void;
  restoreSessions: (projectId: string, cwd: string) => Promise<boolean>;
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
}

let eventListenerRegistered = false;
const historySessionLoads = new Map<string, Promise<void>>();
const runtimeSessionStarts = new Map<string, Promise<string>>();

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

function registerSessionEventListener(get: () => SessionStoreState): void {
  if (eventListenerRegistered || !window.eventBridge) return;
  eventListenerRegistered = true;
  window.eventBridge.onSessionEvent(({ sessionId, event }) => {
    get().handleSessionEvent(sessionId, event);
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
 */
function generateSessionName(message: string): string {
  const firstLine = message.trim().split('\n')[0].trim();
  if (!firstLine) return '新会话';
  if (firstLine.length <= 40) return firstLine;
  return firstLine.slice(0, 40) + '...';
}

function tRPCError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as Record<string, unknown>).message);
  }
  return String(err);
}

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

function normalizeStoredMessages(messages: unknown): ChatMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages.filter((msg): msg is ChatMessage => {
    if (typeof msg !== 'object' || msg === null) return false;
    const m = msg as Record<string, unknown>;
    return (
      typeof m.id === 'string' &&
      (m.role === 'user' || m.role === 'assistant' || m.role === 'tool') &&
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
  if (!updateText && !updateThinking) return;
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
      if (lastAssistantIdx === -1) return sess;
      return {
        ...sess,
        messages: sess.messages.map((m, i) =>
          i === lastAssistantIdx
            ? { ...m, content: updateText, thinking: updateThinking || m.thinking }
            : m,
        ),
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
        })
      : await trpc.session.create.mutate({
          projectId: latest.projectId,
          cwd: latest.cwd ?? cwd,
          provider: latest.model?.provider,
          model: latest.model?.id,
          providerId: latest.model?.providerId,
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
              name: sess.name === '新会话' ? ((result as { name?: string }).name ?? sess.name) : sess.name,
              model: (result as { model?: SessionModel }).model ?? sess.model,
            }
          : sess,
      ),
    }));
    persistSessionMessages(get().sessions.find((sess) => sess.id === latest.id));
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

  createSession: async (projectId, cwd) => {
    const sessionId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const lastModel = get().lastModel;
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
            }
          : sess,
      ),
    }));
    persistSessionMessages(get().sessions.find((sess) => sess.id === sessionId));

    try {
      const runtimeSessionId = await ensureRuntimeSession(sessionId, set, get);
      persistSessionMessages(get().sessions.find((sess) => sess.id === sessionId));
      // Images are passed as full data URLs (data:image/png;base64,...).
      // The runner parses these to extract MIME type + base64 data for the SDK.
      await trpc.session.send.mutate({ sessionId: runtimeSessionId, message: fullMessage, images });

      // Auto-rename session based on the first user message
      if (isFirstMessage && sessionBeforeSend) {
        const autoName = generateSessionName(message);
        void get().renameSession(sessionId, sessionBeforeSend.projectId, autoName);
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
      set((s) => ({
        sessions: s.sessions.map((sess) =>
          sessionMatchesId(sess, sessionId) ? { ...sess, status: 'idle' } : sess,
        ),
      }));
    } catch (err) {
      useToastStore.getState().error('中止会话失败', tRPCError(err));
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
            // Do NOT set status to 'idle' here — the agent may still be working
            // (e.g. multiple messages, tool calls). Only 'agent_end' sets idle.
            return {
              ...sess,
              status: 'streaming',
              messages: sess.messages.map((m) => {
                if (m.role !== 'assistant' || !m.isStreaming) return m;
                return {
                  ...m,
                  isStreaming: false,
                  content: errMsg ? `[错误] ${errMsg}` : (endText || m.content),
                  thinking: endThinking || m.thinking,
                };
              }),
            };
          }

          case 'tool_execution_start': {
            const toolCallId = (evt.toolCallId as string) ?? `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const toolMsg: ChatMessage = {
              id: `tool_${toolCallId}`,
              role: 'tool',
              content: '',
              timestamp: Date.now(),
              toolName: evt.toolName as string,
              toolCallId,
              toolArgs: evt.args,
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
            return {
              ...sess,
              status: 'streaming',
              messages: sess.messages.map((m) => {
                // Match by toolCallId if available (precise), otherwise by toolName + pending (fallback)
                if (m.role !== 'tool' || m.toolResult) return m;
                if (endToolCallId && m.toolCallId) {
                  return m.toolCallId === endToolCallId
                    ? { ...m, toolResult: evt.result, toolEndTime: Date.now() }
                    : m;
                }
                // Fallback: match by toolName (legacy behavior)
                return m.toolName === evt.toolName && !m.toolResult
                  ? { ...m, toolResult: evt.result, toolEndTime: Date.now() }
                  : m;
              }),
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
            // Show agent notices (errors, warnings) in the assistant message
            const noticeText = (evt.message as string) || (evt.text as string) || JSON.stringify(evt);
            return {
              ...sess,
              messages: sess.messages.map((m) =>
                m.role === 'assistant' && m.isStreaming
                  ? { ...m, content: m.content + `\n\n[${type}] ${noticeText}` }
                  : m,
              ),
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
      type === 'irc_message'
    ) {
      schedulePersist(get, sessionId);
    }
    if (type === 'message_end' || type === 'tool_execution_end' || type === 'agent_end') {
      flushPersist(get);
    }
  },

  restoreSessions: async (projectId, cwd) => {
    try {
      const persisted = await trpc.session.getPersistedSessions.query({ projectId });
      if (persisted.length === 0) return false;

      // Sort by lastActivityAt desc so the most recently active session becomes current.
      const sorted = [...persisted].sort((a, b) => b.lastActivityAt - a.lastActivityAt);

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
}));
