/**
 * issue 10 验收项 3/4：发布门禁脚本 engine-payload-gate.mjs。
 *
 * 门禁职责（对 dist/ 或任一载荷目录运行）：
 *   1. 统计 AI 引擎载荷构成（runner-pi 脚本 + node_modules）
 *   2. 扫描禁含产物：socverify-runner*、pi_natives*、bun/bunx 可执行、
 *      oh-my-pi 残留 —— 这些是 omp 时代载荷，绝不允许进入发布包（不可 ack）
 *   3. 载荷 > 30 MB（可调）时记录构成并要求显式确认
 *      （SOCVERIFY_ACK_ENGINE_PAYLOAD=1）才能放行
 *   4. 产出 dist/engine-payload-report.json（构成、原因、收益输入）
 *
 * 测试用临时 fixture 目录驱动脚本（spawnSync），不依赖真实 node_modules。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'engine-payload-gate.mjs');

const tmpDirs: string[] = [];

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'engine-gate-'));
  tmpDirs.push(dir);
  return dir;
}

interface GateResult {
  status: number;
  report: {
    passed: boolean;
    ack?: boolean;
    overLimit?: boolean;
    limitMb?: number;
    totals?: { bytes: number; files: number; mb?: number };
    forbidden?: Array<{ path: string; pattern: string }>;
    topLevel?: Array<{ name: string; bytes: number }>;
  } | null;
  stderr: string;
}

function runGate(payloadDir: string, outPath: string, opts: { limitMb?: number; ack?: boolean } = {}): GateResult {
  const args = ['--payload', payloadDir, '--out', outPath];
  if (opts.limitMb !== undefined) args.push('--limit-mb', String(opts.limitMb));
  const env = { ...process.env };
  delete env.SOCVERIFY_ACK_ENGINE_PAYLOAD;
  if (opts.ack) env.SOCVERIFY_ACK_ENGINE_PAYLOAD = '1';
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf-8' });
  const report = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf-8')) : null;
  return { status: result.status ?? -1, report, stderr: result.stderr ?? '' };
}

function writePayloadFile(root: string, rel: string, content: string | Buffer): void {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

describe('engine-payload-gate', () => {
  it('script exists', () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it('passes a clean small payload and writes a full report', () => {
    const fixture = makeFixture();
    writePayloadFile(fixture, 'index.ts', '// runner entry\n');
    writePayloadFile(fixture, 'node_modules/jiti/package.json', '{"name":"jiti"}');

    const out = join(fixture, 'report.json');
    const r = runGate(fixture, out, { limitMb: 30 });

    expect(r.stderr, r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.report?.passed).toBe(true);
    expect(r.report?.totals?.bytes).toBeGreaterThan(0);
    expect(r.report?.totals?.files).toBe(2);
    expect(r.report?.topLevel?.map((e) => e.name).sort()).toEqual(['index.ts', 'node_modules']);
    expect(r.report?.forbidden).toEqual([]);
  });

  it('fails over the size limit without ack, passes with ack recorded in the report', () => {
    const fixture = makeFixture();
    writePayloadFile(fixture, 'node_modules/big/index.js', 'x'.repeat(1024)); // 1 KB payload

    const out = join(fixture, 'report.json');

    // limit 0 MB → any non-empty payload exceeds it; no ack → exit 1
    const denied = runGate(fixture, out, { limitMb: 0 });
    expect(denied.status).toBe(1);
    expect(denied.report?.passed).toBe(false);
    expect(denied.report?.totals?.bytes).toBeGreaterThan(0);
    // 报告必须自带超限解释（构成/原因/收益的输入）
    expect(denied.report?.limitMb).toBe(0);

    // ack → released, report records both facts (final verdict = passed)
    const allowed = runGate(fixture, out, { limitMb: 0, ack: true });
    expect(allowed.status).toBe(0);
    expect(allowed.report?.passed).toBe(true);
    expect(allowed.report?.overLimit).toBe(true);
    expect(allowed.report?.ack).toBe(true);
  });

  it('never allows forbidden omp-era artifacts, even with ack', () => {
    const fixture = makeFixture();
    writePayloadFile(fixture, 'index.ts', '// ok\n');
    writePayloadFile(fixture, 'binaries/socverify-runner.exe', 'MZ stale binary');
    writePayloadFile(fixture, 'native/pi_natives.win32-x64-baseline.node', 'stale addon');

    const out = join(fixture, 'report.json');
    const r = runGate(fixture, out, { ack: true });

    expect(r.status).toBe(1);
    const paths = (r.report?.forbidden ?? []).map((f) => f.path);
    expect(paths).toContain(join('binaries', 'socverify-runner.exe'));
    expect(paths).toContain(join('native', 'pi_natives.win32-x64-baseline.node'));
  });

  it('flags bun and bunx executables and oh-my-pi leftovers', () => {
    const fixture = makeFixture();
    writePayloadFile(fixture, 'bun', '#!/usr/bin/env sh\n');
    writePayloadFile(fixture, 'bun.exe', 'MZ');
    writePayloadFile(fixture, 'oh-my-pi/README.md', 'stale');

    const out = join(fixture, 'report.json');
    const r = runGate(fixture, out);

    expect(r.status).toBe(1);
    const paths = (r.report?.forbidden ?? []).map((f) => f.path);
    expect(paths).toContain('bun');
    expect(paths).toContain(join('oh-my-pi', 'README.md'));
  });

  it('does not flag innocuous files that merely start with "bun" (e.g. bundle.js)', () => {
    const fixture = makeFixture();
    writePayloadFile(fixture, 'bundle.js', 'console.log(1)\n');

    const out = join(fixture, 'report.json');
    const r = runGate(fixture, out);

    expect(r.status).toBe(0);
    expect(r.report?.forbidden).toEqual([]);
  });

  it('accepts comma-separated payload roots and sums their composition', () => {
    const dirA = makeFixture();
    const dirB = makeFixture();
    writePayloadFile(dirA, 'index.ts', '// runner scripts\n');
    writePayloadFile(dirB, 'node_modules/jiti/package.json', '{"name":"jiti"}\n');

    const out = join(dirA, 'report.json');
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--payload', `${dirA},${dirB}`, '--out', out],
      { encoding: 'utf-8' },
    );
    const report = JSON.parse(readFileSync(out, 'utf-8'));

    expect(result.status).toBe(0);
    expect(report.passed).toBe(true);
    expect(report.totals.files).toBe(2);
    expect(report.payloadDirs).toHaveLength(2);
  });
});
