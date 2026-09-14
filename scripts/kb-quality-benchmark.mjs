#!/usr/bin/env node
/**
 * issue 29 — SoC 知识与检索证据质量门禁 runner。
 *
 * 门禁本体在 `tests/kb-quality-benchmark.test.ts`（需要 vitest 的 TS 转换），
 * 本脚本只负责：挑对池、跑门禁、把报告位置与关键数值打出来。
 *
 *   npm run bench:kb-quality
 *   npm run bench:kb-quality -- --keep-going      # 断言失败也打印报告摘要
 *
 * 报告目录：`.scratch/llm-wiki/spikes/29-quality/{report.json,report.md}`
 * （可用 KB_QUALITY_REPORT_DIR 覆盖；.scratch 已被 gitignore，属本地证据）。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportDir = process.env.KB_QUALITY_REPORT_DIR
  ?? join(repoRoot, '.scratch', 'llm-wiki', 'spikes', '29-quality');
const reportJson = join(reportDir, 'report.json');

const args = process.argv.slice(2);
const keepGoing = args.includes('--keep-going');

// 本环境 vitest 的 forks 池不稳定（上游 #10812），统一用 vmThreads。
const vitestArgs = [
  join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'),
  'run',
  'tests/kb-quality-benchmark.test.ts',
  '--pool=vmThreads',
  '--reporter=default',
];

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

console.log('[kb-quality] 运行门禁：tests/kb-quality-benchmark.test.ts');
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
    console.log(`[kb-quality] 未找到报告 ${reportJson}`);
    return;
  }
  /** @type {{threshold:number,modes:Record<string,{recallAt10:number,recallAt20:number,mrr:number,top1Accuracy:number|null,evidenceMixAt10:{wiki:number,parsed:number}}>,gates:Record<string,{met:boolean}>,fidelity:{facts:number,errors:unknown[],citations:unknown[],mutations:Array<{undetected:string[]}>},findings:Array<{severity:string,id:string,ticket:string}>}} */
  const report = JSON.parse(readFileSync(reportJson, 'utf-8'));

  console.log('');
  console.log(`[kb-quality] 报告：${reportJson}`);
  console.log(`[kb-quality] 门禁阈值 Recall@10 ≥ ${report.threshold}`);
  for (const id of ['keyword', 'keyword-degraded', 'hybrid']) {
    const m = report.modes[id];
    if (!m) continue;
    const met = m.recallAt10 >= report.threshold ? 'OK  ' : 'MISS';
    console.log(
      `[kb-quality]  ${met} ${id.padEnd(17)} Recall@10=${m.recallAt10.toFixed(3)}`
      + ` Recall@20=${m.recallAt20.toFixed(3)} MRR=${m.mrr.toFixed(3)}`
      + ` top1=${m.top1Accuracy === null ? 'n/a' : m.top1Accuracy.toFixed(2)}`
      + ` 证据构成=wiki:${m.evidenceMixAt10.wiki}/parsed:${m.evidenceMixAt10.parsed}`,
    );
  }
  const undetected = report.fidelity.mutations.filter((m) => m.undetected.length > 0).length;
  console.log(
    `[kb-quality]  保真：事实 ${report.fidelity.facts}，错误 ${report.fidelity.errors.length}，`
    + `引用不可解析 ${report.fidelity.citations.length}，`
    + `注入错误未检出 ${undetected}/${report.fidelity.mutations.length}`,
  );
  if (report.findings.length > 0) {
    console.log('[kb-quality]  失败定位：');
    for (const f of report.findings) {
      console.log(`[kb-quality]   [${f.severity}] ${f.id} → issue ${f.ticket}`);
    }
  }
}
