import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from './toast';
import { useWorkbenchStore } from './workbench';
import { useTerminalStore } from './terminal';
import type {
  RegressionDiscoveryResult,
  RegressionRunOptions,
  RegressionHistoryEntry,
  RegressionEntry,
} from '@shared/types';

interface RegressionStoreState {
  // ── Discovery ──
  discovery: RegressionDiscoveryResult;
  discoveryLoading: boolean;
  discoveryError: string | null;

  // ── Parsed list entries (lazy loaded) ──
  parsedLists: Map<string, { entries: RegressionEntry[]; tagSet: string[]; onCount: number; offCount: number }>;
  parsingListPath: string | null;

  // ── Parsed group refs (lazy loaded) ──
  parsedGroups: Map<string, { refPaths: string[]; resolved: Array<{ path: string; type: 'list' | 'group' }> }>;

  // ── History ──
  history: RegressionHistoryEntry[];
  historyLoading: boolean;

  // ── Actions ──
  discover: (projectId: string, refresh?: boolean) => Promise<void>;
  parseList: (filePath: string) => Promise<void>;
  parseGroup: (filePath: string) => Promise<void>;
  runRegression: (projectId: string, filePath: string, subsys: string, options: RegressionRunOptions) => Promise<void>;
  abortRegression: (projectId: string, runId: string) => Promise<void>;
  loadHistory: (projectId: string) => Promise<void>;
}

export const useRegressionStore = create<RegressionStoreState>((set, get) => ({
  discovery: [],
  discoveryLoading: false,
  discoveryError: null,
  parsedLists: new Map(),
  parsingListPath: null,
  parsedGroups: new Map(),
  history: [],
  historyLoading: false,

  discover: async (projectId, refresh) => {
    set({ discoveryLoading: true, discoveryError: null });
    try {
      const result = await trpc.regression.discover.query({ projectId, refresh });
      set({ discovery: result, discoveryLoading: false });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ discoveryLoading: false, discoveryError: msg });
    }
  },

  parseList: async (filePath) => {
    if (get().parsedLists.has(filePath)) return;
    set({ parsingListPath: filePath });
    try {
      const result = await trpc.regression.parseList.query({ filePath });
      set((s) => {
        const next = new Map(s.parsedLists);
        next.set(filePath, result);
        return { parsedLists: next, parsingListPath: null };
      });
    } catch (err) {
      set({ parsingListPath: null });
      useToastStore.getState().error('解析回归列表失败', err instanceof Error ? err.message : String(err));
    }
  },

  parseGroup: async (filePath) => {
    if (get().parsedGroups.has(filePath)) return;
    try {
      const result = await trpc.regression.parseGroup.query({ filePath });
      set((s) => {
        const next = new Map(s.parsedGroups);
        next.set(filePath, result);
        return { parsedGroups: next };
      });
    } catch (err) {
      useToastStore.getState().error('解析回归组失败', err instanceof Error ? err.message : String(err));
    }
  },

  runRegression: async (projectId, filePath, subsys, options) => {
    try {
      const result = await trpc.regression.run.mutate({ projectId, filePath, subsys, options });
      useToastStore.getState().success('回归已提交', `运行 ID: ${result.runId}`);

      // Open terminal tab to show output
      const createTabForSession = useTerminalStore.getState().createTabForSession;
      const tabId = createTabForSession(result.terminalId, `回归 ${result.runId.slice(-6)}`);
      const open = useWorkbenchStore.getState().open;
      open({ type: 'terminal', terminalTabId: tabId, title: `回归 ${result.runId.slice(-6)}` });

      // Refresh history
      void get().loadHistory(projectId);
    } catch (err) {
      useToastStore.getState().error('提交回归失败', err instanceof Error ? err.message : String(err));
    }
  },

  abortRegression: async (projectId, runId) => {
    try {
      await trpc.regression.abort.mutate({ projectId, runId });
      useToastStore.getState().success('回归已中止', `运行 ID: ${runId}`);
      void get().loadHistory(projectId);
    } catch (err) {
      useToastStore.getState().error('中止回归失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadHistory: async (projectId) => {
    set({ historyLoading: true });
    try {
      const history = await trpc.regression.getHistory.query({ projectId });
      set({ history, historyLoading: false });
    } catch (err) {
      set({ historyLoading: false });
      useToastStore.getState().error('加载回归历史失败', err instanceof Error ? err.message : String(err));
    }
  },
}));
