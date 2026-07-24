import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from './toast';
import type { CredentialEntry, CredentialInput, CredentialUpdateInput, SkillInfo, SkillInstallInfo, CreateSkillInput, McpServerInfo, McpToolInfo, McpConfigFile } from '@shared/types';

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
  mcpServers: McpServerInfo[];
  mcpConfig: McpConfigFile | null;
  /** Which scope is being edited: 'user' (~/.omp/mcp.json) or 'project' (<root>/.mcp.json). */
  mcpEditScope: 'user' | 'project';
  /** Tools per MCP server name — populated on demand when a server row is expanded. */
  mcpToolsByServer: Record<string, McpToolInfo[]>;
  /** Loading flag per server name (tool list fetch in progress). */
  mcpToolsLoading: Record<string, boolean>;
  /** Whether an MCP reload is in progress. */
  mcpReloading: boolean;
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
  readSkillContent: (filePath: string) => Promise<string>;
  loadSkillInstallInfo: () => Promise<void>;
  createSkill: (input: CreateSkillInput) => Promise<void>;
  uninstallSkill: (name: string) => Promise<void>;
  loadMcpServers: (projectId: string) => Promise<void>;
  loadMcpConfig: (projectId: string, scope?: 'user' | 'project') => Promise<void>;
  setMcpEditScope: (scope: 'user' | 'project') => void;
  setMcpConfig: (projectId: string, config: McpConfigFile, scope?: 'user' | 'project') => Promise<void>;
  /** Fetch the tool list for a specific MCP server (on demand when expanded). */
  getMcpServerTools: (projectId: string, serverName: string) => Promise<void>;
  /** Reload MCP config in running sessions so new config takes effect immediately. */
  reloadMcp: (projectId: string) => Promise<void>;
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
  mcpConfig: null,
  mcpEditScope: 'user',
  mcpToolsByServer: {},
  mcpToolsLoading: {},
  mcpReloading: false,
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

  readSkillContent: async (filePath) => {
    try {
      return await trpc.settings.readSkill.query({ filePath });
    } catch (err) {
      useToastStore.getState().error('读取技能内容失败', err instanceof Error ? err.message : String(err));
      return '';
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

  loadMcpServers: async (projectId) => {
    try {
      const scope = useSettingsStore.getState().mcpEditScope;
      const servers = await trpc.settings.listMcpServers.query({ projectId, scope });
      set({ mcpServers: servers });
    } catch (err) {
      // Log the error so silent failures (e.g. RPC timeout) are visible in the
      // dev console. Previously this was silently swallowed, which caused the
      // MCP settings page to keep showing "暂无 MCP" with no clue as to why.
      console.error('[settings] loadMcpServers failed:', err);
    }
  },

  loadMcpConfig: async (projectId, scope) => {
    try {
      const effectiveScope = scope ?? useSettingsStore.getState().mcpEditScope;
      const config = await trpc.settings.getMcpConfig.query({ projectId, scope: effectiveScope });
      set({ mcpConfig: config });
    } catch (err) {
      console.error('[settings] loadMcpConfig failed:', err);
    }
  },

  setMcpEditScope: (scope) => {
    set({ mcpEditScope: scope, mcpConfig: null });
  },

  setMcpConfig: async (projectId, config, scope) => {
    try {
      const effectiveScope = scope ?? useSettingsStore.getState().mcpEditScope;
      await trpc.settings.setMcpConfig.mutate({ projectId, config, scope: effectiveScope });

      // Optimistically update the stored config so the UI reflects the new
      // config immediately, even before the server list refresh completes.
      set({ mcpConfig: config, mcpToolsByServer: {} });

      // Refresh server list to reflect changes (file re-read).
      await useSettingsStore.getState().loadMcpServers(projectId);

      // Reload MCP in running sessions so the LLM picks up the new config
      // without requiring the user to restart the session. This is best-effort
      // and runs after the toast so the UI feels responsive.
      useToastStore.getState().success('MCP 配置已保存');
      void useSettingsStore.getState().reloadMcp(projectId);
    } catch (err) {
      useToastStore.getState().error('保存 MCP 配置失败', err instanceof Error ? err.message : String(err));
    }
  },

  getMcpServerTools: async (projectId, serverName) => {
    set((s) => ({ mcpToolsLoading: { ...s.mcpToolsLoading, [serverName]: true } }));
    try {
      const scope = useSettingsStore.getState().mcpEditScope;
      const tools = await trpc.settings.getMcpServerTools.query({ projectId, serverName, scope });
      set((s) => ({
        mcpToolsByServer: { ...s.mcpToolsByServer, [serverName]: tools as McpToolInfo[] },
        mcpToolsLoading: { ...s.mcpToolsLoading, [serverName]: false },
      }));
    } catch (err) {
      set((s) => ({ mcpToolsLoading: { ...s.mcpToolsLoading, [serverName]: false } }));
      console.error(`[settings] getMcpServerTools(${serverName}) failed:`, err);
    }
  },

  reloadMcp: async (projectId) => {
    set({ mcpReloading: true });
    try {
      await trpc.settings.reloadMcp.mutate({ projectId });
      // Refresh the server list to pick up updated connection status.
      // The backend cleared its probe cache, so this triggers a fresh
      // direct probe of all configured MCP servers.
      await useSettingsStore.getState().loadMcpServers(projectId);
      // Clear cached tool lists since the reload may have changed them
      set({ mcpToolsByServer: {}, mcpReloading: false });
    } catch (err) {
      set({ mcpReloading: false });
      console.error('[settings] reloadMcp failed:', err);
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
