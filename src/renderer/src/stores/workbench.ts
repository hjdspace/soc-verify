import { create } from 'zustand';

export type WorkbenchDestination =
  | { type: 'file'; path: string; name: string }
  | { type: 'terminal'; terminalTabId: string; title: string }
  | { type: 'simulation-errors'; runId: string }
  | { type: 'simulation-history' }
  | { type: 'simulation-detail'; runId: string }
  | { type: 'simulation-comparison' }
  | { type: 'running-simulations' }
  | { type: 'coverage' }
  | { type: 'regression' }
  | { type: 'dashboard' }
  | { type: 'to-checklist' }
  | { type: 'source-control' }
  | { type: 'ai-artifacts' }
  | { type: 'diff-review'; filePath: string; fileName: string };

export type WorkbenchTab = {
  id: string;
  title: string;
  closable: boolean;
  destination: WorkbenchDestination;
};

type WorkbenchState = {
  tabs: WorkbenchTab[];
  activeTabId: string | null;
  open: (destination: WorkbenchDestination) => void;
  activate: (tabId: string) => void;
  close: (tabId: string) => void;
  closeActive: () => void;
};

function describeDestination(destination: WorkbenchDestination): Omit<WorkbenchTab, 'destination'> {
  switch (destination.type) {
    case 'file':
      return { id: `file:${destination.path}`, title: destination.name, closable: true };
    case 'terminal':
      return { id: `terminal:${destination.terminalTabId}`, title: destination.title, closable: true };
    case 'simulation-errors':
      return { id: `simulation-errors:${destination.runId}`, title: `编译错误 ${destination.runId.slice(-6)}`, closable: true };
    case 'simulation-detail':
      return { id: `simulation-detail:${destination.runId}`, title: `运行详情 ${destination.runId.slice(-6)}`, closable: true };
    case 'diff-review':
      return { id: `diff-review:${destination.filePath}`, title: `Diff: ${destination.fileName}`, closable: true };
    case 'simulation-history':
      return { id: destination.type, title: '仿真历史', closable: true };
    case 'simulation-comparison':
      return { id: destination.type, title: '运行对比', closable: true };
    case 'running-simulations':
      return { id: destination.type, title: '运行概览', closable: true };
    case 'coverage':
      return { id: destination.type, title: '覆盖率分析', closable: true };
    case 'regression':
      return { id: destination.type, title: '回归套件', closable: true };
    case 'dashboard':
      return { id: destination.type, title: '仪表盘', closable: true };
    case 'to-checklist':
      return { id: destination.type, title: 'TO 检查清单', closable: true };
    case 'source-control':
      return { id: destination.type, title: '源代码管理', closable: true };
    case 'ai-artifacts':
      return { id: destination.type, title: 'AI 产物', closable: true };
  }
}

export const useWorkbenchStore = create<WorkbenchState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  open: (destination) => {
    const descriptor = describeDestination(destination);
    set((state) => {
      const existingIndex = state.tabs.findIndex((tab) => tab.id === descriptor.id);
      const tab = { ...descriptor, destination };
      const tabs = existingIndex === -1
        ? [...state.tabs, tab]
        : state.tabs.map((existing, index) => index === existingIndex ? tab : existing);
      return { tabs, activeTabId: descriptor.id };
    });
  },

  activate: (tabId) => {
    if (get().tabs.some((tab) => tab.id === tabId)) {
      set({ activeTabId: tabId });
    }
  },

  close: (tabId) => {
    set((state) => {
      const tabs = state.tabs.filter((tab) => tab.id !== tabId);
      return {
        tabs,
        activeTabId: state.activeTabId === tabId
          ? (tabs[tabs.length - 1]?.id ?? null)
          : state.activeTabId,
      };
    });
  },

  closeActive: () => {
    const activeTabId = get().activeTabId;
    if (activeTabId) get().close(activeTabId);
  },
}));
