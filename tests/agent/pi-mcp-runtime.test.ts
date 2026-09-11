/**
 * pi runner MCP 运行时状态测试（issue 04 验收项 3）。
 *
 * pi-mcp-adapter 通过共享事件总线（pi.events，channel
 * `pi-mcp-adapter/status/v1`）发布 McpStatusSnapshot —— 这是 headless 场景
 * 下唯一的服务器状态出口。runner 订阅并维护最新快照；快照缺失或 adapter
 * 未加载时必须呈现明确的「未知/未探测」状态。
 */
import { describe, expect, it } from 'vitest';
import {
  createMcpRuntimeState,
  mapSnapshotToHostStatus,
  MCP_STATUS_CHANNEL,
  selectServerToolsFromSession,
} from '../../runner-pi/mcp-runtime';

/** 构造 adapter status/v1 快照（形状对齐 pi-mcp-adapter dist/types.d.ts） */
function snapshotOf(
  servers: Array<{
    name: string;
    status: string;
    toolCount: number;
    disabled?: boolean;
  }>,
) {
  return {
    version: 1,
    servers: servers.map((s) => ({
      name: s.name,
      status: s.status,
      toolCount: s.toolCount,
      listenState: 'disconnected',
      disabled: s.disabled ?? false,
    })),
    totalTools: servers.reduce((acc, s) => acc + s.toolCount, 0),
    totalResources: 0,
    connectedCount: servers.filter((s) => s.status === 'connected').length,
    disabledCount: servers.filter((s) => s.disabled).length,
  };
}

describe('MCP_STATUS_CHANNEL', () => {
  it('使用 pi-mcp-adapter 的官方 status/v1 通道名', () => {
    expect(MCP_STATUS_CHANNEL).toBe('pi-mcp-adapter/status/v1');
  });
});

describe('mapSnapshotToHostStatus — 状态映射与未探测兜底', () => {
  it('adapter 各状态映射到 host 契约状态', () => {
    const state = createMcpRuntimeState(['connected_a', 'cached_b', 'failed_c', 'auth_d', 'off_e']);
    applyAll(state, [
      { name: 'connected_a', status: 'connected', toolCount: 3 },
      { name: 'cached_b', status: 'cached', toolCount: 2 },
      { name: 'failed_c', status: 'failed', toolCount: 0 },
      { name: 'auth_d', status: 'needs-auth', toolCount: 0 },
      { name: 'off_e', status: 'disabled', toolCount: 0 },
    ]);
    const map = mapSnapshotToHostStatus(state);
    expect(map.connected_a).toMatchObject({ status: 'connected', toolCount: 3 });
    // cached：元数据缓存可用，视为已连接
    expect(map.cached_b).toMatchObject({ status: 'connected', toolCount: 2 });
    // failed：启动/连接失败 → disconnected（可附带错误信息）
    expect(map.failed_c).toMatchObject({ status: 'disconnected' });
    expect(map.auth_d).toMatchObject({ status: 'needs-auth' });
    expect(map.off_e).toMatchObject({ status: 'disabled' });
  });

  it('快照缺失时全部配置中的 server 显示未知/未探测', () => {
    const state = createMcpRuntimeState(['alpha', 'beta']);
    const map = mapSnapshotToHostStatus(state);
    expect(map.alpha).toEqual({ status: 'unknown', toolCount: 0 });
    expect(map.beta).toEqual({ status: 'unknown', toolCount: 0 });
  });

  it('adapter 未加载（MCP 被禁用）时同样返回 unknown 而不是臆测', () => {
    const state = createMcpRuntimeState(['alpha']);
    state.adapterLoaded = false;
    expect(mapSnapshotToHostStatus(state).alpha).toEqual({ status: 'unknown', toolCount: 0 });
  });

  it('快照未覆盖的配置 server（尚未探测）补 unknown', () => {
    const state = createMcpRuntimeState(['alpha', 'not_yet_probed']);
    applyAll(state, [{ name: 'alpha', status: 'connected', toolCount: 1 }]);
    const map = mapSnapshotToHostStatus(state);
    expect(map.alpha).toMatchObject({ status: 'connected' });
    expect(map.not_yet_probed).toEqual({ status: 'unknown', toolCount: 0 });
  });

  it('快照中多余的 server（非配置来源）不透出', () => {
    const state = createMcpRuntimeState(['alpha']);
    applyAll(state, [
      { name: 'alpha', status: 'connected', toolCount: 1 },
      { name: 'rogue_runtime', status: 'connected', toolCount: 9 },
    ]);
    expect(Object.keys(mapSnapshotToHostStatus(state))).toEqual(['alpha']);
  });
});

describe('selectServerToolsFromSession — 从会话工具面提取 server 工具列表', () => {
  it('默认 server 前缀模式下按 <server>_<tool> 匹配', () => {
    const sessionTools = [
      { name: 'read', description: 'r' },
      { name: 'searxng_web_search', description: 'search' },
      { name: 'searxng_fetch', description: 'fetch' },
      { name: 'other_tool', description: 'o' },
    ];
    const tools = selectServerToolsFromSession(sessionTools, 'searxng');
    expect(tools.map((t) => t.name)).toEqual(['searxng_web_search', 'searxng_fetch']);
  });

  it('server 名含连字符时用下划线形态匹配（adapter 清洗规则）', () => {
    const sessionTools = [{ name: 'my_server_tool', description: 'x' }];
    const tools = selectServerToolsFromSession(sessionTools, 'my-server');
    expect(tools.map((t) => t.name)).toEqual(['my_server_tool']);
  });

  it('无匹配工具时返回空数组（server 未连接/无工具）', () => {
    expect(selectServerToolsFromSession([], 'alpha')).toEqual([]);
    expect(
      selectServerToolsFromSession([{ name: 'read', description: 'r' }], 'alpha'),
    ).toEqual([]);
  });
});

// ─── helpers ─────────────────────────────────────────────

function applyAll(
  state: ReturnType<typeof createMcpRuntimeState>,
  servers: Array<{ name: string; status: string; toolCount: number; disabled?: boolean }>,
): void {
  state.applyStatusSnapshot(snapshotOf(servers));
}
