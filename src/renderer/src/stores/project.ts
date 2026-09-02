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
let projectOperationToken = 0;

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
  /**
   * 文件树展开目录路径集合（按 node.path 归档）。
   * 提升到 store 以保证组件卸载/重建后展开状态不丢失
   * （docked 模式折叠 → 展开会卸载 FilePanel，drawer 模式切换视图会关闭抽屉）。
   */
  expandedDirs: Set<string>;
  /**
   * 已默认展开过的树根路径（仅内存态）。树根（depth 0）首次挂载时 seed 进
   * expandedDirs 实现默认展开；seed 过之后不再干预——否则 watcher 刷新或
   * 面板重挂载会把用户手动折叠的根目录再次弹开。
   */
  expandedRootsSeeded: Set<string>;
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
  /** 切换目录展开/折叠状态（按 node.path 归档） */
  toggleDirExpanded: (path: string) => void;
  /** 直接设置目录展开状态 */
  setDirExpanded: (path: string, expanded: boolean) => void;
  /** 树根默认展开：每个根路径仅 seed 一次，之后用户可自由折叠且保持折叠 */
  seedRootExpanded: (path: string) => void;
  saveState: () => Promise<void>;
  restoreState: () => Promise<void>;
}

/** Restore the AI sessions that were open as tabs when the GUI was last closed.
 *  If no tabs were open (first launch or all were closed last time), create
 *  a fresh session so the user can start chatting immediately. */
async function restoreOrCreateSession(projectId: string, cwd: string): Promise<void> {
  const sessionStore = useSessionCoreStore.getState();
  // If sessions already exist for this project (e.g. user switched back),
  // select that project's most recently active session. The session id is
  // global in the renderer, so leaving the old project's id selected would
  // make the agent and file links continue to target the old project.
  const existing = sessionStore.sessions
    .filter((s) => s.projectId === projectId)
    .sort((a, b) => b.createdAt - a.createdAt);
  if (existing.length > 0) {
    sessionStore.switchSession(existing[0].id);
    return;
  }

  // Fetch the persisted project state to get lastSessionIds — the list of
  // session IDs that were open as tabs when the GUI was last closed.
  let lastSessionIds: string[] | undefined;
  try {
    const state = await trpc.project.getState.query({ projectId });
    if (useProjectStore.getState().currentProjectId !== projectId) return;
    lastSessionIds = state?.lastSessionIds;
  } catch {
    // If state can't be loaded, proceed with no lastSessionIds
  }

  // Only restore sessions that were explicitly open as tabs last time.
  // If lastSessionIds is empty/undefined (no tabs were open), skip restoring
  // and create a fresh session instead.
  if (lastSessionIds && lastSessionIds.length > 0) {
    if (useProjectStore.getState().currentProjectId !== projectId) return;
    const restored = await sessionStore.restoreSessions(projectId, cwd, lastSessionIds);
    if (useProjectStore.getState().currentProjectId !== projectId) return;
    if (restored) return;
  }

  // No tabs to restore — create a fresh session so the user can start chatting.
  if (useProjectStore.getState().currentProjectId !== projectId) return;
  await sessionStore.createSession(projectId, cwd);
}

async function restoreProjectUiState(projectId: string): Promise<void> {
  try {
    const state = await trpc.project.getState.query({ projectId });
    if (useProjectStore.getState().currentProjectId !== projectId) return;
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
  expandedDirs: new Set<string>(),
  expandedRootsSeeded: new Set<string>(),

  openProject: async (rootPath, name) => {
    const operationToken = ++projectOperationToken;
    try {
      const result = await trpc.project.open.mutate({ rootPath, name });
      if (operationToken !== projectOperationToken) return;
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
      useSessionCoreStore.setState({ currentSessionId: null, historySessions: [] });
      // Load file tree, extra dirs, and restore UI state in parallel.
      await Promise.all([
        get().loadFileTree(result.project.id),
        get().loadExtraDirs(result.project.id),
        restoreProjectUiState(result.project.id),
      ]);
      if (operationToken !== projectOperationToken) return;
      set({ uiStateReady: true });
      await restoreOrCreateSession(result.project.id, result.project.rootPath);
      // Ignore a late project-load completion if the user switched again
      // while file trees/plugins were loading.
      if (operationToken !== projectOperationToken || get().currentProjectId !== result.project.id) return;
      getToast().success(`已打开项目: ${result.project.name}`);
    } catch (err) {
      getToast().error('打开项目失败', tRPCError(err));
    }
  },

  openProjectDialog: async () => {
    const operationToken = ++projectOperationToken;
    try {
      getToast().info('正在打开项目选择器...');
      const result = await trpc.project.openDialog.mutate();
      if (result.canceled) return;
      if (operationToken !== projectOperationToken) return;
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
      useSessionCoreStore.setState({ currentSessionId: null, historySessions: [] });
      // Load file tree, extra dirs, and restore UI state in parallel
      await Promise.all([
        get().loadFileTree(result.project.id),
        get().loadExtraDirs(result.project.id),
        restoreProjectUiState(result.project.id),
      ]);
      if (operationToken !== projectOperationToken) return;
      set({ uiStateReady: true });
      await restoreOrCreateSession(result.project.id, result.project.rootPath);
      if (operationToken !== projectOperationToken || get().currentProjectId !== result.project.id) return;
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
    const operationToken = ++projectOperationToken;

    // Save the current project state before switching (so lastSessionIds is up-to-date).
    if (currentProjectId) {
      await get().saveState();
    }

    // Re-open on the backend to update lastOpenedAt and get fresh plugins.
    // This also ensures file watchers are started for the project.
    try {
      const result = await trpc.project.open.mutate({ rootPath: project.rootPath, name: project.name });
      if (operationToken !== projectOperationToken) return;
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
      useSessionCoreStore.setState({ currentSessionId: null, historySessions: [] });
      // Load file tree, extra dirs, and restore UI state in parallel
      await Promise.all([
        get().loadFileTree(result.project.id),
        get().loadExtraDirs(result.project.id),
        restoreProjectUiState(result.project.id),
      ]);
      if (operationToken !== projectOperationToken) return;
      set({ uiStateReady: true });
      await restoreOrCreateSession(result.project.id, result.project.rootPath);

      if (operationToken !== projectOperationToken || get().currentProjectId !== result.project.id) return;

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
      if (get().currentProjectId !== projectId) return;
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
      if (get().currentProjectId !== projectId) return;
      set({ extraDirs: dirs });
    } catch (err) {
      getToast().error('加载额外目录失败', tRPCError(err));
    }
  },

  loadDirFileTree: async (projectId, dirId) => {
    set((s) => ({ dirFileTreeLoading: { ...s.dirFileTreeLoading, [dirId]: true } }));
    try {
      const tree = await trpc.project.getDirFileTree.query({ projectId, dirId });
      if (get().currentProjectId !== projectId) return;
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

  toggleDirExpanded: (path) => set((s) => {
    const next = new Set(s.expandedDirs);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    return { expandedDirs: next };
  }),

  setDirExpanded: (path, expanded) => set((s) => {
    const next = new Set(s.expandedDirs);
    if (expanded) {
      next.add(path);
    } else {
      next.delete(path);
    }
    return { expandedDirs: next };
  }),

  seedRootExpanded: (path) => set((s) => {
    // 已 seed 过的根不再干预（保留用户的折叠选择）
    if (s.expandedRootsSeeded.has(path)) return {};
    const nextSeeded = new Set(s.expandedRootsSeeded);
    nextSeeded.add(path);
    const nextExpanded = new Set(s.expandedDirs);
    nextExpanded.add(path);
    return { expandedRootsSeeded: nextSeeded, expandedDirs: nextExpanded };
  }),

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
            filePanelMode: useUiStore.getState().filePanelMode,
            filePanelCollapsed: useUiStore.getState().filePanelCollapsed,
            filePanelWidth: useUiStore.getState().filePanelWidth,
            simLeftPanelWidth: useUiStore.getState().simLeftPanelWidth,
          },
          lastSessionIds: useSessionCoreStore.getState().sessions
            .filter((s) => s.projectId === currentProjectId)
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
          useSessionCoreStore.setState({ currentSessionId: null, historySessions: [] });
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
