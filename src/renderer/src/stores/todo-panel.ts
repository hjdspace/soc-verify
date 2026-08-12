import { create } from 'zustand';

/**
 * Per-session collapsed state for the TodoPanel component.
 * Uses a plain object (Map is not serialisable) keyed by session ID.
 */
interface TodoPanelStoreState {
  /** sessionId → collapsed (default: false / expanded) */
  collapsed: Record<string, boolean>;

  toggleCollapse: (sessionId: string) => void;
  setCollapsed: (sessionId: string, collapsed: boolean) => void;
}

export const useTodoPanelStore = create<TodoPanelStoreState>((set) => ({
  collapsed: {},

  toggleCollapse: (sessionId) =>
    set((state) => ({
      collapsed: {
        ...state.collapsed,
        [sessionId]: !state.collapsed[sessionId],
      },
    })),

  setCollapsed: (sessionId, collapsed) =>
    set((state) => ({
      collapsed: {
        ...state.collapsed,
        [sessionId]: collapsed,
      },
    })),
}));
