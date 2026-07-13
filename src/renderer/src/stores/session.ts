import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from './toast';

export type SessionStatus = 'idle' | 'streaming' | 'tool_executing' | 'error';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: number;
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  toolStartTime?: number;
  toolEndTime?: number;
  images?: string[];
  isStreaming?: boolean;
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
}

export interface SelectedSkill {
  name: string;
  description: string;
  filePath: string;
  source: 'project' | 'user';
}

export interface ContextFile {
  name: string;
  path: string;
  type: 'file' | 'directory';
}

export interface SessionEntry {
  id: string;
  projectId: string;
  name: string;
  status: SessionStatus;
  messages: ChatMessage[];
  createdAt: number;
  model?: SessionModel;
}

interface SessionStoreState {
  sessions: SessionEntry[];
  currentSessionId: string | null;
  inputMessage: string;
  isSending: boolean;
  selectedSkills: SelectedSkill[];
  contextFiles: ContextFile[];

  createSession: (projectId: string, cwd: string) => Promise<string | null>;
  destroySession: (sessionId: string, projectId?: string) => Promise<void>;
  closeSession: (sessionId: string) => void;
  switchSession: (sessionId: string) => void;
  sendMessage: (message: string, images?: string[]) => Promise<void>;
  abortSession: () => Promise<void>;
  setSessionName: (sessionId: string, name: string) => void;
  renameSession: (sessionId: string, projectId: string, name: string) => Promise<void>;
  setInputMessage: (msg: string) => void;
  handleSessionEvent: (sessionId: string, event: unknown) => void;
  refreshSessions: () => Promise<void>;
  restoreSessions: (projectId: string, cwd: string) => Promise<void>;
  getAvailableModels: (sessionId: string) => Promise<AvailableModel[]>;
  setModel: (sessionId: string, provider: string, modelId: string, modelName?: string) => Promise<void>;
  steerSession: (message: string) => Promise<void>;
  addSkill: (skill: SelectedSkill) => void;
  removeSkill: (name: string) => void;
  clearSkills: () => void;
  addContextFile: (file: ContextFile) => void;
  removeContextFile: (path: string) => void;
  clearContextFiles: () => void;
}

let eventListenerRegistered = false;

/**
 * Extract text from an agent message object.
 *
 * agent message events (message_start, message_update, message_end) carry a
 * `message` field which is an AssistantMessage with a `content` array of
 * content blocks. TextContent blocks have `{ type: "text", text: "..." }`.
 * ThinkingContent blocks have `{ type: "thinking", thinking: "..." }`.
 *
 * This function concatenates all text and thinking blocks into a single string.
 */
function extractTextFromMessage(message: unknown): string {
  if (typeof message !== 'object' || message === null) return '';
  const msg = message as Record<string, unknown>;
  const content = msg.content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
      // Optionally include thinking content — prefixed for clarity
      parts.push(`[思考] ${b.thinking}`);
    }
  }
  return parts.join('\n');
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

export const useSessionStore = create<SessionStoreState>((set, get) => ({
  sessions: [],
  currentSessionId: null,
  inputMessage: '',
  isSending: false,
  selectedSkills: [],
  contextFiles: [],

  createSession: async (projectId, cwd) => {
    try {
      const result = await trpc.session.create.mutate({ projectId, cwd });
      const session: SessionEntry = {
        id: result.sessionId,
        projectId,
        name: (result as { name?: string }).name ?? '新会话',
        status: 'idle',
        messages: [],
        createdAt: Date.now(),
      };
      set((s) => ({
        sessions: [...s.sessions, session],
        currentSessionId: result.sessionId,
      }));

      // Register IPC event listener once
      if (!eventListenerRegistered && window.eventBridge) {
        eventListenerRegistered = true;
        window.eventBridge.onSessionEvent(({ sessionId, event }) => {
          get().handleSessionEvent(sessionId, event);
        });
      }

      useToastStore.getState().success('AI 会话已创建');
      return result.sessionId;
    } catch (err) {
      useToastStore.getState().error('创建会话失败', tRPCError(err));
      return null;
    }
  },

  destroySession: async (sessionId, projectId) => {
    try {
      await trpc.session.destroy.mutate({ sessionId, projectId });
      set((s) => ({
        sessions: s.sessions.filter((sess) => sess.id !== sessionId),
        currentSessionId: s.currentSessionId === sessionId ? null : s.currentSessionId,
      }));
    } catch (err) {
      useToastStore.getState().error('销毁会话失败', tRPCError(err));
    }
  },

  closeSession: (sessionId) => {
    // Just remove from UI without destroying the backend session
    set((s) => ({
      sessions: s.sessions.filter((sess) => sess.id !== sessionId),
      currentSessionId: s.currentSessionId === sessionId ? null : s.currentSessionId,
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
    const skills = get().selectedSkills;
    const contextFiles = get().contextFiles;
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
    };

    const assistantMsg: ChatMessage = {
      id: `msg_${Date.now() + 1}`,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    };

    set((s) => ({
      inputMessage: '',
      isSending: true,
      selectedSkills: [],
      contextFiles: [],
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId
          ? { ...sess, status: 'streaming', messages: [...sess.messages, userMsg, assistantMsg] }
          : sess,
      ),
    }));

    try {
      await trpc.session.send.mutate({ sessionId, message: fullMessage, images });

      // Auto-rename session based on the first user message
      if (isFirstMessage && sessionBeforeSend) {
        const autoName = generateSessionName(message);
        void get().renameSession(sessionId, sessionBeforeSend.projectId, autoName);
      }
    } catch (err) {
      const errMsg = tRPCError(err);
      set((s) => ({
        isSending: false,
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
    try {
      await trpc.session.abort.mutate({ sessionId });
      set((s) => ({
        isSending: false,
        sessions: s.sessions.map((sess) =>
          sess.id === sessionId ? { ...sess, status: 'idle' } : sess,
        ),
      }));
    } catch (err) {
      useToastStore.getState().error('中止会话失败', tRPCError(err));
    }
  },

  setSessionName: (sessionId, name) => {
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId ? { ...sess, name } : sess,
      ),
    }));
  },

  renameSession: async (sessionId, projectId, name) => {
    try {
      await trpc.session.rename.mutate({ sessionId, projectId, name });
      set((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.id === sessionId ? { ...sess, name } : sess,
        ),
      }));
    } catch (err) {
      useToastStore.getState().error('重命名会话失败', tRPCError(err));
    }
  },

  setInputMessage: (msg) => set({ inputMessage: msg }),

  handleSessionEvent: (sessionId, event) => {
    const evt = event as Record<string, unknown>;
    const type = evt.type as string;

    // Log event type for debugging (avoid dumping full event object — it can be very large)
    console.log(`[session:event] sessionId=${sessionId}, type="${type}"`);

    set((s) => ({
      sessions: s.sessions.map((sess) => {
        if (sess.id !== sessionId) return sess;

        switch (type) {
          case 'message_start': {
            const message = evt.message as Record<string, unknown> | undefined;
            if (message?.role && message.role !== 'assistant') return sess;
            // Extract initial text from message.content if available
            const text = extractTextFromMessage(message);
            // Check if there's already a streaming assistant message
            const hasStreaming = sess.messages.some((m) => m.role === 'assistant' && m.isStreaming);
            if (hasStreaming) {
              return {
                ...sess,
                status: 'streaming',
                messages: sess.messages.map((m) =>
                  m.role === 'assistant' && m.isStreaming && text
                    ? { ...m, content: text }
                    : m,
                ),
              };
            }
            // No streaming assistant message — create a new one
            // (this happens when the agent sends multiple messages in one turn)
            const newMsg: ChatMessage = {
              id: `msg_${Date.now()}`,
              role: 'assistant',
              content: text,
              timestamp: Date.now(),
              isStreaming: true,
            };
            return {
              ...sess,
              status: 'streaming',
              messages: [...sess.messages, newMsg],
            };
          }

          case 'message_update': {
            const message = evt.message as Record<string, unknown> | undefined;
            if (message?.role && message.role !== 'assistant') return sess;
            // agent message_update events contain a full message snapshot, not a delta string.
            // The message.content array has TextContent blocks with accumulated text.
            // We replace (not append) the assistant message content with the latest snapshot.
            const text = extractTextFromMessage(message);
            if (!text) return sess;
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
                  ? { ...m, content: text }
                  : m,
              ),
            };
          }

          case 'message_end': {
            // Extract final text from message.content — this is the authoritative
            // source for the assistant's response, especially when there are no
            // message_update events (non-streaming or empty streaming responses).
            const msg = evt.message as Record<string, unknown> | undefined;
            if (msg?.role && msg.role !== 'assistant') return sess;
            const text = extractTextFromMessage(msg);
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
                  content: errMsg ? `[错误] ${errMsg}` : (text || m.content),
                };
              }),
            };
          }

          case 'tool_execution_start': {
            const toolMsg: ChatMessage = {
              id: `tool_${Date.now()}`,
              role: 'tool',
              content: '',
              timestamp: Date.now(),
              toolName: evt.toolName as string,
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
            return {
              ...sess,
              status: 'streaming',
              messages: sess.messages.map((m) =>
                m.role === 'tool' && m.toolName === evt.toolName && !m.toolResult
                  ? { ...m, toolResult: evt.result, toolEndTime: Date.now() }
                  : m,
              ),
            };
          }

          case 'agent_start':
            return { ...sess, status: 'streaming' };

          case 'agent_end':
            return {
              ...sess,
              status: 'idle',
              isSending: false,
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
                isSending: false,
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

    // Update isSending when agent ends
    if (type === 'agent_end') {
      set({ isSending: false });
    }
  },

  refreshSessions: async () => {
    try {
      const sessions = await trpc.session.list.query();
      // The list from tRPC only returns basic info, not messages
      // Full session restore would need agent --resume
      set({
        sessions: sessions.map((s) => ({
          id: s.id,
          projectId: s.projectId,
          name: '新会话',
          status: 'idle' as SessionStatus,
          messages: [],
          createdAt: s.createdAt,
        })),
      });
    } catch (err) {
      useToastStore.getState().error('刷新会话列表失败', tRPCError(err));
    }
  },

  restoreSessions: async (projectId, cwd) => {
    try {
      const persisted = await trpc.session.getPersistedSessions.query({ projectId });
      if (persisted.length === 0) return;

      for (const p of persisted) {
        try {
          const result = await trpc.session.restore.mutate({
            projectId,
            cwd,
            sessionId: p.sessionId,
            name: p.name,
          });
          const session: SessionEntry = {
            id: result.sessionId,
            projectId,
            name: result.name,
            status: 'idle',
            messages: [],
            createdAt: p.createdAt,
            model: result.model ?? p.model,
          };
          set((s) => ({
            sessions: [...s.sessions, session],
            currentSessionId: s.currentSessionId ?? result.sessionId,
          }));
        } catch {
          // Skip sessions that fail to restore
        }
      }
    } catch {
      // Best-effort restore
    }
  },

  getAvailableModels: async (sessionId) => {
    try {
      const models = await trpc.session.getAvailableModels.query({ sessionId });
      return (models as AvailableModel[]) || [];
    } catch (err) {
      useToastStore.getState().error('获取可用模型失败', tRPCError(err));
      return [];
    }
  },

  setModel: async (sessionId, provider, modelId, modelName) => {
    try {
      await trpc.session.setModel.mutate({ sessionId, provider, modelId, modelName });
      set((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.id === sessionId
            ? { ...sess, model: { provider, id: modelId, name: modelName ?? modelId } }
            : sess,
        ),
      }));
      useToastStore.getState().success('模型已切换');
    } catch (err) {
      useToastStore.getState().error('切换模型失败', tRPCError(err));
    }
  },

  addSkill: (skill) => set((s) => {
    if (s.selectedSkills.some((sk) => sk.name === skill.name)) return s;
    return { selectedSkills: [...s.selectedSkills, skill] };
  }),

  removeSkill: (name) => set((s) => ({
    selectedSkills: s.selectedSkills.filter((sk) => sk.name !== name),
  })),

  clearSkills: () => set({ selectedSkills: [] }),

  addContextFile: (file) => set((s) => {
    if (s.contextFiles.some((f) => f.path === file.path)) return s;
    return { contextFiles: [...s.contextFiles, file] };
  }),

  removeContextFile: (path) => set((s) => ({
    contextFiles: s.contextFiles.filter((f) => f.path !== path),
  })),

  clearContextFiles: () => set({ contextFiles: [] }),

  steerSession: async (message) => {
    const sessionId = get().currentSessionId;
    if (!sessionId || !message.trim()) return;
    try {
      await trpc.session.steer.mutate({ sessionId, message });
    } catch (err) {
      useToastStore.getState().error('引导会话失败', tRPCError(err));
    }
  },
}));
