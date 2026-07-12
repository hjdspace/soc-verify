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
  images?: string[];
  isStreaming?: boolean;
}

export interface SessionEntry {
  id: string;
  projectId: string;
  name: string;
  status: SessionStatus;
  messages: ChatMessage[];
  createdAt: number;
}

interface SessionStoreState {
  sessions: SessionEntry[];
  currentSessionId: string | null;
  inputMessage: string;
  isSending: boolean;

  createSession: (projectId: string, cwd: string) => Promise<string | null>;
  destroySession: (sessionId: string) => Promise<void>;
  switchSession: (sessionId: string) => void;
  sendMessage: (message: string) => Promise<void>;
  abortSession: () => Promise<void>;
  setSessionName: (sessionId: string, name: string) => void;
  setInputMessage: (msg: string) => void;
  handleSessionEvent: (sessionId: string, event: unknown) => void;
  refreshSessions: () => Promise<void>;
}

let eventListenerRegistered = false;

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

  createSession: async (projectId, cwd) => {
    try {
      const result = await trpc.session.create.mutate({ projectId, cwd });
      const session: SessionEntry = {
        id: result.sessionId,
        projectId,
        name: `会话 ${get().sessions.length + 1}`,
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

  destroySession: async (sessionId) => {
    try {
      await trpc.session.destroy.mutate({ sessionId });
      set((s) => ({
        sessions: s.sessions.filter((sess) => sess.id !== sessionId),
        currentSessionId: s.currentSessionId === sessionId ? null : s.currentSessionId,
      }));
    } catch (err) {
      useToastStore.getState().error('销毁会话失败', tRPCError(err));
    }
  },

  switchSession: (sessionId) => {
    set({ currentSessionId: sessionId });
  },

  sendMessage: async (message) => {
    const sessionId = get().currentSessionId;
    if (!sessionId || !message.trim()) return;

    const userMsg: ChatMessage = {
      id: `msg_${Date.now()}`,
      role: 'user',
      content: message,
      timestamp: Date.now(),
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
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId
          ? { ...sess, status: 'streaming', messages: [...sess.messages, userMsg, assistantMsg] }
          : sess,
      ),
    }));

    try {
      await trpc.session.send.mutate({ sessionId, message });
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

  setInputMessage: (msg) => set({ inputMessage: msg }),

  handleSessionEvent: (sessionId, event) => {
    const evt = event as Record<string, unknown>;
    const type = evt.type as string;

    set((s) => ({
      sessions: s.sessions.map((sess) => {
        if (sess.id !== sessionId) return sess;

        switch (type) {
          case 'message_start':
            return { ...sess, status: 'streaming' };

          case 'message_update': {
            const delta = evt.delta as string | undefined;
            if (!delta) return sess;
            return {
              ...sess,
              messages: sess.messages.map((m, i) =>
                i === sess.messages.length - 1 && m.role === 'assistant'
                  ? { ...m, content: m.content + delta }
                  : m,
              ),
            };
          }

          case 'message_end':
            return {
              ...sess,
              status: 'idle',
              messages: sess.messages.map((m, i) =>
                i === sess.messages.length - 1 && m.role === 'assistant'
                  ? { ...m, isStreaming: false }
                  : m,
              ),
            };

          case 'tool_execution_start': {
            const toolMsg: ChatMessage = {
              id: `tool_${Date.now()}`,
              role: 'tool',
              content: '',
              timestamp: Date.now(),
              toolName: evt.toolName as string,
              toolArgs: evt.args,
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
                  ? { ...m, toolResult: evt.result }
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

          default:
            return sess;
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
      // Full session restore would need omp --resume
      set({
        sessions: sessions.map((s) => ({
          id: s.id,
          projectId: s.projectId,
          name: `会话 ${s.id.slice(-6)}`,
          status: 'idle' as SessionStatus,
          messages: [],
          createdAt: s.createdAt,
        })),
      });
    } catch (err) {
      useToastStore.getState().error('刷新会话列表失败', tRPCError(err));
    }
  },
}));
