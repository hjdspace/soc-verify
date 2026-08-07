/**
 * Time Analyzer — simulation time and memory analysis logic.
 *
 * Ported from the Python `time_analyzer` plugin + `utils/log_analyze_utils.py`
 * + `utils/time_unit_converter.py`.
 *
 * Features: scan case directories, extract compile/sim time and memory
 * from log files (xrun / VCS format), unit conversion (minutes/hours/days),
 * CSV export, default directory resolution ($PROJ_WORK).
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// ── Types ──────────────────────────────────────────────────────────

export type TimeUnit = 'minutes' | 'hours' | 'days';

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

// ── Default directory resolution ───────────────────────────────────

/**
 * Get the default analysis directory.
 *
 * Priority: $PROJ_WORK environment variable → process.cwd().
 * Matches Python's `get_default_analysis_dir()`.
 */
export function getDefaultAnalysisDir(): string {
  const projWork = process.env.PROJ_WORK;
  if (projWork && existsSync(projWork)) {
    return projWork;
  }
  return process.cwd();
}

// ── Time unit conversion ───────────────────────────────────────────

/**
 * Conversion factors: how many minutes one unit represents.
 * (Python CONVERSION_FACTORS maps unit → minutes-per-unit.)
 */
const UNIT_TO_MINUTES: Record<TimeUnit, number> = {
  minutes: 1,
  hours: 60,
  days: 1440, // 24 * 60
};

/**
 * Precision (decimal places) per unit, matching Python's UNIT_PRECISION.
 */
const UNIT_PRECISION: Record<TimeUnit, number> = {
  minutes: 2,
  hours: 2,
  days: 3,
};

/** Display name for each unit (Chinese). */
const UNIT_DISPLAY_NAMES: Record<TimeUnit, string> = {
  minutes: '分钟',
  hours: '小时',
  days: '天',
};

/**
 * Convert a time value from minutes to the target unit.
 * Matches Python's `TimeUnitConverter.convert_time(value, MINUTES, target)`.
 */
export function convertTime(minutes: number, targetUnit: TimeUnit): number {
  if (minutes === 0) return 0;
  return minutes / UNIT_TO_MINUTES[targetUnit];
}

/** Get the display label for a time unit. */
export function getUnitLabel(unit: TimeUnit): string {
  return UNIT_DISPLAY_NAMES[unit];
}

/**
 * Format a time value (given in minutes) for display in the target unit.
 *
 * Matches Python's `TimeUnitConverter.format_time()`:
 * 1. Convert to target unit
 * 2. Format to unit-specific precision
 * 3. Strip trailing zeros (and trailing dot if any)
 */
export function formatTime(minutes: number, unit: TimeUnit): string {
  if (minutes === 0) return '0';

  const value = convertTime(minutes, unit);
  const precision = UNIT_PRECISION[unit];

  // Format to fixed precision, then strip trailing zeros
  let formatted = value.toFixed(precision);
  if (formatted.includes('.')) {
    formatted = formatted.replace(/0+$/, '').replace(/\.$/, '');
  }
  return formatted;
}

/** Get all supported time units in display order. */
export function getAllUnits(): TimeUnit[] {
  return ['minutes', 'hours', 'days'];
}

/**
 * Build a table header string like "编译时间(分钟)".
 * Matches Python's `TimeUnitConverter.get_table_header()`.
 */
export function getTableHeader(baseName: string, unit: TimeUnit): string {
  return `${baseName}(${UNIT_DISPLAY_NAMES[unit]})`;
}

// ── Log parsing ────────────────────────────────────────────────────

/**
 * Extract time from a log file.
 *
 * Ported from Python `utils/log_analyze_utils.get_time_from_log`.
 *
 * Strategy:
 * 1. Try xrun format: `xrun: Time - <seconds>s`
 * 2. Try VCS format (requires "Compilation Performance Summary" in content):
 *    - Sim log (is_sim_log=True): find "SimuLation Performance Summary"
 *      section, then `Elapsed Time : <sec> sec` (capital T)
 *    - Compile log (is_sim_log=False): `Elapsed time : <sec> sec` (lowercase t)
 *
 * Returns time in **minutes**, or null if not found.
 */
export async function getTimeFromLog(
  logPath: string,
  isSimLog = false,
): Promise<number | null> {
  if (!existsSync(logPath)) return null;

  try {
    const content = await readFile(logPath, 'utf-8');

    // 1. Try xrun format: xrun: Time - 123.45s
    const xrunMatch = content.match(/xrun: Time - (\d+\.?\d*)s/);
    if (xrunMatch) {
      const seconds = parseFloat(xrunMatch[1]);
      return Math.round((seconds / 60) * 100) / 100;
    }

    // 2. Try VCS format
    if (content.includes('Compilation Performance Summary')) {
      if (isSimLog) {
        // Sim log: locate the simulation section first
        if (content.includes('SimuLation Performance Summary')) {
          // Note: Python uses capital "L" in "SimuLation"
          const simPart = content.split('SimuLation Performance Summary').pop() ?? '';
          const simMatch = simPart.match(/Elapsed Time\s*:\s*(\d+)\s*sec/);
          if (simMatch) {
            const simTime = parseFloat(simMatch[1]);
            return Math.round((simTime / 60) * 100) / 100;
          }
        }
      } else {
        // Compile log: find first "Elapsed time"
        const compileMatch = content.match(/Elapsed time\s*:\s*(\d+)\s*sec/);
        if (compileMatch) {
          const compileTime = parseFloat(compileMatch[1]);
          return Math.round((compileTime / 60) * 100) / 100;
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
 *
 * Ported from Python `utils/log_analyze_utils.get_memory_from_log`.
 *
 * - Sim log (is_sim_log=True): `xmsim: Memory Usage - Final: XXX.XM`
 * - Compile log (is_sim_log=False): `xmelab: Memory Usage - Final: XXX.XM`
 *
 * Returns memory in **MB**, or null if not found.
 */
export async function getMemoryFromLog(
  logPath: string,
  isSimLog = false,
): Promise<number | null> {
  if (!existsSync(logPath)) return null;

  try {
    const content = await readFile(logPath, 'utf-8');

    if (isSimLog) {
      // Sim log: xmsim: Memory Usage - Final: XXX.XM
      const match = content.match(/xmsim: Memory Usage - Final:\s*(\d+\.?\d*)M/);
      if (match) {
        const memoryMb = parseFloat(match[1]);
        return Math.round(memoryMb * 10) / 10;
      }
    } else {
      // Compile log: xmelab: Memory Usage - Final: XXX.XM
      const match = content.match(/xmelab: Memory Usage - Final:\s*(\d+\.?\d*)M/);
      if (match) {
        const memoryMb = parseFloat(match[1]);
        return Math.round(memoryMb * 10) / 10;
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
 *
 * Ported from Python `AnalysisThread.run()`.
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

    // Skip if no time data found (both compile and sim returned null)
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

// ── CSV export ──────────────────────────────────────────────────────

/**
 * Export analysis results to CSV file.
 * Matches Python's `export_to_excel()` data layout (but in CSV format).
 */
export async function exportToCsv(
  data: AnalysisResult,
  savePath: string,
  unit: TimeUnit = 'minutes',
): Promise<void> {
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
