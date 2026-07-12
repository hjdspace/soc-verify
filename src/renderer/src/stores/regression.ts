import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from './toast';
import type { RegressionSuite, RegressionResult } from '@shared/types';

interface RegressionStoreState {
  suites: RegressionSuite[];
  currentResult: RegressionResult | null;
  compareResult: {
    run1: RegressionResult | null;
    run2: RegressionResult | null;
    newFailures: Array<{ caseId: string; caseName: string }>;
    fixed: Array<{ caseId: string; caseName: string }>;
    unchanged: Array<{ caseId: string; caseName: string; status: string }>;
  } | null;
  history: RegressionResult[];
  loading: boolean;

  loadSuites: (projectId: string) => Promise<void>;
  createSuite: (projectId: string, name: string, caseIds: string[], options: Record<string, unknown>) => Promise<void>;
  updateSuite: (projectId: string, name: string, caseIds?: string[], options?: Record<string, unknown>) => Promise<void>;
  deleteSuite: (projectId: string, name: string) => Promise<void>;
  runSuite: (projectId: string, name: string) => Promise<void>;
  getResult: (projectId: string, runId: string) => Promise<void>;
  compareRuns: (projectId: string, runId1: string, runId2: string) => Promise<void>;
  loadHistory: (projectId: string, suiteName?: string) => Promise<void>;
}

export const useRegressionStore = create<RegressionStoreState>((set) => ({
  suites: [],
  currentResult: null,
  compareResult: null,
  history: [],
  loading: false,

  loadSuites: async (projectId) => {
    try {
      const suites = await trpc.regression.list.query({ projectId });
      set({ suites });
    } catch (err) {
      useToastStore.getState().error('加载回归套件失败', err instanceof Error ? err.message : String(err));
    }
  },

  createSuite: async (projectId, name, caseIds, options) => {
    try {
      await trpc.regression.create.mutate({ projectId, name, caseIds, options });
      await useRegressionStore.getState().loadSuites(projectId);
      useToastStore.getState().success('回归套件已创建');
    } catch (err) {
      useToastStore.getState().error('创建套件失败', err instanceof Error ? err.message : String(err));
    }
  },

  updateSuite: async (projectId, name, caseIds, options) => {
    try {
      await trpc.regression.update.mutate({ projectId, name, caseIds, options });
      await useRegressionStore.getState().loadSuites(projectId);
      useToastStore.getState().success('套件已更新');
    } catch (err) {
      useToastStore.getState().error('更新套件失败', err instanceof Error ? err.message : String(err));
    }
  },

  deleteSuite: async (projectId, name) => {
    try {
      await trpc.regression.delete.mutate({ projectId, name });
      await useRegressionStore.getState().loadSuites(projectId);
      useToastStore.getState().success('套件已删除');
    } catch (err) {
      useToastStore.getState().error('删除套件失败', err instanceof Error ? err.message : String(err));
    }
  },

  runSuite: async (projectId, name) => {
    try {
      set({ loading: true });
      const result = await trpc.regression.run.mutate({ projectId, name });
      useToastStore.getState().success(`回归套件 "${name}" 已启动`, `运行 ID: ${result.runId}`);
      set({ loading: false, currentResult: result.results });
    } catch (err) {
      set({ loading: false });
      useToastStore.getState().error('启动回归失败', err instanceof Error ? err.message : String(err));
    }
  },

  getResult: async (projectId, runId) => {
    try {
      const result = await trpc.regression.getResult.query({ projectId, runId });
      set({ currentResult: result });
    } catch (err) {
      useToastStore.getState().error('获取结果失败', err instanceof Error ? err.message : String(err));
    }
  },

  compareRuns: async (projectId, runId1, runId2) => {
    try {
      const result = await trpc.regression.compareRuns.query({ projectId, runId1, runId2 });
      set({ compareResult: result });
    } catch (err) {
      useToastStore.getState().error('对比失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadHistory: async (projectId, suiteName) => {
    try {
      const history = await trpc.regression.getHistory.query({ projectId, suiteName });
      set({ history });
    } catch (err) {
      useToastStore.getState().error('加载历史失败', err instanceof Error ? err.message : String(err));
    }
  },
}));
