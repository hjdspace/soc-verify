/**
 * MCP (Model Context Protocol) shared types.
 *
 * Used by both the main process (settings router, runner) and the renderer
 * (settings store, SettingsPanel) to represent MCP server configuration and
 * runtime connection status.
 */

/** Transport type for an MCP server. */
export type McpTransportType = 'stdio' | 'http' | 'sse';

/** Connection status reported by the omp engine's MCPManager. */
export type McpConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'not_running';

/** Where the server config was discovered (project-level or user-level). */
export type McpConfigSource = 'project' | 'user';

/** A single MCP server configuration entry (matches omp's .mcp.json format). */
export type McpServerConfig = {
  type?: McpTransportType;
  /** stdio: command to run */
  command?: string;
  /** stdio: command arguments */
  args?: string[];
  /** stdio: environment variables */
  env?: Record<string, string>;
  /** stdio: working directory */
  cwd?: string;
  /** http/sse: server URL */
  url?: string;
  /** http/sse: extra headers */
  headers?: Record<string, string>;
  /** Whether this server is enabled (default: true) */
  enabled?: boolean;
  /** Request timeout in ms (default: 30000, 0 to disable) */
  timeout?: number;
};

/** Root structure of a .mcp.json / mcp.json file. */
export type McpConfigFile = {
  $schema?: string;
  mcpServers?: Record<string, McpServerConfig>;
  /** Names to hide regardless of any source `enabled` flag. */
  disabledServers?: string[];
  /** Names to force-enable when a non-writable source reports `enabled: false`. */
  enabledServers?: string[];
};

/** Server info returned by `settings.listMcpServers` — config + runtime status. */
export type McpServerInfo = {
  name: string;
  transport: McpTransportType;
  /** Human-readable summary: command + args (stdio) or URL (http/sse) */
  summary: string;
  enabled: boolean;
  source: McpConfigSource;
  /** Runtime connection status — 'not_running' when no active agent session. */
  status: McpConnectionStatus;
  /** Number of tools exposed by this server (0 if not connected). */
  toolCount: number;
  /** Error message when connection fails (only when status is 'disconnected'). */
  error?: string;
};

/** A single tool exposed by an MCP server (mirrors omp's MCPToolDefinition). */
export type McpToolInfo = {
  name: string;
  description?: string;
  /** JSON Schema for the tool's parameters. */
  inputSchema?: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
};

/**
 * Structured readiness report for the built-in TraceWeave MCP server
 * (returned by `settings.traceweaveDiagnostic`).
 *
 * TraceWeave's runtime prerequisites (Python 3.11+, pip deps) are
 * user-machine provisions rather than bundled payloads (ADR 0020); this
 * report turns "server disconnected" into actionable per-prerequisite status.
 */
export type TraceweaveDiagnostic = {
  /** Vendored TraceWeave release version. */
  version: string;
  /** Upstream commit the vendored tree was taken from. */
  upstreamCommit: string;
  /** TraceWeave source tree (packaged or dev) found. */
  sourceDirFound: boolean;
  pythonFound: boolean;
  pythonPath: string | null;
  /** e.g. "3.12.4"; null when python not found or probe failed. */
  pythonVersion: string | null;
  /** true when >= 3.11; null when unknown. */
  pythonVersionOk: boolean | null;
  /** pip deps (mcp, pyyaml) importable; null when python missing. */
  depsInstalled: boolean | null;
  /** Top-level module names reported missing by the import probe. */
  missingDeps: string[];
  /** FSDB waveform parsing usable (wrapper + VERDI_HOME, Linux only). */
  fsdbAvailable: boolean;
  /** Human-readable reasons FSDB is unavailable (empty when available). */
  fsdbBlockers: string[];
  /** Copy-pasteable fix command; null when python is missing. */
  installCommand: string | null;
  /** MCP server can start (source + python + deps all present). */
  ready: boolean;
};
