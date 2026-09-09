import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from './toast';
import { useTerminalStore } from './terminal';
import { useWorkbenchStore } from './workbench';
import type {
  RegressionDiscoveryResult,
  RegressionRunOptions,
  RegressionHistoryEntry,
  RegressionEntry,
  ActiveRegressionRun,
  RegressionEvent,
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
  parsedGroups: Map<
    string,
    { refPaths: string[]; resolved: Array<{ path: string; type: 'list' | 'group' | 'unreadable' }> }
  >;

  // ── History ──
  history: RegressionHistoryEntry[];
  historyLoading: boolean;

  // ── Active runs（TitleBar 回归徽章；主进程 regressionRunTracker 经事件同步）──
  activeRegressions: ActiveRegressionRun[];
  /** initActiveRuns 已执行（幂等保护） */
  activeRunsInitialized: boolean;

  // ── Actions ──
  discover: (projectId: string, refresh?: boolean) => Promise<void>;
  parseList: (filePath: string) => Promise<void>;
  /** projectRoot 用于主进程展开 $VAR 引用（.socverify/env.json 兜底） */
  parseGroup: (filePath: string, projectRoot?: string) => Promise<void>;
  /** 提交回归；不导航不自动开终端（ADR 0029 决策 4）。返回是否提交成功（失败保持模态/表单） */
  runRegression: (projectId: string, filePath: string, subsys: string, options: RegressionRunOptions) => Promise<boolean>;
  abortRegression: (projectId: string, runId: string) => Promise<void>;
  /** 按需打开运行中回归的终端（卡片「打开终端」按钮） */
  openRunTerminal: (runId: string) => Promise<void>;
  loadHistory: (projectId: string) => Promise<void>;
  /** 拉取运行中回归 + 订阅 regression:event（TitleBar 徽章数据源） */
  initActiveRuns: () => void;
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
  activeRegressions: [],
  activeRunsInitialized: false,

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

  parseGroup: async (filePath, projectRoot) => {
    if (get().parsedGroups.has(filePath)) return;
    try {
      const result = await trpc.regression.parseGroup.query({ filePath, projectRoot });
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

      // 不导航、不自动开终端：卡片就地显示进度（ADR 0029 决策 4），终端按需 openRunTerminal
      void get().loadHistory(projectId);
      return true;
    } catch (err) {
      useToastStore.getState().error('提交回归失败', err instanceof Error ? err.message : String(err));
      return false;
    }
  },

  openRunTerminal: async (runId) => {
    try {
      const { terminalId } = await trpc.regression.getRunTerminal.query({ runId });
      if (!terminalId) {
        useToastStore.getState().warning('无法打开终端', '该回归已结束或不存在');
        return;
      }
      const createTabForSession = useTerminalStore.getState().createTabForSession;
      const tabId = createTabForSession(terminalId, `回归 ${runId.slice(-6)}`);
      useWorkbenchStore.getState().open({ type: 'terminal', terminalTabId: tabId, title: `回归 ${runId.slice(-6)}` });
    } catch (err) {
      useToastStore.getState().error('打开终端失败', err instanceof Error ? err.message : String(err));
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

  initActiveRuns: () => {
    if (get().activeRunsInitialized) return;
    set({ activeRunsInitialized: true });

    // 拉取当前运行中回归（应用启动/重启后 tracker 单例里的存量）
    void trpc.regression.getActiveRuns.query({}).then((runs) => {
      set({ activeRegressions: runs });
    }).catch(() => {
      // 静默失败：事件流会随后校正（submit 时 started 事件全量登记）
      set({ activeRunsInitialized: false });
    });

    // regression:event → started 登记 / progress 更新 / finished 移除
    window.eventBridge?.onRegressionEvent((event: RegressionEvent) => {
      set((s) => {
        switch (event.type) {
          case 'started':
            return {
              activeRegressions: [...s.activeRegressions.filter((r) => r.runId !== event.run.runId), event.run],
            };
          case 'progress':
            return {
              activeRegressions: s.activeRegressions.map((r) =>
                r.runId === event.run.runId ? event.run : r,
              ),
            };
          case 'finished':
            return {
              activeRegressions: s.activeRegressions.filter((r) => r.runId !== event.run.runId),
            };
        }
      });
    });
  },
}));
