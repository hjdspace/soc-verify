/**
 * issue 10 — AI 引擎载荷发布门禁。
 *
 * 用法：
 *   node scripts/engine-payload-gate.mjs --payload <dir> --out <report.json> [--limit-mb 30]
 *
 * 行为：
 *   1. 递归统计 --payload 的载荷构成（字节、文件数、顶层条目分布）
 *   2. 扫描禁含产物（omp 时代遗留，绝不允许进发布包，**不可 ack 豁免**）：
 *        socverify-runner*  — 旧 Bun 单文件 runner
 *        pi_natives*        — 旧 native addon
 *        bun / bunx 可执行  — Bun 运行时（basename 精确匹配，不误伤 bundle.js）
 *        oh-my-pi           — omp submodule 残留
 *   3. 载荷超过 --limit-mb（默认 30）时：报告记录构成与 limit，需
 *      SOCVERIFY_ACK_ENGINE_PAYLOAD=1 显式放行（记录 ack: true）
 *   4. 报告 JSON 写入 --out（dist/engine-payload-report.json），作为
 *      载荷构成 / 原因 / 收益分析的输入
 *
 * 退出码：0 = 通过（或超限已 ack）；1 = 禁含产物 / 超限未 ack / 参数错误。
 */

import { readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';

// ─── Args ────────────────────────────────────────────────────────────

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const payloadArg = argValue('--payload');
const outPath = argValue('--out');
const limitMb = argValue('--limit-mb') !== undefined ? Number(argValue('--limit-mb')) : 30;

// --payload 接受逗号分隔的多个目录（如 runner 脚本与独立安装的依赖树），
// 累加统计为一个引擎载荷。
const payloadDirs = payloadArg ? payloadArg.split(',').map((d) => d.trim()).filter(Boolean) : [];

if (payloadDirs.length === 0 || !outPath || !Number.isFinite(limitMb) || limitMb < 0) {
  console.error('[engine-gate] usage: engine-payload-gate.mjs --payload <dir[,dir2...]> --out <report.json> [--limit-mb 30]');
  process.exit(1);
}

const ack = process.env.SOCVERIFY_ACK_ENGINE_PAYLOAD === '1';

// ─── Forbidden artifacts (omp-era payload) ───────────────────────────

// Basename 精确匹配的 Bun 运行时名（不用 bun* 前缀 glob——会误伤 bundle.js）
const BUN_BASENAMES = new Set(['bun', 'bun.exe', 'bunx', 'bunx.exe']);
// scope: 'basename' → 仅匹配文件名（Bun 运行时是单文件可执行；
// pi SDK 自带的 dist/bun/ 目录与 hono 的 bun adapter 是上游正常代码，不能误伤）
// scope: 'segments' → 匹配路径每一段（目录型残留，如 oh-my-pi/）
const FORBIDDEN_PATTERNS = [
  { pattern: 'socverify-runner*', scope: 'basename', match: (base) => base.startsWith('socverify-runner') },
  { pattern: 'pi_natives*', scope: 'basename', match: (base) => base.startsWith('pi_natives') },
  { pattern: 'bun|bunx', scope: 'basename', match: (base) => BUN_BASENAMES.has(base) },
  { pattern: 'oh-my-pi*', scope: 'segments', match: (base) => base.startsWith('oh-my-pi') },
];

// ─── Walk ────────────────────────────────────────────────────────────

function walk(dir, onFile) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir — skipped (permissions are not a gate failure)
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, onFile);
    } else if (entry.isFile()) {
      onFile(full, entry.name);
    }
  }
}

const totals = { bytes: 0, files: 0 };
const topLevel = new Map();
const forbidden = [];

try {
  for (const root of payloadDirs) {
    walk(root, (full, base) => {
      let size = 0;
      try {
        size = statSync(full).size;
      } catch {
        size = 0;
      }
      totals.bytes += size;
      totals.files += 1;

      const rel = relative(root, full);
      // 顶层条目带 root 短标签，多目录时不会互相覆盖
      const rootLabel = payloadDirs.length > 1 ? `[${relative(process.cwd(), root) || root}] ` : '';
      const top = `${rootLabel}${rel.split(/[\\/]/)[0]}`;
      topLevel.set(top, (topLevel.get(top) ?? 0) + size);

      for (const { pattern, scope, match } of FORBIDDEN_PATTERNS) {
        if (scope === 'basename') {
          // 文件型残留：仅 basename（避免误伤上游 SDK 的同名目录，如 dist/bun/）
          if (match(base)) {
            forbidden.push({ path: rel, pattern });
            break;
          }
        } else {
          // 目录型残留（oh-my-pi/）需检查路径每一段
          const segments = rel.split(/[\\/]/);
          if (segments.some((seg) => match(seg))) {
            forbidden.push({ path: rel, pattern });
            break;
          }
        }
      }
    });
  }
} catch (err) {
  console.error(`[engine-gate] failed to walk payload: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// ─── Verdict ─────────────────────────────────────────────────────────

const limitBytes = limitMb * 1024 * 1024;
const overLimit = totals.bytes > limitBytes;
const hasForbidden = forbidden.length > 0;

const passed = !hasForbidden && (!overLimit || ack);

const report = {
  generatedAt: new Date().toISOString(),
  payloadDirs,
  limitMb,
  totals: {
    bytes: totals.bytes,
    files: totals.files,
    mb: Math.round((totals.bytes / (1024 * 1024)) * 10) / 10,
  },
  topLevel: [...topLevel.entries()]
    .map(([name, bytes]) => ({ name, bytes, mb: Math.round((bytes / (1024 * 1024)) * 10) / 10 }))
    .sort((a, b) => b.bytes - a.bytes),
  forbidden,
  overLimit,
  ack,
  passed,
};

try {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
} catch (err) {
  console.error(`[engine-gate] failed to write report: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// ─── Log + exit ──────────────────────────────────────────────────────

console.log(
  `[engine-gate] payload: ${report.totals.mb} MB / ${totals.files} files (limit ${limitMb} MB) — ${passed ? 'PASS' : 'FAIL'}`,
);
for (const entry of report.topLevel.slice(0, 10)) {
  console.log(`[engine-gate]   ${entry.name}: ${entry.mb} MB`);
}

if (hasForbidden) {
  console.error('[engine-gate] forbidden omp-era artifacts found in payload (not ack-able):');
  for (const f of forbidden) {
    console.error(`[engine-gate]   ${f.path} (matched ${f.pattern})`);
  }
  process.exit(1);
}

if (overLimit) {
  if (ack) {
    console.warn(
      `[engine-gate] payload exceeds ${limitMb} MB — released with SOCVERIFY_ACK_ENGINE_PAYLOAD=1; ` +
        'see the report for composition. Re-evaluate the size rationale each release.',
    );
    process.exit(0);
  }
  console.error(
    `[engine-gate] payload exceeds ${limitMb} MB (target: < 30 MB). ` +
      'Record the composition, reason and benefit, then re-run with SOCVERIFY_ACK_ENGINE_PAYLOAD=1 to release.',
  );
  process.exit(1);
}

process.exit(0);
