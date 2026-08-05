/**
 * Time Analyzer — simulation time and memory analysis logic.
 *
 * Ported from the Python `time_analyzer` plugin.
 * Features: scan case directories, extract compile/sim time and memory
 * from log files, unit conversion, Excel export.
 */

import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// ── Types ──────────────────────────────────────────────────────────

export type TimeUnit = 'seconds' | 'minutes' | 'hours';

export type CaseTimeData = {
  case: string;
  compile: number; // in minutes
  sim: number; // in minutes
  total: number; // in minutes
  compileMemory: number; // in MB
  simMemory: number; // in MB
};

export type AnalysisResult = {
  cases: CaseTimeData[];
  totals: CaseTimeData;
};

// ── Time unit conversion ───────────────────────────────────────────

const UNIT_FACTORS: Record<TimeUnit, number> = {
  seconds: 60, // minutes → seconds: multiply by 60
  minutes: 1, // already in minutes
  hours: 1 / 60, // minutes → hours: divide by 60
};

export function convertTime(minutes: number, targetUnit: TimeUnit): number {
  return minutes * UNIT_FACTORS[targetUnit];
}

export function getUnitLabel(unit: TimeUnit): string {
  switch (unit) {
    case 'seconds': return '秒';
    case 'minutes': return '分钟';
    case 'hours': return '小时';
  }
}

export function formatTime(minutes: number, unit: TimeUnit): string {
  const value = convertTime(minutes, unit);
  if (value === 0) return '0';
  if (value < 0.01) return value.toFixed(4);
  if (value < 1) return value.toFixed(3);
  return value.toFixed(2);
}

// ── Log parsing ────────────────────────────────────────────────────

/**
 * Extract simulation time from a log file.
 * Looks for patterns like "CPU time: 123.45s" or "Total time: 5m30s".
 * Returns time in minutes.
 */
export async function getTimeFromLog(logPath: string, isSimLog = false): Promise<number | null> {
  if (!existsSync(logPath)) return null;

  try {
    const content = await readFile(logPath, 'utf-8');
    const lines = content.split('\n');

    // Common patterns for time extraction
    const patterns = [
      /CPU\s*time:\s*(\d+(?:\.\d+)?)\s*s/i,
      /Total\s*time:\s*(\d+(?:\.\d+)?)\s*s/i,
      /Elapsed\s*time:\s*(\d+(?:\.\d+)?)\s*s/i,
      /Simulation\s*time:\s*(\d+(?:\.\d+)?)\s*s/i,
      /real\s+(\d+)m(\d+(?:\.\d+)?)s/i, // Linux time format: real 5m30.123s
      / totalTime:\s*(\d+(?:\.\d+)?)\s*s/i,
    ];

    // Search from the end of the file (last 200 lines)
    const searchLines = lines.slice(-200);
    for (let i = searchLines.length - 1; i >= 0; i--) {
      const line = searchLines[i];
      for (const pattern of patterns) {
        const match = line.match(pattern);
        if (match) {
          if (pattern.source.includes('real')) {
            // Format: real 5m30.123s
            const minutes = parseInt(match[1], 10);
            const seconds = parseFloat(match[2]);
            return minutes + seconds / 60;
          }
          const seconds = parseFloat(match[1]);
          return seconds / 60;
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Extract memory usage from a log file.
 * Looks for patterns like "Memory: 1234 MB" or "Max memory: 2.5 GB".
 * Returns memory in MB.
 */
export async function getMemoryFromLog(logPath: string, _isSimLog = false): Promise<number | null> {
  if (!existsSync(logPath)) return null;

  try {
    const content = await readFile(logPath, 'utf-8');
    const lines = content.split('\n');

    const patterns = [
      /Max\s*memory:\s*(\d+(?:\.\d+)?)\s*(MB|GB)/i,
      /Memory\s*usage:\s*(\d+(?:\.\d+)?)\s*(MB|GB)/i,
      /Memory:\s*(\d+(?:\.\d+)?)\s*(MB|GB)/i,
      /Peak\s*memory:\s*(\d+(?:\.\d+)?)\s*(MB|GB)/i,
    ];

    const searchLines = lines.slice(-200);
    for (let i = searchLines.length - 1; i >= 0; i--) {
      const line = searchLines[i];
      for (const pattern of patterns) {
        const match = line.match(pattern);
        if (match) {
          const value = parseFloat(match[1]);
          const unit = match[2].toUpperCase();
          return unit === 'GB' ? value * 1024 : value;
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

// ── Directory analysis ─────────────────────────────────────────────

/**
 * Scan a directory for case subdirectories with log folders,
 * extract time and memory data from compile and sim logs.
 */
export async function analyzeDirectory(
  analysisDir: string,
  onProgress?: (message: string) => void,
): Promise<AnalysisResult> {
  if (!existsSync(analysisDir)) {
    throw new Error(`目录不存在: ${analysisDir}`);
  }

  onProgress?.('开始扫描目录...');

  const entries = await readdir(analysisDir, { withFileTypes: true });
  const caseDirs = entries.filter((e) => e.isDirectory());

  // Filter to directories that have a log subdirectory
  const validCases: string[] = [];
  for (const dir of caseDirs) {
    const logDir = join(analysisDir, dir.name, 'log');
    if (existsSync(logDir)) {
      validCases.push(dir.name);
    }
  }

  if (validCases.length === 0) {
    throw new Error('未找到任何包含日志的用例目录');
  }

  onProgress?.(`找到 ${validCases.length} 个用例目录，开始分析...`);

  const caseData: CaseTimeData[] = [];

  for (let i = 0; i < validCases.length; i++) {
    const caseName = validCases[i];
    onProgress?.(`正在分析 ${caseName} (${i + 1}/${validCases.length})`);

    const casePath = join(analysisDir, caseName);
    const logDir = join(casePath, 'log');

    // Find compile and sim logs
    const compileLog = join(logDir, 'irun_compile.log');
    const simLog = join(logDir, 'irun_sim.log');

    const compileTime = await getTimeFromLog(compileLog, false);
    const simTime = await getTimeFromLog(simLog, true);
    const compileMemory = await getMemoryFromLog(compileLog, false);
    const simMemory = await getMemoryFromLog(simLog, true);

    // Skip if no time data found
    if (compileTime === null && simTime === null) continue;

    const total = (compileTime ?? 0) + (simTime ?? 0);

    caseData.push({
      case: caseName,
      compile: compileTime ?? 0,
      sim: simTime ?? 0,
      total,
      compileMemory: compileMemory ?? 0,
      simMemory: simMemory ?? 0,
    });
  }

  if (caseData.length === 0) {
    throw new Error('未找到任何有效的时间数据');
  }

  // Sort by total time descending
  caseData.sort((a, b) => b.total - a.total);

  // Calculate totals
  const totals: CaseTimeData = {
    case: '总计',
    compile: caseData.reduce((sum, c) => sum + c.compile, 0),
    sim: caseData.reduce((sum, c) => sum + c.sim, 0),
    total: caseData.reduce((sum, c) => sum + c.total, 0),
    compileMemory: caseData.reduce((sum, c) => sum + c.compileMemory, 0),
    simMemory: caseData.reduce((sum, c) => sum + c.simMemory, 0),
  };

  onProgress?.('分析完成！');

  return { cases: caseData, totals };
}

// ── Excel export (CSV format for simplicity) ───────────────────────

/** Export analysis results to CSV file. */
export async function exportToCsv(data: AnalysisResult, savePath: string, unit: TimeUnit = 'minutes'): Promise<void> {
  const unitLabel = getUnitLabel(unit);
  const headers = [
    '用例名称',
    `编译时间(${unitLabel})`,
    `仿真时间(${unitLabel})`,
    `总时间(${unitLabel})`,
    '编译内存(MB)',
    '仿真内存(MB)',
  ];

  const rows = data.cases.map((c) => [
    c.case,
    convertTime(c.compile, unit).toFixed(2),
    convertTime(c.sim, unit).toFixed(2),
    convertTime(c.total, unit).toFixed(2),
    c.compileMemory.toFixed(2),
    c.simMemory.toFixed(2),
  ]);

  // Add totals row
  rows.push([
    '总计',
    convertTime(data.totals.compile, unit).toFixed(2),
    convertTime(data.totals.sim, unit).toFixed(2),
    convertTime(data.totals.total, unit).toFixed(2),
    data.totals.compileMemory.toFixed(2),
    data.totals.simMemory.toFixed(2),
  ]);

  const csv = [headers, ...rows]
    .map((row) => row.map((cell) => `"${cell}"`).join(','))
    .join('\n');

  // Add BOM for Excel UTF-8 compatibility
  await writeFile(savePath, '\uFEFF' + csv, 'utf-8');
}
