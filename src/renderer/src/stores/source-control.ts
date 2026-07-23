import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from './toast';
import type { SourceControlCommitResult, SourceControlStatus } from '@shared/types';

interface SourceControlState {
  status: SourceControlStatus | null;
  commitMessage: string;
  loading: boolean;
  generating: boolean;
  committing: boolean;
  staging: boolean;
  loadStatus: (projectId: string) => Promise<void>;
  setCommitMessage: (message: string) => void;
  generateCommitMessage: (projectId: string, modelId?: string, providerId?: string) => Promise<void>;
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

export const useSourceControlStore = create<SourceControlState>((set, get) => ({
  status: null,
  commitMessage: '',
  loading: false,
  generating: false,
  committing: false,
  staging: false,

  loadStatus: async (projectId) => {
    set({ loading: true });
    try {
      const status = await trpc.scm.status.query({ projectId });
      set({ status, loading: false });
    } catch (err) {
      set({ loading: false });
      useToastStore.getState().error('加载 Git 状态失败', errorMessage(err));
    }
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

  stageFiles: async (projectId, filePaths) => {
    set({ staging: true });
    try {
      const status = await trpc.scm.stage.mutate({ projectId, filePaths });
      set({ status, staging: false });
    } catch (err) {
      set({ staging: false });
      useToastStore.getState().error('暂存失败', errorMessage(err));
    }
  },

  unstageFiles: async (projectId, filePaths) => {
    set({ staging: true });
    try {
      const status = await trpc.scm.unstage.mutate({ projectId, filePaths });
      set({ status, staging: false });
    } catch (err) {
      set({ staging: false });
      useToastStore.getState().error('取消暂存失败', errorMessage(err));
    }
  },

  discardChanges: async (projectId, filePaths) => {
    set({ staging: true });
    try {
      const status = await trpc.scm.discard.mutate({ projectId, filePaths });
      set({ status, staging: false });
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
