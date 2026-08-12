import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from './toast';
import type { EdaToolInfo, EnvConfig, EnvVarGroup, SystemEnvVars } from '@shared/types';

interface EnvStoreState {
  config: EnvConfig | null;
  knownEnvVars: string[];
  /** Env var catalog grouped by category. */
  catalog: EnvVarGroup[];
  /** System-detected env vars from the current terminal/shell. */
  systemEnvVars: SystemEnvVars;
  detecting: boolean;
  /** Whether system env detection is in progress. */
  detectingSystemEnv: boolean;
  wizardOpen: boolean;
  wizardStep: 'detect' | 'confirm' | 'envvars' | 'done';
  /** Whether the EnvManagerDialog is open. */
  managerOpen: boolean;

  detectTools: () => Promise<EdaToolInfo[]>;
  loadConfig: (projectId: string) => Promise<void>;
  saveConfig: (projectId: string, config: EnvConfig) => Promise<void>;
  loadKnownEnvVars: () => Promise<void>;
  loadCatalog: () => Promise<void>;
  loadSystemEnv: () => Promise<void>;
  /** Auto-detect system env vars and merge into project config (persists to disk). */
  autoDetect: (projectId: string) => Promise<void>;
  setWizardOpen: (open: boolean) => void;
  setWizardStep: (step: EnvStoreState['wizardStep']) => void;
  setManagerOpen: (open: boolean) => void;
  updateConfig: (updates: Partial<EnvConfig>) => void;
  /** Update a single env var in the current config. */
  setEnvVar: (key: string, value: string) => void;
  /** Remove a single env var from the current config. */
  removeEnvVar: (key: string) => void;
}

export const useEnvStore = create<EnvStoreState>((set, _get) => ({
  config: null,
  knownEnvVars: [],
  catalog: [],
  systemEnvVars: {},
  detecting: false,
  detectingSystemEnv: false,
  wizardOpen: false,
  wizardStep: 'detect',
  managerOpen: false,

  detectTools: async () => {
    set({ detecting: true });
    try {
      const result = await trpc.env.detectTools.mutate();
      set((s) => ({
        config: {
          tools: result.tools,
          envVars: s.config?.envVars ?? {},
        },
        detecting: false,
      }));
      return result.tools;
    } catch (err) {
      set({ detecting: false });
      useToastStore.getState().error('EDA 工具检测失败', err instanceof Error ? err.message : String(err));
      return [];
    }
  },

  loadConfig: async (projectId) => {
    try {
      const config = await trpc.env.getConfig.query({ projectId });
      set({ config });
    } catch (err) {
      useToastStore.getState().error('加载环境配置失败', err instanceof Error ? err.message : String(err));
    }
  },

  saveConfig: async (projectId, config) => {
    try {
      await trpc.env.saveConfig.mutate({ projectId, config });
      set({ config });
      useToastStore.getState().success('环境配置已保存');
    } catch (err) {
      useToastStore.getState().error('保存环境配置失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadKnownEnvVars: async () => {
    try {
      const vars = await trpc.env.getKnownEnvVars.query();
      set({ knownEnvVars: vars });
    } catch {
      // Best-effort
    }
  },

  loadCatalog: async () => {
    try {
      const catalog = await trpc.env.getCatalog.query();
      set({ catalog });
    } catch {
      // Best-effort
    }
  },

  loadSystemEnv: async () => {
    set({ detectingSystemEnv: true });
    try {
      const systemEnvVars = await trpc.env.getSystemEnv.query();
      set({ systemEnvVars, detectingSystemEnv: false });
    } catch {
      set({ detectingSystemEnv: false });
      // Best-effort
    }
  },

  autoDetect: async (projectId) => {
    set({ detectingSystemEnv: true });
    try {
      const result = await trpc.env.autoDetect.mutate({ projectId });
      set({ config: result.config, detectingSystemEnv: false });
      if (result.detectedCount > 0) {
        useToastStore.getState().success(`自动检测到 ${result.detectedCount} 个新环境变量`);
      } else {
        useToastStore.getState().info('未检测到新的环境变量');
      }
    } catch (err) {
      set({ detectingSystemEnv: false });
      useToastStore.getState().error('自动检测失败', err instanceof Error ? err.message : String(err));
    }
  },

  setWizardOpen: (open) => set({ wizardOpen: open, wizardStep: open ? 'detect' : 'detect' }),
  setWizardStep: (step) => set({ wizardStep: step }),
  setManagerOpen: (open) => set({ managerOpen: open }),
  updateConfig: (updates) => set((s) => ({ config: { ...s.config, ...updates } as EnvConfig })),
  setEnvVar: (key, value) =>
    set((s) => ({
      config: s.config
        ? { ...s.config, envVars: { ...s.config.envVars, [key]: value } }
        : s.config,
    })),
  removeEnvVar: (key) =>
    set((s) => {
      if (!s.config) return s;
      const nextEnvVars = { ...s.config.envVars };
      delete nextEnvVars[key];
      return { config: { ...s.config, envVars: nextEnvVars } };
    }),
}));
