// ─── Session Messages Store ───────────────────────────────
//
// 消息流管理：handleSessionEvent、sendMessage、abortSession、compactSession、
// steerSession + 流式 message_update 节流 + 持久化节流 + session:event 监听器。
//
// sessions[] 归 session-core 所有，本 store 通过 useSessionCoreStore.getState()/setState()
// 跨 store 操作 sessions[] 中的 messages、status、subagents、contextUsage 字段。

import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from './toast';
import { tRPCError } from '@renderer/lib/trpc-utils';
import type {
  ChatMessage,
  SessionEntry,
  SubagentActivity,
} from './session-types';
import {
  useSessionCoreStore,
  sessionMatchesId,
  sessionComposer,
  emptyContextUsage,
  readContextUsage,
  readContextBreakdown,
  type SessionCoreSet,
  pendingSessionEvents,
} from './session-core';

// ─── subagent 累积日志上限 ─────────────────────────────────
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

// ─── 消息内容提取辅助 ──────────────────────────────────────
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

// ─── 错误模式 ──────────────────────────────────────────────
const TRANSIENT_ERROR_PATTERNS: readonly RegExp[] = [
  /Transport closed/i,
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /EPIPE/i,
  /ENETUNREACH/i,
  /EHOSTUNREACH/i,
  /fetch failed/i,
  /Transport not connected/i,
  /network error/i,
  /Legacy SSE stream closed/i,
  /Stream closed/i,
];

function isTransientTransportError(errMsg: string): boolean {
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(errMsg));
}

function extractErrorFromMessage(message: Record<string, unknown>): string | null {
  if (typeof message.errorMessage === 'string' && message.errorMessage) {
    const errMsg = message.errorMessage;
    if (isTransientTransportError(errMsg)) return null;
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

// ─── 会话名辅助 ────────────────────────────────────────────
function generateSessionName(message: string): string {
  const firstLine = message.trim().split('\n')[0].trim();
  if (!firstLine) return '新会话';
  if (firstLine.length <= 40) return firstLine;
  return firstLine.slice(0, 40) + '...';
}

function isPlaceholderName(name: string): boolean {
  return name === '新会话' || /^Session [A-Za-z0-9_-]+$/.test(name);
}

const titleGenerationPending = new Set<string>();

async function triggerAiTitleGeneration(
  sessionId: string,
  userMessage: string,
): Promise<void> {
  const get = () => useSessionCoreStore.getState();
  const session = get().sessions.find((s) => sessionMatchesId(s, sessionId));
  if (!session) {
    console.warn('[session:title-generation] session not found, skipping', { sessionId });
    return;
  }

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

// ─── MCP notice 检测 ──────────────────────────────────────
// MCP 工具挂载消息静默处理，不在聊天中显示。
// omp 引擎发送的工具名格式为 mcp__<server>__<tool>（双下划线），
// 因此正则用 \w（含下划线）匹配 mcp_ 前缀后的任意字符。
function isMcpMountNotice(text: string): boolean {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const mcpTools = collapsed.match(/\bmcp_\w+/g) ?? [];
  return /mounted/i.test(collapsed) && mcpTools.length > 0;
}

// ─── 持久化 ────────────────────────────────────────────────
export function persistSessionMessages(session: SessionEntry | undefined): void {
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

// ─── 流式 message_update 节流 ────────────────────────────
let pendingMessageUpdate: { sessionId: string; message: unknown } | null = null;
let messageUpdateTimer: ReturnType<typeof setTimeout> | null = null;
let lastMessageUpdateFlush = 0;
let visibilityListenerRegistered = false;
let flushPendingMessageUpdateRef: (() => void) | null = null;

const MESSAGE_UPDATE_THROTTLE_VISIBLE_MS = 50;
const MESSAGE_UPDATE_THROTTLE_HIDDEN_MS = 500;

// ─── 持久化节流 ──────────────────────────────────────────
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let lastPersistAt = 0;
let flushPersistRef: (() => void) | null = null;
const PERSIST_THROTTLE_MS = 1000;
let pendingPersistSessionId: string | null = null;

function applyMessageUpdateSnapshot(
  set: SessionCoreSet,
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

function flushPendingMessageUpdate(set: SessionCoreSet): void {
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

function scheduleMessageUpdateFlush(set: SessionCoreSet): void {
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

function flushPersist(get: () => ReturnType<typeof useSessionCoreStore.getState>): void {
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

function schedulePersist(get: () => ReturnType<typeof useSessionCoreStore.getState>, sessionId: string): void {
  pendingPersistSessionId = sessionId;
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
    flushPendingMessageUpdateRef?.();
    flushPersistRef?.();
  });
}

// ─── 建议追问生成（回合收尾）──────────────────────────────

/** 助手回复低于该长度不生成建议追问（简短确认没有可追问的内容）。 */
const FOLLOW_UP_MIN_ASSISTANT_CHARS = 20;

/**
 * 回合结束（agent_end）后的建议追问生成：取本轮最后一条用户消息与助手回复，
 * 经 trpc.session.generateFollowUps 做一次轻量 LLM 调用，结果挂到会话上。
 * fire-and-forget——失败静默；写入时校验会话仍空闲且最后一轮助手消息
 * 未变（用户已开始新回合或重新生成时结果作废）。
 */
async function triggerFollowUpGeneration(
  get: () => ReturnType<typeof useSessionCoreStore.getState>,
  sessionId: string,
): Promise<void> {
  const session = get().sessions.find((sess) => sessionMatchesId(sess, sessionId));
  if (!session || session.status !== 'idle') return;

  let lastUser: ChatMessage | undefined;
  let lastAssistant: ChatMessage | undefined;
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (!lastAssistant && msg.role === 'assistant') lastAssistant = msg;
    if (!lastUser && msg.role === 'user') lastUser = msg;
    if (lastUser && lastAssistant) break;
  }
  const assistantText = (lastAssistant?.content ?? '').trim();
  if (!lastUser || !lastAssistant || !assistantText) return;
  if (assistantText.length < FOLLOW_UP_MIN_ASSISTANT_CHARS || assistantText.startsWith('[错误]')) return;

  const expectAssistantId = lastAssistant.id;
  try {
    const result = await trpc.session.generateFollowUps.mutate({
      userMessage: lastUser.content,
      assistantMessage: assistantText,
    });
    const followUps = (result.followUps ?? []).filter((t) => typeof t === 'string' && t.trim());
    if (followUps.length === 0) return;

    useSessionCoreStore.setState((s) => ({
      sessions: s.sessions.map((sess) => {
        if (!sessionMatchesId(sess, sessionId) || sess.status !== 'idle') return sess;
        // 过期守卫：最后一条助手消息仍是本轮那条才写入
        for (let i = sess.messages.length - 1; i >= 0; i--) {
          if (sess.messages[i].role === 'assistant') {
            if (sess.messages[i].id !== expectAssistantId) return sess;
            break;
          }
        }
        return { ...sess, followUps };
      }),
    }));
  } catch {
    // 静默：建议追问生成失败不影响主对话
  }
}

// ─── session:event 监听器 ─────────────────────────────────
let eventListenerRegistered = false;

export function registerSessionEventListener(): void {
  if (eventListenerRegistered || !window.eventBridge) return;
  eventListenerRegistered = true;
  window.eventBridge.onSessionEvent(({ sessionId, event }) => {
    useSessionMessagesStore.getState().handleSessionEvent(sessionId, event);
  });
}

// ─── Store State 接口 ─────────────────────────────────────
export interface SessionMessagesState {
  sendMessage: (message: string, images?: string[]) => Promise<void>;
  abortSession: () => Promise<void>;
  compactSession: () => Promise<boolean>;
  steerSession: (message: string) => Promise<void>;
  regenerateLast: () => Promise<void>;
  handleSessionEvent: (sessionId: string, event: unknown) => void;
  registerMessagesEventListeners: () => void;
}

// ─── Store ─────────────────────────────────────────────────
export const useSessionMessagesStore = create<SessionMessagesState>(() => ({
  sendMessage: async (message, images) => {
    const coreGet = useSessionCoreStore.getState;
    const coreSet = useSessionCoreStore.setState.bind(useSessionCoreStore);
    const sessionId = coreGet().currentSessionId;
    if (!sessionId || !message.trim()) return;

    const sessionBeforeSend = coreGet().sessions.find((s) => s.id === sessionId);
    const isFirstMessage = sessionBeforeSend && sessionBeforeSend.messages.length === 0;
    const firstMessageText = message;

    const composer = sessionComposer(sessionBeforeSend);
    const skills = composer.selectedSkills;
    const contextFiles = composer.contextFiles;
    let fullMessage = message;

    if (skills.length > 0) {
      const skillPrefix = skills.map((s) => `skill://${s.name}`).join('\n');
      fullMessage = `${skillPrefix}\n\n${fullMessage}`;
    }

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

    coreSet((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId
          ? {
            ...sess,
            status: 'streaming',
            messages: [...sess.messages, userMsg, assistantMsg],
            composer: { inputMessage: '', selectedSkills: [], contextFiles: [] },
            contextCompacted: false,
            // 新回合开始，上一轮的建议追问已过时
            followUps: undefined,
          }
          : sess,
      ),
    }));
    persistSessionMessages(coreGet().sessions.find((sess) => sess.id === sessionId));

    try {
      let runtimeSessionId = await coreGet().ensureRuntimeSession(sessionId);
      persistSessionMessages(coreGet().sessions.find((sess) => sess.id === sessionId));
      try {
        await trpc.session.send.mutate({ sessionId: runtimeSessionId, message: fullMessage, images });
      } catch (sendErr) {
        const sendErrMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
        // Session not found OR agent process died (e.g. after abort, idle
        // timeout, or crash) — clear the stale runtimeSessionId and retry
        // with a fresh session created via ensureRuntimeSession.
        if (/Session not found|Client not started|not running/i.test(sendErrMsg)) {
          coreSet((s) => ({
            sessions: s.sessions.map((sess) =>
              sess.id === sessionId
                ? { ...sess, runtimeSessionId: undefined }
                : sess,
            ),
          }));
          runtimeSessionId = await coreGet().ensureRuntimeSession(sessionId);
          await trpc.session.send.mutate({ sessionId: runtimeSessionId, message: fullMessage, images });
        } else {
          throw sendErr;
        }
      }

      if (isFirstMessage && sessionBeforeSend) {
        if (isPlaceholderName(sessionBeforeSend.name)) {
          const autoName = generateSessionName(firstMessageText);
          void coreGet().renameSession(sessionId, sessionBeforeSend.projectId, autoName);
        }
        void triggerAiTitleGeneration(sessionId, firstMessageText);
      }
    } catch (err) {
      const errMsg = tRPCError(err);
      coreSet((s) => ({
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
    const coreGet = useSessionCoreStore.getState;
    const coreSet = useSessionCoreStore.setState.bind(useSessionCoreStore);
    const sessionId = coreGet().currentSessionId;
    if (!sessionId) return;
    const session = coreGet().sessions.find((s) => sessionMatchesId(s, sessionId));
    const runtimeSessionId = session?.runtimeSessionId ?? (!session?.cwd ? sessionId : null);
    if (!runtimeSessionId) {
      coreSet((s) => ({
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
      if (/Session not found/i.test(errMsg)) {
        coreSet((s) => ({
          sessions: s.sessions.map((sess) =>
            sessionMatchesId(sess, sessionId)
              ? { ...sess, status: 'idle', runtimeSessionId: undefined }
              : sess,
          ),
        }));
        coreSet((s) => ({
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
    // abort() kills the agent process (stop() sets process=null). The session
    // entry on the backend is now stale — clear runtimeSessionId so the next
    // sendMessage triggers ensureRuntimeSession to create a fresh session.
    coreSet((s) => ({
      sessions: s.sessions.map((sess) =>
        sessionMatchesId(sess, sessionId)
          ? { ...sess, status: 'idle', runtimeSessionId: undefined }
          : sess,
      ),
    }));
    coreSet((s) => ({
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
    const coreGet = useSessionCoreStore.getState;
    const coreSet = useSessionCoreStore.setState.bind(useSessionCoreStore);
    const sessionId = coreGet().currentSessionId;
    if (!sessionId) return false;
    const session = coreGet().sessions.find((candidate) => candidate.id === sessionId);
    if (
      !session
      || session.status !== 'idle'
      || (session.contextUsage?.tokens ?? 0) <= 0
      || session.isCompacting
      || session.contextCompacted
    ) return false;

    coreSet((state) => ({
      sessions: state.sessions.map((candidate) =>
        candidate.id === sessionId ? { ...candidate, isCompacting: true } : candidate,
      ),
    }));

    try {
      const runtimeSessionId = await coreGet().ensureRuntimeSession(sessionId);
      const result = await trpc.session.compact.mutate({ sessionId: runtimeSessionId });
      coreSet((state) => ({
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
      coreSet((state) => ({
        sessions: state.sessions.map((candidate) =>
          candidate.id === sessionId ? { ...candidate, isCompacting: false } : candidate,
        ),
      }));
      useToastStore.getState().error('上下文压缩失败', tRPCError(err));
      return false;
    }
  },

  steerSession: async (message) => {
    const coreGet = useSessionCoreStore.getState;
    const sessionId = coreGet().currentSessionId;
    if (!sessionId || !message.trim()) return;
    try {
      const runtimeSessionId = await coreGet().ensureRuntimeSession(sessionId);
      await trpc.session.steer.mutate({ sessionId: runtimeSessionId, message });
    } catch (err) {
      useToastStore.getState().error('引导会话失败', tRPCError(err));
    }
  },

  /**
   * Regenerate the last assistant response: drop everything after the latest
   * user message in the UI transcript, then have the engine branch back to
   * that user message and re-prompt (see session.regenerate tRPC procedure).
   *
   * The optimistic placeholder is filled by the regenerated turn's
   * message_start event; on failure the removed messages are rolled back.
   */
  regenerateLast: async () => {
    const coreGet = useSessionCoreStore.getState;
    const coreSet = useSessionCoreStore.setState.bind(useSessionCoreStore);
    const sessionId = coreGet().currentSessionId;
    if (!sessionId) return;
    const session = coreGet().sessions.find((s) => sessionMatchesId(s, sessionId));
    if (!session) return;
    // Regenerating mid-turn would branch a running session — only idle (or a
    // previously failed turn) may regenerate.
    if (session.status !== 'idle' && session.status !== 'error') return;

    let lastUserIdx = -1;
    for (let i = session.messages.length - 1; i >= 0; i--) {
      if (session.messages[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx === -1) return;
    const trailing = session.messages.slice(lastUserIdx + 1);
    // Nothing after the user message — there is no response to regenerate.
    if (trailing.length === 0) return;

    const kept = session.messages.slice(0, lastUserIdx + 1);
    const placeholder: ChatMessage = {
      id: `msg_${Date.now()}`,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    };

    coreSet((s) => ({
      sessions: s.sessions.map((sess) =>
        sessionMatchesId(sess, sessionId)
          ? { ...sess, status: 'streaming', messages: [...kept, placeholder], followUps: undefined }
          : sess,
      ),
    }));
    persistSessionMessages(coreGet().sessions.find((sess) => sessionMatchesId(sess, sessionId)));

    const rollback = () => {
      coreSet((s) => ({
        sessions: s.sessions.map((sess) =>
          sessionMatchesId(sess, sessionId)
            ? { ...sess, status: 'idle', messages: [...kept, ...trailing] }
            : sess,
        ),
      }));
      persistSessionMessages(coreGet().sessions.find((sess) => sessionMatchesId(sess, sessionId)));
    };

    try {
      let runtimeSessionId = await coreGet().ensureRuntimeSession(sessionId);
      try {
        await trpc.session.regenerate.mutate({ sessionId: runtimeSessionId });
      } catch (regenErr) {
        const regenErrMsg = regenErr instanceof Error ? regenErr.message : String(regenErr);
        // Dead runtime process — rebuild it and retry once, mirroring sendMessage.
        if (/Session not found|Client not started|not running/i.test(regenErrMsg)) {
          coreSet((s) => ({
            sessions: s.sessions.map((sess) =>
              sessionMatchesId(sess, sessionId) ? { ...sess, runtimeSessionId: undefined } : sess,
            ),
          }));
          runtimeSessionId = await coreGet().ensureRuntimeSession(sessionId);
          await trpc.session.regenerate.mutate({ sessionId: runtimeSessionId });
        } else {
          throw regenErr;
        }
      }
    } catch (err) {
      rollback();
      useToastStore.getState().error('重新生成失败', tRPCError(err));
    }
  },

  registerMessagesEventListeners: () => {
    registerSessionEventListener();
  },

  handleSessionEvent: (sessionId, event) => {
    const coreGet = useSessionCoreStore.getState;
    const coreSet = useSessionCoreStore.setState.bind(useSessionCoreStore);
    const evt = event as Record<string, unknown>;
    const type = evt.type as string;

    // Error-analysis sessions are created in the main process. Their first
    // agent events can arrive before the separate `started` notification, so
    // retain those events until the renderer creates the matching tab.
    if (!coreGet().sessions.some((session) => sessionMatchesId(session, sessionId)) && sessionId.startsWith('session_')) {
      const pending = pendingSessionEvents.get(sessionId) ?? [];
      if (pending.length < 100) pending.push(event);
      pendingSessionEvents.set(sessionId, pending);
      return;
    }

    console.log(`[session:event] sessionId=${sessionId}, type="${type}"`);

    registerVisibilityListener();
    flushPendingMessageUpdateRef = () => flushPendingMessageUpdate(coreSet);
    flushPersistRef = () => flushPersist(coreGet);

    // ── message_update 走节流路径 ───────────────────────────
    if (type === 'message_update') {
      pendingMessageUpdate = { sessionId, message: evt.message };
      scheduleMessageUpdateFlush(coreSet);
      schedulePersist(coreGet, sessionId);
      return;
    }

    // ── 其它事件：先强制 flush 挂起的 message_update ─────────
    if (pendingMessageUpdate) {
      flushPendingMessageUpdate(coreSet);
    }

    coreSet((s) => ({
      sessions: s.sessions.map((sess) => {
        if (!sessionMatchesId(sess, sessionId)) return sess;

        switch (type) {
          case 'subagent_lifecycle': {
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
            const p = evt.payload as Record<string, unknown> | undefined;
            const prog = p?.progress as Record<string, unknown> | undefined;
            const id = typeof p?.id === 'string' ? p.id : (typeof prog?.id === 'string' ? prog.id : '');
            console.log(`[store] subagent_progress id=${id} tokens=${prog?.tokens} tool=${prog?.currentTool} parentToolCallId=${p?.parentToolCallId}`);
            if (!p || !id) return sess;
            const prev = sess.subagents?.[id];
            if (prev && prev.status !== 'running') return sess;
            const tokens = typeof prog?.tokens === 'number' ? prog.tokens : (prev?.tokens ?? 0);
            const delta = prev ? Math.max(0, tokens - prev.tokens) : tokens;
            const tokenHistory = [...(prev?.tokenHistory ?? []), delta].slice(-16);
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
            const { text: startText, thinking: startThinking } = extractTextFromMessage(message);
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
            const msg = evt.message as Record<string, unknown> | undefined;
            if (msg?.role && msg.role !== 'assistant') return sess;
            const { text: endText, thinking: endThinking } = extractTextFromMessage(msg);
            const errMsg = msg ? extractErrorFromMessage(msg) : null;
            const endToolCalls = extractToolCallsFromMessage(msg);
            const isTransientGlitch = errMsg === null && !endText && !endThinking && endToolCalls.length === 0
              && msg?.errorMessage != null && typeof msg.errorMessage === 'string'
              && isTransientTransportError(msg.errorMessage as string);
            if (isTransientGlitch) {
              return sess;
            }
            return {
              ...sess,
              status: 'streaming',
              messages: (() => {
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
            const rawNoticeText = (evt.message as string) || (evt.text as string);
            if (!rawNoticeText) return sess;
            // MCP 挂载消息静默跳过，不显示在聊天中
            if (isMcpMountNotice(rawNoticeText)) return sess;
            const noticeText = rawNoticeText.replace(/\s+/g, ' ').trim();
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
            // MCP 挂载消息静默跳过，不追加到 assistant 内容
            if (isMcpMountNotice(ircText)) return sess;
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
            const isErr = type === 'error' || type?.includes('error') || evt.error;
            if (isErr) {
              const errText = (evt.error as string) || (evt.message as string) || JSON.stringify(evt);
              if (isTransientTransportError(errText)) return sess;
              return {
                ...sess,
                status: 'error' as SessionEntry['status'],
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
      schedulePersist(coreGet, sessionId);
    }
    if (type === 'message_end' || type === 'tool_execution_end' || type === 'agent_end') {
      flushPersist(coreGet);
    }
    // 回合结束后的建议追问生成（fire-and-forget，失败静默）
    if (type === 'agent_end') {
      void triggerFollowUpGeneration(coreGet, sessionId);
    }
  },
}));
