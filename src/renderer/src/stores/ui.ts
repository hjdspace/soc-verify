import { create } from 'zustand';

interface UiState {
  leftRailCollapsed: boolean;
  rightPanelCollapsed: boolean;
  optionDockExpanded: boolean;
  settingsOpen: boolean;
  commandPaletteOpen: boolean;
  leftRailWidth: number;
  rightPanelWidth: number;
  toggleLeftRail: () => void;
  toggleRightPanel: () => void;
  toggleOptionDock: () => void;
  setSettingsOpen: (open: boolean) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setLeftRailWidth: (width: number) => void;
  setRightPanelWidth: (width: number) => void;
}

const LEFT_MIN = 200;
const LEFT_MAX = 500;
const RIGHT_MIN = 280;
const RIGHT_MAX = 600;

export const useUiStore = create<UiState>((set) => ({
  leftRailCollapsed: false,
  rightPanelCollapsed: false,
  optionDockExpanded: false,
  settingsOpen: false,
  commandPaletteOpen: false,
  leftRailWidth: 256,
  rightPanelWidth: 384,
  toggleLeftRail: () => set((s) => ({ leftRailCollapsed: !s.leftRailCollapsed })),
  toggleRightPanel: () => set((s) => ({ rightPanelCollapsed: !s.rightPanelCollapsed })),
  toggleOptionDock: () => set((s) => ({ optionDockExpanded: !s.optionDockExpanded })),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  setLeftRailWidth: (width) => set({ leftRailWidth: Math.max(LEFT_MIN, Math.min(LEFT_MAX, width)) }),
  setRightPanelWidth: (width) => set({ rightPanelWidth: Math.max(RIGHT_MIN, Math.min(RIGHT_MAX, width)) }),
}));
