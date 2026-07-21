import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from './toast';
import type { CredentialEntry, CredentialInput, CredentialUpdateInput, SkillInfo, SkillInstallInfo, CreateSkillInput } from '@shared/types';

export interface ApiModel {
  id: string;
  name: string;
  provider: string;
  description?: string;
}

interface SettingsStoreState {
  credentials: CredentialEntry[];
  skills: SkillInfo[];
  skillInstallInfo: SkillInstallInfo | null;
  mcpServers: string[];
  systemPrompt: string;
  loading: boolean;
  models: ApiModel[];
  modelsLoading: boolean;
  /** Cached models per providerId — powers the inline model switcher in SettingsPanel. */
  modelsByProvider: Record<string, ApiModel[]>;
  /** Per-provider loading flag for the inline model switcher. */
  modelsLoadingByProvider: Record<string, boolean>;

  loadCredentials: () => Promise<void>;
  setCredential: (input: CredentialInput) => Promise<void>;
  updateCredential: (input: CredentialUpdateInput) => Promise<void>;
  deleteCredential: (providerId: string) => Promise<void>;
  loadSkills: () => Promise<void>;
  loadSkillInstallInfo: () => Promise<void>;
  createSkill: (input: CreateSkillInput) => Promise<void>;
  uninstallSkill: (name: string) => Promise<void>;
  loadMcpServers: () => Promise<void>;
  setMcpConfig: (projectId: string, config: unknown) => Promise<void>;
  loadSystemPrompt: (projectId: string) => Promise<void>;
  setSystemPrompt: (projectId: string, prompt: string) => Promise<void>;
  fetchModels: (providerId?: string, apiKey?: string, baseUrl?: string) => Promise<ApiModel[]>;
  /** Fetch models for a specific stored credential and cache the result. */
  fetchModelsForProvider: (providerId: string) => Promise<ApiModel[]>;
}

export const useSettingsStore = create<SettingsStoreState>((set) => ({
  credentials: [],
  skills: [],
  skillInstallInfo: null,
  mcpServers: [],
  systemPrompt: '',
  loading: false,
  models: [],
  modelsLoading: false,
  modelsByProvider: {},
  modelsLoadingByProvider: {},

  loadCredentials: async () => {
    try {
      const creds = await trpc.settings.getCredentials.query();
      set({ credentials: creds });
    } catch (err) {
      useToastStore.getState().error('加载凭据失败', err instanceof Error ? err.message : String(err));
    }
  },

  setCredential: async (input) => {
    try {
      const entry = await trpc.settings.setCredential.mutate({ input });
      set((s) => {
        const existing = s.credentials.findIndex((c) => c.providerId === entry.providerId);
        const creds = [...s.credentials];
        if (existing >= 0) creds[existing] = entry;
        else creds.push(entry);
        return { credentials: creds };
      });
      useToastStore.getState().success('凭据已保存');
    } catch (err) {
      useToastStore.getState().error('保存凭据失败', err instanceof Error ? err.message : String(err));
    }
  },

  updateCredential: async (input) => {
    try {
      const entry = await trpc.settings.updateCredential.mutate({ input });
      set((s) => {
        const existing = s.credentials.findIndex((c) => c.providerId === entry.providerId);
        const creds = [...s.credentials];
        if (existing >= 0) creds[existing] = entry;
        else creds.push(entry);
        // Invalidate cached models for this provider since credentials changed
        const { [entry.providerId]: _removedModels, ...restModels } = s.modelsByProvider;
        const { [entry.providerId]: _removedLoading, ...restLoading } = s.modelsLoadingByProvider;
        return {
          credentials: creds,
          modelsByProvider: restModels,
          modelsLoadingByProvider: restLoading,
        };
      });
      useToastStore.getState().success('凭据已更新');
    } catch (err) {
      useToastStore.getState().error('更新凭据失败', err instanceof Error ? err.message : String(err));
    }
  },

  deleteCredential: async (providerId) => {
    try {
      await trpc.settings.deleteCredential.mutate({ providerId });
      set((s) => {
        const { [providerId]: _removedModels, ...restModels } = s.modelsByProvider;
        const { [providerId]: _removedLoading, ...restLoading } = s.modelsLoadingByProvider;
        return {
          credentials: s.credentials.filter((c) => c.providerId !== providerId),
          modelsByProvider: restModels,
          modelsLoadingByProvider: restLoading,
        };
      });
      useToastStore.getState().success('凭据已删除');
    } catch (err) {
      useToastStore.getState().error('删除凭据失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadSkills: async () => {
    try {
      const skills = await trpc.settings.listSkills.query();
      set({ skills });
    } catch {
      // Best-effort
    }
  },

  loadSkillInstallInfo: async () => {
    try {
      const info = await trpc.settings.getSkillInstallInfo.query();
      set({ skillInstallInfo: info });
    } catch {
      // Best-effort
    }
  },

  createSkill: async (input) => {
    try {
      await trpc.settings.createSkill.mutate({ input });
      await useSettingsStore.getState().loadSkills();
      useToastStore.getState().success(`技能 "${input.name}" 已创建`);
    } catch (err) {
      useToastStore.getState().error('创建技能失败', err instanceof Error ? err.message : String(err));
    }
  },

  uninstallSkill: async (name) => {
    try {
      await trpc.settings.uninstallSkill.mutate({ name });
      await useSettingsStore.getState().loadSkills();
      useToastStore.getState().success(`技能 "${name}" 已卸载`);
    } catch (err) {
      useToastStore.getState().error('卸载技能失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadMcpServers: async () => {
    try {
      const servers = await trpc.settings.listMcpServers.query();
      set({ mcpServers: servers });
    } catch {
      // Best-effort
    }
  },

  setMcpConfig: async (projectId, config) => {
    try {
      await trpc.settings.setMcpConfig.mutate({ projectId, config });
      useToastStore.getState().success('MCP 配置已保存');
    } catch (err) {
      useToastStore.getState().error('保存 MCP 配置失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadSystemPrompt: async (projectId) => {
    try {
      const prompt = await trpc.settings.getSystemPrompt.query({ projectId });
      set({ systemPrompt: prompt });
    } catch {
      // Best-effort
    }
  },

  setSystemPrompt: async (projectId, prompt) => {
    try {
      await trpc.settings.setSystemPrompt.mutate({ projectId, prompt });
      useToastStore.getState().success('系统提示词已保存');
    } catch (err) {
      useToastStore.getState().error('保存提示词失败', err instanceof Error ? err.message : String(err));
    }
  },

  fetchModels: async (providerId, apiKey, baseUrl) => {
    set({ modelsLoading: true });
    try {
      const models = await trpc.settings.fetchModels.query({
        providerId,
        apiKey,
        baseUrl,
      });
      set({ models: models as ApiModel[], modelsLoading: false });
      return models as ApiModel[];
    } catch (err) {
      set({ modelsLoading: false });
      useToastStore.getState().error('获取模型列表失败', err instanceof Error ? err.message : String(err));
      return [];
    }
  },

  fetchModelsForProvider: async (providerId) => {
    set((s) => ({
      modelsLoadingByProvider: { ...s.modelsLoadingByProvider, [providerId]: true },
    }));
    try {
      const models = await trpc.settings.fetchModels.query({ providerId });
      set((s) => ({
        modelsByProvider: { ...s.modelsByProvider, [providerId]: models as ApiModel[] },
        modelsLoadingByProvider: { ...s.modelsLoadingByProvider, [providerId]: false },
      }));
      return models as ApiModel[];
    } catch (err) {
      set((s) => ({
        modelsLoadingByProvider: { ...s.modelsLoadingByProvider, [providerId]: false },
      }));
      useToastStore.getState().error('获取模型列表失败', err instanceof Error ? err.message : String(err));
      return [];
    }
  },
}));
