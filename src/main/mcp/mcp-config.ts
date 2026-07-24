/**
 * MCP configuration reader/writer.
 *
 * Reads MCP server configs from the same locations the omp engine scans:
 *   - Project-level: `<projectRoot>/.mcp.json` or `<projectRoot>/mcp.json`
 *   - User-level:    `~/.omp/mcp.json`
 *
 * The omp engine's `mcp-json` discovery provider loads these files and
 * transforms them into canonical MCPServer objects. We mirror that logic here
 * so the settings UI can display configured servers without starting a session.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import type {
  McpConfigFile,
  McpConfigSource,
  McpConnectionStatus,
  McpServerConfig,
  McpServerInfo,
  McpTransportType,
} from '@shared/types';

/** Schema URL for .mcp.json validation (matches omp's MCP_CONFIG_SCHEMA_URL). */
const MCP_SCHEMA_URL =
  'https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json';

/** User-level MCP config path: ~/.omp/mcp.json */
function userMcpConfigPath(): string {
  return join(homedir(), '.omp', 'mcp.json');
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
    const parsed = JSON.parse(content) as Record<string, unknown>;
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
 * @param scope  'user' → read ~/.omp/mcp.json (cross-project, personal)
 *               'project' → read <root>/.mcp.json (team-shared, git-tracked)
 *               Defaults to 'user'.
 */
export async function getMcpConfig(
  projectRoot: string,
  scope: 'user' | 'project' = 'user',
): Promise<McpConfigFile> {
  if (scope === 'user') {
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
 * @param scope  'user' → write ~/.omp/mcp.json (default; personal, not in git)
 *               'project' → write <root>/.mcp.json (team-shared, git-tracked)
 */
export async function setMcpConfig(
  projectRoot: string,
  config: McpConfigFile,
  scope: 'user' | 'project' = 'user',
): Promise<void> {
  const configPath = scope === 'user' ? userMcpConfigPath() : join(projectRoot, '.mcp.json');
  const configWithSchema: McpConfigFile = {
    $schema: MCP_SCHEMA_URL,
    ...config,
  };
  // Ensure the target directory exists (~/.omp for user scope)
  const dir = join(configPath, '..');
  await mkdir(dir, { recursive: true });
  await writeFile(configPath, JSON.stringify(configWithSchema, null, 2) + '\n', 'utf-8');
}
