/**
 * issue 10 验收项 2/3：生产构建使用精确 lockfile 依赖的 runner 载荷。
 *
 * runner-pi 以普通 Node 脚本 + extraResources 分发：
 *   - resources/runner-deps/          — pi runner 生产依赖清单（精确版本）
 *   - resources/runner-deps/package-lock.json — 可复现 lockfile
 *   - scripts/prepare-runner-deps.mjs — npm ci --omit=dev --ignore-scripts
 *   - electron-builder.yml            — runner-pi 与 runner-deps/node_modules
 *                                       映射到打包产物 resources/runner-pi/
 *
 * 这些测试是「打包布局的守门员」：任何漂移（版本不一致、混入 caret、
 * lockfile 缺失、yml 映射丢失）都应在此失败，而不是等到发布包损坏。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');
const RUNNER_DEPS_DIR = join(ROOT, 'resources', 'runner-deps');

/** runner 运行时依赖的权威集合（与根 package.json 共用同一套精确版本）。 */
const RUNNER_DEPENDENCIES = [
  '@earendil-works/pi-ai',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-tui',
  'jiti',
  'pi-mcp-adapter',
  'pi-subagents',
  'typebox',
] as const;

type PkgJson = {
  name?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, unknown>;
};

function readJson(path: string): PkgJson {
  return JSON.parse(readFileSync(path, 'utf-8')) as PkgJson;
}

describe('runner-deps manifest', () => {
  const manifestPath = join(RUNNER_DEPS_DIR, 'package.json');
  const rootPkg = readJson(join(ROOT, 'package.json'));

  it('runner-deps/package.json exists and is a private standalone package', () => {
    expect(existsSync(manifestPath), 'resources/runner-deps/package.json must exist').toBe(true);
    const manifest = readJson(manifestPath);
    expect(manifest.name).toBe('socverify-runner-deps');
    expect(manifest.private).toBe(true);
  });

  it('declares exactly the runner dependency set with versions matching the root manifest', () => {
    const manifest = readJson(manifestPath);
    const deps = manifest.dependencies ?? {};

    for (const dep of RUNNER_DEPENDENCIES) {
      expect(deps[dep], `runner-deps must declare ${dep}`).toBeDefined();
    }
    // No extra runtime deps beyond the sanctioned set — payload discipline.
    const extra = Object.keys(deps).filter((d) => !(RUNNER_DEPENDENCIES as readonly string[]).includes(d));
    expect(extra, `unexpected extra runner deps: ${extra.join(', ')}`).toEqual([]);

    for (const dep of RUNNER_DEPENDENCIES) {
      const rootVersion = rootPkg.devDependencies?.[dep] ?? rootPkg.dependencies?.[dep];
      expect(rootVersion, `${dep} must exist in root package.json`).toBeDefined();
      expect(deps[dep], `${dep} version must match the root manifest`).toBe(rootVersion);
    }
  });

  it('uses exact (non-range) versions so the published payload is reproducible', () => {
    const manifest = readJson(manifestPath);
    const deps = manifest.dependencies ?? {};
    for (const [dep, version] of Object.entries(deps)) {
      expect(version.startsWith('^') || version.startsWith('~'), `${dep}@${version} must be exact`).toBe(false);
    }
  });

  it('carries the pi-mcp-adapter override that pins its peer deps to the runner versions', () => {
    const manifest = readJson(manifestPath);
    const rootOverrides = rootPkg.overrides as Record<string, unknown> | undefined;
    expect(manifest.overrides).toEqual(rootOverrides);
  });

  it('has a package-lock.json whose direct dependency versions match the manifest', () => {
    const lockPath = join(RUNNER_DEPS_DIR, 'package-lock.json');
    expect(existsSync(lockPath), 'runner-deps lockfile must exist (npm ci input)').toBe(true);
    const lock = JSON.parse(readFileSync(lockPath, 'utf-8')) as {
      lockfileVersion: number;
      packages: Record<string, { version?: string }>;
    };
    expect(lock.lockfileVersion).toBeGreaterThanOrEqual(3);

    const manifest = readJson(manifestPath);
    const deps = manifest.dependencies ?? {};
    for (const [dep, expected] of Object.entries(deps)) {
      const entry = lock.packages[`node_modules/${dep}`];
      expect(entry, `lockfile must contain ${dep}`).toBeDefined();
      expect(entry?.version, `lockfile ${dep} version must be exact`).toBe(expected);
    }
  });

  it('prepare script exists and installs with ci + omit=dev + ignore-scripts', () => {
    const scriptPath = join(ROOT, 'scripts', 'prepare-runner-deps.mjs');
    expect(existsSync(scriptPath), 'scripts/prepare-runner-deps.mjs must exist').toBe(true);
    const source = readFileSync(scriptPath, 'utf-8');
    expect(source).toContain('ci');
    expect(source).toContain('--omit=dev');
    expect(source).toContain('--ignore-scripts');
    expect(source).toContain('runner-deps');
  });

  it('electron-builder ships runner-pi and its node_modules as extraResources', () => {
    const yml = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf-8');
    // runner-pi scripts land at resources/runner-pi/
    expect(yml).toMatch(/from:\s*runner-pi\s*\n\s*to:\s*runner-pi/);
    // runner-deps node_modules land at resources/runner-pi/node_modules
    expect(yml).toMatch(/from:\s*resources\/runner-deps\/node_modules\s*\n\s*to:\s*runner-pi\/node_modules/);
  });

  it('keeps the pi dependency set out of the root production dependencies (not bundled into asar)', () => {
    for (const dep of RUNNER_DEPENDENCIES) {
      expect(
        rootPkg.dependencies?.[dep],
        `${dep} must not be a production dependency (it would be bundled into the asar while the runner loads it from extraResources)`,
      ).toBeUndefined();
      const inDev = rootPkg.devDependencies?.[dep];
      expect(inDev, `${dep} must stay installed for development (runner resolves it from the repo root)`).toBeDefined();
    }
  });
});
