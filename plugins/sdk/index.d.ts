export interface PluginUiBridge {
  invoke<T = unknown>(command: string, args?: unknown[]): Promise<T>;
}

export declare function getPluginUiBridge(target?: typeof globalThis): PluginUiBridge;
