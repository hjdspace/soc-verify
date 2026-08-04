import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';

interface OverviewData {
  subsystemCount: number;
  caseCount: number;
  passRate: number;
}

interface OverviewState {
  /** 缓存的概览数据（按 projectId 隔离）。 */
  dataByProject: Record<string, OverviewData>;
  /** 当前 projectId 对应的加载状态。 */
  loading: boolean;
  /** 无效化计数器：递增后触发依赖此值的组件重新加载。 */
  invalidateCount: number;
  /**
   * 加载概览数据（有缓存时直接返回，force=true 强制刷新）。
   *
   * 使用场景：
   * - 切换到概览页时调用（有缓存则秒开）
   * - case_cfg 变更后 invalidate() 触发重新加载
   */
  loadOverview: (projectId: string, force?: boolean) => Promise<void>;
  /** 无效化缓存（case_cfg 增删后调用，触发概览页重新加载）。 */
  invalidate: () => void;
  /** 清除指定项目的缓存（项目关闭时调用）。 */
  clearForProject: (projectId: string) => void;
}

export const useOverviewStore = create<OverviewState>((set, get) => ({
  dataByProject: {},
  loading: false,
  invalidateCount: 0,

  loadOverview: async (projectId, force = false) => {
    const state = get();
    // 有缓存且非强制刷新时，直接使用缓存
    if (!force && state.dataByProject[projectId]) return;
    if (state.loading) return;

    set({ loading: true });
    try {
      const data = await trpc.project.getOverview.query({ projectId });
      set((s) => ({
        dataByProject: { ...s.dataByProject, [projectId]: data },
        loading: false,
      }));
    } catch {
      set((s) => ({
        dataByProject: {
          ...s.dataByProject,
          [projectId]: { subsystemCount: 0, caseCount: 0, passRate: 0 },
        },
        loading: false,
      }));
    }
  },

  invalidate: () => {
    set((s) => ({
      dataByProject: {},
      invalidateCount: s.invalidateCount + 1,
      loading: false,
    }));
  },

  clearForProject: (projectId) => {
    set((s) => {
      const next = { ...s.dataByProject };
      delete next[projectId];
      return { dataByProject: next };
    });
  },
}));
