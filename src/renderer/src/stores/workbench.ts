import { create } from 'zustand';
import { useUiStore, type ActiveView } from './ui';
import { useProjectStore } from './project';

import type { DashboardTab } from '@renderer/stores/dashboard';

export type OfficePreviewMode = 'html' | 'screenshots' | 'watch';

export type DatabaseDestination = {
  type: 'database';
  filePath: string;
};

export type DrawioDiagramDestination = {
  type: 'drawio-diagram';
  filePath: string;
};

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
  | { type: 'coverage-detail' }
  | { type: 'regression' }
  | { type: 'regression-detail' }
  | { type: 'dashboard' }
  | { type: 'dashboard-tab'; tab: DashboardTab }
  | { type: 'sysbase-env-gen' }
  | { type: 'to-checklist' }
  | { type: 'source-control' }
  | { type: 'timing-violation' }
  | { type: 'ai-artifacts' }
  | { type: 'plugin-view'; pluginId: string; viewId: string; title: string }
  | { type: 'kb' }
  | OfficeDocumentDestination
  | DatabaseDestination
  | DrawioDiagramDestination;

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
  closeAll: () => void;
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
    case 'simulation-history':
      return { id: destination.type, title: '仿真历史', closable: true };
    case 'simulation-comparison':
      return { id: destination.type, title: '运行对比', closable: true };
    case 'running-simulations':
      return { id: destination.type, title: '运行概览', closable: true };
    case 'coverage':
      return { id: destination.type, title: '覆盖率分析', closable: true };
    case 'coverage-detail':
      return { id: destination.type, title: '覆盖率分析', closable: true };
    case 'regression':
      return { id: destination.type, title: '回归套件', closable: true };
    case 'regression-detail':
      return { id: destination.type, title: '回归测试', closable: true };
    case 'dashboard':
      return { id: destination.type, title: '仪表盘', closable: true };
    case 'dashboard-tab': {
      const tabLabel = DASHBOARD_TAB_LABELS[destination.tab] ?? destination.tab;
      return { id: `dashboard-tab:${destination.tab}`, title: tabLabel, closable: true };
    }
    case 'sysbase-env-gen':
      return { id: destination.type, title: '验证环境生成器', closable: true };
    case 'to-checklist':
      return { id: destination.type, title: 'TO 检查清单', closable: true };
    case 'source-control':
      return { id: destination.type, title: '源代码管理', closable: true };
    case 'timing-violation':
      return { id: destination.type, title: '时序违例', closable: true };
    case 'ai-artifacts':
      return { id: destination.type, title: 'AI 产物', closable: true };
    case 'kb':
      return { id: destination.type, title: '知识库', closable: true };
    case 'plugin-view':
      return { id: `plugin-view:${destination.pluginId}:${destination.viewId}`, title: destination.title, closable: true };
    case 'office-document': {
      // tab 标题使用文件基本名，便于在多文档间区分
      const sep = destination.filePath.includes('/') ? '/' : '\\';
      const parts = destination.filePath.split(sep);
      const fileName = parts[parts.length - 1] || destination.filePath;
      return { id: `office-document:${destination.filePath}`, title: fileName, closable: true };
    }
    case 'database': {
      const sep = destination.filePath.includes('/') ? '/' : '\\';
      const parts = destination.filePath.split(sep);
      const fileName = parts[parts.length - 1] || destination.filePath;
      return { id: `database:${destination.filePath}`, title: fileName, closable: true };
    }
    case 'drawio-diagram': {
      const sep = destination.filePath.includes('/') ? '/' : '\\';
      const parts = destination.filePath.split(sep);
      const fileName = parts[parts.length - 1] || destination.filePath;
      return { id: `drawio-diagram:${destination.filePath}`, title: fileName, closable: true };
    }
  }
}

/** 支持预览的 Office 文档扩展名（小写、无前导点） */
const OFFICE_DOC_EXTENSIONS = new Set(['docx', 'pptx', 'xlsx', 'pdf']);

/** 支持查看的数据库文件扩展名（小写、无前导点） */
const DB_EXTENSIONS = new Set(['db', 'sqlite', 'sqlite3', 'db3']);

/** draw.io 框图文件扩展名（小写、无前导点；.drawio.xml 为双扩展名特判） */
const DRAWIO_EXTENSIONS = new Set(['drawio', 'dio']);

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
  if (DB_EXTENSIONS.has(ext)) {
    open({ type: 'database', filePath: path });
    return;
  }
  if (DRAWIO_EXTENSIONS.has(ext) || path.toLowerCase().endsWith('.drawio.xml')) {
    open({ type: 'drawio-diagram', filePath: path });
    return;
  }
  open({ type: 'file', path, name });
}

/** DashboardTab → 中文标签（用于 Tab 标题） */
const DASHBOARD_TAB_LABELS: Record<DashboardTab, string> = {
  overview: '概览',
  trend: '趋势',
  subsys: '子系统',
  failures: '失败',
  regression: '回归进度',
  duration: '耗时分布',
  unstable: '不稳定',
  phase: '阶段',
  debug: '调试难度',
};

/**
 * 目的地 → 视图重定向（mission-control 视图路由）：
 * 这四类目的地不再开 Tab，而是切换到对应的 App Shell 视图。
 * 注意：通过 getState() 访问 ui store，避免 store 间循环依赖。
 */
const DESTINATION_VIEW_ROUTES: Partial<Record<WorkbenchDestination['type'], ActiveView>> = {
  dashboard: 'dashboard',
  coverage: 'coverage',
  regression: 'regression',
  'running-simulations': 'simulation',
};

export const useWorkbenchStore = create<WorkbenchState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  open: (destination) => {
    // 视图型目的地 → 切换视图，不开 Tab
    const routedView = DESTINATION_VIEW_ROUTES[destination.type];
    if (routedView) {
      useUiStore.getState().setActiveView(routedView);
      return;
    }
    // 其余目的地照旧开 Tab，并自动切到 workspace 视图
    const descriptor = describeDestination(destination);
    // 文件型目的地 → 记录「最近打开」（左抽屉底部列表）
    if (
      destination.type === 'file' ||
      destination.type === 'office-document' ||
      destination.type === 'database' ||
      destination.type === 'drawio-diagram'
    ) {
      const filePath = destination.type === 'file' ? destination.path : destination.filePath;
      useProjectStore.getState().pushRecentFile({ path: filePath, name: descriptor.title });
    }
    set((state) => {
      const existingIndex = state.tabs.findIndex((tab) => tab.id === descriptor.id);
      const tab = { ...descriptor, destination };
      const tabs = existingIndex === -1
        ? [...state.tabs, tab]
        : state.tabs.map((existing, index) => index === existingIndex ? tab : existing);
      return { tabs, activeTabId: descriptor.id };
    });
    useUiStore.getState().setActiveView('workspace');
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

  closeAll: () => {
    set({ tabs: [], activeTabId: null });
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
