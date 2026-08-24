/**
 * Coverage Gaps Store — 目标 / 缺口 / 分诊 / 排除 / Delta / 趋势。
 *
 * 从原 coverage.ts 中提取的 gaps 领域。
 * currentSessionId 归 coverage-core，本 store 的 action 必须 explicit 传入 sessionId。
 */

import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from '../toast';
// 跨 store 引用：sessionId 缺省时从 core store 读取
import { useCoverageCoreStore } from './coverage-core';
import type {
  CoverageSummary,
  CoverageMetric,
  CoverageGap,
  CoverageDelta,
  CoverageTriage,
  CoverageExclusion,
  TriageCause,
  TriageConfidence,
  ExclusionStatus,
} from '@shared/types';

type CoverageGapsState = {
  // ─── 目标 / 缺口 / 分诊 / 排除 ──────────────────────────
  /** 当前 session 的覆盖率目标（与默认值合并后的有效目标） */
  targets: Partial<Record<CoverageMetric, number>>;
  /** 当前 session 的 Gap 列表 */
  gaps: CoverageGap[];
  /** 当前 session 的 Triage 列表 */
  triages: CoverageTriage[];
  /** 当前 session 的 Exclusion 列表 */
  exclusions: CoverageExclusion[];
  /** 两个 session 之间的 Delta（手动计算后填充） */
  delta: { before: CoverageSummary; after: CoverageSummary; deltas: CoverageDelta[] } | null;
  /** 覆盖率趋势数据（按 session 时间序列） */
  trend: Array<{ sessionId: string; createdAt: number; summary: CoverageSummary }>;

  // ─── Actions ──────────────────────────────────────────────
  /** 内部使用：由 coverage-core.loadTree 调用，同步 targets 状态 */
  setTargetsState: (targets: Partial<Record<CoverageMetric, number>>) => void;
  /** 内部使用：由 coverage-core.deleteSession 调用，清空 session 相关数据 */
  clearSessionData: () => void;

  loadTargets: (projectId: string, sessionId?: string) => Promise<void>;
  setTargets: (
    projectId: string,
    sessionId: string,
    targets: Partial<Record<CoverageMetric, number>>,
  ) => Promise<void>;
  loadGaps: (projectId: string, sessionId?: string) => Promise<void>;
  loadDelta: (
    projectId: string,
    sessionIdBefore: string,
    sessionIdAfter: string,
  ) => Promise<void>;
  loadTrend: (projectId: string, limit?: number) => Promise<void>;
  loadTriages: (projectId: string, sessionId?: string) => Promise<void>;
  addTriage: (
    projectId: string,
    input: {
      sessionId: string;
      nodePath: string;
      metric: CoverageMetric;
      gap: CoverageGap;
      cause?: TriageCause;
      confidence?: TriageConfidence;
      note?: string;
      triagedBy?: string;
    },
  ) => Promise<void>;
  deleteTriage: (projectId: string, id: string) => Promise<void>;
  loadExclusions: (
    projectId: string,
    sessionId?: string,
    status?: ExclusionStatus,
  ) => Promise<void>;
  requestExclusion: (
    projectId: string,
    input: {
      sessionId: string;
      nodePath: string;
      metric: CoverageMetric;
      reason: string;
      requestedBy: string;
    },
  ) => Promise<void>;
  approveExclusion: (projectId: string, id: string, approver: string) => Promise<void>;
  rejectExclusion: (
    projectId: string,
    id: string,
    approver: string,
    reason: string,
  ) => Promise<void>;
};

export const useCoverageGapsStore = create<CoverageGapsState>((set, get) => ({
  targets: {},
  gaps: [],
  triages: [],
  exclusions: [],
  delta: null,
  trend: [],

  setTargetsState: (targets) => set({ targets }),

  clearSessionData: () => set({ gaps: [], triages: [], exclusions: [], targets: {} }),

  loadTargets: async (projectId, sessionId) => {
    const sid = sessionId ?? useCoverageCoreStore.getState().currentSessionId ?? undefined;
    if (!sid) return;
    try {
      const targets = await trpc.coverage.getTarget.query({ projectId, sessionId: sid });
      set({ targets });
    } catch (err) {
      useToastStore.getState().error('加载覆盖率目标失败', err instanceof Error ? err.message : String(err));
    }
  },

  setTargets: async (projectId, sessionId, targets) => {
    try {
      const merged = await trpc.coverage.setTarget.mutate({ projectId, sessionId, targets });
      set({ targets: merged });
      // 目标变化后 Gap 也要刷新
      await get().loadGaps(projectId, sessionId);
      useToastStore.getState().success('覆盖率目标已保存');
    } catch (err) {
      useToastStore.getState().error('保存覆盖率目标失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadGaps: async (projectId, sessionId) => {
    const sid = sessionId ?? useCoverageCoreStore.getState().currentSessionId ?? undefined;
    if (!sid) return;
    try {
      const result = await trpc.coverage.listGaps.query({ projectId, sessionId: sid });
      set({ gaps: result.gaps });
    } catch (err) {
      useToastStore.getState().error('加载覆盖率缺口失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadDelta: async (projectId, sessionIdBefore, sessionIdAfter) => {
    try {
      const delta = await trpc.coverage.getDelta.query({
        projectId,
        sessionIdBefore,
        sessionIdAfter,
      });
      set({ delta });
    } catch (err) {
      useToastStore.getState().error('计算覆盖率变化失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadTrend: async (projectId, limit) => {
    try {
      const result = await trpc.coverage.getTrend.query({ projectId, limit: limit ?? 20 });
      set({ trend: result });
    } catch (err) {
      useToastStore.getState().error('加载覆盖率趋势失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadTriages: async (projectId, sessionId) => {
    const sid = sessionId ?? useCoverageCoreStore.getState().currentSessionId ?? undefined;
    if (!sid) return;
    try {
      const triages = await trpc.coverage.listTriage.query({ projectId, sessionId: sid });
      set({ triages });
    } catch (err) {
      useToastStore.getState().error('加载 Triage 列表失败', err instanceof Error ? err.message : String(err));
    }
  },

  addTriage: async (projectId, input) => {
    try {
      await trpc.coverage.addTriage.mutate({ projectId, ...input });
      await get().loadTriages(projectId, input.sessionId);
      useToastStore.getState().success('Triage 已添加');
    } catch (err) {
      useToastStore.getState().error('添加 Triage 失败', err instanceof Error ? err.message : String(err));
    }
  },

  deleteTriage: async (projectId, id) => {
    try {
      await trpc.coverage.deleteTriage.mutate({ projectId, id });
      // 重新加载当前 session 的 triages
      const sessionId = get().triages[0]?.sessionId;
      if (sessionId) {
        await get().loadTriages(projectId, sessionId);
      } else {
        set({ triages: [] });
      }
      useToastStore.getState().success('Triage 已删除');
    } catch (err) {
      useToastStore.getState().error('删除 Triage 失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadExclusions: async (projectId, sessionId, status) => {
    const sid = sessionId ?? useCoverageCoreStore.getState().currentSessionId ?? undefined;
    if (!sid) return;
    try {
      const exclusions = await trpc.coverage.listExclusions.query({
        projectId,
        sessionId: sid,
        status,
      });
      set({ exclusions });
    } catch (err) {
      useToastStore.getState().error('加载排除项列表失败', err instanceof Error ? err.message : String(err));
    }
  },

  requestExclusion: async (projectId, input) => {
    try {
      await trpc.coverage.requestExclusion.mutate({ projectId, ...input });
      await get().loadExclusions(projectId, input.sessionId);
      useToastStore.getState().success('排除请求已提交，等待审批');
    } catch (err) {
      useToastStore.getState().error('提交排除请求失败', err instanceof Error ? err.message : String(err));
    }
  },

  approveExclusion: async (projectId, id, approver) => {
    try {
      await trpc.coverage.approveExclusion.mutate({ projectId, id, approver });
      // 刷新当前 session 的 exclusions
      const sessionId = get().exclusions[0]?.sessionId;
      if (sessionId) {
        await get().loadExclusions(projectId, sessionId);
      }
      useToastStore.getState().success('排除项已通过审批');
    } catch (err) {
      useToastStore.getState().error('审批失败', err instanceof Error ? err.message : String(err));
    }
  },

  rejectExclusion: async (projectId, id, approver, reason) => {
    try {
      await trpc.coverage.rejectExclusion.mutate({ projectId, id, approver, reason });
      // 刷新当前 session 的 exclusions
      const sessionId = get().exclusions[0]?.sessionId;
      if (sessionId) {
        await get().loadExclusions(projectId, sessionId);
      }
      useToastStore.getState().success('排除请求已驳回');
    } catch (err) {
      useToastStore.getState().error('驳回失败', err instanceof Error ? err.message : String(err));
    }
  },
}));
