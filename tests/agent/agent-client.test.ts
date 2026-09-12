import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentClient, diagnoseSpawnFailure } from '../../src/main/agent/agent-client';
import type { AgentClientOptions } from '../../src/main/agent/types';

describe('diagnoseSpawnFailure', () => {
  it('reports executable permission problems for EACCES', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-spawn-'));
    const binary = join(dir, 'spawn-target');
    try {
      await writeFile(binary, '#!/bin/sh\n');
      await chmod(binary, 0o644);

      const detail = diagnoseSpawnFailure(binary, new Error(`spawn ${binary} EACCES`));

      expect(detail).toContain('Binary exists: yes');
      expect(detail).toContain('Executable permission: NO');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a missing binary path for ENOENT', async () => {
    const missing = join(tmpdir(), `missing-${Date.now()}`);
    const detail = diagnoseSpawnFailure(missing, new Error(`spawn ${missing} ENOENT`));
    expect(detail).toContain('Binary not found at:');
  });

  it('ignores non-spawn errors', () => {
    expect(diagnoseSpawnFailure(join(tmpdir(), 'x'), new Error('something else'))).toBe('');
  });
});

// ─── 引擎中立基类（issue 10）────────────────────────────
//
// omp 运行时移除后，AgentClient 只是 JSONL 客户端机制基类：
// 引擎身份与 spawn 方式完全由子类决定，基类不再提供
// binary（预编译二进制）或 Bun 脚本两种 omp 专用启动模式。

class MinimalClient extends AgentClient {
  readonly engine = 'pi' as const;
  regenerate(): Promise<{ engineSessionId: string }> {
    return Promise.resolve({ engineSessionId: 'unused' });
  }
}

describe('AgentClient 引擎中立基类（issue 10）', () => {
  function makeOptions(overrides: Partial<AgentClientOptions> = {}): AgentClientOptions {
    return { cwd: tmpdir(), ...overrides };
  }

  it('基类不再提供 omp regenerate 语义（分支语义由引擎子类实现）', () => {
    expect(
      (AgentClient.prototype as unknown as Record<string, unknown>).regenerate,
    ).toBeUndefined();
  });

  it('未覆写 resolveSpawn 的子类在 start 时得到清晰错误，而非静默尝试 omp 启动模式', async () => {
    const client = new MinimalClient(makeOptions());
    await expect(client.start()).rejects.toThrow(/resolveSpawn/);
  });

  it('reports a missing working directory before spawning the runner', async () => {
    const missingCwd = join(tmpdir(), `agent-missing-${Date.now()}`);
    const client = new MinimalClient({ cwd: missingCwd });

    await expect(client.start()).rejects.toThrow(`Agent working directory does not exist: ${missingCwd}`);
  });
});
