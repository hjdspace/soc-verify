/** Stable types shared by plugin backends and plugin-hosted HTML views. */

export const PLUGIN_SDK_VERSION = '1.0';
export const PLUGIN_UI_GLOBAL = 'socVerify';

export interface PluginUiBridge {
  invoke<T = unknown>(command: string, args?: unknown[]): Promise<T>;
}

export interface PluginUiNotification {
  level: 'info' | 'warning' | 'error';
  message: string;
  detail?: string;
}

export interface PluginSdkPackageManifest {
  apiVersion: typeof PLUGIN_SDK_VERSION;
  id: string;
  name: string;
  version: string;
  kind: string;
}
