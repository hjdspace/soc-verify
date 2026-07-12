import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from './toast';
import type { CredentialEntry, CredentialInput } from '@shared/types';

interface SettingsStoreState {
  credentials: CredentialEntry[];
  skills: string[];
  mcpServers: string[];
  systemPrompt: string;
  loading: boolean;

  loadCredentials: () => Promise<void>;
  setCredential: (input: CredentialInput) => Promise<void>;
  deleteCredential: (providerId: string) => Promise<void>;
  loadSkills: () => Promise<void>;
  installSkill: (name: string) => Promise<void>;
  uninstallSkill: (name: string) => Promise<void>;
  loadMcpServers: () => Promise<void>;
  setMcpConfig: (projectId: string, config: unknown) => Promise<void>;
  loadSystemPrompt: (projectId: string) => Promise<void>;
  setSystemPrompt: (projectId: string, prompt: string) => Promise<void>;
}

export const useSettingsStore = create<SettingsStoreState>((set) => ({
  credentials: [],
  skills: [],
  mcpServers: [],
  systemPrompt: '',
  loading: false,

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

  deleteCredential: async (providerId) => {
    try {
      await trpc.settings.deleteCredential.mutate({ providerId });
      set((s) => ({ credentials: s.credentials.filter((c) => c.providerId !== providerId) }));
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

  installSkill: async (name) => {
    try {
      await trpc.settings.installSkill.mutate({ name });
      await useSettingsStore.getState().loadSkills();
      useToastStore.getState().success(`Skill "${name}" 已安装`);
    } catch (err) {
      useToastStore.getState().error('安装 Skill 失败', err instanceof Error ? err.message : String(err));
    }
  },

  uninstallSkill: async (name) => {
    try {
      await trpc.settings.uninstallSkill.mutate({ name });
      await useSettingsStore.getState().loadSkills();
      useToastStore.getState().success(`Skill "${name}" 已卸载`);
    } catch (err) {
      useToastStore.getState().error('卸载 Skill 失败', err instanceof Error ? err.message : String(err));
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
}));
