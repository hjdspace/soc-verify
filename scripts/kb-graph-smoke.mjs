/**
 * 图视图冒烟编排器（issue 26 / spec §11）。
 *
 * 步骤：构建 harness → 在真实 Electron 中依次跑三个场景 → 汇总报告。
 *
 *   node scripts/kb-graph-smoke.mjs [--scenario=webgl|no-webgl|large] [--keep]
 *
 * 报告写到 .scratch/llm-wiki/spikes/26-graph/smoke-report.json（本地证据，
 * 不入库）；任一检查失败以非 0 退出。
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const harnessDir = resolve(repositoryRoot, 'dist', 'kb-graph-smoke');
const reportDir = resolve(repositoryRoot, '.scratch', 'llm-wiki', 'spikes', '26-graph');
const reportPath = resolve(reportDir, 'smoke-report.json');

const scenarioArg = process.argv.find((value) => value.startsWith('--scenario='));
const scenarios = scenarioArg
  ? [scenarioArg.split('=')[1]]
  : ['webgl', 'no-webgl', 'large'];

function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      // options.env 是「完整」环境（不是补丁），否则删掉的 ELECTRON_RUN_AS_NODE
      // 会被 process.env 合并回来，Electron 就退化成 Node 并拒绝 --no-sandbox
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (options.echo) process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

async function buildHarness() {
  process.stdout.write('[kb-graph-smoke] 构建 harness…\n');
  const result = await run(process.execPath, [resolve(repositoryRoot, 'scripts', 'build-kb-graph-smoke.mjs')]);
  if (result.code !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error('harness 构建失败');
  }
  process.stdout.write(result.stdout.split('\n').filter(Boolean).slice(-1)[0] + '\n');
}

async function runScenario(scenario) {
  const env = { ...process.env };
  // ELECTRON_RUN_AS_NODE 会把 Electron 降级成纯 Node，GUI 场景必须清掉
  delete env.ELECTRON_RUN_AS_NODE;
  if (scenario === 'no-webgl') env.KB_GRAPH_SMOKE_NO_WEBGL = '1';

  const outFile = resolve(reportDir, `raw-${scenario}.json`);
  const result = await run(
    electronPath,
    [
      '--no-sandbox',
      resolve(repositoryRoot, 'scripts', 'kb-graph-smoke', 'main.cjs'),
      `--scenario=${scenario}`,
      `--harness=${harnessDir}`,
      `--out=${outFile}`,
    ],
    { env },
  );

  const marker = result.stdout.indexOf('SMOKE_RESULT=');
  if (marker === -1) {
    return {
      scenario,
      ok: false,
      checks: [],
      metrics: {},
      diagnostics: {
        failures: [`无法解析冒烟输出（exit=${result.code}）`, result.stdout.slice(-2000), result.stderr.slice(-2000)],
        console: [],
        requests: [],
      },
    };
  }
  const json = result.stdout.slice(marker + 'SMOKE_RESULT='.length).trim();
  try {
    return JSON.parse(json.split('\nSMOKE_RESULT=')[0]);
  } catch (error) {
    return {
      scenario,
      ok: false,
      checks: [],
      metrics: {},
      diagnostics: { failures: [`报告 JSON 解析失败：${String(error)}`, json.slice(0, 2000)], console: [], requests: [] },
    };
  }
}

async function main() {
  await buildHarness();

  const reports = [];
  for (const scenario of scenarios) {
    process.stdout.write(`\n[kb-graph-smoke] 场景 ${scenario}…\n`);
    const report = await runScenario(scenario);
    reports.push(report);
    for (const check of report.checks) {
      process.stdout.write(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.name}${describe(check.detail)}\n`);
    }
    if (report.metrics.firstFrameMs !== undefined) {
      process.stdout.write(`  指标 首个可交互画面 ${Math.round(report.metrics.firstFrameMs)}ms\n`);
    }
    if (report.diagnostics?.failures?.length) {
      for (const failure of report.diagnostics.failures) {
        process.stdout.write(`  诊断 ${String(failure).slice(0, 500)}\n`);
      }
    }
  }

  const ok = reports.every((report) => report.ok);
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(
    reportPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), electron: process.versions.electron ?? null, ok, reports }, null, 2),
    'utf8',
  );

  const total = reports.reduce((sum, report) => sum + report.checks.length, 0);
  const failed = reports.reduce((sum, report) => sum + report.checks.filter((c) => !c.ok).length, 0);
  process.stdout.write(`\n[kb-graph-smoke] ${ok ? 'PASS' : 'FAIL'}：${total - failed}/${total} 项检查通过\n`);
  process.stdout.write(`[kb-graph-smoke] 报告：${reportPath}\n`);
  process.exit(ok ? 0 : 1);
}

function describe(detail) {
  if (detail === undefined) return '';
  const text = JSON.stringify(detail);
  return text === undefined ? '' : `  ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`;
}

await main();
