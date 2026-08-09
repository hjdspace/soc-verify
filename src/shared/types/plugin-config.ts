import type { PluginContributions, PluginKind, PluginOrigin } from '../plugin-types';

export interface PluginConfigEntry {
  id: string;
  apiVersion?: string;
  name: string;
  version: string;
  kind: PluginKind;
  source: 'node_modules' | 'local';
  origin?: PluginOrigin;
  path: string;
  enabled: boolean;
  active?: boolean;
  error?: string;
  contributes?: PluginContributions;
}

export interface PluginConfig {
  plugins: PluginConfigEntry[];
}
