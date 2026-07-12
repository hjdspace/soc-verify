import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from './toast';
import type { CoverageSummary } from '@shared/types';

interface DashboardMetrics {
  passRate: number;
  totalRuns: number;
  coverage: CoverageSummary | null;
  regressionCount: number;
}

interface DashboardStoreState {
  metrics: DashboardMetrics | null;
  loading: boolean;
  loadMetrics: (projectId: string) => Promise<void>;
}

export const useDashboardStore = create<DashboardStoreState>((set) => ({
  metrics: null,
  loading: false,
  loadMetrics: async (projectId) => {
    set({ loading: true });
    try {
      const metrics = await trpc.dashboard.getMetrics.query({ projectId });
      set({ metrics, loading: false });
    } catch (err) {
      set({ loading: false });
      useToastStore.getState().error('加载仪表盘失败', err instanceof Error ? err.message : String(err));
    }
  },
}));
