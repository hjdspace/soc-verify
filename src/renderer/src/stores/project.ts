import { create } from 'zustand';
import type {
  ProjectInfo,
  FileTreeNode,
  PluginConfigEntry,
} from '@shared/types';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from './toast';
import { useSessionStore } from './session';

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

function getToast() {
  return useToastStore.getState();
}

function tRPCError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as Record<string, unknown>).message);
  }
  return String(err);
}

/**
 * Restore persisted AI sessions for a project, or create a new one if none exist.
 * This replaces the old autoCreateDefaultSession — instead of always creating
 * a new session, it first tries to restore previously open sessions from disk.
 */
async function restoreOrCreateSession(projectId: string, cwd: string): Promise<void> {
  const sessionStore = useSessionStore.getState();
  // If sessions already exist for this project (e.g. user switched back), do nothing
  const existing = sessionStore.sessions.some((s) => s.projectId === projectId);
  if (existing) return;
  // Try to restore persisted sessions first
  const restored = await sessionStore.restoreSessions(projectId, cwd);
  // If no sessions were restored, create a new default one
  if (!restored) {
    await sessionStore.createSession(projectId, cwd);
  }
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
    try {
      const result = await trpc.project.open.mutate({ rootPath, name });
      set((s) => ({
        projects: [...s.projects.filter((p) => p.id !== result.project.id), result.project],
        currentProjectId: result.project.id,
        plugins: result.plugins as PluginConfigEntry[],
        fileTree: null,
      }));
      // Load file tree, then restore or create AI sessions
      await get().loadFileTree(result.project.id);
      await restoreOrCreateSession(result.project.id, result.project.rootPath);
      getToast().success(`已打开项目: ${result.project.name}`);
    } catch (err) {
      getToast().error('打开项目失败', tRPCError(err));
    }
  },

  openProjectDialog: async () => {
    try {
      getToast().info('正在打开项目选择器...');
      const result = await trpc.project.openDialog.mutate();
      if (result.canceled) return;
      set((s) => ({
        projects: [...s.projects.filter((p) => p.id !== result.project.id), result.project],
        currentProjectId: result.project.id,
        plugins: result.plugins as PluginConfigEntry[],
        fileTree: null,
      }));
      // Load file tree, then restore or create AI sessions
      await get().loadFileTree(result.project.id);
      await restoreOrCreateSession(result.project.id, result.project.rootPath);
      getToast().success(`已打开项目: ${result.project.name}`);
    } catch (err) {
      getToast().error('打开项目对话框失败', tRPCError(err));
    }
  },

  closeProject: async (projectId) => {
    try {
      await trpc.project.close.mutate({ projectId });
      set((s) => ({
        projects: s.projects.filter((p) => p.id !== projectId),
        currentProjectId: s.currentProjectId === projectId ? null : s.currentProjectId,
        fileTree: s.currentProjectId === projectId ? null : s.fileTree,
      }));
    } catch (err) {
      getToast().error('关闭项目失败', tRPCError(err));
    }
  },

  refreshProjects: async () => {
    try {
      const projects = await trpc.project.list.query();
      set({ projects });
    } catch (err) {
      getToast().error('刷新项目列表失败', tRPCError(err));
    }
  },

  loadFileTree: async (projectId) => {
    set({ fileTreeLoading: true });
    try {
      const tree = await trpc.project.getFileTree.query({ projectId });
      set({ fileTree: tree, fileTreeLoading: false });
    } catch (err) {
      set({ fileTreeLoading: false });
      getToast().error('加载文件树失败', tRPCError(err));
    }
  },

  refreshFileTree: async () => {
    const projectId = get().currentProjectId;
    if (!projectId) return;
    await get().loadFileTree(projectId);
  },

  loadPlugins: async (projectId) => {
    try {
      const plugins = await trpc.project.getPlugins.query({ projectId });
      set({ plugins: plugins as PluginConfigEntry[] });
    } catch (err) {
      getToast().error('加载插件列表失败', tRPCError(err));
    }
  },

  togglePlugin: async (pluginId, enabled) => {
    const projectId = get().currentProjectId;
    if (!projectId) return;
    try {
      await trpc.project.togglePlugin.mutate({ projectId, pluginId, enabled });
      await get().loadPlugins(projectId);
    } catch (err) {
      getToast().error('切换插件状态失败', tRPCError(err));
    }
  },

  setSelectedSubsys: (subsys) => set({ selectedSubsys: subsys }),

  setCaseStatusFilter: (filter) => set({ caseStatusFilter: filter }),

  saveState: async () => {
    const { currentProjectId } = get();
    if (!currentProjectId) return;
    try {
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
    } catch (err) {
      console.error('Failed to save state:', err);
    }
  },

  restoreState: async () => {
    try {
      await get().refreshProjects();
      const projects = get().projects;
      if (projects.length > 0) {
        // Restore the most recently opened project by re-opening it on the backend.
        // This ensures plugins are loaded and file watchers are started.
        const latest = projects.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0];
        try {
          const result = await trpc.project.open.mutate({ rootPath: latest.rootPath, name: latest.name });
          set((s) => ({
            projects: [...s.projects.filter((p) => p.id !== result.project.id), result.project],
            currentProjectId: result.project.id,
            plugins: result.plugins as PluginConfigEntry[],
            fileTree: null,
          }));
          // Load file tree, then restore or create AI sessions
          await get().loadFileTree(result.project.id);
          await restoreOrCreateSession(result.project.id, result.project.rootPath);
        } catch {
          // Fallback: if re-open fails (e.g. directory deleted), just set the ID
          set({ currentProjectId: latest.id });
        }
      }
    } catch (err) {
      getToast().error('恢复项目状态失败', tRPCError(err));
    }
  },
}));
