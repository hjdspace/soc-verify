// ─── Session Approval Store ───────────────────────────────
//
// 工具审批 + ask 队列管理。审批模式（approvalMode）存储在 sessions[] 中
// （归 session-core 所有），本 store 通过 useSessionCoreStore 跨 store 操作。

import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from './toast';
import { useUiStore } from './ui';
import { tRPCError } from '@renderer/lib/trpc-utils';
import type { AskAnswer, AskQuestion } from '@shared/ask-types';
import type {
  ApprovalMode,
  ApprovalRequest,
  AskRequest,
  TrustRequest,
} from './session-types';
import { useSessionCoreStore } from './session-core';

const APPROVAL_MODE_STORAGE_KEY = 'socverify:approvalMode';

// ─── Store State 接口 ─────────────────────────────────────
export interface SessionApprovalState {
  /** Pending approval requests awaiting user decision */
  approvalRequests: ApprovalRequest[];
  /** Pending ask requests awaiting user answers */
  askRequests: AskRequest[];
  /** Pending trust requests awaiting user decision（issue 04） */
  trustRequests: TrustRequest[];

  setApprovalMode: (mode: ApprovalMode) => void;
  resolveApproval: (requestId: string, approved: boolean) => Promise<void>;
  resolveAsk: (requestId: string, answers: AskAnswer[]) => Promise<void>;
  resolveTrust: (requestId: string, approved: boolean) => Promise<void>;
  registerApprovalEventListeners: () => void;
}

// ─── approval/ask/trust 事件监听器 ─────────────────────────
let approvalRequestListenerRegistered = false;
let askRequestListenerRegistered = false;
let trustRequestListenerRegistered = false;

function registerApprovalRequestListener(): void {
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
    useSessionApprovalStore.setState((s) => ({ approvalRequests: [...s.approvalRequests, request] }));

    // Auto-expand the right panel if collapsed so the user sees the request
    if (useUiStore.getState().rightPanelCollapsed) {
      useUiStore.getState().toggleRightPanel();
    }
  });
}

function registerAskRequestListener(): void {
  if (askRequestListenerRegistered || !window.eventBridge?.onAskRequest) return;
  askRequestListenerRegistered = true;
  window.eventBridge.onAskRequest((data: { sessionId: string; requestId: string; questions: unknown[] }) => {
    const questions = (data.questions as AskQuestion[]).map((q) => ({
      id: typeof q.id === 'string' ? q.id : `q_${Math.random().toString(36).slice(2, 8)}`,
      question: typeof q.question === 'string' ? q.question : '',
      options: Array.isArray(q.options) ? q.options.map((o: AskQuestion['options'][number]) => {
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
    useSessionApprovalStore.setState((s) => ({ askRequests: [...s.askRequests, request] }));

    // Auto-expand the right panel if collapsed so the user sees the question
    if (useUiStore.getState().rightPanelCollapsed) {
      useUiStore.getState().toggleRightPanel();
    }
  });
}

function registerTrustRequestListener(): void {
  if (trustRequestListenerRegistered || !window.eventBridge?.onTrustRequest) return;
  trustRequestListenerRegistered = true;
  window.eventBridge.onTrustRequest((data: { sessionId: string; requestId: string; kind: 'project-extension' | 'mcp-server'; name: string; path?: string }) => {
    const request: TrustRequest = {
      requestId: data.requestId,
      sessionId: data.sessionId,
      kind: data.kind,
      name: data.name,
      ...(data.path !== undefined ? { path: data.path } : {}),
      timestamp: Date.now(),
    };
    useSessionApprovalStore.setState((s) => ({ trustRequests: [...s.trustRequests, request] }));

    // Auto-expand the right panel if collapsed so the user sees the request
    if (useUiStore.getState().rightPanelCollapsed) {
      useUiStore.getState().toggleRightPanel();
    }
  });
}

// ─── Store ─────────────────────────────────────────────────
export const useSessionApprovalStore = create<SessionApprovalState>((set, get) => ({
  approvalRequests: [],
  askRequests: [],
  trustRequests: [],

  setApprovalMode: (mode) => {
    const coreGet = useSessionCoreStore.getState;
    const coreSet = useSessionCoreStore.setState.bind(useSessionCoreStore);
    const sessionId = coreGet().currentSessionId;
    if (!sessionId) return;
    try {
      localStorage.setItem(APPROVAL_MODE_STORAGE_KEY, mode);
    } catch {
      // localStorage might be unavailable — ignore
    }
    coreSet((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId
          ? { ...sess, approvalMode: mode }
          : sess,
      ),
    }));
    // Fire-and-forget: backend dynamically re-wraps tools on the running session.
    const session = coreGet().sessions.find((sess) => sess.id === sessionId);
    const runtimeSessionId = session?.runtimeSessionId ?? sessionId;
    void trpc.session.setApprovalMode.mutate({ sessionId: runtimeSessionId, approvalMode: mode }).catch(() => {});
  },

  resolveApproval: async (requestId, approved) => {
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
    set((s) => ({
      askRequests: s.askRequests.filter((r) => r.requestId !== requestId),
    }));
    try {
      await trpc.session.resolveAsk.mutate({ requestId, answers });
    } catch (err) {
      useToastStore.getState().error('提交答案失败', tRPCError(err));
    }
  },

  resolveTrust: async (requestId, approved) => {
    // kind 需随请求透传（wire 协议字段）；队列中不存在说明已决议，直接忽略
    const request = get().trustRequests.find((r) => r.requestId === requestId);
    if (!request) return;
    set((s) => ({
      trustRequests: s.trustRequests.filter((r) => r.requestId !== requestId),
    }));
    try {
      await trpc.session.resolveTrust.mutate({
        requestId,
        approved,
        kind: request.kind,
        ...(request.path !== undefined ? { path: request.path } : {}),
      });
    } catch (err) {
      useToastStore.getState().error('信任确认失败', tRPCError(err));
    }
  },

  registerApprovalEventListeners: () => {
    registerApprovalRequestListener();
    registerAskRequestListener();
    registerTrustRequestListener();
  },
}));
