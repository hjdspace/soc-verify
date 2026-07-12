import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from './toast';
import type { TOChecklistItem } from '@shared/types';

interface TOChecklistStoreState {
  items: TOChecklistItem[];
  loading: boolean;
  loadChecklist: (projectId: string) => Promise<void>;
  updateItem: (projectId: string, itemId: string, updates: Partial<TOChecklistItem>) => Promise<void>;
  exportReport: (projectId: string, outputPath: string) => Promise<void>;
}

export const useTOChecklistStore = create<TOChecklistStoreState>((set) => ({
  items: [],
  loading: false,
  loadChecklist: async (projectId) => {
    set({ loading: true });
    try {
      const items = await trpc.to.getChecklist.query({ projectId });
      set({ items, loading: false });
    } catch (err) {
      set({ loading: false });
      useToastStore.getState().error('加载 TO 清单失败', err instanceof Error ? err.message : String(err));
    }
  },
  updateItem: async (projectId, itemId, updates) => {
    try {
      await trpc.to.updateItem.mutate({ projectId, itemId, updates });
      set((s) => ({
        items: s.items.map((item) =>
          item.id === itemId ? { ...item, ...updates } : item,
        ),
      }));
      useToastStore.getState().success('检查项已更新');
    } catch (err) {
      useToastStore.getState().error('更新失败', err instanceof Error ? err.message : String(err));
    }
  },
  exportReport: async (projectId, outputPath) => {
    try {
      await trpc.to.exportReport.mutate({ projectId, outputPath });
      useToastStore.getState().success('报告已导出', outputPath);
    } catch (err) {
      useToastStore.getState().error('导出失败', err instanceof Error ? err.message : String(err));
    }
  },
}));
