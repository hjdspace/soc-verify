import { describe, expect, it, vi } from 'vitest';
import {
  buildTrustedMcpServers,
  resolveProjectTrustDecision,
  resolveToolCallGate,
} from '../../runner-pi/extensions';
import type { ApprovalMode } from '../../runner-pi/approval-logic';
import type { McpConfigResolution } from '../../runner-pi/mcp-config';
import type { TrustKind } from '../../runner-pi/protocol';

// ─── resolveToolCallGate — 工具调用审批门 ─────────────────────────────────

describe('resolveToolCallGate', () => {
  const makeDeps = (mode: ApprovalMode, approved: boolean) => ({
    getMode: () => mode,
    requestApproval: vi.fn(async () => approved),
  });

  it('无需审批（read 工具 + always-ask）时放行且不调用 requestApproval', async () => {
    const deps = makeDeps('always-ask', false);
    const gate = await resolveToolCallGate('read', { path: 'a.txt' }, deps.getMode, deps.requestApproval);
    expect(gate).toBeUndefined();
    expect(deps.requestApproval).not.toHaveBeenCalled();
  });

  it('需要审批且用户批准 → 放行（返回 undefined）', async () => {
    const deps = makeDeps('always-ask', true);
    const gate = await resolveToolCallGate('bash', { command: 'ls' }, deps.getMode, deps.requestApproval);
    expect(gate).toBeUndefined();
    expect(deps.requestApproval).toHaveBeenCalledWith('bash', { command: 'ls' });
  });

  it('需要审批且用户拒绝 → 返回 block 帧（带 reason）', async () => {
    const deps = makeDeps('always-ask', false);
    const gate = await resolveToolCallGate('bash', { command: 'rm -rf /' }, deps.getMode, deps.requestApproval);
    expect(gate?.block).toBe(true);
    expect(gate?.reason).toContain('bash');
  });

  it('yolo 模式下即使工具是 exec 级也不询问', async () => {
    const deps = makeDeps('yolo', false);
    const gate = await resolveToolCallGate('bash', {}, deps.getMode, deps.requestApproval);
    expect(gate).toBeUndefined();
    expect(deps.requestApproval).not.toHaveBeenCalled();
  });

  it('MCP / extension 未知工具按 exec 层级走审批（write 模式）', async () => {
    const deps = makeDeps('write', false);
    const gate = await resolveToolCallGate('cov_query_coverage', {}, deps.getMode, deps.requestApproval);
    expect(gate?.block).toBe(true);
    expect(deps.requestApproval).toHaveBeenCalledOnce();
  });
});

// ─── resolveProjectTrustDecision — 项目信任决策 ──────────────────────────

describe('resolveProjectTrustDecision', () => {

  it('项目无信任敏感资源时直接信任，不询问用户', async () => {
    const requestTrust = vi.fn();
    const trusted = await resolveProjectTrustDecision('/proj', [], false, requestTrust);
    expect(trusted).toBe(true);
    expect(requestTrust).not.toHaveBeenCalled();
  });

  it('cwd 已在 host 信任存储（trustedProjectDirs）→ 直接信任', async () => {
    const requestTrust = vi.fn();
    const trusted = await resolveProjectTrustDecision('/proj/dv', [], false, requestTrust);
    expect(trusted).toBe(true);

    const trusted2 = await resolveProjectTrustDecision(
      '/proj/dv',
      ['/proj/dv'],
      true,
      requestTrust,
    );
    expect(trusted2).toBe(true);
    expect(requestTrust).not.toHaveBeenCalled();
  });

  it('未信任且有信任敏感资源 → 以 project-extension 类型询问用户并透传结果', async () => {
    const requestTrust = vi.fn(async (kind: TrustKind, name: string) => kind === 'project-extension' && name === '/proj/dv');
    const trusted = await resolveProjectTrustDecision('/proj/dv', [], true, requestTrust);
    expect(trusted).toBe(true);
    expect(requestTrust).toHaveBeenCalledOnce();
    expect(requestTrust.mock.calls[0]?.[0]).toBe('project-extension');
  });

  it('用户拒绝信任 → 返回 false（项目 extension 不加载）', async () => {
    const requestTrust = vi.fn(async () => false);
    const trusted = await resolveProjectTrustDecision('/proj/dv', [], true, requestTrust);
    expect(trusted).toBe(false);
  });
});

// ─── buildTrustedMcpServers — MCP 信任装配计划 ───────────────────────────

describe('buildTrustedMcpServers', () => {
  const resolutionOf = (servers: Record<string, { command?: string; disabled?: boolean }>): McpConfigResolution => ({
    selected: { path: '/proj/.pi/mcp.json', servers },
    ignored: [],
  });

  it('enableMCP=false → 空集，不询问信任', async () => {
    const requestTrust = vi.fn();
    const plan = await buildTrustedMcpServers(resolutionOf({ alpha: { command: 'a' } }), {
      enableMCP: false,
      trustedMcpServers: [],
      requestTrust,
    });
    expect(plan.mcpServers).toEqual({});
    expect(plan.ignored).toEqual([]);
    expect(requestTrust).not.toHaveBeenCalled();
  });

  it('无选中配置来源 → 空集', async () => {
    const requestTrust = vi.fn();
    const plan = await buildTrustedMcpServers(
      { selected: null, ignored: [{ path: '/proj/.pi/mcp.json', reason: 'invalid-json' }] },
      { enableMCP: true, trustedMcpServers: [], requestTrust },
    );
    expect(plan.mcpServers).toEqual({});
    expect(plan.ignored).toHaveLength(1);
    expect(requestTrust).not.toHaveBeenCalled();
  });

  it('信任存储命中的 server 直接放行，不询问', async () => {
    const requestTrust = vi.fn();
    const plan = await buildTrustedMcpServers(
      resolutionOf({ alpha: { command: 'a' }, beta: { command: 'b' } }),
      { enableMCP: true, trustedMcpServers: ['alpha', 'beta'], requestTrust },
    );
    expect(Object.keys(plan.mcpServers).sort()).toEqual(['alpha', 'beta']);
    expect(requestTrust).not.toHaveBeenCalled();
  });

  it('未信任 server 逐个以 mcp-server 类型询问；批准者并入，拒绝者排除', async () => {
    const requestTrust = vi.fn(async (_kind: TrustKind, name: string) => name === 'approved');
    const plan = await buildTrustedMcpServers(
      resolutionOf({
        approved: { command: 'a' },
        rejected: { command: 'b' },
        known: { command: 'c' },
      }),
      { enableMCP: true, trustedMcpServers: ['known'], requestTrust },
    );
    expect(Object.keys(plan.mcpServers).sort()).toEqual(['approved', 'known']);
    const kinds = requestTrust.mock.calls.map((c) => (c as unknown[])[0]);
    expect(kinds).toEqual(['mcp-server', 'mcp-server']);
  });

  it('ignored 列表原样透出（供 host 报告配置冲突）', async () => {
    const ignored = [{ path: '/proj/mcp.json', reason: 'lower-priority' as const }];
    const plan = await buildTrustedMcpServers(
      { selected: { path: '/proj/.pi/mcp.json', servers: {} }, ignored },
      { enableMCP: true, trustedMcpServers: [], requestTrust: vi.fn() },
    );
    expect(plan.ignored).toEqual(ignored);
  });

  it('disabled 的 server 不启动也不询问信任', async () => {
    const requestTrust = vi.fn();
    const plan = await buildTrustedMcpServers(
      resolutionOf({ off: { command: 'a', disabled: true } }),
      { enableMCP: true, trustedMcpServers: [], requestTrust },
    );
    expect(plan.mcpServers).toEqual({});
    expect(requestTrust).not.toHaveBeenCalled();
  });
});

// ─── 信任治理三分（issue 09 验收项 5）────────────────────────────────────
//
// extension 加载信任、MCP server 信任、单次工具审批是三条独立链路：
//   记录 — TrustStore 按 projectDirs / mcpServers 分开持久化（trust-store.test.ts）
//   展示 — trustRequest 事件携带 kind 透传 renderer（session-router-trust.test.ts）
//   执行 — 本文件：三条链路互不干涉，审批放宽（yolo）不越过信任边界

describe('信任治理三分 — yolo 不绕过信任（issue 09）', () => {
  it('yolo 放行单次工具审批，但不跳过项目 extension 信任确认', async () => {
    // 单次审批：yolo 放行 exec 级工具
    const gate = await resolveToolCallGate('bash', {}, () => 'yolo', vi.fn(async () => false));
    expect(gate).toBeUndefined();

    // 项目信任：与审批模式无关 —— 未信任项目仍需确认，拒绝则 extension 不加载
    const requestTrust = vi.fn(async (_kind: TrustKind, _name: string) => false);
    const trusted = await resolveProjectTrustDecision('/proj/untrusted', [], true, requestTrust);
    expect(trusted).toBe(false);
    expect(requestTrust).toHaveBeenCalledOnce();
    expect(requestTrust.mock.calls[0]?.[0]).toBe('project-extension');
  });

  it('yolo 不跳过 MCP server 信任确认（首次启动仍逐个询问）', async () => {
    const requestTrust = vi.fn(async (_kind: TrustKind, _name: string) => false);
    const plan = await buildTrustedMcpServers(
      { selected: { path: '/proj/.pi/mcp.json', servers: { alpha: { command: 'a' } } }, ignored: [] },
      { enableMCP: true, trustedMcpServers: [], requestTrust },
    );
    // 未信任 server 被排除（不启动），且确以 mcp-server 类型询问过
    expect(plan.mcpServers).toEqual({});
    expect(requestTrust).toHaveBeenCalledOnce();
    expect(requestTrust.mock.calls[0]?.[0]).toBe('mcp-server');
  });

  it('三类决策互不干涉：审批拒绝不撤销已记录的信任，信任通过不放宽单次审批', async () => {
    // 单次审批照常拦截（用户拒绝 bash）
    const gate = await resolveToolCallGate('bash', {}, () => 'always-ask', vi.fn(async () => false));
    expect(gate?.block).toBe(true);

    // 已记录信任的 MCP server 直接并入，无需再确认 —— 与审批结果无关
    const requestTrust = vi.fn();
    const plan = await buildTrustedMcpServers(
      { selected: { path: '/proj/.pi/mcp.json', servers: { known: { command: 'a' } } }, ignored: [] },
      { enableMCP: true, trustedMcpServers: ['known'], requestTrust },
    );
    expect(plan.mcpServers).toHaveProperty('known');
    expect(requestTrust).not.toHaveBeenCalled();
  });
});
