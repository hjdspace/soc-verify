import { create } from 'zustand';
import type {
  ProjectInfo,
  FileTreeNode,
  PluginConfigEntry,
  ExtraDirEntry,
  DirGroup,
} from '@shared/types';
import { trpc } from '@renderer/lib/trpc';
import { useSessionCoreStore } from './session-core';
import { useUiStore } from './ui';
import { tRPCError, getToast } from '@renderer/lib/trpc-utils';

/** 「最近打开」条目（左抽屉底部列表；会话内存态，重启不保留） */
export type RecentFileEntry = {
  path: string;
  name: string;
  openedAt: number;
};

/** 最近打开列表上限（原型展示 4 条，留余量） */
const RECENT_FILES_MAX = 8;

interface ProjectState {
  // ── 状态 ──────────────────────────────────────────────
  projects: ProjectInfo[];
  currentProjectId: string | null;
  fileTree: FileTreeNode | null;
  fileTreeLoading: boolean;
  /** Extra directories for the current project. */
  extraDirs: ExtraDirEntry[];
  /** Per-directory file trees, keyed by dirId. */
  dirFileTrees: Record<string, FileTreeNode>;
  /** Per-directory loading state, keyed by dirId. */
  dirFileTreeLoading: Record<string, boolean>;
  plugins: PluginConfigEntry[];
  pluginsLoading: boolean;
  selectedSubsys: string | null;
  caseStatusFilter: string;
  uiStateReady: boolean;
  /** 最近打开的文件（新→旧，去重，上限 RECENT_FILES_MAX） */
  recentFiles: RecentFileEntry[];
  // ── 动作 ──────────────────────────────────────────────
  openProject: (rootPath: string, name?: string) => Promise<void>;
  openProjectDialog: () => Promise<void>;
  switchProject: (projectId: string) => Promise<void>;
  closeProject: (projectId: string) => Promise<void>;
  renameProject: (projectId: string, name: string) => Promise<void>;
  refreshProjects: () => Promise<void>;
  loadFileTree: (projectId: string) => Promise<void>;
  refreshFileTree: () => Promise<void>;
  loadExtraDirs: (projectId: string) => Promise<void>;
  loadDirFileTree: (projectId: string, dirId: string) => Promise<void>;
  addDir: (path: string, group: DirGroup, label?: string) => Promise<void>;
  removeDir: (dirId: string) => Promise<void>;
  refreshAllFileTrees: () => Promise<void>;
  loadPlugins: (projectId: string) => Promise<void>;
  reloadPlugins: () => Promise<void>;
  togglePlugin: (pluginId: string, enabled: boolean) => Promise<void>;
  setSelectedSubsys: (subsys: string | null) => void;
  setCaseStatusFilter: (filter: string) => void;
  /** 记录最近打开的文件：去重后置顶，超出上限截断 */
  pushRecentFile: (entry: { path: string; name: string }) => void;
  saveState: () => Promise<void>;
  restoreState: () => Promise<void>;
}

/** Restore the AI sessions that were open as tabs when the GUI was last closed.
 *  If no tabs were open (first launch or all were closed last time), create
 *  a fresh session so the user can start chatting immediately. */
async function restoreOrCreateSession(projectId: string, cwd: string): Promise<void> {
  const sessionStore = useSessionCoreStore.getState();
  // If sessions already exist for this project (e.g. user switched back), do nothing
  const existing = sessionStore.sessions.some((s) => s.projectId === projectId);
  if (existing) return;

  // Fetch the persisted project state to get lastSessionIds — the list of
  // session IDs that were open as tabs when the GUI was last closed.
  let lastSessionIds: string[] | undefined;
  try {
    const state = await trpc.project.getState.query({ projectId });
    lastSessionIds = state?.lastSessionIds;
  } catch {
    // If state can't be loaded, proceed with no lastSessionIds
  }

  // Only restore sessions that were explicitly open as tabs last time.
  // If lastSessionIds is empty/undefined (no tabs were open), skip restoring
  // and create a fresh session instead.
  if (lastSessionIds && lastSessionIds.length > 0) {
    const restored = await sessionStore.restoreSessions(projectId, cwd, lastSessionIds);
    if (restored) return;
  }

  // No tabs to restore — create a fresh session so the user can start chatting.
  await sessionStore.createSession(projectId, cwd);
}

async function restoreProjectUiState(projectId: string): Promise<void> {
  try {
    const state = await trpc.project.getState.query({ projectId });
    useUiStore.getState().hydrateLayout(state?.uiLayout);
  } catch {
    // A missing or unreadable layout should keep the default host layout.
  }
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  currentProjectId: null,
  fileTree: null,
  fileTreeLoading: false,
  extraDirs: [],
  dirFileTrees: {},
  dirFileTreeLoading: {},
  plugins: [],
  pluginsLoading: false,
  selectedSubsys: null,
  caseStatusFilter: 'all',
  uiStateReady: false,
  recentFiles: [],

  openProject: async (rootPath, name) => {
    try {
      const result = await trpc.project.open.mutate({ rootPath, name });
      set((s) => ({
        projects: [...s.projects.filter((p) => p.id !== result.project.id), result.project],
        currentProjectId: result.project.id,
        plugins: result.plugins as PluginConfigEntry[],
        fileTree: null,
        extraDirs: [],
        dirFileTrees: {},
        dirFileTreeLoading: {},
        uiStateReady: false,
      }));
      // Load file tree, extra dirs, and restore UI state in parallel.
      await Promise.all([
        get().loadFileTree(result.project.id),
        get().loadExtraDirs(result.project.id),
        restoreProjectUiState(result.project.id),
      ]);
      set({ uiStateReady: true });
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
        extraDirs: [],
        dirFileTrees: {},
        dirFileTreeLoading: {},
        uiStateReady: false,
      }));
      // Load file tree, extra dirs, and restore UI state in parallel
      await Promise.all([
        get().loadFileTree(result.project.id),
        get().loadExtraDirs(result.project.id),
        restoreProjectUiState(result.project.id),
      ]);
      set({ uiStateReady: true });
      await restoreOrCreateSession(result.project.id, result.project.rootPath);
      getToast().success(`已打开项目: ${result.project.name}`);
    } catch (err) {
      getToast().error('打开项目对话框失败', tRPCError(err));
    }
  },

  switchProject: async (projectId) => {
    const { currentProjectId } = get();
    if (currentProjectId === projectId) return;

    const project = get().projects.find((p) => p.id === projectId);
    if (!project) return;

    // Save the current project state before switching (so lastSessionIds is up-to-date).
    if (currentProjectId) {
      await get().saveState();
    }

    // Re-open on the backend to update lastOpenedAt and get fresh plugins.
    // This also ensures file watchers are started for the project.
    try {
      const result = await trpc.project.open.mutate({ rootPath: project.rootPath, name: project.name });
      set((s) => ({
        projects: [...s.projects.filter((p) => p.id !== result.project.id), result.project],
        currentProjectId: result.project.id,
        plugins: result.plugins as PluginConfigEntry[],
        fileTree: null,
        extraDirs: [],
        dirFileTrees: {},
        dirFileTreeLoading: {},
        uiStateReady: false,
      }));
      // Load file tree, extra dirs, and restore UI state in parallel
      await Promise.all([
        get().loadFileTree(result.project.id),
        get().loadExtraDirs(result.project.id),
        restoreProjectUiState(result.project.id),
      ]);
      set({ uiStateReady: true });
      await restoreOrCreateSession(result.project.id, result.project.rootPath);

      // Switch to a session belonging to the new project.
      // restoreOrCreateSession may have created or restored sessions, but
      // currentSessionId could still point to the old project's session.
      const sessionStore = useSessionCoreStore.getState();
      const projectSessions = sessionStore.sessions.filter((s) => s.projectId === result.project.id);
      if (projectSessions.length > 0) {
        const current = sessionStore.sessions.find((s) => s.id === sessionStore.currentSessionId);
        if (!current || current.projectId !== result.project.id) {
          // Pick the most recently active session for this project.
          const latest = projectSessions[projectSessions.length - 1];
          sessionStore.switchSession(latest.id);
        }
      }
    } catch (err) {
      getToast().error('切换项目失败', tRPCError(err));
    }
  },

  closeProject: async (projectId) => {
    try {
      await trpc.project.close.mutate({ projectId });
      set((s) => ({
        projects: s.projects.filter((p) => p.id !== projectId),
        currentProjectId: s.currentProjectId === projectId ? null : s.currentProjectId,
        fileTree: s.currentProjectId === projectId ? null : s.fileTree,
        extraDirs: s.currentProjectId === projectId ? [] : s.extraDirs,
        dirFileTrees: s.currentProjectId === projectId ? {} : s.dirFileTrees,
        uiStateReady: s.currentProjectId === projectId ? false : s.uiStateReady,
      }));
    } catch (err) {
      getToast().error('关闭项目失败', tRPCError(err));
    }
  },

  renameProject: async (projectId, name) => {
    try {
      const updated = await trpc.project.renameProject.mutate({ projectId, name });
      set((s) => ({
        projects: s.projects.map((p) => (p.id === projectId ? updated : p)),
      }));
      getToast().success(`项目已重命名为: ${updated.name}`);
    } catch (err) {
      getToast().error('重命名项目失败', tRPCError(err));
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
    await Promise.all([
      get().loadFileTree(projectId),
      // Also refresh all extra dir file trees
      ...Object.keys(get().dirFileTrees).map((dirId) => get().loadDirFileTree(projectId, dirId)),
    ]);
  },

  loadExtraDirs: async (projectId) => {
    try {
      const dirs = await trpc.project.getExtraDirs.query({ projectId });
      set({ extraDirs: dirs });
    } catch (err) {
      getToast().error('加载额外目录失败', tRPCError(err));
    }
  },

  loadDirFileTree: async (projectId, dirId) => {
    set((s) => ({ dirFileTreeLoading: { ...s.dirFileTreeLoading, [dirId]: true } }));
    try {
      const tree = await trpc.project.getDirFileTree.query({ projectId, dirId });
      set((s) => ({
        dirFileTrees: { ...s.dirFileTrees, [dirId]: tree },
        dirFileTreeLoading: { ...s.dirFileTreeLoading, [dirId]: false },
      }));
    } catch (err) {
      set((s) => ({ dirFileTreeLoading: { ...s.dirFileTreeLoading, [dirId]: false } }));
      getToast().error('加载目录文件树失败', tRPCError(err));
    }
  },

  addDir: async (path, group, label) => {
    const projectId = get().currentProjectId;
    if (!projectId) return;
    try {
      await trpc.project.addDir.mutate({ projectId, path, group, label });
      // Reload extra dirs to reflect the newly added directory
      await get().loadExtraDirs(projectId);
      getToast().success(`已添加${group === 'verify' ? '验证' : '设计'}目录`);
    } catch (err) {
      getToast().error('添加目录失败', tRPCError(err));
    }
  },

  removeDir: async (dirId) => {
    const projectId = get().currentProjectId;
    if (!projectId) return;
    try {
      await trpc.project.removeDir.mutate({ projectId, dirId });
      // Remove the dir's cached file tree from local state
      set((s) => {
        const { [dirId]: _, ...restTrees } = s.dirFileTrees;
        const { [dirId]: __, ...restLoading } = s.dirFileTreeLoading;
        return { dirFileTrees: restTrees, dirFileTreeLoading: restLoading };
      });
      // Reload extra dirs to reflect the removal
      await get().loadExtraDirs(projectId);
      getToast().success('已移除目录');
    } catch (err) {
      getToast().error('移除目录失败', tRPCError(err));
    }
  },

  refreshAllFileTrees: async () => {
    const projectId = get().currentProjectId;
    if (!projectId) return;
    await get().refreshFileTree();
  },

  loadPlugins: async (projectId) => {
    set({ pluginsLoading: true });
    try {
      const plugins = await trpc.project.getPlugins.query({ projectId });
      set({ plugins: plugins as PluginConfigEntry[], pluginsLoading: false });
    } catch (err) {
      set({ pluginsLoading: false });
      getToast().error('加载插件列表失败', tRPCError(err));
    }
  },

  reloadPlugins: async () => {
    const projectId = get().currentProjectId;
    if (!projectId) return;
    set({ pluginsLoading: true });
    try {
      const plugins = await trpc.project.reloadPlugins.mutate({ projectId });
      set({ plugins: plugins as PluginConfigEntry[], pluginsLoading: false });
      getToast().success(`已重新扫描 ${plugins.length} 个插件`);
    } catch (err) {
      set({ pluginsLoading: false });
      getToast().error('重新扫描插件失败', tRPCError(err));
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

  pushRecentFile: (entry) => set((s) => ({
    recentFiles: [
      { ...entry, openedAt: Date.now() },
      ...s.recentFiles.filter((f) => f.path !== entry.path),
    ].slice(0, RECENT_FILES_MAX),
  })),

  saveState: async () => {
    const { currentProjectId } = get();
    if (!currentProjectId) return;
    try {
      await trpc.project.saveState.mutate({
        state: {
          projectId: currentProjectId,
          uiLayout: {
            rightPanelCollapsed: useUiStore.getState().rightPanelCollapsed,
            pluginViews: useUiStore.getState().pluginViewLayouts,
            activeView: useUiStore.getState().activeView,
            aiPanelMode: useUiStore.getState().aiPanelMode,
            simLeftPanelWidth: useUiStore.getState().simLeftPanelWidth,
          },
          lastSessionIds: useSessionCoreStore.getState().sessions
            .map((s) => s.persistedSessionId ?? s.id)
            .filter((id): id is string => Boolean(id)),
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
            extraDirs: [],
            dirFileTrees: {},
            dirFileTreeLoading: {},
            uiStateReady: false,
          }));
          // Load file tree, extra dirs, and restore UI state in parallel
          await Promise.all([
            get().loadFileTree(result.project.id),
            get().loadExtraDirs(result.project.id),
            restoreProjectUiState(result.project.id),
          ]);
          set({ uiStateReady: true });
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
