import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from './toast';
import type {
  CoverageData,
  CoverageMergeSession,
  CoverageSummary,
  EdaToolConfig,
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
  loading: boolean;
  importing: boolean;

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
}

export const useCoverageStore = create<CoverageStoreState>((set, get) => ({
  sessions: [],
  currentSessionId: null,
  tree: null,
  overview: null,
  edaConfig: null,
  loading: false,
  importing: false,

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
}));
