import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TrustStore } from '../../src/main/agent/trust-store';

describe('TrustStore — host 侧持久化信任存储（issue 04）', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'trust-store-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('空存储返回空信任集（不抛错）', async () => {
    const store = new TrustStore(dir);
    await store.load();
    expect(store.getTrustedProjectDirs('/ws/dv')).toEqual([]);
    expect(store.getTrustedMcpServers('/ws/dv')).toEqual([]);
  });

  it('add 后可查询，并按 workspace 隔离', async () => {
    const store = new TrustStore(dir);
    await store.load();
    await store.addTrustedProjectDir('/ws/dv', '/proj/userA/view/dv');
    await store.addTrustedMcpServer('/ws/dv', 'traceweave');

    expect(store.getTrustedProjectDirs('/ws/dv')).toEqual(['/proj/userA/view/dv']);
    expect(store.getTrustedMcpServers('/ws/dv')).toEqual(['traceweave']);
    expect(store.getTrustedProjectDirs('/other/ws')).toEqual([]);
    expect(store.getTrustedMcpServers('/other/ws')).toEqual([]);
  });

  it('trust 决策持久化到磁盘，新实例 load 后可见', async () => {
    const store = new TrustStore(dir);
    await store.load();
    await store.addTrustedProjectDir('/ws/dv', '/proj/dv');
    await store.addTrustedMcpServer('/ws/dv', 'alpha');

    const store2 = new TrustStore(dir);
    await store2.load();
    expect(store2.getTrustedProjectDirs('/ws/dv')).toEqual(['/proj/dv']);
    expect(store2.getTrustedMcpServers('/ws/dv')).toEqual(['alpha']);
  });

  it('重复添加幂等（不产生重复项）', async () => {
    const store = new TrustStore(dir);
    await store.load();
    await store.addTrustedMcpServer('/ws', 'alpha');
    await store.addTrustedMcpServer('/ws', 'alpha');
    expect(store.getTrustedMcpServers('/ws')).toEqual(['alpha']);
  });

  it('损坏的存储文件按空状态处理（fail open 为未信任）', async () => {
    await writeFile(join(dir, 'trust.json'), '{ not json', 'utf-8');
    const store = new TrustStore(dir);
    await store.load();
    expect(store.getTrustedProjectDirs('/ws')).toEqual([]);
    // 随后的添加会覆盖损坏文件
    await store.addTrustedProjectDir('/ws', '/proj/dv');
    expect(store.getTrustedProjectDirs('/ws')).toEqual(['/proj/dv']);
  });

  it('文件不存在时直接添加可自建目录并持久化', async () => {
    const nested = join(dir, 'sub', 'dir');
    const store = new TrustStore(nested);
    await store.load();
    await store.addTrustedMcpServer('/ws', 'beta');

    const content = JSON.parse(await readFile(join(nested, 'trust.json'), 'utf-8')) as {
      version: number;
      workspaces: Record<string, { projectDirs: string[]; mcpServers: string[] }>;
    };
    expect(content.version).toBe(1);
    expect(content.workspaces['/ws'].mcpServers).toEqual(['beta']);
    expect(mkdir).toBeDefined();
  });
});
