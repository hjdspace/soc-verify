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
} from './session-types';
import { useSessionCoreStore } from './session-core';

const APPROVAL_MODE_STORAGE_KEY = 'socverify:approvalMode';

// ─── Store State 接口 ─────────────────────────────────────
export interface SessionApprovalState {
  /** Pending approval requests awaiting user decision */
  approvalRequests: ApprovalRequest[];
  /** Pending ask requests awaiting user answers */
  askRequests: AskRequest[];

  setApprovalMode: (mode: ApprovalMode) => void;
  resolveApproval: (requestId: string, approved: boolean) => Promise<void>;
  resolveAsk: (requestId: string, answers: AskAnswer[]) => Promise<void>;
  registerApprovalEventListeners: () => void;
}

// ─── approval/ask 事件监听器 ──────────────────────────────
let approvalRequestListenerRegistered = false;
let askRequestListenerRegistered = false;

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

// ─── Store ─────────────────────────────────────────────────
export const useSessionApprovalStore = create<SessionApprovalState>((set) => ({
  approvalRequests: [],
  askRequests: [],

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

  registerApprovalEventListeners: () => {
    registerApprovalRequestListener();
    registerAskRequestListener();
  },
}));
