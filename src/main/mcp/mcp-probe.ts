/**
 * Standalone MCP server probe — connects to MCP servers directly via the MCP
 * JSON-RPC protocol, independent of any AI agent session.
 *
 * Supports stdio and http/sse transports. Performs the full handshake:
 *   initialize → notifications/initialized → tools/list
 *
 * Results are cached for a short TTL to avoid re-spawning processes on every
 * list query.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { McpServerConfig, McpToolInfo } from '@shared/types';

export type McpProbeStatus = 'connected' | 'disconnected';

export interface McpProbeResult {
  status: McpProbeStatus;
  toolCount: number;
  tools: McpToolInfo[];
  error?: string;
  probedAt: number;
}

const CACHE_TTL_MS = 30_000;
const probeCache = new Map<string, { result: McpProbeResult; timestamp: number }>();

export function clearProbeCache(): void {
  probeCache.clear();
}

export function clearProbeCacheForServer(name: string): void {
  probeCache.delete(name);
}

function getCached(name: string): McpProbeResult | undefined {
  const entry = probeCache.get(name);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    probeCache.delete(name);
    return undefined;
  }
  return entry.result;
}

function setCached(name: string, result: McpProbeResult): void {
  probeCache.set(name, { result, timestamp: Date.now() });
}

const PROTOCOL_VERSION = '2025-03-26';
const CLIENT_INFO = { name: 'socverify-probe', version: '1.0.0' };

/**
 * Parse an MCP JSON-RPC response from an HTTP body.
 * Handles both plain JSON and SSE (text/event-stream) content types.
 */
function parseMcpResponse(text: string, contentType: string): unknown {
  if (contentType.includes('text/event-stream')) {
    // SSE: lines starting with "data:" contain JSON payloads
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data:')) {
        const data = trimmed.slice(5).trim();
        if (data) {
          try {
            return JSON.parse(data);
          } catch {
            // skip malformed lines
          }
        }
      }
    }
    return null;
  }
  // Plain JSON
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Probe a stdio MCP server by spawning the command and performing the MCP
 * handshake over stdin/stdout.
 */
function probeStdio(
  name: string,
  config: McpServerConfig,
  timeoutMs: number,
): Promise<McpProbeResult> {
  return new Promise((resolve) => {
    if (!config.command) {
      const r: McpProbeResult = {
        status: 'disconnected',
        toolCount: 0,
        tools: [],
        error: 'No command specified',
        probedAt: Date.now(),
      };
      setCached(name, r);
      resolve(r);
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(config.command, config.args ?? [], {
        env: { ...process.env, ...config.env },
        cwd: config.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32', // Windows needs shell to find .cmd
      });
    } catch (err) {
      const r: McpProbeResult = {
        status: 'disconnected',
        toolCount: 0,
        tools: [],
        error: err instanceof Error ? err.message : String(err),
        probedAt: Date.now(),
      };
      setCached(name, r);
      resolve(r);
      return;
    }

    let resolved = false;
    let lineBuffer = '';
    const pending = new Map<number, (data: unknown) => void>();

    const finish = (result: McpProbeResult) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // best-effort
      }
      setCached(name, result);
      resolve(result);
    };

    const timer = setTimeout(
      () => {
        finish({
          status: 'disconnected',
          toolCount: 0,
          tools: [],
          error: 'Connection timeout',
          probedAt: Date.now(),
        });
      },
      timeoutMs,
    );

    child.on('error', (err) => {
      finish({
        status: 'disconnected',
        toolCount: 0,
        tools: [],
        error: err.message,
        probedAt: Date.now(),
      });
    });

    child.on('exit', (code, signal) => {
      if (!resolved) {
        finish({
          status: 'disconnected',
          toolCount: 0,
          tools: [],
          error: `Process exited (code=${code}, signal=${signal})`,
          probedAt: Date.now(),
        });
      }
    });

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const id = msg.id;
      if (typeof id === 'number' && pending.has(id)) {
        pending.get(id)!(msg);
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        handleLine(line);
      }
    });

    const send = (obj: unknown) => {
      child.stdin?.write(JSON.stringify(obj) + '\n');
    };

    // 1. initialize
    pending.set(1, (resp) => {
      const r = resp as { error?: { message?: string }; result?: unknown };
      if (r.error) {
        finish({
          status: 'disconnected',
          toolCount: 0,
          tools: [],
          error: r.error.message ?? 'Initialize failed',
          probedAt: Date.now(),
        });
        return;
      }
      // 2. notifications/initialized
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      // 3. tools/list
      pending.set(2, (resp2) => {
        const r2 = resp2 as { error?: { message?: string }; result?: { tools?: Array<Record<string, unknown>> } };
        if (r2.error || !r2.result?.tools) {
          // Connected but no tools capability
          finish({
            status: 'connected',
            toolCount: 0,
            tools: [],
            probedAt: Date.now(),
          });
          return;
        }
        const tools: McpToolInfo[] = r2.result.tools.map((t) => ({
          name: String(t.name ?? ''),
          description: typeof t.description === 'string' ? t.description : undefined,
          inputSchema: t.inputSchema as McpToolInfo['inputSchema'],
        }));
        finish({
          status: 'connected',
          toolCount: tools.length,
          tools,
          probedAt: Date.now(),
        });
      });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
    });
  });
}

/**
 * Probe an HTTP/SSE MCP server by sending JSON-RPC over HTTP POST.
 */
async function probeHttp(
  name: string,
  config: McpServerConfig,
  timeoutMs: number,
): Promise<McpProbeResult> {
  if (!config.url) {
    const r: McpProbeResult = {
      status: 'disconnected',
      toolCount: 0,
      tools: [],
      error: 'No URL specified',
      probedAt: Date.now(),
    };
    setCached(name, r);
    return r;
  }

  const baseHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(config.headers ?? {}),
  };

  const fail = (error: string): McpProbeResult => {
    const r: McpProbeResult = {
      status: 'disconnected',
      toolCount: 0,
      tools: [],
      error,
      probedAt: Date.now(),
    };
    setCached(name, r);
    return r;
  };

  try {
    // 1. initialize
    const initResp = await fetch(config.url, {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!initResp.ok) {
      return fail(`HTTP ${initResp.status} ${initResp.statusText}`);
    }

    const sessionId = initResp.headers.get('Mcp-Session-Id') ?? undefined;
    const initText = await initResp.text();
    const initData = parseMcpResponse(
      initText,
      initResp.headers.get('content-type') ?? '',
    ) as { error?: { message?: string }; result?: unknown } | null;

    if (initData?.error) {
      return fail(initData.error.message ?? 'Initialize failed');
    }

    // 2. notifications/initialized (best-effort, ignore response)
    const sessionHeaders = sessionId
      ? { ...baseHeaders, 'Mcp-Session-Id': sessionId }
      : baseHeaders;
    await fetch(config.url, {
      method: 'POST',
      headers: sessionHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(() => {
      // best-effort
    });

    // 3. tools/list
    const toolsResp = await fetch(config.url, {
      method: 'POST',
      headers: sessionHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const toolsText = await toolsResp.text();
    const toolsData = parseMcpResponse(
      toolsText,
      toolsResp.headers.get('content-type') ?? '',
    ) as {
      error?: { message?: string };
      result?: { tools?: Array<Record<string, unknown>> };
    } | null;

    if (toolsData?.result?.tools) {
      const tools: McpToolInfo[] = toolsData.result.tools.map((t) => ({
        name: String(t.name ?? ''),
        description: typeof t.description === 'string' ? t.description : undefined,
        inputSchema: t.inputSchema as McpToolInfo['inputSchema'],
      }));
      const r: McpProbeResult = {
        status: 'connected',
        toolCount: tools.length,
        tools,
        probedAt: Date.now(),
      };
      setCached(name, r);
      return r;
    }

    // Connected but no tools or tools capability
    const r: McpProbeResult = {
      status: 'connected',
      toolCount: 0,
      tools: [],
      probedAt: Date.now(),
    };
    setCached(name, r);
    return r;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Probe a single MCP server. Uses cache when available unless `forceRefresh`.
 */
export async function probeMcpServer(
  name: string,
  config: McpServerConfig,
  options?: { timeoutMs?: number; useCache?: boolean },
): Promise<McpProbeResult> {
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const useCache = options?.useCache ?? true;

  if (useCache) {
    const cached = getCached(name);
    if (cached) return cached;
  }

  const transport = config.type ?? (config.url ? 'http' : 'stdio');
  const result =
    transport === 'stdio'
      ? await probeStdio(name, config, timeoutMs)
      : await probeHttp(name, config, timeoutMs);

  return result;
}

/**
 * Probe all configured servers in parallel.
 */
export async function probeAllServers(
  servers: Record<string, McpServerConfig>,
  options?: { timeoutMs?: number; useCache?: boolean },
): Promise<Record<string, McpProbeResult>> {
  const entries = Object.entries(servers);
  if (entries.length === 0) return {};

  const results = await Promise.all(
    entries.map(async ([name, config]) => {
      // Skip disabled servers
      if (config.enabled === false) {
        return [
          name,
          {
            status: 'disconnected' as const,
            toolCount: 0,
            tools: [],
            error: 'Disabled',
            probedAt: Date.now(),
          },
        ] as [string, McpProbeResult];
      }
      const result = await probeMcpServer(name, config, options);
      return [name, result] as [string, McpProbeResult];
    }),
  );

  return Object.fromEntries(results);
}
