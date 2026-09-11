/**
 * pi runner MCP 配置解析（issue 04）。
 *
 * spec：MCP 配置选择一个来源，优先级为 `.pi/mcp.json`、`.mcp.json`、
 * `mcp.json`、`.socverify/mcp-config.json`；**不自动合并**，未选文件保持
 * 不动并报告冲突（这里以 ignored 列表形式返回给调用方上报 host）。
 *
 * 与 pi-mcp-adapter 自身发现逻辑的关系：adapter 的 loadMcpConfig 会把多个
 * 来源合并，违反 spec。因此 runner 侧先解析出单一来源，再通过
 * `createMcpAdapter({ config })` 显式注入，绕开 adapter 的多源合并。
 *
 * 读取函数支持注入（测试用内存 fs），生产环境默认 fs/promises.readFile。
 */

export interface McpServerEntry {
  /** 其余字段透传给 pi-mcp-adapter 的 ServerEntry（command/args/url/env/...） */
  [key: string]: unknown;
}

export interface ResolvedMcpConfigSource {
  /** 选中的配置文件绝对路径 */
  path: string;
  /** 该文件声明的 server 集（单一来源，未合并） */
  servers: Record<string, McpServerEntry>;
}

export type McpConfigIgnoreReason = 'lower-priority' | 'invalid-json';

export interface McpConfigIgnore {
  path: string;
  reason: McpConfigIgnoreReason;
}

export interface McpConfigResolution {
  selected: ResolvedMcpConfigSource | null;
  /** 存在但未选中的文件（含解析失败者），供 host 报告冲突 */
  ignored: McpConfigIgnore[];
}

/** spec 固定的优先级（相对 projectDir 的路径） */
export const MCP_CONFIG_PRIORITY = [
  '.pi/mcp.json',
  '.mcp.json',
  'mcp.json',
  '.socverify/mcp-config.json',
] as const;

type ReadFileFn = (path: string) => Promise<string>;

function defaultReadFile(path: string): Promise<string> {
  // 延迟加载，保持模块导入无副作用（runner 与测试共享）
  return import('node:fs/promises').then((fs) => fs.readFile(path, 'utf-8'));
}

/** 剥离 UTF-8 BOM（Windows PowerShell 写入的文件常见） */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 解析单个配置文件文本；非法 JSON / 非对象 / mcpServers 键缺失或非对象
 * 均视为无效来源（返回 null）。空 mcpServers 是有效来源（显式为空）。
 */
export function parseMcpConfigText(text: string): Record<string, McpServerEntry> | null {
  try {
    const parsed: unknown = JSON.parse(stripBom(text));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const servers = (parsed as Record<string, unknown>).mcpServers;
    if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return null;
    return servers as Record<string, McpServerEntry>;
  } catch {
    return null;
  }
}

/**
 * 按优先级选择**单一** MCP 配置来源。
 *
 * 选择规则（确定性）：
 * 1. 依序取第一个「存在且可解析」的文件作为 selected；
 * 2. 优先级更高的存在但不可解析文件 → ignored（invalid-json），继续回退；
 * 3. 优先级更低的存在文件 → ignored（lower-priority），内容保持不动；
 * 4. 全部缺失/无效 → selected 为 null。
 */
export async function resolveMcpConfigSource(
  projectDir: string,
  readFile: ReadFileFn = defaultReadFile,
): Promise<McpConfigResolution> {
  const join = (rel: string) => `${projectDir.replace(/[\\/]+$/, '')}/${rel}`;
  const ignored: McpConfigIgnore[] = [];

  for (let i = 0; i < MCP_CONFIG_PRIORITY.length; i++) {
    const rel = MCP_CONFIG_PRIORITY[i];
    const path = join(rel);
    let text: string;
    try {
      text = await readFile(path);
    } catch {
      continue; // 文件不存在 → 静默跳过
    }

    const servers = parseMcpConfigText(text);
    if (servers === null) {
      ignored.push({ path, reason: 'invalid-json' });
      continue;
    }

    // 选中：其余更低优先级的已存在文件全部记为 lower-priority
    for (let j = i + 1; j < MCP_CONFIG_PRIORITY.length; j++) {
      const lowerPath = join(MCP_CONFIG_PRIORITY[j]);
      try {
        await readFile(lowerPath);
        ignored.push({ path: lowerPath, reason: 'lower-priority' });
      } catch {
        // 不存在，无需报告
      }
    }
    return { selected: { path, servers }, ignored };
  }

  return { selected: null, ignored };
}

export interface TrustPartition {
  /** 信任决策已确认、允许启动的 server 集 */
  trusted: Record<string, McpServerEntry>;
  /** 需要请求用户信任确认的 server 名（disabled 的不参与） */
  untrusted: string[];
}

function isServerDisabled(entry: McpServerEntry | undefined): boolean {
  return entry?.disabled === true;
}

/**
 * 将解析出的 server 集按信任决策分区。
 *
 * 信任独立于审批模式：`yolo` 只放宽单次工具审批，MCP server 首次启动的
 * 信任确认不因此跳过（spec 验收项 5）。
 */
export function partitionServersByTrust(
  servers: Record<string, McpServerEntry>,
  trustedNames: readonly string[],
): TrustPartition {
  const trustedSet = new Set(trustedNames);
  const trusted: Record<string, McpServerEntry> = {};
  const untrusted: string[] = [];
  for (const [name, entry] of Object.entries(servers)) {
    if (isServerDisabled(entry)) continue;
    if (trustedSet.has(name)) {
      trusted[name] = entry;
    } else {
      untrusted.push(name);
    }
  }
  return { trusted, untrusted };
}
