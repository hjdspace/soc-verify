import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createPluginLoader } from '../../src/main/plugins/loader';

describe('socverify-plugin-dev EDA example', () => {
  let projectRoot: string;
  let userPluginsDir: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'socverify-plugin-skill-project-'));
    userPluginsDir = await mkdtemp(join(tmpdir(), 'socverify-plugin-skill-user-'));
    await mkdir(join(projectRoot, 'logs'), { recursive: true });
    await writeFile(
      join(projectRoot, 'logs', 'eda-run.log'),
      '[EDA] compile: pass\n[EDA] simulation: pass\n[EDA] tests: 12\n[EDA] passed: 11\n[EDA] failed: 1\n[EDA] elapsed_s: 42.5\n',
      'utf-8',
    );
    await cp(
      resolve('resources/built-in-extension/skills/socverify-plugin-dev/assets/eda-log-summary'),
      join(userPluginsDir, 'eda-log-summary'),
      { recursive: true },
    );
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(userPluginsDir, { recursive: true, force: true });
  });

  it('loads the user plugin asset and summarizes an EDA log', async () => {
    const loader = createPluginLoader({ builtinPluginsDir: null, userPluginsDir });
    const results = await loader.loadPlugins(projectRoot);

    expect(results[0]).toMatchObject({
      origin: 'user',
      manifest: { id: 'eda-log-summary', kind: 'ui' },
    });
    const html = results[0].contributes?.views?.[0].html;
    expect(html).toContain('EDA Log Summary');
    expect(html).toContain('prefers-color-scheme');
    expect(html).toContain('Analyze log');
    await expect(
      loader.executeCommand(projectRoot, 'eda-log-summary.analyze', ['logs/eda-run.log']),
    ).resolves.toEqual({
      status: 'fail',
      tests: 12,
      passed: 11,
      failed: 1,
      elapsedSeconds: 42.5,
    });
    await expect(
      loader.executeCommand(projectRoot, 'eda-log-summary.analyze', ['logs/missing.log']),
    ).rejects.toThrow();
    loader.clearAll();
  });
});
