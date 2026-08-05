import { create } from 'zustand';

export type OfficePreviewMode = 'html' | 'screenshots' | 'watch';

export type OfficeDocumentDestination = {
  type: 'office-document';
  filePath: string;
  mode: 'preview' | 'edit';
  previewMode?: OfficePreviewMode;
};

export type WorkbenchDestination =
  | { type: 'file'; path: string; name: string }
  | { type: 'browser'; surfaceId: string; url: string; title?: string }
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
  | { type: 'timing-violation' }
  | { type: 'ai-artifacts' }
  | { type: 'plugin-view'; pluginId: string; viewId: string; title: string }
  | { type: 'diff-review'; filePath: string; fileName: string }
  | OfficeDocumentDestination;

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
  updateTabTitle: (tabId: string, title: string) => void;
};

function describeDestination(destination: WorkbenchDestination): Omit<WorkbenchTab, 'destination'> {
  switch (destination.type) {
    case 'file':
      return { id: `file:${destination.path}`, title: destination.name, closable: true };
    case 'browser':
      return { id: `browser:${destination.surfaceId}`, title: destination.title ?? (destination.url || '新标签页'), closable: true };
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
    case 'timing-violation':
      return { id: destination.type, title: '时序违例', closable: true };
    case 'ai-artifacts':
      return { id: destination.type, title: 'AI 产物', closable: true };
    case 'plugin-view':
      return { id: `plugin-view:${destination.pluginId}:${destination.viewId}`, title: destination.title, closable: true };
    case 'office-document': {
      // tab 标题使用文件基本名，便于在多文档间区分
      const sep = destination.filePath.includes('/') ? '/' : '\\';
      const parts = destination.filePath.split(sep);
      const fileName = parts[parts.length - 1] || destination.filePath;
      return { id: `office-document:${destination.filePath}`, title: fileName, closable: true };
    }
  }
}

/** 支持预览的 Office 文档扩展名（小写、无前导点） */
const OFFICE_DOC_EXTENSIONS = new Set(['docx', 'pptx', 'xlsx', 'pdf']);

/**
 * 根据文件扩展名推断合适的 destination：
 *   - .xlsx → office-document，mode='edit'（编辑能力在 Issue #5 实现，本期占位）
 *   - .docx/.pptx → office-document，mode='preview'，previewMode='html'
 *   - .pdf → office-document，mode='preview'，previewMode='html'（Issue #4 用 react-pdf，本期占位）
 *   - 其他 → 普通 'file' destination
 *
 * 供文件树点击、文件选择对话框等调用方复用，避免分散判断。
 */
export function openFileDestination(
  open: (destination: WorkbenchDestination) => void,
  path: string,
  name: string,
): void {
  const dot = path.lastIndexOf('.');
  const ext = dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
  if (OFFICE_DOC_EXTENSIONS.has(ext)) {
    open({
      type: 'office-document',
      filePath: path,
      mode: ext === 'xlsx' ? 'edit' : 'preview',
      previewMode: 'html',
    });
    return;
  }
  open({ type: 'file', path, name });
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

  updateTabTitle: (tabId, title) => {
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.id === tabId);
      if (index === -1) return state;
      const tab = state.tabs[index];
      if (tab.title === title) return state;
      const tabs = [...state.tabs];
      tabs[index] = { ...tab, title };
      return { tabs };
    });
  },
}));
