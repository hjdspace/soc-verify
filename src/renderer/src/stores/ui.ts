import { create } from 'zustand';

interface UiState {
  leftRailCollapsed: boolean;
  rightPanelCollapsed: boolean;
  optionDockExpanded: boolean;
  activeCenterTab: string | null;
  toggleLeftRail: () => void;
  toggleRightPanel: () => void;
  toggleOptionDock: () => void;
  setActiveCenterTab: (id: string | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  leftRailCollapsed: false,
  rightPanelCollapsed: false,
  optionDockExpanded: false,
  activeCenterTab: null,
  toggleLeftRail: () => set((s) => ({ leftRailCollapsed: !s.leftRailCollapsed })),
  toggleRightPanel: () => set((s) => ({ rightPanelCollapsed: !s.rightPanelCollapsed })),
  toggleOptionDock: () => set((s) => ({ optionDockExpanded: !s.optionDockExpanded })),
  setActiveCenterTab: (id) => set({ activeCenterTab: id })
}));
