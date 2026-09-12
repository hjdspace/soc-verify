/**
 * issue 10 — prepare-runner-deps 平台二进制裁剪（载荷瘦身）。
 *
 * @earendil-works/pi-coding-agent 发布时自带 npm-shrinkwrap.json，npm ci
 * 将其视为自包含包，在其嵌套 node_modules 里安装全部平台变体
 * （@esbuild 26 平台、@mariozechner/clipboard-* 全平台），绕过顶层
 * lockfile 的 os/cpu 过滤。prunePayload 必须只保留目标平台的变体——
 * 这些测试用临时 fixture 目录驱动脚本（RUNNER_DEPS_DIR + --prune-only），
 * 不依赖真实 node_modules，也不执行 npm ci。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'prepare-runner-deps.mjs');

const tmpDirs: string[] = [];

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'runner-deps-'));
  tmpDirs.push(dir);
  return dir;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runPrune(depsDir: string, platform: string): RunResult {
  const result = spawnSync(process.execPath, [SCRIPT, '--prune-only', '--platform', platform], {
    encoding: 'utf-8',
    env: { ...process.env, RUNNER_DEPS_DIR: depsDir },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function writePkg(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }));
}

/**
 * 构造 shrinkwrap 嵌套安装形态的 fixture：
 * 顶层 node_modules（npm 已按本机过滤）+ pi-coding-agent 嵌套
 * node_modules（全平台变体，模拟 shrinkwrap 自包含安装的结果）。
 */
function makePlatformFixture(): string {
  const fixture = makeFixture();
  const nm = join(fixture, 'node_modules');

  writeFileSync(
    join(fixture, 'package.json'),
    JSON.stringify({
      name: 'socverify-runner-deps',
      private: true,
      dependencies: { 'fake-dep': '1.0.0' },
    }),
  );
  writeFileSync(
    join(fixture, 'package-lock.json'),
    JSON.stringify({
      name: 'socverify-runner-deps',
      lockfileVersion: 3,
      requires: true,
      packages: { '': {}, 'node_modules/fake-dep': { version: '1.0.0' } },
    }),
  );

  writePkg(join(nm, 'fake-dep'), 'fake-dep');
  // 顶层：npm ci 已按本机平台过滤，只剩一个变体
  writePkg(join(nm, '@esbuild', 'win32-x64'), '@esbuild/win32-x64');
  writePkg(join(nm, '@esbuild', 'linux-arm64'), '@esbuild/linux-arm64');

  // 嵌套：pi-coding-agent 的 shrinkwrap 自包含安装（全平台）
  const nested = join(nm, '@earendil-works', 'pi-coding-agent', 'node_modules');
  writePkg(join(nested, '@esbuild', 'win32-x64'), '@esbuild/win32-x64');
  writePkg(join(nested, '@esbuild', 'win32-arm64'), '@esbuild/win32-arm64');
  writePkg(join(nested, '@esbuild', 'darwin-arm64'), '@esbuild/darwin-arm64');
  writePkg(join(nested, '@esbuild', 'linux-x64'), '@esbuild/linux-x64');
  writePkg(join(nested, '@esbuild', 'android-arm'), '@esbuild/android-arm');
  // 未识别的非平台子目录（保守保留的守护样本）
  writePkg(join(nested, '@esbuild', 'helper'), '@esbuild/helper');
  writePkg(join(nested, '@mariozechner', 'clipboard'), '@mariozechner/clipboard');
  writePkg(
    join(nested, '@mariozechner', 'clipboard-win32-x64-msvc'),
    '@mariozechner/clipboard-win32-x64-msvc',
  );
  writePkg(
    join(nested, '@mariozechner', 'clipboard-darwin-universal'),
    '@mariozechner/clipboard-darwin-universal',
  );
  writePkg(
    join(nested, '@mariozechner', 'clipboard-linux-x64-gnu'),
    '@mariozechner/clipboard-linux-x64-gnu',
  );
  writePkg(
    join(nested, '@mariozechner', 'clipboard-linux-x64-musl'),
    '@mariozechner/clipboard-linux-x64-musl',
  );
  return fixture;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

describe('prepare-runner-deps platform pruning', () => {
  it('keeps only the target platform variants at every nesting level', () => {
    const fixture = makePlatformFixture();
    const r = runPrune(fixture, 'win32-x64');

    expect(r.stderr, r.stderr).toBe('');
    expect(r.status).toBe(0);

    const nm = join(fixture, 'node_modules');
    const nested = join(nm, '@earendil-works', 'pi-coding-agent', 'node_modules');

    // 目标平台保留（顶层 + 嵌套）
    expect(existsSync(join(nm, '@esbuild', 'win32-x64'))).toBe(true);
    expect(existsSync(join(nested, '@esbuild', 'win32-x64'))).toBe(true);
    expect(existsSync(join(nested, '@mariozechner', 'clipboard-win32-x64-msvc'))).toBe(true);
    // clipboard JS wrapper 不是平台目录，不能误删
    expect(existsSync(join(nested, '@mariozechner', 'clipboard'))).toBe(true);
    // 未识别的非平台子目录保守保留
    expect(existsSync(join(nested, '@esbuild', 'helper'))).toBe(true);

    // 异平台裁掉
    expect(existsSync(join(nm, '@esbuild', 'linux-arm64'))).toBe(false);
    expect(existsSync(join(nested, '@esbuild', 'win32-arm64'))).toBe(false);
    expect(existsSync(join(nested, '@esbuild', 'darwin-arm64'))).toBe(false);
    expect(existsSync(join(nested, '@esbuild', 'linux-x64'))).toBe(false);
    expect(existsSync(join(nested, '@esbuild', 'android-arm'))).toBe(false);
    expect(existsSync(join(nested, '@mariozechner', 'clipboard-darwin-universal'))).toBe(false);
    expect(existsSync(join(nested, '@mariozechner', 'clipboard-linux-x64-gnu'))).toBe(false);
    expect(existsSync(join(nested, '@mariozechner', 'clipboard-linux-x64-musl'))).toBe(false);
  });

  it('keeps both gnu and musl variants when targeting linux', () => {
    const fixture = makePlatformFixture();
    const r = runPrune(fixture, 'linux-x64');

    expect(r.stderr, r.stderr).toBe('');
    expect(r.status).toBe(0);

    const nested = join(fixture, 'node_modules', '@earendil-works', 'pi-coding-agent', 'node_modules');
    expect(existsSync(join(nested, '@esbuild', 'linux-x64'))).toBe(true);
    expect(existsSync(join(nested, '@mariozechner', 'clipboard-linux-x64-gnu'))).toBe(true);
    expect(existsSync(join(nested, '@mariozechner', 'clipboard-linux-x64-musl'))).toBe(true);
    expect(existsSync(join(nested, '@mariozechner', 'clipboard-win32-x64-msvc'))).toBe(false);
  });

  it('keeps universal fat binaries when targeting their OS', () => {
    const fixture = makePlatformFixture();
    const r = runPrune(fixture, 'darwin-arm64');

    expect(r.stderr, r.stderr).toBe('');
    expect(r.status).toBe(0);

    const nested = join(fixture, 'node_modules', '@earendil-works', 'pi-coding-agent', 'node_modules');
    expect(existsSync(join(nested, '@esbuild', 'darwin-arm64'))).toBe(true);
    expect(existsSync(join(nested, '@mariozechner', 'clipboard-darwin-universal'))).toBe(true);
    expect(existsSync(join(nested, '@mariozechner', 'clipboard-win32-x64-msvc'))).toBe(false);
  });

  it('still prunes maps and non-license markdown, and stays idempotent', () => {
    const fixture = makePlatformFixture();
    const nm = join(fixture, 'node_modules');
    mkdirSync(join(nm, 'fake-dep'), { recursive: true });
    writeFileSync(join(nm, 'fake-dep', 'index.js.map'), '{}');
    writeFileSync(join(nm, 'fake-dep', 'README.md'), 'docs');
    writeFileSync(join(nm, 'fake-dep', 'LICENSE'), 'MIT');

    const first = runPrune(fixture, 'win32-x64');
    expect(first.status).toBe(0);
    expect(existsSync(join(nm, 'fake-dep', 'index.js.map'))).toBe(false);
    expect(existsSync(join(nm, 'fake-dep', 'README.md'))).toBe(false);
    expect(existsSync(join(nm, 'fake-dep', 'LICENSE'))).toBe(true);

    // 幂等：第二次运行不再删除任何内容且依然成功
    const second = runPrune(fixture, 'win32-x64');
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/0 paths, 0\.0 MB removed/);
  });
});
