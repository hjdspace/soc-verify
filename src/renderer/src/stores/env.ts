import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from './toast';
import type { EdaToolInfo, EnvConfig } from '@shared/types';

interface EnvStoreState {
  config: EnvConfig | null;
  knownEnvVars: string[];
  detecting: boolean;
  wizardOpen: boolean;
  wizardStep: 'detect' | 'confirm' | 'envvars' | 'done';

  detectTools: () => Promise<EdaToolInfo[]>;
  loadConfig: (projectId: string) => Promise<void>;
  saveConfig: (projectId: string, config: EnvConfig) => Promise<void>;
  loadKnownEnvVars: () => Promise<void>;
  setWizardOpen: (open: boolean) => void;
  setWizardStep: (step: EnvStoreState['wizardStep']) => void;
  updateConfig: (updates: Partial<EnvConfig>) => void;
}

export const useEnvStore = create<EnvStoreState>((set, get) => ({
  config: null,
  knownEnvVars: [],
  detecting: false,
  wizardOpen: false,
  wizardStep: 'detect',

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

  setWizardOpen: (open) => set({ wizardOpen: open, wizardStep: open ? 'detect' : 'detect' }),
  setWizardStep: (step) => set({ wizardStep: step }),
  updateConfig: (updates) => set((s) => ({ config: { ...s.config, ...updates } as EnvConfig })),
}));
