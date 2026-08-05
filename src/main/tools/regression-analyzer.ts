/**
 * Regression Analyzer — parse regression result files and provide summary data.
 *
 * Ported from the Python `regression_result_analyzer` plugin.
 * Features: scan regression directories, parse .lst files, extract timestamps,
 * generate runsim commands, parse time from logs, aggregate case data, export Excel.
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';

// ── Types ──────────────────────────────────────────────────────────

export type CaseInfo = {
  status: string;       // ON/OFF
  block: string;        // block option
  case: string;         // case name
  seed: string;         // seed option, e.g. [123456]
  iterative: string;    // regression count
  tag: string;          // sim status, e.g. [PASS]
  log: string | null;   // log path
  compileTime: number | null;  // compile time in minutes
  simTime: number | null;      // sim time in minutes
  command: string;             // generated runsim command
  cfgDef: string;              // cfg_def option
  sdfCorner: string;           // sdf corner info
  isPostSim: boolean;          // is post-sim regression
};

export type RegressionData = Record<string, {
  pass: Record<string, CaseInfo[]>;
  fail: Record<string, CaseInfo[]>;
}>;

export type AggregatedCase = {
  caseName: string;
  corner: string;
  finalStatus: string;
  executionCount: number;
  simTimes: number[];
  latestCompileTime: number | null;
  seeds: string[];
  latestLog: string | null;
  latestCommand: string;
  latestTimestamp: string;
  hasFail: boolean;
  isPostSim: boolean;
};

export type ScanResult = {
  data: RegressionData;
  timestamps: string[];
  totalCount: number;
  passCount: number;
  failCount: number;
};

// ── Smart CSV line splitting ───────────────────────────────────────

/**
 * Split a CSV line, correctly handling commas inside brackets, parentheses, and quotes.
 */
export function smartSplitLine(line: string): string[] {
  const parts: string[] = [];
  let current = '';
  let bracketDepth = 0;
  let parenDepth = 0;
  let inQuotes = false;
  let quoteChar: string | null = null;

  for (const char of line) {
    if ((char === '"' || char === "'") && !inQuotes) {
      inQuotes = true;
      quoteChar = char;
      current += char;
    } else if (char === quoteChar && inQuotes) {
      inQuotes = false;
      quoteChar = null;
      current += char;
    } else if (inQuotes) {
      current += char;
    } else if (char === '[') {
      bracketDepth++;
      current += char;
    } else if (char === ']') {
      bracketDepth--;
      current += char;
    } else if (char === '(') {
      parenDepth++;
      current += char;
    } else if (char === ')') {
      parenDepth--;
      current += char;
    } else if (char === ',' && bracketDepth === 0 && parenDepth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  if (current) parts.push(current.trim());
  return parts;
}

// ── Timestamp extraction ──────────────────────────────────────────

/** Extract timestamp from filename like `regr_pass_list_regr_20231215_143000.lst` */
export function extractTimestamp(filePath: string): string | null {
  const match = basename(filePath).match(/regr_(?:pass|fail)_list_regr_(\d{8}_\d{6})\.lst/);
  return match ? match[1] : null;
}

// ── Command generation ─────────────────────────────────────────────

/** Generate a runsim command from parsed case parts. */
export function generateCommand(parts: string[]): string {
  if (parts.length < 10) return '无法生成命令：数据不完整';

  const block = parts[1]?.trim() ?? '';
  const caseName = parts[2]?.trim() ?? '';
  const seed = parts[3]?.trim() ?? '';
  const config = parts[7]?.trim() ?? '';
  const cfgDef = parts[8]?.trim() ?? '';
  const base = parts[9]?.trim() ?? '';
  const plusarg = parts[10]?.trim() ?? '';
  const sdfCorner = parts[11]?.trim() ?? '';

  const cmd: string[] = ['runsim'];

  if (base) cmd.push(`-base ${base}`);
  if (block) cmd.push(`-block ${block}`);
  if (caseName) cmd.push(`-case ${caseName}`);

  // Add seed (strip brackets)
  if (seed && seed.includes('[') && seed.includes(']')) {
    const seedValue = seed.replace(/[\][]/g, '');
    cmd.push(`-seed ${seedValue}`);
  }

  // Add -fsdb for regression (re-sim FAIL cases need waveform)
  cmd.push('-fsdb');

  if (config && config.toLowerCase() !== 'default') {
    cmd.push(`-config ${config}`);
  }

  if (cfgDef) {
    const cfgDefValue = cfgDef.replace(/[\][]/g, '');
    if (cfgDefValue.toLowerCase() !== 'default') {
      cmd.push(`-cfg_def ${cfgDefValue}`);
    }
  }

  if (plusarg && plusarg.includes('(') && plusarg.includes(')')) {
    const plusargValue = plusarg.replace(/[()]/g, '');
    if (plusargValue) {
      for (const arg of plusargValue.split(',')) {
        if (arg.includes('=')) {
          const [key, value] = arg.split('=', 2);
          const cleanValue = value.replace(/[\][]/g, '');
          cmd.push(`-simarg +${key}=${cleanValue}`);
        } else {
          cmd.push(`-simarg +${arg}`);
        }
      }
    }
  }

  if (sdfCorner) {
    cmd.push(`-post sdf=${sdfCorner}`);
  }

  return cmd.join(' ');
}

// ── File parsing ───────────────────────────────────────────────────

/** Parse a single regression result file (.lst format). */
export function parseRegressionFile(
  content: string,
  _filePath: string,
  _resultType: 'pass' | 'fail',
): Record<string, CaseInfo[]> {
  const groups: Record<string, CaseInfo[]> = {};
  let currentGroup: string | null = null;
  let currentLog: string | null = null;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    // Skip empty lines and plain comments (but keep //group: and //log:)
    if (!trimmed || (trimmed.startsWith('//') && !trimmed.startsWith('//group:') && !trimmed.startsWith('//log:'))) {
      continue;
    }

    if (trimmed.startsWith('//group:')) {
      currentGroup = trimmed.replace('//group:', '').trim();
      if (currentGroup && !(currentGroup in groups)) {
        groups[currentGroup] = [];
      }
    } else if (trimmed.startsWith('//log:')) {
      currentLog = trimmed.replace('//log:', '').trim();
    } else if (currentGroup && trimmed.includes(',')) {
      const parts = smartSplitLine(trimmed);
      if (parts.length < 6) continue;

      const cfgDef = parts[8]?.trim() ?? '';
      const sdfCorner = parts[11]?.trim() ?? '';
      const isPostSim = cfgDef.toUpperCase().includes('POST_SIM') || (!!sdfCorner && sdfCorner.trim() !== '');

      const caseInfo: CaseInfo = {
        status: parts[0],
        block: parts[1],
        case: parts[2],
        seed: parts[3],
        iterative: parts[4],
        tag: parts[5],
        log: currentLog,
        compileTime: null,
        simTime: null,
        command: generateCommand(parts),
        cfgDef,
        sdfCorner,
        isPostSim,
      };

      groups[currentGroup].push(caseInfo);
    }
  }

  return groups;
}

// ── Directory scanning ─────────────────────────────────────────────

/** Scan a regression directory for pass/fail .lst files and parse them. */
export async function scanRegressionDir(regressionDir: string): Promise<ScanResult> {
  if (!existsSync(regressionDir)) {
    throw new Error(`回归目录不存在: ${regressionDir}`);
  }

  // Find all pass/fail list files
  const allFiles = await readdir(regressionDir);
  const passFiles = allFiles
    .filter((f) => f.match(/^regr_pass_list_regr_\d{8}_\d{6}\.lst$/))
    .map((f) => join(regressionDir, f));
  const failFiles = allFiles
    .filter((f) => f.match(/^regr_fail_list_regr_\d{8}_\d{6}\.lst$/))
    .map((f) => join(regressionDir, f));

  // Sort by modification time (newest first)
  const sortByMtime = (files: string[]) => {
    const withMtime = files.map((f) => ({ path: f, mtime: statSync(f).mtimeMs }));
    return withMtime.sort((a, b) => b.mtime - a.mtime).map((x) => x.path);
  };

  const sortedPass = sortByMtime(passFiles);
  const sortedFail = sortByMtime(failFiles);

  // Build file map by timestamp
  const fileMap: Record<string, [string | null, string | null]> = {};

  for (const f of sortedPass) {
    const ts = extractTimestamp(f);
    if (ts && !(ts in fileMap)) fileMap[ts] = [null, null];
    if (ts) fileMap[ts][0] = f;
  }

  for (const f of sortedFail) {
    const ts = extractTimestamp(f);
    if (ts && !(ts in fileMap)) fileMap[ts] = [null, null];
    if (ts) fileMap[ts][1] = f;
  }

  // Parse all files
  const data: RegressionData = {};
  const sortedTimestamps = Object.keys(fileMap).sort().reverse();

  for (const ts of sortedTimestamps) {
    const [passFile, failFile] = fileMap[ts];
    data[ts] = { pass: {}, fail: {} };

    if (passFile) {
      const content = await readFile(passFile, 'utf-8');
      data[ts].pass = parseRegressionFile(content, passFile, 'pass');
    }

    if (failFile) {
      const content = await readFile(failFile, 'utf-8');
      data[ts].fail = parseRegressionFile(content, failFile, 'fail');
    }
  }

  // Calculate counts
  let passCount = 0;
  let failCount = 0;
  for (const ts of sortedTimestamps) {
    for (const cases of Object.values(data[ts].pass)) passCount += cases.length;
    for (const cases of Object.values(data[ts].fail)) failCount += cases.length;
  }

  return {
    data,
    timestamps: sortedTimestamps,
    totalCount: passCount + failCount,
    passCount,
    failCount,
  };
}

// ── Time parsing from logs ─────────────────────────────────────────

/** Parse time (in minutes) from a log file's last 60 lines. */
export async function parseTimeFromLog(logPath: string, isSimLog = false): Promise<number | null> {
  if (!logPath || !existsSync(logPath)) return null;

  try {
    const content = await readFile(logPath, 'utf-8');
    const lastLines = content.split('\n').slice(-60).join('\n');

    // xrun format
    const xunMatch = lastLines.match(/xrun:\s*Time\s*-\s*(\d+\.?\d*)s/);
    if (xunMatch) {
      return Math.round((parseFloat(xunMatch[1]) / 60) * 100) / 100;
    }

    // VCS format
    if (lastLines.includes('Compilation Performance Summary')) {
      if (isSimLog) {
        if (lastLines.includes('SimuLation Performance Summary')) {
          const simPart = lastLines.split('SimuLation Performance Summary').pop() ?? '';
          const simMatch = simPart.match(/Elapsed Time\s*:\s*(\d+)\s*sec/);
          if (simMatch) return Math.round((parseInt(simMatch[1]) / 60) * 100) / 100;
        }
      } else {
        const compileMatch = lastLines.match(/Elapsed time\s*:\s*(\d+)\s*sec/);
        if (compileMatch) return Math.round((parseInt(compileMatch[1]) / 60) * 100) / 100;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/** Parse sim and compile times for all cases in the scan result. */
export async function parseAllTimes(data: RegressionData): Promise<RegressionData> {
  const logTimeCache: Record<string, number | null> = {};

  for (const ts of Object.keys(data)) {
    for (const resultType of ['pass', 'fail'] as const) {
      for (const [_group, cases] of Object.entries(data[ts][resultType])) {
        for (let i = 0; i < cases.length; i++) {
          const caseInfo = cases[i];
          const tag = caseInfo.tag.replace(/[\][]/g, '');

          if (!['PASS', 'RSF', 'RSP'].includes(tag)) continue;
          if (!caseInfo.log || !existsSync(caseInfo.log)) continue;

          // Parse sim time (with cache)
          const simLogKey = `${caseInfo.log}_sim`;
          if (!(simLogKey in logTimeCache)) {
            logTimeCache[simLogKey] = await parseTimeFromLog(caseInfo.log, true);
          }
          caseInfo.simTime = logTimeCache[simLogKey];

          // Parse compile time
          const compileLogPath = join(dirname(caseInfo.log), 'irun_compile.log');
          if (existsSync(compileLogPath)) {
            if (!(compileLogPath in logTimeCache)) {
              logTimeCache[compileLogPath] = await parseTimeFromLog(compileLogPath, false);
            }
            caseInfo.compileTime = logTimeCache[compileLogPath];
          }
        }
      }
    }
  }

  return data;
}

// ── Aggregation ────────────────────────────────────────────────────

/** Check if any case in the given timestamps is a post-sim regression. */
function isPostSimRegression(data: RegressionData, timestamps: string[]): boolean {
  for (const ts of timestamps) {
    if (!(ts in data)) continue;
    for (const resultType of ['pass', 'fail'] as const) {
      for (const cases of Object.values(data[ts][resultType])) {
        for (const c of cases) {
          if (c.isPostSim) return true;
        }
      }
    }
  }
  return false;
}

/** Aggregate case data across timestamps, handling repeated executions. */
export function aggregateCaseData(
  data: RegressionData,
  specificTimestamp?: string,
): Record<string, AggregatedCase> {
  const aggregated: Record<string, AggregatedCase> = {};

  const timestampsToProcess = specificTimestamp
    ? (specificTimestamp in data ? [specificTimestamp] : [])
    : Object.keys(data).sort().reverse();

  const isPostSim = isPostSimRegression(data, timestampsToProcess);

  for (const ts of timestampsToProcess) {
    if (!(ts in data)) continue;
    const tsData = data[ts];

    for (const resultType of ['pass', 'fail'] as const) {
      for (const [_group, cases] of Object.entries(tsData[resultType])) {
        for (const caseInfo of cases) {
          const corner = caseInfo.sdfCorner.trim();
          const uniqueKey = isPostSim && corner ? `${caseInfo.case}_${corner}` : caseInfo.case;

          if (!(uniqueKey in aggregated)) {
            aggregated[uniqueKey] = {
              caseName: caseInfo.case,
              corner: corner || '-',
              finalStatus: caseInfo.tag.replace(/[\][]/g, ''),
              executionCount: 1,
              simTimes: [],
              latestCompileTime: caseInfo.compileTime,
              seeds: [caseInfo.seed.replace(/[\][]/g, '')],
              latestLog: caseInfo.log,
              latestCommand: caseInfo.command,
              latestTimestamp: ts,
              hasFail: resultType === 'fail',
              isPostSim: caseInfo.isPostSim,
            };
            if (caseInfo.simTime !== null) {
              aggregated[uniqueKey].simTimes.push(caseInfo.simTime);
            }
          } else {
            const agg = aggregated[uniqueKey];
            agg.executionCount++;

            if (!specificTimestamp && ts >= agg.latestTimestamp) {
              agg.finalStatus = caseInfo.tag.replace(/[\][]/g, '');
              agg.hasFail = resultType === 'fail';
              agg.latestCompileTime = caseInfo.compileTime;
              agg.latestLog = caseInfo.log;
              agg.latestCommand = caseInfo.command;
              agg.latestTimestamp = ts;
            } else if (specificTimestamp && resultType === 'fail') {
              agg.finalStatus = caseInfo.tag.replace(/[\][]/g, '');
              agg.hasFail = true;
              agg.latestLog = caseInfo.log;
              agg.latestCommand = caseInfo.command;
            }

            if (caseInfo.simTime !== null) {
              agg.simTimes.push(caseInfo.simTime);
            }

            const seedValue = caseInfo.seed.replace(/[\][]/g, '');
            if (!agg.seeds.includes(seedValue)) {
              agg.seeds.push(seedValue);
            }
          }
        }
      }
    }
  }

  return aggregated;
}

// ── Excel export ───────────────────────────────────────────────────

/** Export regression data to an HTML file (simulates Excel export with a styled table). */
export async function exportReport(
  data: RegressionData,
  currentTimestamp: string | null,
  savePath: string,
): Promise<void> {
  const aggregated = aggregateCaseData(data, currentTimestamp ?? undefined);
  const sortedCases = Object.values(aggregated).sort((a, b) => a.caseName.localeCompare(b.caseName));

  const overviewRows = sortedCases.map((c) => `
    <tr>
      <td>${escapeHtml(c.caseName)}</td>
      <td style="background-color:${c.finalStatus === 'PASS' ? '#c8e6c9' : '#ffcdd2'}">${c.finalStatus}</td>
      <td style="text-align:center">${c.executionCount}</td>
      <td style="text-align:center">${escapeHtml(c.corner)}</td>
      <td style="text-align:right">${c.simTimes.length > 0 ? (c.isPostSim ? c.simTimes[c.simTimes.length - 1].toFixed(2) : (c.simTimes.reduce((a, b) => a + b, 0) / c.simTimes.length).toFixed(2)) : '-'}</td>
      <td style="text-align:right">${c.latestCompileTime !== null ? c.latestCompileTime.toFixed(2) : '-'}</td>
      <td>${escapeHtml(c.seeds.join(', '))}</td>
      <td>${escapeHtml(c.latestLog ?? '-')}</td>
      <td>${escapeHtml(c.latestCommand)}</td>
    </tr>`).join('\n');

  const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<title>回归测试报告 ${currentTimestamp ?? '全部'}</title>
<style>
body { font-family: 'Microsoft YaHei', sans-serif; margin: 20px; }
h1 { font-size: 18px; }
table { border-collapse: collapse; width: 100%; font-size: 12px; }
th, td { border: 1px solid #ddd; padding: 6px 8px; }
th { background-color: #f8f9fa; font-weight: bold; text-align: center; }
tr:nth-child(even) { background-color: #f9f9f9; }
</style>
</head>
<body>
<h1>回归测试报告 — ${currentTimestamp ?? '全部时间戳'}</h1>
<table>
<thead><tr>
<th>用例名</th><th>最终状态</th><th>执行次数</th><th>Corner</th>
<th>仿真时间(分钟)</th><th>最新编译时间(分钟)</th><th>所有种子</th><th>最新日志</th><th>最新命令</th>
</tr></thead>
<tbody>
${overviewRows}
</tbody>
</table>
</body>
</html>`;

  await writeFile(savePath, html, 'utf-8');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
