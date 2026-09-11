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
