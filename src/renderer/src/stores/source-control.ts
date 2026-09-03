import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from './toast';
import type { ScmFileDiff, SourceControlCommitResult, SourceControlStatus } from '@shared/types';

/** 展开行缓存 key：同一文件的已暂存 diff 与未暂存 diff 视为不同条目 */
export function scmDiffKey(filePath: string, staged: boolean): string {
  return `${staged ? 's' : 'w'}:${filePath}`;
}

interface SourceControlState {
  status: SourceControlStatus | null;
  commitMessage: string;
  loading: boolean;
  generating: boolean;
  committing: boolean;
  staging: boolean;
  /** 已展开的文件行（key 见 scmDiffKey） */
  expandedDiffKeys: Record<string, boolean>;
  /** 已加载的文件 diff 内容 */
  fileDiffs: Record<string, ScmFileDiff | undefined>;
  /** 正在加载 diff 的 key 集合 */
  loadingDiffKeys: Record<string, boolean>;
  loadStatus: (projectId: string) => Promise<void>;
  /**
   * 文件系统变化后的轻量 git 状态刷新（文件树 watcher 事件触发）。
   * 防抖 + inflight 去重；只更新 status，不动 expandedDiffKeys/fileDiffs
   * （避免用户正在查看的 diff 被折叠）；失败静默（后台刷新不值得打扰用户）。
   */
  refreshStatus: (projectId: string) => Promise<void>;
  setCommitMessage: (message: string) => void;
  generateCommitMessage: (projectId: string, modelId?: string, providerId?: string) => Promise<void>;
  toggleFileDiff: (projectId: string, filePath: string, staged: boolean) => Promise<void>;
  stageFiles: (projectId: string, filePaths: string[]) => Promise<void>;
  unstageFiles: (projectId: string, filePaths: string[]) => Promise<void>;
  discardChanges: (projectId: string, filePaths: string[]) => Promise<void>;
  commit: (projectId: string) => Promise<SourceControlCommitResult | null>;
  commitAll: (projectId: string) => Promise<SourceControlCommitResult | null>;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as Record<string, unknown>).message);
  }
  return String(err);
}

// ── 文件变化后的轻量 git 状态刷新（refreshStatus 共享状态）────────
// watcher 突发多条事件、或多个 FileTree 实例（root + 额外目录）同时订阅时，
// 只允许发一次 git status 请求：模块级防抖 timer + inflight Promise 去重。
const SCM_REFRESH_DEBOUNCE_MS = 500;
let scmRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let scmRefreshInflight: Promise<void> | null = null;

// ── loadStatus 并发去重 ────────────────────────────────────────────
// 文件树、SCM 面板等同时挂载都会触发 loadStatus；git status 在 Linux 大工程
// 树上可能耗时数秒~十几秒，并发去重保证同一时刻只跑一次全树 status。
let loadStatusInflight: Promise<void> | null = null;

/** 挂载类 loadStatus 允许复用主进程缓存的时长（毫秒）。 */
const SCM_STATUS_MAX_AGE_MS = 15000;

export const useSourceControlStore = create<SourceControlState>((set, get) => ({
  status: null,
  commitMessage: '',
  loading: false,
  generating: false,
  committing: false,
  staging: false,
  expandedDiffKeys: {},
  fileDiffs: {},
  loadingDiffKeys: {},

  loadStatus: async (projectId) => {
    // 并发去重：同时挂载的多个组件共享同一次请求
    if (loadStatusInflight) return loadStatusInflight;
    const run = (async () => {
      set({ loading: true });
      try {
        const status = await trpc.scm.status.query({ projectId, maxAgeMs: SCM_STATUS_MAX_AGE_MS });
        // 暂存区/工作区已变化，旧的展开 diff 不再可信，全部收起
        set({ status, loading: false, expandedDiffKeys: {}, fileDiffs: {}, loadingDiffKeys: {} });
      } catch (err) {
        set({ loading: false });
        useToastStore.getState().error('加载 Git 状态失败', errorMessage(err));
      } finally {
        loadStatusInflight = null;
      }
    })();
    loadStatusInflight = run;
    return run;
  },

  refreshStatus: (projectId) => {
    if (scmRefreshTimer) clearTimeout(scmRefreshTimer);
    return new Promise<void>((resolve) => {
      scmRefreshTimer = setTimeout(() => {
        scmRefreshTimer = null;
        if (!scmRefreshInflight) {
          scmRefreshInflight = trpc.scm.status
            .query({ projectId })
            .then((status) => {
              // 只更新 status —— 保留 SCM 面板正在查看的展开 diff
              set({ status });
            })
            .catch(() => {
              // 静默：文件事件触发的后台刷新失败不打扰用户
            })
            .finally(() => {
              scmRefreshInflight = null;
            });
        }
        void scmRefreshInflight.then(resolve);
      }, SCM_REFRESH_DEBOUNCE_MS);
    });
  },

  setCommitMessage: (message) => set({ commitMessage: message }),

  generateCommitMessage: async (projectId, modelId, providerId) => {
    set({ generating: true });
    try {
      const result = await trpc.scm.generateCommitMessage.mutate({ projectId, modelId, providerId });
      set({ commitMessage: result.message, generating: false });
      useToastStore.getState().success('已生成提交信息');
    } catch (err) {
      set({ generating: false });
      useToastStore.getState().error('生成提交信息失败', errorMessage(err));
    }
  },

  toggleFileDiff: async (projectId, filePath, staged) => {
    const key = scmDiffKey(filePath, staged);
    if (get().expandedDiffKeys[key]) {
      // 收起（保留缓存，便于再次展开时秒开）
      set({ expandedDiffKeys: { ...get().expandedDiffKeys, [key]: false } });
      return;
    }

    set({ expandedDiffKeys: { ...get().expandedDiffKeys, [key]: true } });
    if (get().fileDiffs[key]) return; // 已缓存

    set({ loadingDiffKeys: { ...get().loadingDiffKeys, [key]: true } });
    try {
      const result = await trpc.scm.fileDiff.query({ projectId, filePath, staged });
      set({
        fileDiffs: { ...get().fileDiffs, [key]: result.diff },
        loadingDiffKeys: { ...get().loadingDiffKeys, [key]: false },
      });
    } catch (err) {
      // 加载失败则收起该行，避免停留在空展开态
      const { [key]: _collapsed, ...restExpanded } = get().expandedDiffKeys;
      set({
        expandedDiffKeys: restExpanded,
        loadingDiffKeys: { ...get().loadingDiffKeys, [key]: false },
      });
      useToastStore.getState().error('加载文件 diff 失败', errorMessage(err));
    }
  },

  stageFiles: async (projectId, filePaths) => {
    set({ staging: true });
    try {
      const status = await trpc.scm.stage.mutate({ projectId, filePaths });
      set({ status, staging: false, expandedDiffKeys: {}, fileDiffs: {}, loadingDiffKeys: {} });
    } catch (err) {
      set({ staging: false });
      useToastStore.getState().error('暂存失败', errorMessage(err));
    }
  },

  unstageFiles: async (projectId, filePaths) => {
    set({ staging: true });
    try {
      const status = await trpc.scm.unstage.mutate({ projectId, filePaths });
      set({ status, staging: false, expandedDiffKeys: {}, fileDiffs: {}, loadingDiffKeys: {} });
    } catch (err) {
      set({ staging: false });
      useToastStore.getState().error('取消暂存失败', errorMessage(err));
    }
  },

  discardChanges: async (projectId, filePaths) => {
    set({ staging: true });
    try {
      const status = await trpc.scm.discard.mutate({ projectId, filePaths });
      set({ status, staging: false, expandedDiffKeys: {}, fileDiffs: {}, loadingDiffKeys: {} });
      useToastStore.getState().success('已放弃更改');
    } catch (err) {
      set({ staging: false });
      useToastStore.getState().error('放弃更改失败', errorMessage(err));
    }
  },

  commit: async (projectId) => {
    const message = get().commitMessage.trim();
    if (!message) {
      useToastStore.getState().error('提交信息不能为空');
      return null;
    }

    set({ committing: true });
    try {
      const result = await trpc.scm.commit.mutate({ projectId, message });
      set({ committing: false, commitMessage: '' });
      await get().loadStatus(projectId);
      useToastStore.getState().success(`已提交 ${result.commitHash}`);
      return result;
    } catch (err) {
      set({ committing: false });
      useToastStore.getState().error('提交失败', errorMessage(err));
      return null;
    }
  },

  commitAll: async (projectId) => {
    const message = get().commitMessage.trim();
    if (!message) {
      useToastStore.getState().error('提交信息不能为空');
      return null;
    }

    set({ committing: true });
    try {
      const result = await trpc.scm.commitAll.mutate({ projectId, message });
      set({ committing: false, commitMessage: '' });
      await get().loadStatus(projectId);
      useToastStore.getState().success(`已提交 ${result.commitHash}`);
      return result;
    } catch (err) {
      set({ committing: false });
      useToastStore.getState().error('提交失败', errorMessage(err));
      return null;
    }
  },
}));
