/**
 * MCP configuration reader/writer (issue 10: omp → pi 生态对齐).
 *
 * Reads MCP server configs from the same locations the pi engine stack scans:
 *   - User-level:    `~/.pi/agent/mcp.json`（pi-mcp-adapter getAgentPath("mcp.json")）
 *   - Project-level: `<projectRoot>/.mcp.json` or `<projectRoot>/mcp.json`
 *
 * Legacy note: pre-pi builds stored user-level config at `~/.omp/mcp.json`.
 * A best-effort one-time migration moves it to the new location on first
 * read (see migrateLegacyUserConfig).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import type {
  McpConfigFile,
  McpConfigSource,
  McpConnectionStatus,
  McpServerConfig,
  McpServerInfo,
  McpTransportType,
} from '@shared/types';

/** User-level MCP config path: ~/.pi/agent/mcp.json (pi ecosystem standard). */
function userMcpConfigPath(): string {
  return join(homedir(), '.pi', 'agent', 'mcp.json');
}

/** Legacy omp-era user config path, migrated once on first read. */
function legacyOmpConfigPath(): string {
  return join(homedir(), '.omp', 'mcp.json');
}

/**
 * One-time best-effort migration: copy the legacy ~/.omp/mcp.json to
 * ~/.pi/agent/mcp.json when the latter does not exist yet. Never throws —
 * a failed migration only means built-in servers get re-registered fresh.
 */
async function migrateLegacyUserConfig(): Promise<void> {
  try {
    const newPath = userMcpConfigPath();
    const oldPath = legacyOmpConfigPath();
    if (existsSync(newPath) || !existsSync(oldPath)) return;
    const raw = await readFile(oldPath, 'utf-8');
    // Validate before copying — don't migrate garbage.
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null) return;
    await mkdir(join(newPath, '..'), { recursive: true });
    await writeFile(newPath, raw, 'utf-8');
    console.log('[mcp-config] migrated legacy user MCP config: ~/.omp/mcp.json -> ~/.pi/agent/mcp.json');
  } catch (err) {
    console.warn(
      '[mcp-config] legacy user MCP config migration skipped:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Candidate project-level MCP config paths: .mcp.json, mcp.json */
function projectMcpConfigPaths(projectRoot: string): string[] {
  return [join(projectRoot, '.mcp.json'), join(projectRoot, 'mcp.json')];
}

/**
 * Parse raw JSON content into an McpConfigFile, returning an empty config on
 * parse failure.
 *
 * Accepts two shapes:
 *   1. Canonical: `{ "mcpServers": { "name": {...} } }`
 *   2. Bare server map: `{ "name": {...} }` — auto-wrapped into `mcpServers`.
 *      This tolerates hand-edited files or older front-end code that wrote
 *      servers directly at the top level, which previously caused
 *      `listMcpServers` to return an empty list (the "暂无 MCP" bug).
 */
function parseConfig(content: string): McpConfigFile {
  try {
    // Strip UTF-8 BOM if present. Windows PowerShell's Set-Content -Encoding UTF8
    // adds a BOM (EF BB BF / \uFEFF) which causes JSON.parse to throw SyntaxError,
    // leading to config loss (parseConfig returns empty config, caller writes
    // only built-in servers, user-configured servers like codegraph are lost).
    const stripped = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
    const parsed = JSON.parse(stripped) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null) {
      return { mcpServers: {} };
    }

    // Canonical shape: has `mcpServers` object
    if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
      return parsed as unknown as McpConfigFile;
    }

    // Bare server map shape: top-level keys (except $schema / meta keys)
    // map to server configs. Wrap them into `mcpServers`.
    const serverEntries = Object.entries(parsed).filter(
      ([k, v]) => k !== '$schema' && k !== 'disabledServers' && k !== 'enabledServers' && typeof v === 'object' && v !== null,
    );
    if (serverEntries.length > 0) {
      const result: McpConfigFile = {
        mcpServers: Object.fromEntries(serverEntries) as Record<string, McpServerConfig>,
      };
      // Preserve disabled/enabled lists if present
      if (Array.isArray(parsed.disabledServers)) {
        result.disabledServers = parsed.disabledServers as string[];
      }
      if (Array.isArray(parsed.enabledServers)) {
        result.enabledServers = parsed.enabledServers as string[];
      }
      return result;
    }

    return parsed as unknown as McpConfigFile;
  } catch {
    // fall through to empty config
  }
  return { mcpServers: {} };
}

/**
 * Read a single MCP config file, returning an empty config if the file
 * doesn't exist or can't be parsed.
 */
async function readConfigFile(filePath: string): Promise<McpConfigFile> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return parseConfig(content);
  } catch {
    return { mcpServers: {} };
  }
}

/**
 * Determine the transport type from a server config.
 * Falls back to 'stdio' when a command is present (matching omp's default).
 */
function inferTransport(config: McpServerConfig): McpTransportType {
  if (config.type === 'http' || config.type === 'sse') return config.type;
  return 'stdio';
}

/**
 * Build a human-readable summary for a server config.
 * e.g. "npx -y @modelcontextprotocol/server-filesystem /tmp" or "https://api.example.com/mcp"
 */
function buildSummary(config: McpServerConfig): string {
  const transport = inferTransport(config);
  if (transport === 'stdio') {
    const parts = [config.command ?? '(no command)'];
    if (config.args?.length) parts.push(...config.args);
    return parts.join(' ');
  }
  return config.url ?? '(no url)';
}

/** Map of server name → connection status from the omp engine. */
export type McpStatusMap = Record<
  string,
  { status: string; toolCount: number; error?: string }
>;

/**
 * Read configured MCP servers for a project.
 *
 * @param projectRoot  Absolute path to the project root directory.
 * @param statusMap    Optional runtime status from probing or active sessions.
 * @param scope        When set to 'user' or 'project', only return servers from
 *                     that scope (no merging). When undefined, merges both
 *                     scopes with project-level taking precedence.
 */
export async function listMcpServers(
  projectRoot: string,
  statusMap?: McpStatusMap,
  scope?: 'user' | 'project',
): Promise<McpServerInfo[]> {
  await migrateLegacyUserConfig();
  const merged = new Map<string, { config: McpServerConfig; source: McpConfigSource }>();
  let disabledSet = new Set<string>();

  if (scope === 'user') {
    // Only user-level config
    const userConfig = await readConfigFile(userMcpConfigPath());
    disabledSet = new Set(userConfig.disabledServers ?? []);
    for (const [name, config] of Object.entries(userConfig.mcpServers ?? {})) {
      merged.set(name, { config, source: 'user' });
    }
  } else if (scope === 'project') {
    // Only project-level config
    let projectConfig: McpConfigFile | null = null;
    for (const p of projectMcpConfigPaths(projectRoot)) {
      const cfg = await readConfigFile(p);
      if (cfg.mcpServers && Object.keys(cfg.mcpServers).length > 0) {
        projectConfig = cfg;
        break;
      }
    }
    if (!projectConfig) {
      const legacyPath = join(projectRoot, '.socverify', 'mcp-config.json');
      projectConfig = await readConfigFile(legacyPath);
    }
    for (const [name, config] of Object.entries(projectConfig.mcpServers ?? {})) {
      merged.set(name, { config, source: 'project' });
    }
  } else {
    // Merge both scopes (original behavior)
    const userConfig = await readConfigFile(userMcpConfigPath());
    const projectConfigs: Array<{ config: McpConfigFile; source: McpConfigSource }> = [];
    for (const p of projectMcpConfigPaths(projectRoot)) {
      const cfg = await readConfigFile(p);
      if (cfg.mcpServers && Object.keys(cfg.mcpServers).length > 0) {
        projectConfigs.push({ config: cfg, source: 'project' });
        break;
      }
    }
    if (projectConfigs.length === 0) {
      const legacyPath = join(projectRoot, '.socverify', 'mcp-config.json');
      const legacyConfig = await readConfigFile(legacyPath);
      if (legacyConfig.mcpServers && Object.keys(legacyConfig.mcpServers).length > 0) {
        projectConfigs.push({ config: legacyConfig, source: 'project' });
      }
    }

    for (const [name, config] of Object.entries(userConfig.mcpServers ?? {})) {
      merged.set(name, { config, source: 'user' });
    }
    for (const { config: cfg } of projectConfigs) {
      for (const [name, config] of Object.entries(cfg.mcpServers ?? {})) {
        merged.set(name, { config, source: 'project' });
      }
    }
    disabledSet = new Set(userConfig.disabledServers ?? []);
  }

  const servers: McpServerInfo[] = [];
  for (const [name, { config, source }] of merged) {
    const enabled = config.enabled !== false && !disabledSet.has(name);
    const runtime = statusMap?.[name];
    servers.push({
      name,
      transport: inferTransport(config),
      summary: buildSummary(config),
      enabled,
      source,
      status: (runtime?.status as McpConnectionStatus) ?? 'not_running',
      toolCount: runtime?.toolCount ?? 0,
      error: runtime?.error,
    });
  }

  // Sort: enabled first, then by name
  servers.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return servers;
}

/**
 * Read the MCP config file for a project.
 *
 * @param scope  'user' → read ~/.pi/agent/mcp.json (cross-project, personal)
 *               'project' → read <root>/.mcp.json (team-shared, git-tracked)
 *               Defaults to 'user'.
 */
export async function getMcpConfig(
  projectRoot: string,
  scope: 'user' | 'project' = 'user',
): Promise<McpConfigFile> {
  if (scope === 'user') {
    await migrateLegacyUserConfig();
    return readConfigFile(userMcpConfigPath());
  }
  // Project scope: try .mcp.json then mcp.json, then legacy path
  for (const p of projectMcpConfigPaths(projectRoot)) {
    const cfg = await readConfigFile(p);
    if (cfg.mcpServers && Object.keys(cfg.mcpServers).length > 0) {
      return cfg;
    }
  }
  const legacyPath = join(projectRoot, '.socverify', 'mcp-config.json');
  const legacyConfig = await readConfigFile(legacyPath);
  if (legacyConfig.mcpServers && Object.keys(legacyConfig.mcpServers).length > 0) {
    return legacyConfig;
  }
  return { mcpServers: {} };
}

/**
 * Write the MCP config to the appropriate file based on scope.
 *
 * @param scope  'user' → write ~/.pi/agent/mcp.json (default; personal, not in git)
 *               'project' → write <root>/.mcp.json (team-shared, git-tracked)
 */
export async function setMcpConfig(
  projectRoot: string,
  config: McpConfigFile,
  scope: 'user' | 'project' = 'user',
): Promise<void> {
  const configPath = scope === 'user' ? userMcpConfigPath() : join(projectRoot, '.mcp.json');
  // Ensure the target directory exists (~/.pi/agent for user scope)
  const dir = join(configPath, '..');
  await mkdir(dir, { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Check if an existing built-in server config is stale and should be updated.
 *
 * A config is considered stale when:
 * - On Windows: the command path contains `WindowsApps` (Windows Store
 *   app execution alias stub that exits with code 9009)
 * - The command points to a file that no longer exists
 *
 * This allows `ensureBuiltinMcpServers` to auto-fix configs that were
 * written by a previous run with an incorrect Python path, while still
 * preserving genuine user customizations (e.g., a custom command that
 * works and doesn't match either stale condition).
 */
function isStaleBuiltinConfig(existing: McpServerConfig): boolean {
  const cmd = existing.command;
  if (!cmd) return false;

  // Windows Store stub detection
  if (process.platform === 'win32' && cmd.toLowerCase().includes('windowsapps')) {
    return true;
  }

  // Command file no longer exists
  if (!existsSync(cmd)) {
    return true;
  }

  return false;
}

/**
 * Ensure built-in MCP servers (like TraceWeave) are registered in the
 * user-level MCP config (`~/.pi/agent/mcp.json`).
 *
 * This merges built-in server configs into the existing user-level config
 * without removing or overriding user-configured servers. If a built-in
 * server name already exists in the config, the user's entry is preserved
 * (the user may have customized it or explicitly disabled it).
 *
 * However, if the existing entry is "stale" (e.g., its command points to
 * a Windows Store stub or a non-existent file), it is automatically updated
 * with the fresh built-in config. This handles the case where a previous
 * run auto-registered the server with an incorrect Python path.
 *
 * @param builtinServers  Map of server name → config to inject as defaults.
 * @returns true if the config file was modified (new servers were added or stale ones updated).
 */
export async function ensureBuiltinMcpServers(
  builtinServers: Array<{ name: string; config: McpServerConfig }>,
): Promise<boolean> {
  if (builtinServers.length === 0) return false;

  await migrateLegacyUserConfig();
  const configPath = userMcpConfigPath();
  const existing = await readConfigFile(configPath);
  const servers = existing.mcpServers ?? {};
  let modified = false;

  for (const { name, config } of builtinServers) {
    if (!(name in servers)) {
      // New built-in server — register it
      servers[name] = config;
      modified = true;
    } else if (isStaleBuiltinConfig(servers[name])) {
      // Existing entry is stale (e.g., Windows Store Python stub) — update it
      servers[name] = config;
      modified = true;
    }
    // Otherwise: user has a valid custom config — preserve it
  }

  if (modified) {
    existing.mcpServers = servers;
    await setMcpConfig('', existing, 'user');
  }

  return modified;
}
