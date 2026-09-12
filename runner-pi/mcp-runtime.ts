/**
 * pi runner MCP 运行时状态（issue 04）。
 *
 * pi-mcp-adapter 通过共享事件总线发布状态快照（channel
 * `pi-mcp-adapter/status/v1`，见其 dist/types.js 的 MCP_STATUS_EVENT 与
 * mcp-status.ts 的 publishMcpStatusSnapshot）。runner 侧订阅该通道并维护
 * 最新快照，供 getMcpStatus / getMcpServerTools / reloadMcp 三个协议命令
 * 查询 —— 这是无 TUI 场景下 adapter 唯一的 headless 状态出口。
 *
 * 关键语义（spec）：headless 能力不支持时（快照缺失 / adapter 未加载 /
 * 尚未探测到的 server），状态必须显式为 `unknown`（未知/未探测），不得
 * 臆测为 connected/disconnected；reload 无 in-place 出口，返回
 * requiresSessionRestart，由 host 走重建会话生效，且绝不自动重放 turn。
 */

/** pi-mcp-adapter status 快照的共享事件总线通道名 */
export const MCP_STATUS_CHANNEL = 'pi-mcp-adapter/status/v1';

export interface AdapterServerSnapshot {
  name: string;
  status: string;
  toolCount: number;
  disabled?: boolean;
  [key: string]: unknown;
}

export interface AdapterStatusSnapshot {
  version: number;
  servers: AdapterServerSnapshot[];
  [key: string]: unknown;
}

/** host 契约的单 server 状态（getMcpStatus 返回 map 的 value） */
export interface McpServerStatusInfo {
  status: string;
  toolCount: number;
  error?: string;
}

export interface McpRuntimeState {
  /** 已解析配置中的 server 名（信任过滤后实际交给 adapter 的集合） */
  readonly configuredServers: readonly string[];
  /** adapter 扩展是否成功加载（false = MCP 被禁用或加载失败 → unknown） */
  adapterLoaded: boolean;
  /** 配置来源路径（供 host 展示） */
  configSourcePath: string | null;
  /** 最近一次 adapter status 快照（未收到过为 null） */
  latestSnapshot: AdapterStatusSnapshot | null;
  /** 订阅 adapter status 快照（由内联扩展在 pi.events 上转发进来） */
  applyStatusSnapshot(snapshot: AdapterStatusSnapshot): void;
}

/** 创建 runner 侧 MCP 运行时状态容器 */
export function createMcpRuntimeState(configuredServers: readonly string[]): McpRuntimeState {
  return {
    configuredServers,
    adapterLoaded: configuredServers.length > 0,
    configSourcePath: null,
    latestSnapshot: null,
    applyStatusSnapshot(snapshot: AdapterStatusSnapshot): void {
      this.latestSnapshot = snapshot;
    },
  };
}

/**
 * 将最新快照映射为 host 契约的 status map。
 *
 * - adapter 各状态 → host 契约：connected/cached → `connected`，
 *   failed/not-connected → `disconnected`，needs-auth/disabled 原样透出；
 * - 快照缺失、adapter 未加载、或快照未覆盖的配置 server → `unknown`
 *   （明确的未知/未探测状态，spec 验收项 3）；
 * - 快照中不属于配置来源的 server（runtime 注册等）不透出。
 */
export function mapSnapshotToHostStatus(
  state: McpRuntimeState,
): Record<string, McpServerStatusInfo> {
  const byName = new Map<string, AdapterServerSnapshot>();
  const snapshot = state.latestSnapshot;
  if (snapshot && Array.isArray(snapshot.servers)) {
    for (const s of snapshot.servers) {
      if (s && typeof s.name === 'string') byName.set(s.name, s);
    }
  }

  const result: Record<string, McpServerStatusInfo> = {};
  for (const name of state.configuredServers) {
    const s = byName.get(name);
    if (!state.adapterLoaded || !s) {
      result[name] = { status: 'unknown', toolCount: 0 };
      continue;
    }
    result[name] = mapServerStatus(s);
  }
  return result;
}

function mapServerStatus(s: AdapterServerSnapshot): McpServerStatusInfo {
  switch (s.status) {
    case 'connected':
    case 'cached':
      return { status: 'connected', toolCount: s.toolCount ?? 0 };
    case 'failed':
      return {
        status: 'disconnected',
        toolCount: 0,
        ...(typeof s.failedAgoSeconds === 'number'
          ? { error: `failed ${Math.round(s.failedAgoSeconds)}s ago` }
          : {}),
      };
    case 'needs-auth':
      return { status: 'needs-auth', toolCount: 0 };
    case 'disabled':
      return { status: 'disabled', toolCount: 0 };
    case 'not-connected':
    default:
      return { status: 'disconnected', toolCount: 0 };
  }
}

export interface SessionToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * 从会话工具面提取某 MCP server 的工具列表。
 *
 * adapter 默认 `toolPrefix: "server"` 模式下 direct 工具命名为
 * `<server>_<tool>`（server 名中的非标识字符清洗为下划线）。server 未
 * 连接或无工具时返回空数组 —— 上层据此显示为空列表/未知。
 */
export function selectServerToolsFromSession(
  sessionTools: readonly SessionToolInfo[],
  serverName: string,
): SessionToolInfo[] {
  const prefix = `${sanitizeServerToken(serverName)}_`;
  return sessionTools.filter((t) => typeof t.name === 'string' && t.name.startsWith(prefix));
}

/** adapter 的 server 名清洗规则：非字母数字字符 → 下划线（types.ts formatToolName 前置） */
function sanitizeServerToken(serverName: string): string {
  return serverName.replace(/[^a-zA-Z0-9_]/g, '_');
}
