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
  centerView: 'terminal' | 'file' | 'ai-artifacts' | 'sim-errors' | 'sim-history' | 'sim-detail' | 'sim-compare' | 'empty';
  leftRailWidth: number;
  rightPanelWidth: number;
  toggleLeftRail: () => void;
  toggleRightPanel: () => void;
  toggleOptionDock: () => void;
  setActiveCenterTab: (id: string | null) => void;
  setSettingsOpen: (open: boolean) => void;
  setSelectedFile: (path: string, name: string) => void;
  setCenterView: (view: 'terminal' | 'file' | 'ai-artifacts' | 'sim-errors' | 'sim-history' | 'sim-detail' | 'sim-compare' | 'empty') => void;
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
  activeCenterTab: null,
  settingsOpen: false,
  selectedFile: null,
  centerView: 'empty',
  leftRailWidth: 256,
  rightPanelWidth: 384,
  toggleLeftRail: () => set((s) => ({ leftRailCollapsed: !s.leftRailCollapsed })),
  toggleRightPanel: () => set((s) => ({ rightPanelCollapsed: !s.rightPanelCollapsed })),
  toggleOptionDock: () => set((s) => ({ optionDockExpanded: !s.optionDockExpanded })),
  setActiveCenterTab: (id) => set({ activeCenterTab: id }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setSelectedFile: (path, name) => set({ selectedFile: { path, name }, centerView: 'file' }),
  setCenterView: (view) => set({ centerView: view }),
  setLeftRailWidth: (width) => set({ leftRailWidth: Math.max(LEFT_MIN, Math.min(LEFT_MAX, width)) }),
  setRightPanelWidth: (width) => set({ rightPanelWidth: Math.max(RIGHT_MIN, Math.min(RIGHT_MAX, width)) }),
}));
