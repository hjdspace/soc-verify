// ─── Session Core Store ──────────────────────────────────
//
// 会话生命周期 + 元数据管理。拥有 sessions[] 数组（单一数据源），
// 其他 store（session-messages / session-approval）通过
// useSessionCoreStore.getState() / setState() 跨 store 操作 sessions[]。

import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from './toast';
import { useUiStore } from './ui';
import { useSettingsStore } from './settings';
import { tRPCError } from '@renderer/lib/trpc-utils';
import { DEFAULT_CONTEXT_WINDOW, type ContextBreakdown, type ContextUsage } from '@shared/context-management';
import { normalizeThinkingLevelSetting, type ThinkingLevelSetting } from '@shared/types';
import type {
  ApprovalMode,
  ChatMessage,
  HistorySession,
  SessionEntry,
  SessionModel,
  SessionComposer,
} from './session-types';

// ─── 常量 ──────────────────────────────────────────────────
const MODEL_STORAGE_KEY = 'socverify:lastModel';
const APPROVAL_MODE_STORAGE_KEY = 'socverify:approvalMode';
const THINKING_LEVEL_STORAGE_KEY = 'socverify:thinkingLevel';

// ─── 模块级辅助 / 缓存 ────────────────────────────────────
const historySessionLoads = new Map<string, Promise<void>>();
const runtimeSessionStarts = new Map<string, Promise<string>>();
const pendingSessionEvents = new Map<string, unknown[]>();

// ─── 工具函数 ──────────────────────────────────────────────
export function sessionMatchesId(session: SessionEntry, sessionId: string): boolean {
  return (
    session.id === sessionId ||
    session.runtimeSessionId === sessionId ||
    session.persistedSessionId === sessionId
  );
}

export function emptyComposer(): SessionComposer {
  return { inputMessage: '', selectedSkills: [], contextFiles: [] };
}

export function sessionComposer(session: SessionEntry | undefined): SessionComposer {
  return session?.composer ?? emptyComposer();
}

export function emptyContextUsage(): ContextUsage {
  const configured = useSettingsStore.getState().contextWindow;
  const contextWindow = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_CONTEXT_WINDOW;
  return { tokens: 0, contextWindow, percent: 0 };
}

export function readContextUsage(value: unknown, fallback: ContextUsage): ContextUsage {
  if (typeof value !== 'object' || value === null) return fallback;
  const usage = value as Record<string, unknown>;
  if (typeof usage.tokens !== 'number' || typeof usage.contextWindow !== 'number') return fallback;
  const percent = typeof usage.percent === 'number'
    ? usage.percent
    : usage.contextWindow > 0 ? (usage.tokens / usage.contextWindow) * 100 : 0;
  return { tokens: usage.tokens, contextWindow: usage.contextWindow, percent };
}

export function readContextBreakdown(value: unknown, fallback?: ContextBreakdown): ContextBreakdown | undefined {
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

function isPlaceholderName(name: string): boolean {
  return name === '新会话' || /^Session [A-Za-z0-9_-]+$/.test(name);
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
      (m.role === 'user' || m.role === 'assistant' || m.role === 'tool' || m.role === 'system') &&
      typeof m.content === 'string' &&
      typeof m.timestamp === 'number'
    );
  });
}

// ─── 模块级 setter 类型（供跨 store 使用） ────────────────
export type SessionCoreSet = (
  partial: Partial<SessionCoreState> | ((state: SessionCoreState) => Partial<SessionCoreState>),
) => void;

// ─── Store State 接口 ─────────────────────────────────────
export interface SessionCoreState {
  sessions: SessionEntry[];
  currentSessionId: string | null;
  historySessions: HistorySession[];
  historyLoading: boolean;
  /** Last user-selected model, persisted to localStorage so new sessions reuse it. */
  lastModel: SessionModel | null;

  initLastModel: () => void;
  registerCoreEventListeners: () => void;
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
  renameSession: (sessionId: string, projectId: string, name: string) => Promise<void>;
  restoreSessions: (projectId: string, cwd: string, lastSessionIds?: string[]) => Promise<boolean>;
  setModel: (sessionId: string, provider: string, modelId: string, modelName?: string, providerId?: string) => Promise<void>;
  setThinkingLevel: (level: ThinkingLevelSetting) => void;
  applyCredential: (sessionId: string, providerId: string) => Promise<void>;
  ensureRuntimeSession: (sessionId: string) => Promise<string>;
  setInputMessage: (msg: string) => void;
  addSkill: (skill: import('./session-types').SelectedSkill) => void;
  removeSkill: (name: string) => void;
  addContextFile: (file: import('./session-types').ContextFile) => void;
  removeContextFile: (path: string) => void;
  fetchHistorySessions: (projectId: string) => Promise<void>;
  loadHistorySession: (historySession: HistorySession, projectId: string, cwd: string) => Promise<void>;
  deleteHistorySession: (sessionId: string, projectId: string) => Promise<void>;
}

// ─── cwd changed 监听器 ───────────────────────────────────
let cwdChangedListenerRegistered = false;

function registerCwdChangedListener(get: () => SessionCoreState): void {
  if (cwdChangedListenerRegistered || !window.eventBridge?.onCwdChanged) return;
  cwdChangedListenerRegistered = true;
  window.eventBridge.onCwdChanged((data: { projectId: string; cwd: string; dirId: string }) => {
    const state = get();
    if (state.currentSessionId) {
      const session = state.sessions.find((s) => sessionMatchesId(s, state.currentSessionId!));
      if (!session || session.projectId !== data.projectId) return;

      const runtimeSessionId = session.runtimeSessionId;
      if (!runtimeSessionId) {
        setSessionCwd(session.id, data.cwd);
        return;
      }

      void trpc.session.destroy.mutate({ sessionId: runtimeSessionId }).catch(() => {
      }).finally(() => {
        setSessionCwdAndClearRuntime(session.id, data.cwd);
      });
    }
  });
}

function setSessionCwd(sessionId: string, cwd: string): void {
  useSessionCoreStore.setState((s) => ({
    sessions: s.sessions.map((sess) =>
      sess.id === sessionId ? { ...sess, cwd } : sess,
    ),
  }));
}

function setSessionCwdAndClearRuntime(sessionId: string, cwd: string): void {
  useSessionCoreStore.setState((s) => ({
    sessions: s.sessions.map((sess) =>
      sess.id === sessionId
        ? { ...sess, cwd, runtimeSessionId: undefined }
        : sess,
    ),
  }));
}

// ─── error-analysis 事件监听器 ────────────────────────────
let errorAnalysisListenerRegistered = false;

function registerErrorAnalysisEventListener(get: () => SessionCoreState): void {
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

// ─── ensureRuntimeSession ─────────────────────────────────
//
// 创建或恢复 runtime session。由 session-messages 的 sendMessage 等操作调用。
// 修改的字段（runtimeSessionId、persistedSessionId、name、model）都是 session-core
// 管理的元数据。pendingEvents 重放通过跨 store 调用 session-messages 的 handleSessionEvent。

// session-messages 的函数在运行时调用（非模块顶层），
// ESM 循环依赖安全：session-messages.ts import session-core.ts 的导出在加载时就已定义。
import { useSessionMessagesStore, persistSessionMessages, registerSessionEventListener } from './session-messages';

// ─── Store ─────────────────────────────────────────────────
export const useSessionCoreStore = create<SessionCoreState>((set, get) => ({
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

  registerCoreEventListeners: () => {
    registerCwdChangedListener(get);
    registerErrorAnalysisEventListener(get);
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

    // 重放 pending events（同步调用 session-messages 的 handleSessionEvent）
    const pending = pendingSessionEvents.get(event.sessionId);
    if (pending) {
      pendingSessionEvents.delete(event.sessionId);
      const handleSessionEvent = useSessionMessagesStore.getState().handleSessionEvent;
      for (const pendingEvent of pending) {
        handleSessionEvent(event.sessionId, pendingEvent);
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
    let storedThinkingLevel: ThinkingLevelSetting | undefined;
    try {
      const saved = localStorage.getItem(THINKING_LEVEL_STORAGE_KEY);
      if (saved) storedThinkingLevel = normalizeThinkingLevelSetting(saved);
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
      thinkingLevel: storedThinkingLevel ?? 'default',
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

  ensureRuntimeSession: async (sessionId) => {
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
      registerSessionEventListener();

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
          thinkingLevel: latest.thinkingLevel,
        })
        : await trpc.session.create.mutate({
          projectId: latest.projectId,
          cwd: latest.cwd ?? cwd,
          provider: latest.model?.provider,
          model: latest.model?.id,
          providerId: latest.model?.providerId,
          approvalMode: latest.approvalMode,
          thinkingLevel: latest.thinkingLevel,
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
              name: isPlaceholderName(sess.name) && (result as { name?: string }).name && !isPlaceholderName((result as { name?: string }).name!)
                ? (result as { name?: string }).name!
                : sess.name,
              model: (result as { model?: SessionModel }).model ?? sess.model,
            }
            : sess,
        ),
      }));

      // 重放 pending events
      const pendingEvents = pendingSessionEvents.get(runtimeSessionId);
      if (pendingEvents) {
        pendingSessionEvents.delete(runtimeSessionId);
        const handleSessionEvent = useSessionMessagesStore.getState().handleSessionEvent;
        for (const pendingEvent of pendingEvents) {
          handleSessionEvent(runtimeSessionId, pendingEvent);
        }
      }

      // 持久化初始消息
      persistSessionMessages(get().sessions.find((sess) => sess.id === latest.id));

      // Fire-and-forget: fetch the current context usage
      void (async () => {
        try {
          const state = await trpc.session.getState.query({ sessionId: runtimeSessionId });
          const stateObj = state as Record<string, unknown> | null;
          if (!stateObj || typeof stateObj !== 'object') return;
          const usage = stateObj.contextUsage;
          set((s) => ({
            sessions: s.sessions.map((sess) =>
              sess.id === latest.id
                ? {
                  ...sess,
                  // 后端返回的是 omp 会话的 configured thinking level —— omp 文件
                  // 原生恢复的值会覆盖 UI 侧暂存值；undefined 时保留 UI 现值。
                  thinkingLevel: stateObj.thinkingLevel !== undefined && stateObj.thinkingLevel !== null
                    ? normalizeThinkingLevelSetting(stateObj.thinkingLevel)
                    : sess.thinkingLevel,
                  ...(usage !== undefined && usage !== null
                    ? {
                      contextUsage: readContextUsage(usage, sess.contextUsage ?? emptyContextUsage()),
                      autoCompactionEnabled: stateObj.autoCompactionEnabled !== false,
                    }
                    : {}),
                }
                : sess,
            ),
          }));
        } catch {
          // Best-effort
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
  },

  setModel: async (sessionId, provider, modelId, modelName, providerId) => {
    const model: SessionModel = { provider, id: modelId, name: modelName ?? modelId, providerId };

    localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(model));
    set((s) => ({
      lastModel: model,
      sessions: s.sessions.map((sess) =>
        sessionMatchesId(sess, sessionId)
          ? { ...sess, model }
          : sess,
      ),
    }));

    try {
      const runtimeSessionId = await get().ensureRuntimeSession(sessionId);
      const result = await trpc.session.setModel.mutate({
        sessionId: runtimeSessionId,
        provider,
        modelId,
        modelName,
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
      useToastStore.getState().error('切换模型失败', tRPCError(err));
    }
  },

  /**
   * 设置思考强度：更新当前会话 UI 状态 + 持久化到 localStorage（新会话继承），
   * 并 fire-and-forget 推送到运行中的 omp 会话（runner 持久化进 omp 会话文件，
   * 模型整体切换 / 应用重启后的原生 resume 都能保留）。
   * 会话尚未启动时仅落 UI 状态，create 时经 InitConfig.thinkingLevel 下发。
   */
  setThinkingLevel: (level) => {
    const sessionId = get().currentSessionId;
    if (!sessionId) return;
    try {
      localStorage.setItem(THINKING_LEVEL_STORAGE_KEY, level);
    } catch {
      // localStorage might be unavailable — ignore
    }
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId ? { ...sess, thinkingLevel: level } : sess,
      ),
    }));
    const session = get().sessions.find((sess) => sess.id === sessionId);
    const runtimeSessionId = session?.runtimeSessionId;
    if (!runtimeSessionId) return;
    void trpc.session.setThinkingLevel.mutate({ sessionId: runtimeSessionId, level }).catch(() => {});
  },

  applyCredential: async (sessionId, providerId) => {
    try {
      const runtimeSessionId = await get().ensureRuntimeSession(sessionId);
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

  setInputMessage: (msg) => set((state) => ({
    sessions: state.sessions.map((session) => session.id === state.currentSessionId
      ? { ...session, composer: { ...sessionComposer(session), inputMessage: msg } }
      : session),
  })),

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

  restoreSessions: async (projectId, cwd, lastSessionIds) => {
    try {
      const persisted = await trpc.session.getPersistedSessions.query({ projectId });
      if (persisted.length === 0) return false;

      const openIdSet = lastSessionIds && lastSessionIds.length > 0
        ? new Set(lastSessionIds)
        : null;
      const filtered = openIdSet
        ? persisted.filter((p) => openIdSet.has(p.sessionId))
        : persisted;
      if (filtered.length === 0) return false;

      const sorted = [...filtered].sort((a, b) => b.lastActivityAt - a.lastActivityAt);

      const existingIds = new Set(
        get().sessions
          .map((s) => s.persistedSessionId ?? s.id)
          .filter((id): id is string => Boolean(id)),
      );
      const toRestore = sorted.filter((p) => !existingIds.has(p.sessionId));
      if (toRestore.length === 0) {
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
    const existing = get().sessions.find(
      (s) => sessionMatchesId(s, historySession.sessionId),
    );
    if (existing) {
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

// ─── pendingSessionEvents 导出（供 session-messages 使用） ──
export { pendingSessionEvents };
