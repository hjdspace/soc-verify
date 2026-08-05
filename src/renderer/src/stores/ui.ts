import { create } from 'zustand';
import type { PluginViewLayoutState } from '@shared/types/project';
import type { PluginViewLocation } from '@shared/plugin-types';

type PluginViewLayouts = Record<PluginViewLocation, PluginViewLayoutState>;

const DEFAULT_PLUGIN_VIEW_LAYOUTS: PluginViewLayouts = {
  center: { collapsed: false },
  left: { collapsed: false },
  right: { collapsed: false },
  bottom: { collapsed: false },
};

interface UiState {
  leftRailCollapsed: boolean;
  rightPanelCollapsed: boolean;
  optionDockExpanded: boolean;
  settingsOpen: boolean;
  commandPaletteOpen: boolean;
  sourceControlOpen: boolean;
  centerMenuOpen: boolean;
  leftRailWidth: number;
  rightPanelWidth: number;
  bottomPanelCollapsed: boolean;
  bottomPanelHeight: number;
  pluginViewLayouts: PluginViewLayouts;
  toggleLeftRail: () => void;
  toggleRightPanel: () => void;
  toggleOptionDock: () => void;
  toggleBottomPanel: () => void;
  setSettingsOpen: (open: boolean) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setSourceControlOpen: (open: boolean) => void;
  setCenterMenuOpen: (open: boolean) => void;
  setLeftRailWidth: (width: number) => void;
  setRightPanelWidth: (width: number) => void;
  setBottomPanelCollapsed: (collapsed: boolean) => void;
  setBottomPanelHeight: (height: number) => void;
  setPluginViewActive: (location: PluginViewLocation, viewId: string) => void;
  setPluginViewCollapsed: (location: PluginViewLocation, collapsed: boolean) => void;
  hydratePluginViewLayouts: (layouts?: Partial<PluginViewLayouts>) => void;
  hydrateLayout: (layout?: {
    leftRailCollapsed?: boolean;
    rightPanelCollapsed?: boolean;
    optionDockExpanded?: boolean;
    pluginViews?: Partial<PluginViewLayouts>;
  }) => void;
}

const LEFT_MIN = 200;
const LEFT_MAX = 500;
const RIGHT_MIN = 280;
const RIGHT_MAX = 600;
const BOTTOM_MIN = 120;
const BOTTOM_MAX = 600;

export const useUiStore = create<UiState>((set) => ({
  leftRailCollapsed: false,
  rightPanelCollapsed: false,
  optionDockExpanded: false,
  settingsOpen: false,
  commandPaletteOpen: false,
  sourceControlOpen: false,
  centerMenuOpen: false,
  leftRailWidth: 256,
  rightPanelWidth: 384,
  bottomPanelCollapsed: true,
  bottomPanelHeight: 240,
  pluginViewLayouts: DEFAULT_PLUGIN_VIEW_LAYOUTS,
  toggleLeftRail: () => set((s) => ({ leftRailCollapsed: !s.leftRailCollapsed })),
  toggleRightPanel: () => set((s) => ({ rightPanelCollapsed: !s.rightPanelCollapsed })),
  toggleOptionDock: () => set((s) => ({ optionDockExpanded: !s.optionDockExpanded })),
  toggleBottomPanel: () => set((s) => ({ bottomPanelCollapsed: !s.bottomPanelCollapsed })),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  setSourceControlOpen: (open) => set({ sourceControlOpen: open }),
  setCenterMenuOpen: (open) => set({ centerMenuOpen: open }),
  setLeftRailWidth: (width) => set({ leftRailWidth: Math.max(LEFT_MIN, Math.min(LEFT_MAX, width)) }),
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
    leftRailCollapsed: layout?.leftRailCollapsed ?? state.leftRailCollapsed,
    rightPanelCollapsed: layout?.rightPanelCollapsed ?? state.rightPanelCollapsed,
    optionDockExpanded: layout?.optionDockExpanded ?? state.optionDockExpanded,
    pluginViewLayouts: {
      ...DEFAULT_PLUGIN_VIEW_LAYOUTS,
      ...(layout?.pluginViews ?? {}),
    },
  })),
}));
