/**
 * pi runner MCP 配置单一来源解析测试（issue 04 验收项 2）。
 *
 * spec：MCP 配置按 `.pi/mcp.json` → `.mcp.json` → `mcp.json` →
 * `.socverify/mcp-config.json` 的优先级选择**单一来源**，不自动合并，
 * 未选文件保持不动并报告（ignored 列表）。
 */
import { describe, expect, it } from 'vitest';
import {
  MCP_CONFIG_PRIORITY,
  partitionServersByTrust,
  resolveMcpConfigSource,
} from '../../runner-pi/mcp-config';

/** 内存文件系统：path → 文本内容（不存在的路径不写） */
function fsOf(files: Record<string, string>) {
  return async (path: string): Promise<string> => {
    const hit = files[path];
    if (hit === undefined) throw new Error(`ENOENT: ${path}`);
    return hit;
  };
}

const SERVERS_A = { mcpServers: { alpha: { command: 'a' } } };
const SERVERS_B = { mcpServers: { beta: { command: 'b' } } };
const SERVERS_C = { mcpServers: { gamma: { command: 'c' } } };
const SERVERS_D = { mcpServers: { delta: { command: 'd' } } };

describe('MCP_CONFIG_PRIORITY', () => {
  it('优先级顺序符合 spec', () => {
    expect(MCP_CONFIG_PRIORITY).toEqual([
      '.pi/mcp.json',
      '.mcp.json',
      'mcp.json',
      '.socverify/mcp-config.json',
    ]);
  });
});

describe('resolveMcpConfigSource — 单一来源选择', () => {
  it('无任何配置文件时返回 null（无来源）', async () => {
    const r = await resolveMcpConfigSource('/proj', fsOf({}));
    expect(r.selected).toBeNull();
    expect(r.ignored).toEqual([]);
  });

  it('只有一个文件时选中它且无 ignored', async () => {
    const r = await resolveMcpConfigSource(
      '/proj',
      fsOf({ '/proj/.mcp.json': JSON.stringify(SERVERS_B) }),
    );
    expect(r.selected?.path).toBe('/proj/.mcp.json');
    expect(r.selected?.servers).toEqual(SERVERS_B.mcpServers);
    expect(r.ignored).toEqual([]);
  });

  it('多个文件共存时按优先级选最高者，其余保持不动并报告 ignored', async () => {
    const r = await resolveMcpConfigSource(
      '/proj',
      fsOf({
        '/proj/.pi/mcp.json': JSON.stringify(SERVERS_A),
        '/proj/.mcp.json': JSON.stringify(SERVERS_B),
        '/proj/mcp.json': JSON.stringify(SERVERS_C),
        '/proj/.socverify/mcp-config.json': JSON.stringify(SERVERS_D),
      }),
    );
    // 单一来源：只取 .pi/mcp.json，绝不合并 beta/gamma/delta
    expect(r.selected?.path).toBe('/proj/.pi/mcp.json');
    expect(r.selected?.servers).toEqual({ alpha: { command: 'a' } });
    expect(r.selected?.servers).not.toHaveProperty('beta');
    // 未选文件保持不动（内容不改动），仅报告
    expect(r.ignored.map((i) => i.path)).toEqual([
      '/proj/.mcp.json',
      '/proj/mcp.json',
      '/proj/.socverify/mcp-config.json',
    ]);
  });

  it('高优先级文件缺失时回退到下一个存在的文件', async () => {
    const r = await resolveMcpConfigSource(
      '/proj',
      fsOf({
        '/proj/mcp.json': JSON.stringify(SERVERS_C),
        '/proj/.socverify/mcp-config.json': JSON.stringify(SERVERS_D),
      }),
    );
    expect(r.selected?.path).toBe('/proj/mcp.json');
    expect(r.selected?.servers).toEqual(SERVERS_C.mcpServers);
    expect(r.ignored.map((i) => i.path)).toEqual(['/proj/.socverify/mcp-config.json']);
  });

  it('无法解析（非法 JSON）的文件跳过并标记 invalid-json，继续回退', async () => {
    const r = await resolveMcpConfigSource(
      '/proj',
      fsOf({
        '/proj/.mcp.json': '{ not json',
        '/proj/mcp.json': JSON.stringify(SERVERS_C),
      }),
    );
    expect(r.selected?.path).toBe('/proj/mcp.json');
    expect(r.ignored).toEqual([{ path: '/proj/.mcp.json', reason: 'invalid-json' }]);
  });

  it('非对象 JSON（数组/标量）视为无效来源', async () => {
    const r = await resolveMcpConfigSource(
      '/proj',
      fsOf({ '/proj/.mcp.json': '[1,2,3]', '/proj/mcp.json': JSON.stringify(SERVERS_C) }),
    );
    expect(r.selected?.path).toBe('/proj/mcp.json');
    expect(r.ignored[0]?.reason).toBe('invalid-json');
  });

  it('mcpServers 键缺失或非对象视为无效来源', async () => {
    const r = await resolveMcpConfigSource(
      '/proj',
      fsOf({
        '/proj/.pi/mcp.json': '{"foo": 1}',
        '/proj/.mcp.json': JSON.stringify(SERVERS_B),
      }),
    );
    expect(r.selected?.path).toBe('/proj/.mcp.json');
    expect(r.ignored[0]?.reason).toBe('invalid-json');
  });

  it('mcpServers 为空对象仍是有效来源（用户显式配置为空）', async () => {
    const r = await resolveMcpConfigSource(
      '/proj',
      fsOf({ '/proj/.mcp.json': '{"mcpServers": {}}' }),
    );
    expect(r.selected?.path).toBe('/proj/.mcp.json');
    expect(r.selected?.servers).toEqual({});
  });

  it('UTF-8 BOM 不影响解析（Windows 常见写入）', async () => {
    const r = await resolveMcpConfigSource(
      '/proj',
      fsOf({ '/proj/.mcp.json': '\uFEFF' + JSON.stringify(SERVERS_B) }),
    );
    expect(r.selected?.path).toBe('/proj/.mcp.json');
    expect(r.selected?.servers).toEqual(SERVERS_B.mcpServers);
  });
});

describe('partitionServersByTrust — MCP server 信任分区', () => {
  const servers = {
    trusted_a: { command: 'a' },
    untrusted_b: { command: 'b' },
    trusted_c: { command: 'c' },
  };

  it('已信任的进入 trusted，未信任的列在 untrusted（不改动配置）', () => {
    const r = partitionServersByTrust(servers, ['trusted_a', 'trusted_c']);
    expect(r.trusted).toEqual({
      trusted_a: { command: 'a' },
      trusted_c: { command: 'c' },
    });
    expect(r.untrusted).toEqual(['untrusted_b']);
  });

  it('trust 列表为空时全部 untrusted（首次启动场景）', () => {
    const r = partitionServersByTrust(servers, []);
    expect(r.trusted).toEqual({});
    expect(r.untrusted).toEqual(['trusted_a', 'untrusted_b', 'trusted_c']);
  });

  it('disabled 的 server 不参与信任请求（不会被启动）', () => {
    const r = partitionServersByTrust(
      { off: { command: 'x', disabled: true }, on: { command: 'y' } },
      [],
    );
    expect(r.untrusted).toEqual(['on']);
    expect(r.trusted).toEqual({});
  });
});
