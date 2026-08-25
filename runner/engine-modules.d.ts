/**
 * Ambient module declarations for the omp engine submodule.
 *
 * The engine uses Bun-specific features (`.md` imports, `.lark` imports,
 * Bun globals, etc.) that produce spurious TS errors when checked by our
 * project's TypeScript configuration.
 *
 * This file provides:
 * 1. Wildcard declarations for non-TS file types the engine imports
 * 2. Ambient module declarations for engine entry points that the runner
 *    dynamically imports (to prevent TS from following into the engine)
 *
 * Note: `tsconfig.runner.json` uses `"lib": ["ES2024"]` (no DOM) to avoid
 * conflicts between bun-types and TypeScript's built-in DOM type declarations.
 * DOM types are provided by bun-types via the `"types": ["bun"]` setting.
 */

// ── Non-TS file types used by the engine ──────────────────

declare module '*.md' {
  const content: string;
  export default content;
}

declare module '*.lark' {
  const content: string;
  export default content;
}

declare module '*.jl' {
  const content: string;
  export default content;
}

declare module '*.py' {
  const content: string;
  export default content;
}

declare module '*.rb' {
  const content: string;
  export default content;
}

declare module '*.css' {
  const content: string;
  export default content;
}

declare module '*.js' {
  const content: string;
  export default content;
}

declare module '*.sh' {
  const content: string;
  export default content;
}

declare module '*.applescript' {
  const content: string;
  export default content;
}

// ── Engine package entry points (also redirected via tsconfig paths) ──

declare module 'engine/oh-my-pi/packages/coding-agent/src/sdk' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function createAgentSession(options: unknown): Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function discoverAuthStorage(): Promise<any>;
}

declare module 'engine/oh-my-pi/packages/coding-agent/src/config/model-registry' {
  export class ModelRegistry {
    constructor(authStorage: unknown);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    find(provider: string, modelId: string): any;
  }
}

declare module 'engine/oh-my-pi/packages/coding-agent/src/session/session-manager' {
  export class SessionManager {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static create(cwd: string, sessionDir: string): any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static inMemory(): any;
    static list(cwd: string, sessionDir?: string): Promise<Array<{ id: string; path: string }>>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static open(path: string): Promise<any>;
    appendMessage(msg: unknown): void;
  }
}

declare module 'engine/oh-my-pi/packages/utils/src/logger' {
  export interface LogEvent {
    readonly level: 'error' | 'warn' | 'info' | 'debug';
    readonly message: string;
    readonly context: Record<string, unknown> | undefined;
    readonly timestamp: Date;
  }
  export type LogSink = (event: LogEvent) => void;
  /** Register an out-of-band log sink and return a disposer. */
  export function registerLogSink(sink: LogSink): () => void;
}

declare module 'engine/oh-my-pi/packages/coding-agent/src/mcp/manager' {
  export class MCPManager {
    static instance(): MCPManager | null;
    getAllServerNames(): string[];
    getConnectionStatus(name: string): string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getConnection(name: string): { tools?: any[] } | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getTools(): any[];
    disconnectAll(): void;
    discoverAndConnect(): Promise<void>;
  }
}

declare module 'engine/oh-my-pi/packages/coding-agent/src/mcp/client' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function listTools(connection: unknown): Promise<any[]>;
}
