import { create } from 'zustand';
import type { PluginViewLayoutState } from '@shared/types/project';
import type { PluginViewLocation } from '@shared/plugin-types';

type PluginViewLayouts = Record<PluginViewLocation, PluginViewLayoutState>;

/** App Shell 视图路由：四大主视图 + 工作区（多 Tab 工作台） */
export type ActiveView = 'dashboard' | 'simulation' | 'coverage' | 'regression' | 'workspace';

/** AI 面板呈现模式：抽屉（默认）或固定右栏（旧布局回退），随布局持久化 */
export type AiPanelMode = 'drawer' | 'docked';

const ACTIVE_VIEWS: readonly ActiveView[] = ['dashboard', 'simulation', 'coverage', 'regression', 'workspace'];

function isActiveView(value: string | undefined): value is ActiveView {
  return value !== undefined && (ACTIVE_VIEWS as readonly string[]).includes(value);
}

function isAiPanelMode(value: string | undefined): value is AiPanelMode {
  return value === 'drawer' || value === 'docked';
}

const DEFAULT_PLUGIN_VIEW_LAYOUTS: PluginViewLayouts = {
  center: { collapsed: false },
  left: { collapsed: false },
  right: { collapsed: false },
  bottom: { collapsed: false },
};

interface UiState {
  activeView: ActiveView;
  /** 左侧文件抽屉（NavRail「文件」按钮 toggle；切换视图自动关闭） */
  leftDrawerOpen: boolean;
  /** 左侧文件抽屉当前 Tab（files = 文件树 / subsystems = 子系统用例），供跨组件打开子系统 Tab */
  leftDrawerTab: 'files' | 'subsystems';
  /** 右侧 AI 抽屉（仅 aiPanelMode === 'drawer' 时有效） */
  rightDrawerOpen: boolean;
  aiPanelMode: AiPanelMode;
  rightPanelCollapsed: boolean;
  optionDockExpanded: boolean;
  settingsOpen: boolean;
  commandPaletteOpen: boolean;
  sourceControlOpen: boolean;
  centerMenuOpen: boolean;
  rightPanelWidth: number;
  bottomPanelCollapsed: boolean;
  bottomPanelHeight: number;
  pluginViewLayouts: PluginViewLayouts;
  setActiveView: (view: ActiveView) => void;
  toggleLeftDrawer: () => void;
  setLeftDrawerTab: (tab: 'files' | 'subsystems') => void;
  /** 打开左侧抽屉并切到子系统用例 Tab（供总览里程碑「后仿用例调试」等入口调用） */
  openSubsystemCases: () => void;
  toggleRightDrawer: () => void;
  closeDrawers: () => void;
  setAiPanelMode: (mode: AiPanelMode) => void;
  toggleRightPanel: () => void;
  toggleOptionDock: () => void;
  toggleBottomPanel: () => void;
  setSettingsOpen: (open: boolean) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setSourceControlOpen: (open: boolean) => void;
  setCenterMenuOpen: (open: boolean) => void;
  setRightPanelWidth: (width: number) => void;
  setBottomPanelCollapsed: (collapsed: boolean) => void;
  setBottomPanelHeight: (height: number) => void;
  setPluginViewActive: (location: PluginViewLocation, viewId: string) => void;
  setPluginViewCollapsed: (location: PluginViewLocation, collapsed: boolean) => void;
  hydratePluginViewLayouts: (layouts?: Partial<PluginViewLayouts>) => void;
  hydrateLayout: (layout?: {
    activeView?: string;
    rightPanelCollapsed?: boolean;
    optionDockExpanded?: boolean;
    pluginViews?: Partial<PluginViewLayouts>;
    aiPanelMode?: string;
  }) => void;
}

const RIGHT_MIN = 280;
const RIGHT_MAX = 600;
const BOTTOM_MIN = 120;
const BOTTOM_MAX = 600;

export const useUiStore = create<UiState>((set) => ({
  activeView: 'dashboard',
  leftDrawerOpen: false,
  leftDrawerTab: 'files',
  rightDrawerOpen: false,
  aiPanelMode: 'drawer',
  rightPanelCollapsed: false,
  optionDockExpanded: false,
  settingsOpen: false,
  commandPaletteOpen: false,
  sourceControlOpen: false,
  centerMenuOpen: false,
  rightPanelWidth: 384,
  bottomPanelCollapsed: true,
  bottomPanelHeight: 240,
  pluginViewLayouts: DEFAULT_PLUGIN_VIEW_LAYOUTS,
  // 切换视图时自动关闭所有抽屉（原型 §2.1-3：mission-control 行为闭环）
  setActiveView: (view) =>
    set({ activeView: view, leftDrawerOpen: false, rightDrawerOpen: false }),
  toggleLeftDrawer: () => set((s) => ({ leftDrawerOpen: !s.leftDrawerOpen })),
  setLeftDrawerTab: (tab) => set({ leftDrawerTab: tab }),
  openSubsystemCases: () => set({ leftDrawerOpen: true, leftDrawerTab: 'subsystems' }),
  toggleRightDrawer: () => set((s) => ({ rightDrawerOpen: !s.rightDrawerOpen })),
  closeDrawers: () => set({ leftDrawerOpen: false, rightDrawerOpen: false }),
  // 切回固定侧栏模式时收起抽屉，避免再次切回抽屉模式时意外弹开
  setAiPanelMode: (mode) => set({ aiPanelMode: mode, rightDrawerOpen: false }),
  toggleRightPanel: () => set((s) => ({ rightPanelCollapsed: !s.rightPanelCollapsed })),
  toggleOptionDock: () => set((s) => ({ optionDockExpanded: !s.optionDockExpanded })),
  toggleBottomPanel: () => set((s) => ({ bottomPanelCollapsed: !s.bottomPanelCollapsed })),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  setSourceControlOpen: (open) => set({ sourceControlOpen: open }),
  setCenterMenuOpen: (open) => set({ centerMenuOpen: open }),
  setRightPanelWidth: (width) => set({ rightPanelWidth: Math.max(RIGHT_MIN, Math.min(RIGHT_MAX, width)) }),
  setBottomPanelCollapsed: (collapsed) => set({ bottomPanelCollapsed: collapsed }),
  setBottomPanelHeight: (height) => set({ bottomPanelHeight: Math.max(BOTTOM_MIN, Math.min(BOTTOM_MAX, height)) }),
  setPluginViewActive: (location, viewId) => set((state) => ({
    pluginViewLayouts: {
      ...state.pluginViewLayouts,
      [location]: { ...state.pluginViewLayouts[location], activeViewId: viewId },
    },
  })),
  setPluginViewCollapsed: (location, collapsed) => set((state) => ({
    pluginViewLayouts: {
      ...state.pluginViewLayouts,
      [location]: { ...state.pluginViewLayouts[location], collapsed },
    },
  })),
  hydratePluginViewLayouts: (layouts) => set((state) => ({
    pluginViewLayouts: {
      ...DEFAULT_PLUGIN_VIEW_LAYOUTS,
      ...state.pluginViewLayouts,
      ...layouts,
    },
  })),
  hydrateLayout: (layout) => set((state) => ({
    activeView: isActiveView(layout?.activeView) ? layout.activeView : state.activeView,
    rightPanelCollapsed: layout?.rightPanelCollapsed ?? state.rightPanelCollapsed,
    optionDockExpanded: layout?.optionDockExpanded ?? state.optionDockExpanded,
    aiPanelMode: isAiPanelMode(layout?.aiPanelMode) ? layout.aiPanelMode : state.aiPanelMode,
    pluginViewLayouts: {
      ...DEFAULT_PLUGIN_VIEW_LAYOUTS,
      ...(layout?.pluginViews ?? {}),
    },
  })),
}));
