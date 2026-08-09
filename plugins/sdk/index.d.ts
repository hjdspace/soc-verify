export type PluginKind =
  | 'case-parser'
  | 'subsys-discoverer'
  | 'coverage-parser'
  | 'simulation-runner'
  | 'sim-option-schema'
  | 'ui';

export type PluginViewLocation = 'center' | 'left' | 'right' | 'bottom';

export interface PluginManifest {
  apiVersion: '1.0';
  id: string;
  name: string;
  version: string;
  kind: PluginKind;
  description?: string;
  activationEvents?: string[];
  contributes?: {
    commands?: Array<{ command: string; title: string; category?: string }>;
    views?: Array<{ id: string; name: string; location: PluginViewLocation; entry?: string }>;
  };
}

export interface PluginActivationContext {
  readonly pluginId: string;
  readonly projectRoot: string;
  registerCommand(command: string, handler: (...args: unknown[]) => unknown | Promise<unknown>): void;
  on(event: string, handler: (payload: unknown) => unknown | Promise<unknown>): () => void;
  getState<T>(key: string): Promise<T | undefined>;
  setState<T>(key: string, value: T): Promise<void>;
  notify(notification: { level: 'info' | 'warning' | 'error'; message: string; detail?: string }): void;
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
}

export interface SocVerifyPlugin {
  manifest: PluginManifest;
  activate?(context: PluginActivationContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

export interface PluginUiBridge {
  invoke<T = unknown>(command: string, args?: unknown[]): Promise<T>;
}

export declare function definePlugin<T extends SocVerifyPlugin>(plugin: T): T;
export declare function getPluginUiBridge(target?: typeof globalThis): PluginUiBridge;
