#!/usr/bin/env node
/**
 * issue 30 — 验收安装包完整旅程与固定规模性能（门禁 runner）。
 *
 * 门禁本体在 `tests/kb-package-gate.test.ts`（需要 vitest 的 TS 转换），
 * 取消响应测量在 `tests/kb-package-cancel.test.ts`（独立 mock 文件）。
 * 本脚本只负责：挑对池、按顺序跑两个门禁文件、把报告位置与判定打出来。
 *
 *   npm run gate:kb-package
 *   npm run gate:kb-package -- --keep-going    # 断言失败也打印报告摘要
 *
 * 前置：`npm run package:win` 按 HEAD 产出 dist/win-unpacked（本门禁只
 * 验收实际安装包，不验收 dev 产物；缺失会在报告中记 blocker）。
 *
 * 报告目录：`.scratch/llm-wiki/spikes/30-package/`（KB_PACKAGE_REPORT_DIR
 * 可覆盖；.scratch 已被 gitignore，属本地证据）。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportDir = process.env.KB_PACKAGE_REPORT_DIR
  ?? join(repoRoot, '.scratch', 'llm-wiki', 'spikes', '30-package');
const reportJson = join(reportDir, 'report.json');

const args = process.argv.slice(2);
const keepGoing = args.includes('--keep-going');

// 本环境 vitest 的 forks 池不稳定（上游 #10812），统一用 vmThreads。
const files = ['tests/kb-package-cancel.test.ts', 'tests/kb-package-gate.test.ts'];
const vitestArgs = [
  join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'),
  'run',
  ...files,
  '--pool=vmThreads',
  '--reporter=default',
];

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

console.log('[kb-package-gate] 运行门禁：');
for (const f of files) console.log(`[kb-package-gate]   ${f}`);
const code = await new Promise((resolveCode) => {
  const child = spawn(process.execPath, vitestArgs, { cwd: repoRoot, env, stdio: 'inherit' });
  child.on('close', (c) => resolveCode(c ?? 1));
});

printSummary();

if (code !== 0 && !keepGoing) {
  process.exit(code);
}
process.exit(0);

/** 打印报告摘要（报告由门禁写出；跑挂了也尽量给出行外证据） */
function printSummary() {
  if (!existsSync(reportJson)) {
    console.log(`[kb-package-gate] 未找到报告 ${reportJson}`);
    return;
  }
  const report = JSON.parse(readFileSyncSafe(reportJson));
  if (!report) return;

  console.log('');
  console.log(`[kb-package-gate] 报告：${reportJson}`);
  console.log(`[kb-package-gate] 被测安装包：${report.package ? report.package.exePath : '（未找到）'}`);
  console.log(`[kb-package-gate] 固定规模：${report.fixture ? `${report.fixture.pageCount} 页 / ${report.fixture.edgeCount} 边 / parsed ${Math.round(report.fixture.parsedBytes / 1024 / 1024)}MB` : '未生成'}`);
  for (const gate of report.gates ?? []) {
    console.log(`[kb-package-gate]  ${gate.met ? 'OK  ' : 'MISS'} ${gate.name}：${gate.actual}（${gate.threshold}）`);
  }
  const handover = report.ticketHandovers ?? [];
  const missing = handover.filter((t) => !t.hasHandover);
  console.log(`[kb-package-gate]  实施票交接记录：${handover.length - missing.length}/${handover.length}`);
  if (report.findings?.length) {
    console.log('[kb-package-gate]  失败定位：');
    for (const f of report.findings) {
      console.log(`[kb-package-gate]   [${f.severity}] ${f.id} → issue ${f.ticket}`);
    }
  }
}

function readFileSyncSafe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}
