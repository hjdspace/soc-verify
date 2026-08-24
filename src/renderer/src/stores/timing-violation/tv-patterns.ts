/**
 * TV Patterns Store — Pattern CRUD / 历史匹配。
 *
 * 从原 timing-violation.ts 中提取的 pattern 领域。
 * 对齐主进程 pattern-router。
 */

import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { getToast } from '@renderer/lib/trpc-utils';
import type { ViolationPattern } from './tv-types';

type TvPatternsState = {
  // ── Pattern 状态 ────────────────────────────────────────
  patterns: ViolationPattern[];
  loadingPatterns: boolean;
  showPatternManager: boolean;

  // ── Pattern Actions ─────────────────────────────────────
  loadPatterns: (projectId: string) => Promise<void>;
  clearAllPatterns: (projectId: string) => Promise<void>;
  setShowPatternManager: (show: boolean) => void;
};

export const useTvPatternsStore = create<TvPatternsState>((set, get) => ({
  patterns: [],
  loadingPatterns: false,
  showPatternManager: false,

  loadPatterns: async (projectId) => {
    set({ loadingPatterns: true });
    try {
      const result = await trpc.pattern.getPatterns.query({ projectId });
      set({ patterns: result as ViolationPattern[], loadingPatterns: false });
    } catch (err) {
      set({ loadingPatterns: false });
      getToast().error('加载 Pattern 列表失败', err instanceof Error ? err.message : String(err));
    }
  },

  clearAllPatterns: async (projectId) => {
    try {
      const result = await trpc.pattern.clearAllPatterns.mutate({ projectId });
      getToast().success(`已清除 ${result.deleted} 条 Pattern`);
      await get().loadPatterns(projectId);
    } catch (err) {
      getToast().error('清除 Pattern 失败', err instanceof Error ? err.message : String(err));
    }
  },

  setShowPatternManager: (show) => set({ showPatternManager: show }),
}));
