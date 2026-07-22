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
  /** Whether this terminal is running in fallback mode (no node-pty). */
  fallback: boolean;
  /** User-facing warning message when in fallback mode. */
  warning: string | null;
}

interface TerminalStoreState {
  tabs: TerminalTab[];
  activeTabId: string | null;

  createTerminal: (projectId?: string, cwd?: string) => Promise<string>;
  /** Create a tab for an already-existing terminal session (e.g. from simulation.runInTerminal) */
  createTabForSession: (terminalId: string, title: string, cwd?: string, fallback?: boolean, warning?: string | null) => string;
  closeTerminal: (tabId: string) => Promise<void>;
  setActiveTab: (tabId: string) => void;
  writeToTerminal: (terminalId: string, data: string) => Promise<void>;
  resizeTerminal: (terminalId: string, cols: number, rows: number) => Promise<void>;
  handleTerminalData: (id: string, data: string) => void;
  handleTerminalExit: (id: string, exitCode: number) => void;
  // Note: exitCode is used to show pass (✓) / fail (✗) on simulation terminal tabs
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
        fallback: false,
        warning: null,
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
            ? { ...t, terminalId: session.id, title: `Terminal ${tabIdCounter}`, cwd: session.cwd, creating: false, fallback: session.backend === 'fallback', warning: session.warning }
            : t,
        ),
      }));

      // Show a toast warning if the terminal is running in fallback mode
      if (session.backend === 'fallback' && session.warning) {
        useToastStore.getState().warning(
          '终端运行在降级模式',
          'node-pty 无法加载，终端已回退到 child_process。交互功能（调整大小、TUI 应用）可能不可用。请查看主进程控制台获取详细诊断信息。',
        );
      }
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

  createTabForSession: (terminalId, title, cwd, fallback = false, warning = null) => {
    const tabId = `term_tab_${++tabIdCounter}`;
    set((s) => ({
      tabs: [...s.tabs, {
        id: tabId,
        terminalId,
        title,
        cwd: cwd ?? '',
        active: true,
        creating: false,
        fallback,
        warning,
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

  handleTerminalExit: (id, exitCode) => {
    // Mark the tab as exited, with a status indicator for simulation terminals
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.terminalId !== id) return t;
        // Skip if already marked as exited/pass/fail (prevents duplicate exit events)
        if (t.title.endsWith('✓') || t.title.endsWith('✗') || t.title.endsWith('(exited)')) {
          return t;
        }
        // For simulation terminals (title starts with "sim:"), show pass/fail
        // based on the exit code (0 = pass ✓, non-zero = fail ✗)
        if (t.title.startsWith('sim:')) {
          return { ...t, title: `${t.title} ${exitCode === 0 ? '✓' : '✗'}` };
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
