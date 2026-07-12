import { create } from 'zustand';

interface SelectedFile {
  path: string;
  name: string;
}

interface UiState {
  leftRailCollapsed: boolean;
  rightPanelCollapsed: boolean;
  optionDockExpanded: boolean;
  activeCenterTab: string | null;
  settingsOpen: boolean;
  selectedFile: SelectedFile | null;
  centerView: 'terminal' | 'file' | 'ai-artifacts' | 'empty';
  toggleLeftRail: () => void;
  toggleRightPanel: () => void;
  toggleOptionDock: () => void;
  setActiveCenterTab: (id: string | null) => void;
  setSettingsOpen: (open: boolean) => void;
  setSelectedFile: (path: string, name: string) => void;
  setCenterView: (view: 'terminal' | 'file' | 'ai-artifacts' | 'empty') => void;
}

export const useUiStore = create<UiState>((set) => ({
  leftRailCollapsed: false,
  rightPanelCollapsed: false,
  optionDockExpanded: false,
  activeCenterTab: null,
  settingsOpen: false,
  selectedFile: null,
  centerView: 'empty',
  toggleLeftRail: () => set((s) => ({ leftRailCollapsed: !s.leftRailCollapsed })),
  toggleRightPanel: () => set((s) => ({ rightPanelCollapsed: !s.rightPanelCollapsed })),
  toggleOptionDock: () => set((s) => ({ optionDockExpanded: !s.optionDockExpanded })),
  setActiveCenterTab: (id) => set({ activeCenterTab: id }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setSelectedFile: (path, name) => set({ selectedFile: { path, name }, centerView: 'file' }),
  setCenterView: (view) => set({ centerView: view }),
}));
