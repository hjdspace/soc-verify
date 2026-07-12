import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from './toast';

export interface TerminalTab {
  id: string;
  terminalId: string | null;
  title: string;
  cwd: string;
  active: boolean;
  creating: boolean;
}

interface TerminalStoreState {
  tabs: TerminalTab[];
  activeTabId: string | null;

  createTerminal: (projectId?: string, cwd?: string) => Promise<string>;
  closeTerminal: (tabId: string) => Promise<void>;
  setActiveTab: (tabId: string) => void;
  writeToTerminal: (terminalId: string, data: string) => Promise<void>;
  resizeTerminal: (terminalId: string, cols: number, rows: number) => Promise<void>;
  handleTerminalData: (id: string, data: string) => void;
  handleTerminalExit: (id: string, exitCode: number) => void;
}

let eventListenerRegistered = false;
let tabIdCounter = 0;

export const useTerminalStore = create<TerminalStoreState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  createTerminal: async (projectId, cwd) => {
    const tabId = `term_tab_${++tabIdCounter}`;

    // Add a placeholder tab immediately
    set((s) => ({
      tabs: [...s.tabs, {
        id: tabId,
        terminalId: null,
        title: 'Terminal',
        cwd: cwd ?? '',
        active: true,
        creating: true,
      }],
      activeTabId: tabId,
    }));

    try {
      const session = await trpc.terminal.create.mutate({
        projectId,
        cwd,
      });

      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId
            ? { ...t, terminalId: session.id, title: `Terminal ${tabIdCounter}`, cwd: session.cwd, creating: false }
            : t,
        ),
      }));

      // Register IPC event listener once
      if (!eventListenerRegistered && window.eventBridge) {
        eventListenerRegistered = true;
        window.eventBridge.onTerminalData(({ id, data }) => {
          get().handleTerminalData(id, data);
        });
        window.eventBridge.onTerminalExit(({ id, exitCode }) => {
          get().handleTerminalExit(id, exitCode);
        });
      }

      return tabId;
    } catch (err) {
      useToastStore.getState().error('创建终端失败', err instanceof Error ? err.message : String(err));
      // Remove the placeholder tab on error
      set((s) => ({
        tabs: s.tabs.filter((t) => t.id !== tabId),
        activeTabId: s.tabs.find((t) => t.id !== tabId)?.id ?? null,
      }));
      return tabId;
    }
  },

  closeTerminal: async (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (tab?.terminalId) {
      try {
        await trpc.terminal.destroy.mutate({ terminalId: tab.terminalId });
      } catch {
        // best-effort
      }
    }
    set((s) => {
      const filtered = s.tabs.filter((t) => t.id !== tabId);
      const nextActive = s.activeTabId === tabId
        ? (filtered[filtered.length - 1]?.id ?? null)
        : s.activeTabId;
      return { tabs: filtered, activeTabId: nextActive };
    });
  },

  setActiveTab: (tabId) => set({ activeTabId: tabId }),

  writeToTerminal: async (terminalId, data) => {
    try {
      await trpc.terminal.write.mutate({ terminalId, data });
    } catch {
      // best-effort
    }
  },

  resizeTerminal: async (terminalId, cols, rows) => {
    try {
      await trpc.terminal.resize.mutate({ terminalId, cols, rows });
    } catch {
      // best-effort
    }
  },

  handleTerminalData: (id, _data) => {
    // Data is handled by the TerminalView component via its own event listener
    // This is a no-op in the store; the actual rendering happens in the xterm.js instance
  },

  handleTerminalExit: (id, _exitCode) => {
    // Mark the tab as exited
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.terminalId === id
          ? { ...t, title: `${t.title} (exited)` }
          : t,
      ),
    }));
  },
}));
