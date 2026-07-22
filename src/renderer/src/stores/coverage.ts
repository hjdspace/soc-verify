import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from './toast';
import type {
  CoverageData,
  CoverageMergeSession,
  CoverageSummary,
  EdaToolConfig,
  CoverageMetric,
  CoverageGap,
  CoverageDelta,
  CoverageTriage,
  CoverageExclusion,
  TriageCause,
  TriageConfidence,
  ExclusionStatus,
} from '@shared/types';

interface CoverageStoreState {
  /** 所有 Coverage Merge Session（按创建时间倒序） */
  sessions: CoverageMergeSession[];
  /** 当前选中的 session ID */
  currentSessionId: string | null;
  /** 当前 session 的完整 CoverageData（层级树） */
  tree: CoverageData | null;
  /** 扁平摘要（root 8 metric 百分比），由 tree 派生 */
  overview: CoverageSummary | null;
  /** 项目级 EDA Tool Configuration */
  edaConfig: EdaToolConfig | null;
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
  loading: boolean;
  importing: boolean;

  /** 当前 UI 视图：树表格 / 仪表盘 */
  view: 'tree-table' | 'dashboard';
  setView: (view: 'tree-table' | 'dashboard') => void;

  loadSessions: (projectId: string) => Promise<void>;
  loadTree: (projectId: string, sessionId?: string) => Promise<void>;
  loadEdaConfig: (projectId: string) => Promise<void>;
  setEdaConfig: (projectId: string, config: EdaToolConfig) => Promise<void>;
  importCoverage: (
    projectId: string,
    covMergeDir: string,
    edaConfig?: EdaToolConfig,
  ) => Promise<string | null>;
  setSessionId: (sessionId: string | null) => void;

  // ─── Slice 2 新增 ──────────────────────────────────────────
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
  deleteSession: (projectId: string, sessionId: string) => Promise<boolean>;
}

export const useCoverageStore = create<CoverageStoreState>((set, get) => ({
  sessions: [],
  currentSessionId: null,
  tree: null,
  overview: null,
  edaConfig: null,
  targets: {},
  gaps: [],
  triages: [],
  exclusions: [],
  delta: null,
  loading: false,
  importing: false,
  view: 'tree-table',

  setView: (view) => set({ view }),

  loadSessions: async (projectId) => {
    try {
      const sessions = await trpc.coverage.listSessions.query({ projectId });
      set({ sessions });
      // 若无选中 session 且有 session 列表，默认选第一个
      if (!get().currentSessionId && sessions.length > 0) {
        set({ currentSessionId: sessions[0].sessionId });
      }
    } catch (err) {
      useToastStore.getState().error('加载覆盖率 session 列表失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadTree: async (projectId, sessionId) => {
    const sid = sessionId ?? get().currentSessionId ?? undefined;
    set({ loading: true });
    try {
      const tree = await trpc.coverage.getTree.query({ projectId, sessionId: sid });
      const overview = await trpc.coverage.getOverview.query({ projectId, sessionId: sid });
      set({
        tree,
        overview: overview.summary,
        currentSessionId: overview.sessionId,
        loading: false,
      });
    } catch (err) {
      set({ loading: false, tree: null, overview: null });
      useToastStore.getState().error('加载覆盖率数据失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadEdaConfig: async (projectId) => {
    try {
      const config = await trpc.coverage.getEdaConfig.query({ projectId });
      set({ edaConfig: config });
    } catch {
      // Best-effort
    }
  },

  setEdaConfig: async (projectId, config) => {
    try {
      const saved = await trpc.coverage.setEdaConfig.mutate({ projectId, config });
      set({ edaConfig: saved });
    } catch (err) {
      useToastStore.getState().error('保存 EDA 配置失败', err instanceof Error ? err.message : String(err));
    }
  },

  importCoverage: async (projectId, covMergeDir, edaConfig) => {
    set({ importing: true });
    try {
      const result = await trpc.coverage.import.mutate({
        projectId,
        covMergeDir,
        edaConfig,
      });
      set({ importing: false, currentSessionId: result.sessionId, overview: result.summary });
      // 导入后刷新 session 列表和树
      await get().loadSessions(projectId);
      await get().loadTree(projectId, result.sessionId);
      useToastStore.getState().success('覆盖率导入成功', `Session: ${result.sessionId}`);
      return result.sessionId;
    } catch (err) {
      set({ importing: false });
      useToastStore.getState().error('覆盖率导入失败', err instanceof Error ? err.message : String(err));
      return null;
    }
  },

  setSessionId: (sessionId) => set({ currentSessionId: sessionId }),

  // ─── Slice 2 实现 ──────────────────────────────────────────

  loadTargets: async (projectId, sessionId) => {
    const sid = sessionId ?? get().currentSessionId ?? undefined;
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
    const sid = sessionId ?? get().currentSessionId ?? undefined;
    try {
      const result = await trpc.coverage.listGaps.query({ projectId, sessionId: sid });
      set({ gaps: result.gaps, currentSessionId: result.sessionId });
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

  loadTriages: async (projectId, sessionId) => {
    const sid = sessionId ?? get().currentSessionId ?? undefined;
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
      await get().loadTriages(projectId);
      useToastStore.getState().success('Triage 已删除');
    } catch (err) {
      useToastStore.getState().error('删除 Triage 失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadExclusions: async (projectId, sessionId, status) => {
    const sid = sessionId ?? get().currentSessionId ?? undefined;
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
      await get().loadExclusions(projectId);
      useToastStore.getState().success('排除项已通过审批');
    } catch (err) {
      useToastStore.getState().error('审批失败', err instanceof Error ? err.message : String(err));
    }
  },

  rejectExclusion: async (projectId, id, approver, reason) => {
    try {
      await trpc.coverage.rejectExclusion.mutate({ projectId, id, approver, reason });
      await get().loadExclusions(projectId);
      useToastStore.getState().success('排除请求已驳回');
    } catch (err) {
      useToastStore.getState().error('驳回失败', err instanceof Error ? err.message : String(err));
    }
  },

  deleteSession: async (projectId, sessionId) => {
    try {
      await trpc.coverage.deleteSession.mutate({ projectId, sessionId });
      // 切换当前 session 到剩余的第一个（若有）
      const remaining = get().sessions.filter((s) => s.sessionId !== sessionId);
      set({
        sessions: remaining,
        currentSessionId: get().currentSessionId === sessionId
          ? (remaining[0]?.sessionId ?? null)
          : get().currentSessionId,
        tree: get().currentSessionId === sessionId ? null : get().tree,
        overview: get().currentSessionId === sessionId ? null : get().overview,
        gaps: get().currentSessionId === sessionId ? [] : get().gaps,
        triages: get().currentSessionId === sessionId ? [] : get().triages,
        exclusions: get().currentSessionId === sessionId ? [] : get().exclusions,
      });
      useToastStore.getState().success('Session 已删除');
      return true;
    } catch (err) {
      useToastStore.getState().error('删除 session 失败', err instanceof Error ? err.message : String(err));
      return false;
    }
  },
}));
