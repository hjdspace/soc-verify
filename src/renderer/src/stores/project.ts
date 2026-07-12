import { create } from 'zustand';
import type {
  ProjectInfo,
  FileTreeNode,
  PluginConfigEntry,
} from '@shared/types';
import { trpc } from '@renderer/lib/trpc';

interface ProjectState {
  // ── 状态 ──────────────────────────────────────────────
  projects: ProjectInfo[];
  currentProjectId: string | null;
  fileTree: FileTreeNode | null;
  fileTreeLoading: boolean;
  plugins: PluginConfigEntry[];
  selectedSubsys: string | null;
  caseStatusFilter: string;
  // ── 动作 ──────────────────────────────────────────────
  openProject: (rootPath: string, name?: string) => Promise<void>;
  openProjectDialog: () => Promise<void>;
  closeProject: (projectId: string) => Promise<void>;
  refreshProjects: () => Promise<void>;
  loadFileTree: (projectId: string) => Promise<void>;
  refreshFileTree: () => Promise<void>;
  loadPlugins: (projectId: string) => Promise<void>;
  togglePlugin: (pluginId: string, enabled: boolean) => Promise<void>;
  setSelectedSubsys: (subsys: string | null) => void;
  setCaseStatusFilter: (filter: string) => void;
  saveState: () => Promise<void>;
  restoreState: () => Promise<void>;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  currentProjectId: null,
  fileTree: null,
  fileTreeLoading: false,
  plugins: [],
  selectedSubsys: null,
  caseStatusFilter: 'all',

  openProject: async (rootPath, name) => {
    const result = await trpc.project.open.mutate({ rootPath, name });
    set((s) => ({
      projects: [...s.projects.filter((p) => p.id !== result.project.id), result.project],
      currentProjectId: result.project.id,
      plugins: result.plugins as PluginConfigEntry[],
      fileTree: null,
    }));
    // Auto-load file tree
    await get().loadFileTree(result.project.id);
  },

  openProjectDialog: async () => {
    const result = await trpc.project.openDialog.mutate();
    if (result.canceled) return;
    set((s) => ({
      projects: [...s.projects.filter((p) => p.id !== result.project.id), result.project],
      currentProjectId: result.project.id,
      plugins: result.plugins as PluginConfigEntry[],
      fileTree: null,
    }));
    await get().loadFileTree(result.project.id);
  },

  closeProject: async (projectId) => {
    await trpc.project.close.mutate({ projectId });
    set((s) => ({
      projects: s.projects.filter((p) => p.id !== projectId),
      currentProjectId: s.currentProjectId === projectId ? null : s.currentProjectId,
      fileTree: s.currentProjectId === projectId ? null : s.fileTree,
    }));
  },

  refreshProjects: async () => {
    const projects = await trpc.project.list.query();
    set({ projects });
  },

  loadFileTree: async (projectId) => {
    set({ fileTreeLoading: true });
    try {
      const tree = await trpc.project.getFileTree.query({ projectId });
      set({ fileTree: tree, fileTreeLoading: false });
    } catch {
      set({ fileTreeLoading: false });
    }
  },

  refreshFileTree: async () => {
    const projectId = get().currentProjectId;
    if (!projectId) return;
    await get().loadFileTree(projectId);
  },

  loadPlugins: async (projectId) => {
    const plugins = await trpc.project.getPlugins.query({ projectId });
    set({ plugins: plugins as PluginConfigEntry[] });
  },

  togglePlugin: async (pluginId, enabled) => {
    const projectId = get().currentProjectId;
    if (!projectId) return;
    await trpc.project.togglePlugin.mutate({ projectId, pluginId, enabled });
    await get().loadPlugins(projectId);
  },

  setSelectedSubsys: (subsys) => set({ selectedSubsys: subsys }),

  setCaseStatusFilter: (filter) => set({ caseStatusFilter: filter }),

  saveState: async () => {
    const { currentProjectId } = get();
    if (!currentProjectId) return;
    await trpc.project.saveState.mutate({
      state: {
        projectId: currentProjectId,
        uiLayout: {
          leftRailCollapsed: false,
          rightPanelCollapsed: false,
          optionDockExpanded: false,
        },
        lastSessionIds: [],
      },
    });
  },

  restoreState: async () => {
    await get().refreshProjects();
    const projects = get().projects;
    if (projects.length > 0) {
      // Restore the most recently opened project
      const latest = projects.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0];
      set({ currentProjectId: latest.id });
      await get().loadFileTree(latest.id);
      await get().loadPlugins(latest.id);
    }
  },
}));
