import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentClient, diagnoseSpawnFailure } from '../../src/main/agent/agent-client';

describe('diagnoseSpawnFailure', () => {
  it('reports executable permission problems for EACCES', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'socverify-runner-'));
    const runner = join(dir, 'socverify-runner');
    try {
      await writeFile(runner, '#!/bin/sh\n');
      await chmod(runner, 0o644);

      const detail = diagnoseSpawnFailure(runner, new Error(`spawn ${runner} EACCES`));

      expect(detail).toContain('Binary exists: yes');
      expect(detail).toContain('Executable permission: NO');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('AgentClient.start', () => {
  it('reports a missing working directory before spawning the runner', async () => {
    const missingCwd = join(tmpdir(), `socverify-missing-${Date.now()}`);
    const client = new AgentClient({
      runnerBinaryPath: join(missingCwd, 'socverify-runner'),
      cwd: missingCwd,
    });

    await expect(client.start()).rejects.toThrow(`Agent working directory does not exist: ${missingCwd}`);
  });
});
