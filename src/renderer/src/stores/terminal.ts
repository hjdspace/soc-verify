import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from './toast';
import { useWorkbenchStore } from './workbench';

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
  /** Create a tab for an already-existing terminal session (e.g. from simulation.runInTerminal) */
  createTabForSession: (terminalId: string, title: string, cwd?: string) => string;
  closeTerminal: (tabId: string) => Promise<void>;
  setActiveTab: (tabId: string) => void;
  writeToTerminal: (terminalId: string, data: string) => Promise<void>;
  resizeTerminal: (terminalId: string, cols: number, rows: number) => Promise<void>;
  handleTerminalData: (id: string, data: string) => void;
  handleTerminalExit: (id: string, exitCode: number) => void;
  /** Find the tab ID associated with a terminal session ID */
  getTabIdByTerminalId: (terminalId: string) => string | null;
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
    useWorkbenchStore.getState().open({ type: 'terminal', terminalTabId: tabId, title: 'Terminal' });

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
      useWorkbenchStore.getState().open({
        type: 'terminal',
        terminalTabId: tabId,
        title: `Terminal ${tabIdCounter}`,
      });

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
      useWorkbenchStore.getState().close(`terminal:${tabId}`);
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
    useWorkbenchStore.getState().close(`terminal:${tabId}`);
  },

  setActiveTab: (tabId) => {
    const tab = get().tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    set({ activeTabId: tabId });
    useWorkbenchStore.getState().open({ type: 'terminal', terminalTabId: tab.id, title: tab.title });
  },

  createTabForSession: (terminalId, title, cwd) => {
    const tabId = `term_tab_${++tabIdCounter}`;
    set((s) => ({
      tabs: [...s.tabs, {
        id: tabId,
        terminalId,
        title,
        cwd: cwd ?? '',
        active: true,
        creating: false,
      }],
      activeTabId: tabId,
    }));
    useWorkbenchStore.getState().open({ type: 'terminal', terminalTabId: tabId, title });

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
  },

  getTabIdByTerminalId: (terminalId) => {
    const tab = get().tabs.find((t) => t.terminalId === terminalId);
    return tab?.id ?? null;
  },

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
    // Mark the tab as exited, with a status indicator for simulation terminals
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.terminalId !== id) return t;
        // For simulation terminals (title starts with "sim:"), show pass/fail
        if (t.title.startsWith('sim:')) {
          return { ...t, title: `${t.title} ✓` };
        }
        return { ...t, title: `${t.title} (exited)` };
      }),
    }));
    const tab = get().tabs.find((candidate) => candidate.terminalId === id);
    if (tab) {
      useWorkbenchStore.getState().open({ type: 'terminal', terminalTabId: tab.id, title: tab.title });
    }
  },
}));
