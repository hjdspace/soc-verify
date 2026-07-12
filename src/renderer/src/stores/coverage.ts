import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from './toast';
import type { CoverageSummary, CoverageBySubsys } from '@shared/types';

interface CoverageStoreState {
  overview: CoverageSummary | null;
  subsysCoverage: CoverageBySubsys[];
  currentRunId: string | null;
  cachedRuns: string[];
  loading: boolean;

  loadOverview: (projectId: string, runId?: string) => Promise<void>;
  loadBySubsys: (projectId: string, runId?: string) => Promise<void>;
  loadCachedRuns: (projectId: string) => Promise<void>;
  setRunId: (runId: string | null) => void;
}

export const useCoverageStore = create<CoverageStoreState>((set) => ({
  overview: null,
  subsysCoverage: [],
  currentRunId: null,
  cachedRuns: [],
  loading: false,

  loadOverview: async (projectId, runId) => {
    set({ loading: true });
    try {
      const result = await trpc.coverage.getOverview.query({ projectId, runId });
      set({ overview: result.summary, currentRunId: result.runId, loading: false });
    } catch (err) {
      set({ loading: false });
      useToastStore.getState().error('加载覆盖率失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadBySubsys: async (projectId, runId) => {
    try {
      const result = await trpc.coverage.getBySubsys.query({ projectId, runId });
      set({ subsysCoverage: result.items });
    } catch (err) {
      useToastStore.getState().error('加载子系统覆盖率失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadCachedRuns: async (projectId) => {
    try {
      const runs = await trpc.coverage.listCachedRuns.query({ projectId });
      set({ cachedRuns: runs });
    } catch {
      // Best-effort
    }
  },

  setRunId: (runId) => set({ currentRunId: runId }),
}));
