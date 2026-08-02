import type { PluginContributions, PluginKind } from '../plugin-types';

export interface PluginConfigEntry {
  id: string;
  name: string;
  version: string;
  kind: PluginKind;
  source: 'node_modules' | 'local';
  path: string;
  enabled: boolean;
  error?: string;
  contributes?: PluginContributions;
}

export interface PluginConfig {
  plugins: PluginConfigEntry[];
}
