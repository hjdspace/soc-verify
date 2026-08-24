/**
 * Coverage Closure Store — 闭环流程 / Test Promotion。
 *
 * 从原 coverage.ts 中提取的 closure + promotion 领域。
 * currentSessionId 归 coverage-core，本 store 的 action 必须 explicit 传入 sessionId。
 */

import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from '../toast';
import { useProjectStore } from '../project';
import type { PromotionQueueItem, ClosureSummary } from '@shared/types';
import type { ClosureSession, ClosureLiveProgress } from './coverage-types';

type CoverageClosureState = {
  // ─── Closure 相关状态 ────────────────────────────────────
  /** 所有 Closure Session 列表 */
  closures: ClosureSession[];
  /** 当前选中的 closureId */
  currentClosureId: string | null;
  /** 当前选中的 ClosureSession 完整数据 */
  currentClosure: ClosureSession | null;
  /** 实时进度（由 closure:event 事件流更新） */
  closureLive: ClosureLiveProgress;
  /** closure 事件监听器是否已注册 */
  closureListenerRegistered: boolean;

  // ─── Test Promotion 状态 ────────────────────────────────
  /** Test Promotion 审阅队列 */
  promotionQueue: PromotionQueueItem[];
  /** Closure 闭环结果摘要 */
  closureSummary: ClosureSummary | null;
  /** 是否正在执行 Test Promotion 提升 */
  promoting: boolean;

  // ─── Closure Actions ──────────────────────────────────────
  startClosure: (
    projectId: string,
    sessionId: string,
    /** 选中的模块路径列表；缺省自动聚合全部有 gap 的模块 */
    modules?: string[],
    maxRounds?: number,
  ) => Promise<string | null>;
  abortClosure: (projectId: string, closureId: string) => Promise<void>;
  /** 单独中止一个 target（Issue 06）：中止即转人工（escalated），不影响其他 target */
  abortClosureTarget: (projectId: string, closureId: string, targetId: string) => Promise<void>;
  loadClosures: (projectId: string) => Promise<void>;
  loadClosure: (projectId: string, closureId: string) => Promise<void>;
  setCurrentClosure: (closureId: string | null) => void;
  /** 注册 closure:event IPC 监听器（幂等，全局只需注册一次） */
  registerClosureEventListener: () => void;
  /** 处理 closure:event 事件（内部使用） */
  handleClosureEvent: (event: { type: string; [key: string]: unknown }) => void;

  // ─── Test Promotion Actions ────────────────────────────────
  /** 加载 Test Promotion 审阅队列 */
  loadPromotionQueue: (projectId: string, closureId: string) => Promise<void>;
  /** 执行 Test Promotion：接受的复制到正式目录，拒绝的丢弃 */
  promoteTests: (
    projectId: string,
    closureId: string,
    accepted: string[],
    rejected: string[],
  ) => Promise<void>;
  /** 加载 Closure 闭环结果摘要 */
  loadClosureSummary: (projectId: string, closureId: string) => Promise<void>;
  /** 清理 Closure Workspace 临时目录 */
  cleanupClosure: (projectId: string, closureId: string) => Promise<void>;
};

export const useCoverageClosureStore = create<CoverageClosureState>((set, get) => ({
  closures: [],
  currentClosureId: null,
  currentClosure: null,
  closureLive: { running: false },
  closureListenerRegistered: false,

  // ─── Test Promotion 初始状态 ────────────────────────────
  promotionQueue: [],
  closureSummary: null,
  promoting: false,

  // ─── Closure 实现 ──────────────────────────────────────────

  startClosure: async (projectId, sessionId, modules, maxRounds) => {
    try {
      const session = await trpc.coverage.startClosure.mutate({
        projectId,
        sessionId,
        modules,
        maxRounds,
      });
      set({
        currentClosureId: session.id,
        currentClosure: session,
        closureLive: { running: true },
        closures: [...get().closures, session],
      });
      useToastStore.getState().success('AI Closure 已启动', `${session.targets.length} 个目标模块`);
      return session.id;
    } catch (err) {
      useToastStore.getState().error('启动 AI Closure 失败', err instanceof Error ? err.message : String(err));
      return null;
    }
  },

  abortClosure: async (projectId, closureId) => {
    try {
      await trpc.coverage.abortClosure.mutate({ projectId, closureId });
      set({ closureLive: { running: false } });
      // 刷新当前 closure 状态（应变为 aborted）
      await get().loadClosure(projectId, closureId);
      useToastStore.getState().info('AI Closure 已中止');
    } catch (err) {
      useToastStore.getState().error('中止 AI Closure 失败', err instanceof Error ? err.message : String(err));
    }
  },

  abortClosureTarget: async (projectId, closureId, targetId) => {
    try {
      await trpc.coverage.abortClosureTarget.mutate({ projectId, closureId, targetId });
      useToastStore.getState().info('Target 已中止，转为人工处理');
      // 刷新当前 closure（该 target 将在检查点后变为 escalated）
      await get().loadClosure(projectId, closureId);
    } catch (err) {
      useToastStore.getState().error('中止 Target 失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadClosures: async (projectId) => {
    try {
      const closures = await trpc.coverage.listClosures.query({ projectId });
      set({ closures });
    } catch (err) {
      useToastStore.getState().error('加载 Closure 列表失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadClosure: async (projectId, closureId) => {
    try {
      const closure = await trpc.coverage.getClosure.query({ projectId, closureId });
      set({
        currentClosureId: closureId,
        currentClosure: closure,
        // 若 closure 已进入终态，同步关闭 live 运行标志
        closureLive: closure && ['completed', 'aborted', 'failed'].includes(closure.status)
          ? { running: false }
          : get().closureLive,
      });
    } catch (err) {
      useToastStore.getState().error('加载 Closure 详情失败', err instanceof Error ? err.message : String(err));
    }
  },

  setCurrentClosure: (closureId) => {
    if (closureId === null) {
      set({ currentClosureId: null, currentClosure: null });
      return;
    }
    const found = get().closures.find((c) => c.id === closureId) ?? null;
    set({ currentClosureId: closureId, currentClosure: found });
  },

  registerClosureEventListener: () => {
    if (get().closureListenerRegistered) return;
    if (!window.eventBridge) return;
    set({ closureListenerRegistered: true });
    window.eventBridge.onClosureEvent((event) => {
      get().handleClosureEvent(event);
    });
  },

  handleClosureEvent: (event) => {
    const type = event.type;
    const closureId = typeof event.closureId === 'string' ? event.closureId : undefined;
    if (!closureId) return;

    const current = get().currentClosureId;
    const isCurrent = current === closureId;

    // 根据事件类型更新 closureLive（仅当事件属于当前关注的 closure）
    if (isCurrent) {
      const live = { ...get().closureLive };
      live.running = true;

      switch (type) {
        case 'closure:started':
          live.running = true;
          break;
        case 'closure:gap_started':
          live.activeTargetId = typeof event.targetId === 'string' ? event.targetId : live.activeTargetId;
          live.activeRound = typeof event.round === 'number' ? event.round : live.activeRound;
          live.agentPhase = undefined;
          break;
        case 'closure:agent_prompting':
          live.agentSessionId = typeof event.sessionId === 'string' ? event.sessionId : live.agentSessionId;
          live.agentPhase = 'prompting';
          break;
        case 'closure:agent_ended':
          live.agentPhase = 'ended';
          break;
        case 'closure:tests_scanned':
          live.lastGeneratedTests = Array.isArray(event.files) ? (event.files as string[]) : live.lastGeneratedTests;
          break;
        case 'closure:recovery_started':
          live.agentPhase = 'recovering';
          break;
        case 'closure:recovery_done':
          live.lastDeltaOverall = typeof event.deltaOverall === 'number' ? event.deltaOverall : live.lastDeltaOverall;
          live.agentPhase = undefined;
          break;
        case 'closure:recovery_failed':
          live.lastError = typeof event.error === 'string' ? event.error : 'Recovery 失败';
          live.agentPhase = undefined;
          break;
        case 'closure:iteration_done':
          live.lastDeltaOverall = typeof event.deltaOverall === 'number' ? event.deltaOverall : live.lastDeltaOverall;
          live.agentPhase = undefined;
          break;
        case 'closure:gap_closed':
          live.activeTargetId = undefined;
          live.activeRound = undefined;
          live.agentPhase = undefined;
          break;
        case 'closure:gap_escalated':
          // 记录升级原因（Issue 06：详情页展示 escalationReason / AI triage 前态）
          live.lastEscalation = {
            targetId: typeof event.targetId === 'string' ? event.targetId : '',
            reason: typeof event.reason === 'string' ? event.reason : '',
          };
          live.activeTargetId = undefined;
          live.activeRound = undefined;
          live.agentPhase = undefined;
          break;
        case 'closure:exclusion_suggested':
          // AI 建议已持久化为 pending（工单 07）——审批面板数据由
          // ExclusionApprovalPanel 自行拉取，live 状态无变化；下方 loadClosure 兜底刷新
          break;
        case 'closure:gap_failed':
          live.lastError = typeof event.error === 'string' ? event.error : 'Target 失败';
          live.activeTargetId = undefined;
          live.activeRound = undefined;
          live.agentPhase = undefined;
          break;
        case 'closure:completed':
        case 'closure:aborted':
          live.running = false;
          live.activeTargetId = undefined;
          live.activeRound = undefined;
          live.agentPhase = undefined;
          break;
        case 'closure:finalized':
          // 固化完成，mergeSessionId 可用于后续操作（best-effort，不改变 live 状态）
          break;
        case 'closure:error':
          live.running = false;
          live.lastError = typeof event.error === 'string' ? event.error : 'Closure 错误';
          break;
        default:
          break;
      }
      set({ closureLive: live });
    }

    // 异步刷新当前 closure 完整数据（兜底 IPC 推送，确保状态一致）
    if (isCurrent) {
      const projectId = useProjectStore.getState().currentProjectId;
      if (projectId) {
        void get().loadClosure(projectId, closureId);
      }
    }
  },

  // ─── Test Promotion 实现 ────────────────────────────────

  loadPromotionQueue: async (projectId, closureId) => {
    try {
      const queue = await trpc.coverage.getPromotionQueue.query({ projectId, closureId });
      set({ promotionQueue: queue });
    } catch (err) {
      useToastStore.getState().error('加载 Test Promotion 队列失败', err instanceof Error ? err.message : String(err));
    }
  },

  promoteTests: async (projectId, closureId, accepted, rejected) => {
    set({ promoting: true });
    try {
      const result = await trpc.coverage.promoteTests.mutate({
        projectId,
        closureId,
        accepted,
        rejected,
      });
      set({ promoting: false });
      // 刷新队列状态和摘要
      await get().loadPromotionQueue(projectId, closureId);
      await get().loadClosureSummary(projectId, closureId);
      useToastStore.getState().success(
        'Test Promotion 完成',
        `已提升 ${result.promoted} 个测试，拒绝 ${result.rejected} 个`,
      );
    } catch (err) {
      set({ promoting: false });
      useToastStore.getState().error('Test Promotion 失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadClosureSummary: async (projectId, closureId) => {
    try {
      const summary = await trpc.coverage.getClosureSummary.query({ projectId, closureId });
      set({ closureSummary: summary });
    } catch (err) {
      useToastStore.getState().error('加载 Closure 摘要失败', err instanceof Error ? err.message : String(err));
    }
  },

  cleanupClosure: async (projectId, closureId) => {
    try {
      await trpc.coverage.cleanupClosure.mutate({ projectId, closureId });
      // 清理后清空本地队列与摘要
      set({ promotionQueue: [], closureSummary: null });
      useToastStore.getState().success('Closure Workspace 已清理');
    } catch (err) {
      useToastStore.getState().error('清理 Closure Workspace 失败', err instanceof Error ? err.message : String(err));
    }
  },
}));
