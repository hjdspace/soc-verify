/**
 * LogAnalyzer — EDA 日志分析工具模块
 *
 * 从 Python `ai_core/utils/extract_compile_errors.py`、
 * `ai_core/utils/extract_sim_errors.py` 和
 * `utils/log_analyze_utils.py` 完全移植。
 *
 * 提供：
 * - 编译/仿真日志路径解析
 * - 仿真状态检查
 * - 编译错误提取（Xcelium / VCS 正则）
 * - 仿真错误提取（UVM / SPRD / VCS / Timing 正则）
 * - 错误上下文格式化（用于 AI Agent）
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type {
  ErrorType,
  ExtractedCompileError,
  ExtractedSimError,
  LogAnalysisResult,
} from '@shared/types';

// ─── 常量 ──────────────────────────────────────────────────

const DEFAULT_CONTEXT_LINES = 10;
const DEFAULT_MAX_ERRORS = 5;

// ─── 正则模式（从 Python 完全移植）──────────────────────────

// Xcelium 编译错误: xmelab: *E,FOO (file,line|col): message
const xceliumErrorPattern =
  /\w+:\s*\*([EF]),(\w+)\s*(?:\(([^,)]+?)(?:,(\d+)\|?\d*)?\))?\s*:\s*(.+)$/;

// VCS 编译错误: Error-[CODE] message
const vcsErrorPattern = /^Error-\[(.+?)\]\s*(.+)$/;

// UVM 仿真错误: UVM_ERROR/UVM_FATAL @ time: message (排除 summary 行)
const uvmPattern = /^(UVM_)(ERROR|FATAL)\s+@\s+(\d+ns):\s*(.+)$/i;

// SPRD 仿真错误: SPRD_ERROR/SPRD_FATAL @ time: [testcase] message (排除 summary 行)
const sprdPattern =
  /^(SPRD_)(ERROR|FATAL)\s+@\s+(\d+ns):\s*(\[[^\]]+\])?\s*(.+)$/i;

// VCS *E 仿真错误: *E, message[, location]
const vcsStarPattern = /^\*E,\s*(.+?)(?:,\s*\[?([^\]]+)\])?$/;

// ** Error 仿真错误: ** Error: [file:line] message
const doubleStarPattern =
  /^\*\*\s*Error:\s*\[?([^\]:]+):(\d+)\]?\s*(.+)$/;

// Error: "file" line N: message
const quoteErrorPattern = /^Error:\s*"([^"]+)"\s+line\s+(\d+):\s*(.+)$/;

// Timing path 仿真错误: [index] [CODE]-name : @ Time: time
const timingPathPattern =
  /^\[(\d+)\]\s*\[([A-Z]{2})\]-(\w+)\s*:\s*@\s*Time:\s*(\d+ns)/;

// ─── 日志路径解析（从 Python log_analyze_utils.py 移植）──────

/**
 * 获取仿真日志路径
 *
 * 尝试多种常见路径模式，返回第一个存在的文件路径。
 * 如果都不存在，返回默认路径。
 */
export function getSimulationLogPath(
  caseName: string,
  currentDir?: string,
): string {
  const dir = currentDir ?? process.cwd();
  const possiblePaths = [
    join(dir, caseName, 'log', 'irun_sim.log'),
    join(dir, 'log', 'irun_sim.log'),
    join(dir, caseName, 'log', 'simulation.log'),
    join(dir, caseName, 'log', 'vcs_sim.log'),
    join(dir, caseName, 'log', 'ncsim_sim.log'),
    join(dir, caseName, 'sim.log'),
  ];

  for (const p of possiblePaths) {
    if (existsSync(p)) return p;
  }
  return join(dir, caseName, 'log', 'irun_sim.log');
}

/**
 * 获取编译日志路径
 *
 * 尝试多种常见路径模式，返回第一个存在的文件路径。
 * 如果都不存在，返回默认路径。
 */
export function getCompileLogPath(
  caseName: string,
  currentDir?: string,
): string {
  const dir = currentDir ?? process.cwd();
  const possiblePaths = [
    join(dir, caseName, 'log', 'irun_compile.log'),
    join(dir, 'log', 'irun_compile.log'),
    join(dir, caseName, 'log', 'irun_comp.log'),
    join(dir, caseName, 'log', 'compile.log'),
    join(dir, caseName, 'log', 'vcs_comp.log'),
    join(dir, caseName, 'log', 'ncsim_comp.log'),
    join(dir, caseName, 'compile.log'),
  ];

  for (const p of possiblePaths) {
    if (existsSync(p)) return p;
  }
  return join(dir, caseName, 'log', 'irun_compile.log');
}

// ─── 仿真状态检查（从 Python log_analyze_utils.py 移植）──────

/**
 * 检查仿真状态
 *
 * 根据日志所在目录下是否存在 sprd_log_pass.log 或 sprd_log_fail.log
 * 判断仿真状态。
 */
export function checkSimulationStatus(logPath: string): 'PASS' | 'FAIL' | 'On-Going' {
  try {
    const logDir = dirname(logPath);
    const passLogPath = join(logDir, 'sprd_log_pass.log');
    const failLogPath = join(logDir, 'sprd_log_fail.log');

    if (existsSync(passLogPath)) return 'PASS';
    if (existsSync(failLogPath)) return 'FAIL';
    return 'On-Going';
  } catch {
    return 'On-Going';
  }
}

// ─── 编译错误提取器（从 Python extract_compile_errors.py 移植）──

/**
 * 从日志行列表中提取 Xcelium 编译错误
 */
function extractXceliumErrors(
  logLines: string[],
  contextLines: number,
  maxErrors: number,
): ExtractedCompileError[] {
  const errors: ExtractedCompileError[] = [];
  const endLine = logLines.length > 50 ? logLines.length - 50 : logLines.length;

  for (let i = 0; i < endLine && i < logLines.length; i++) {
    if (maxErrors > 0 && errors.length >= maxErrors) break;

    const match = logLines[i].match(xceliumErrorPattern);
    if (match) {
      const [, errorType, errorCode, filePath, lineNum, errorInfo] = match;
      const startIdx = Math.max(0, i - contextLines);
      const endIdx = Math.min(logLines.length, i + contextLines + 1);
      errors.push({
        tool: 'Xcelium',
        errorType: errorType ?? undefined,
        errorCode: errorCode ?? '',
        file: filePath ?? undefined,
        line: lineNum ?? undefined,
        errorInfo: errorInfo ?? '',
        lineNumber: i + 1,
        context: logLines.slice(startIdx, endIdx),
      });
    }
  }
  return errors;
}

/**
 * 从日志行列表中提取 VCS 编译错误
 */
function extractVcsErrors(
  logLines: string[],
  contextLines: number,
  maxErrors: number,
): ExtractedCompileError[] {
  const errors: ExtractedCompileError[] = [];
  const endLine = logLines.length > 50 ? logLines.length - 50 : logLines.length;

  for (let i = 0; i < endLine && i < logLines.length; i++) {
    if (maxErrors > 0 && errors.length >= maxErrors) break;

    const match = logLines[i].match(vcsErrorPattern);
    if (match) {
      const [, errorCode, errorInfo] = match;
      const startIdx = Math.max(0, i - contextLines);
      const endIdx = Math.min(logLines.length, i + contextLines + 1);
      errors.push({
        tool: 'VCS',
        errorCode: errorCode ?? '',
        errorInfo: errorInfo ?? '',
        lineNumber: i + 1,
        context: logLines.slice(startIdx, endIdx),
      });
    }
  }
  return errors;
}

/** 快速统计各类型错误总数（不提取上下文） */
function countCompileErrors(logLines: string[]): { xcelium: number; vcs: number } {
  const endLine = logLines.length > 50 ? logLines.length - 50 : logLines.length;
  let xceliumCount = 0;
  let vcsCount = 0;

  for (let i = 0; i < endLine && i < logLines.length; i++) {
    if (xceliumErrorPattern.test(logLines[i])) xceliumCount++;
    if (vcsErrorPattern.test(logLines[i])) vcsCount++;
  }
  return { xcelium: xceliumCount, vcs: vcsCount };
}

/**
 * 处理编译日志文件，提取错误
 */
export function processCompileLog(
  filePath: string,
  opts?: { contextLines?: number; maxErrors?: number },
): LogAnalysisResult {
  const contextLines = opts?.contextLines ?? DEFAULT_CONTEXT_LINES;
  const maxErrors = opts?.maxErrors ?? DEFAULT_MAX_ERRORS;

  try {
    const content = readFileSync(filePath, 'utf-8');
    const logLines = content.split('\n').map((l) => l.replace(/\r$/, ''));

    const errorCounts = countCompileErrors(logLines);

    const xceliumErrors = extractXceliumErrors(logLines, contextLines, maxErrors);
    const vcsErrors = extractVcsErrors(logLines, contextLines, maxErrors);

    let errors: ExtractedCompileError[];
    let toolType: string;
    let totalErrors: number;

    if (xceliumErrors.length >= vcsErrors.length) {
      errors = xceliumErrors;
      toolType = 'xcelium';
      totalErrors = errorCounts.xcelium;
    } else {
      errors = vcsErrors;
      toolType = 'vcs';
      totalErrors = errorCounts.vcs;
    }

    const criticalErrors = errors.filter((e) => e.errorType === 'F').length;
    const truncated = totalErrors > errors.length;

    return {
      filePath,
      toolType,
      totalLines: logLines.length,
      totalErrors,
      errors,
      truncated,
      criticalErrors,
    };
  } catch (err) {
    return {
      filePath,
      toolType: 'unknown',
      totalLines: 0,
      totalErrors: 0,
      errors: [],
      truncated: false,
    };
  }
}

// ─── 仿真错误提取器（从 Python extract_sim_errors.py 移植）────

/** 提取 UVM 仿真错误 */
function extractUvmErrors(
  logLines: string[],
  contextLines: number,
  maxErrors: number,
): ExtractedSimError[] {
  const errors: ExtractedSimError[] = [];
  let simPassLine = -1;

  for (let i = 0; i < logLines.length; i++) {
    if (/Simulation\s+Pass/i.test(logLines[i])) {
      simPassLine = i;
      break;
    }
  }

  for (let i = 0; i < logLines.length; i++) {
    if (maxErrors > 0 && errors.length >= maxErrors) break;
    if (simPassLine >= 0 && i > simPassLine) break;

    const match = logLines[i].match(uvmPattern);
    if (match) {
      // Skip summary lines like "UVM_ERROR reports: 0"
      if (/UVM_(ERROR|FATAL)\s*(reports)?\s*:\s*0/i.test(logLines[i])) continue;

      const [, , severity, timestamp, message] = match;
      const startIdx = Math.max(0, i - contextLines);
      const endIdx = Math.min(logLines.length, i + contextLines + 1);
      errors.push({
        tool: 'UVM',
        severity: severity?.toUpperCase(),
        timestamp,
        message,
        lineNumber: i + 1,
        context: logLines.slice(startIdx, endIdx),
      });
    }
  }
  return errors;
}

/** 提取 SPRD 仿真错误 */
function extractSprdErrors(
  logLines: string[],
  contextLines: number,
  maxErrors: number,
): ExtractedSimError[] {
  const errors: ExtractedSimError[] = [];
  let simPassedLine = -1;

  for (let i = 0; i < logLines.length; i++) {
    if (/Simulation\s+PASSED\s+on/i.test(logLines[i])) {
      simPassedLine = i;
      break;
    }
  }

  for (let i = 0; i < logLines.length; i++) {
    if (maxErrors > 0 && errors.length >= maxErrors) break;
    if (simPassedLine >= 0 && i > simPassedLine) break;

    const match = logLines[i].match(sprdPattern);
    if (match) {
      if (/SPRD_(ERROR|FATAL)\s*:\s*0/i.test(logLines[i])) continue;

      const [, , severity, timestamp, testCase, message] = match;
      const startIdx = Math.max(0, i - contextLines);
      const endIdx = Math.min(logLines.length, i + contextLines + 1);
      errors.push({
        tool: 'SPRD',
        severity: severity?.toUpperCase(),
        timestamp,
        testCase: testCase ?? undefined,
        message,
        lineNumber: i + 1,
        context: logLines.slice(startIdx, endIdx),
      });
    }
  }
  return errors;
}

/** 提取 VCS *E 仿真错误 */
function extractVcsStarErrors(
  logLines: string[],
  contextLines: number,
  maxErrors: number,
): ExtractedSimError[] {
  const errors: ExtractedSimError[] = [];

  for (let i = 0; i < logLines.length; i++) {
    if (maxErrors > 0 && errors.length >= maxErrors) break;

    const match = logLines[i].match(vcsStarPattern);
    if (match) {
      const [, message, location] = match;
      const startIdx = Math.max(0, i - contextLines);
      const endIdx = Math.min(logLines.length, i + contextLines + 1);
      errors.push({
        tool: 'VCS',
        errorType: '*E',
        message: message ?? '',
        location: location ?? undefined,
        lineNumber: i + 1,
        context: logLines.slice(startIdx, endIdx),
      });
    }
  }
  return errors;
}

/** 提取 ** Error 仿真错误 */
function extractDoubleStarErrors(
  logLines: string[],
  contextLines: number,
  maxErrors: number,
): ExtractedSimError[] {
  const errors: ExtractedSimError[] = [];

  for (let i = 0; i < logLines.length; i++) {
    if (maxErrors > 0 && errors.length >= maxErrors) break;

    const match = logLines[i].match(doubleStarPattern);
    if (match) {
      const [, file, line, message] = match;
      const startIdx = Math.max(0, i - contextLines);
      const endIdx = Math.min(logLines.length, i + contextLines + 1);
      errors.push({
        tool: 'VCS/NC',
        errorType: '** Error',
        file,
        line,
        message,
        lineNumber: i + 1,
        context: logLines.slice(startIdx, endIdx),
      });
    }
  }
  return errors;
}

/** 提取 quote error 仿真错误 */
function extractQuoteErrors(
  logLines: string[],
  contextLines: number,
  maxErrors: number,
): ExtractedSimError[] {
  const errors: ExtractedSimError[] = [];

  for (let i = 0; i < logLines.length; i++) {
    if (maxErrors > 0 && errors.length >= maxErrors) break;

    const match = logLines[i].match(quoteErrorPattern);
    if (match) {
      const [, file, line, message] = match;
      const startIdx = Math.max(0, i - contextLines);
      const endIdx = Math.min(logLines.length, i + contextLines + 1);
      errors.push({
        tool: 'VCS/NC',
        errorType: 'Error',
        file,
        line,
        message,
        lineNumber: i + 1,
        context: logLines.slice(startIdx, endIdx),
      });
    }
  }
  return errors;
}

/** 提取 timing path 仿真错误 */
function extractTimingPathErrors(
  logLines: string[],
  contextLines: number,
  maxErrors: number,
): ExtractedSimError[] {
  const errors: ExtractedSimError[] = [];

  for (let i = 0; i < logLines.length; i++) {
    if (maxErrors > 0 && errors.length >= maxErrors) break;

    const match = logLines[i].match(timingPathPattern);
    if (match) {
      const [, index, code, typeName, timestamp] = match;
      const endIdx = Math.min(logLines.length, i + 10);
      errors.push({
        tool: 'Timing',
        index,
        code,
        typeName,
        timestamp,
        message: `${code}-${typeName} @ Time: ${timestamp}`,
        lineNumber: i + 1,
        context: logLines.slice(i, endIdx),
      });
    }
  }
  return errors;
}

/** 快速统计仿真错误总数 */
function countSimErrors(logLines: string[]): number {
  let count = 0;
  for (const line of logLines) {
    if (uvmPattern.test(line)) count++;
    else if (sprdPattern.test(line)) count++;
    else if (vcsStarPattern.test(line)) count++;
    else if (doubleStarPattern.test(line)) count++;
    else if (quoteErrorPattern.test(line)) count++;
    else if (timingPathPattern.test(line)) count++;
  }
  return count;
}

/**
 * 处理仿真日志文件，提取错误
 */
export function processSimLog(
  filePath: string,
  opts?: { contextLines?: number; maxErrors?: number },
): LogAnalysisResult {
  const contextLines = opts?.contextLines ?? DEFAULT_CONTEXT_LINES;
  const maxErrors = opts?.maxErrors ?? DEFAULT_MAX_ERRORS;

  try {
    const content = readFileSync(filePath, 'utf-8');
    const logLines = content.split('\n').map((l) => l.replace(/\r$/, ''));

    const realTotal = countSimErrors(logLines);

    const allErrors: ExtractedSimError[] = [
      ...extractUvmErrors(logLines, contextLines, maxErrors),
      ...extractSprdErrors(logLines, contextLines, maxErrors),
      ...extractVcsStarErrors(logLines, contextLines, maxErrors),
      ...extractDoubleStarErrors(logLines, contextLines, maxErrors),
      ...extractQuoteErrors(logLines, contextLines, maxErrors),
      ...extractTimingPathErrors(logLines, contextLines, maxErrors),
    ];

    const errors =
      maxErrors > 0 ? allErrors.slice(0, maxErrors) : allErrors;

    const toolCounts: Record<string, number> = {};
    for (const e of allErrors) {
      const t = e.tool;
      toolCounts[t] = (toolCounts[t] ?? 0) + 1;
    }
    const toolType =
      Object.keys(toolCounts).length > 0
        ? Object.entries(toolCounts).sort(([, a], [, b]) => b - a)[0][0]
        : 'unknown';

    const fatalErrors = errors.filter((e) => e.severity === 'FATAL').length;
    const errorCount = errors.filter(
      (e) =>
        e.severity === 'ERROR' ||
        e.errorType === '*E' ||
        e.errorType === '** Error' ||
        e.errorType === 'Error',
    ).length;
    const truncated = realTotal > errors.length;

    return {
      filePath,
      toolType,
      totalLines: logLines.length,
      totalErrors: realTotal,
      errors,
      truncated,
      fatalErrors,
      errorCount,
    };
  } catch {
    return {
      filePath,
      toolType: 'unknown',
      totalLines: 0,
      totalErrors: 0,
      errors: [],
      truncated: false,
    };
  }
}

// ─── 错误类型判定 ─────────────────────────────────────────────

/**
 * 判定失败仿真的错误类型
 *
 * 逻辑：
 * 1. 如果编译日志不存在 → sim_error
 * 2. 如果编译日志存在且有编译错误 → compile_error
 * 3. 如果编译日志存在但无编译错误 → sim_error
 * 4. 如果编译失败导致仿真日志不存在 → compile_error
 *
 * @param caseName 用例名称
 * @param cwd 工作目录
 * @returns 'compile_error' | 'sim_error'
 */
export function determineErrorType(
  caseName: string,
  cwd?: string,
): ErrorType {
  const compileLogPath = getCompileLogPath(caseName, cwd);

  if (!existsSync(compileLogPath)) {
    return 'sim_error';
  }

  const result = processCompileLog(compileLogPath, {
    contextLines: 5,
    maxErrors: 5,
  });

  if (result.totalErrors > 0) {
    return 'compile_error';
  }

  return 'sim_error';
}

// ─── 错误上下文格式化（用于 AI Agent）────────────────────────

/**
 * 格式化编译错误分析结果为 AI 可读文本
 */
export function formatCompileErrorsForAI(result: LogAnalysisResult): string {
  const output: string[] = [];
  output.push('=== EDA 编译 LOG 预处理结果 ===');
  output.push(`文件: ${result.filePath}`);
  output.push(`工具类型: ${result.toolType}`);
  output.push(`总行数: ${result.totalLines}`);
  output.push(`错误总数: ${result.totalErrors}`);
  if (result.criticalErrors !== undefined) {
    output.push(`严重错误: ${result.criticalErrors}`);
  }
  if (result.truncated) {
    output.push(`（仅展示前 ${(result.errors as ExtractedCompileError[]).length} 个错误，共 ${result.totalErrors} 个）`);
  }
  output.push('');

  const errors = result.errors as ExtractedCompileError[];
  for (let i = 0; i < errors.length; i++) {
    const e = errors[i];
    output.push(`--- 错误 #${i + 1} ---`);
    if (e.errorType) output.push(`类型: ${e.errorType}`);
    output.push(`工具: ${e.tool}`);
    output.push(`错误代码: ${e.errorCode}`);
    if (e.file) output.push(`文件: ${e.file}`);
    if (e.line) output.push(`行号: ${e.line}`);
    output.push(`行号(日志): ${e.lineNumber}`);
    output.push(`错误信息: ${e.errorInfo}`);
    if (e.context.length > 0) {
      output.push('上下文:');
      for (const ctxLine of e.context) {
        output.push(`  ${ctxLine}`);
      }
    }
    output.push('');
  }
  return output.join('\n');
}

/**
 * 格式化仿真错误分析结果为 AI 可读文本
 */
export function formatSimErrorsForAI(result: LogAnalysisResult): string {
  const output: string[] = [];
  output.push('=== EDA 仿真 LOG 预处理结果 ===');
  output.push(`文件: ${result.filePath}`);
  output.push(`工具类型: ${result.toolType}`);
  output.push(`总行数: ${result.totalLines}`);
  output.push(`错误总数: ${result.totalErrors}`);
  if (result.fatalErrors !== undefined) {
    output.push(`严重错误(FATAL): ${result.fatalErrors}`);
  }
  if (result.errorCount !== undefined) {
    output.push(`普通错误: ${result.errorCount}`);
  }
  if (result.truncated) {
    output.push(`（仅展示前 ${(result.errors as ExtractedSimError[]).length} 个错误，共 ${result.totalErrors} 个）`);
  }
  output.push('');

  const errors = result.errors as ExtractedSimError[];
  for (let i = 0; i < errors.length; i++) {
    const e = errors[i];
    output.push(`--- 错误 #${i + 1} ---`);
    output.push(`工具: ${e.tool}`);
    if (e.severity) output.push(`严重级别: ${e.severity}`);
    if (e.errorType) output.push(`错误类型: ${e.errorType}`);
    if (e.timestamp) output.push(`时间戳: ${e.timestamp}`);
    if (e.testCase) output.push(`测试用例: ${e.testCase}`);
    if (e.code) output.push(`错误代码: ${e.code}`);
    if (e.typeName) output.push(`类型: ${e.typeName}`);
    if (e.location) output.push(`位置: ${e.location}`);
    if (e.file) output.push(`文件: ${e.file}`);
    if (e.line) output.push(`行号: ${e.line}`);
    output.push(`行号: ${e.lineNumber}`);
    output.push(`错误信息: ${e.message}`);
    if (e.context.length > 0) {
      output.push('上下文:');
      for (const ctxLine of e.context) {
        output.push(`  ${ctxLine}`);
      }
    }
    output.push('');
  }
  return output.join('\n');
}

// ─── 统一入口 ─────────────────────────────────────────────────

/**
 * LogAnalyzer 统一入口
 *
 * 提供日志分析的完整流程：
 * 1. 路径解析
 * 2. 错误类型判定
 * 3. 错误上下文提取
 * 4. 格式化
 */
export const logAnalyzer = {
  getSimulationLogPath,
  getCompileLogPath,
  checkSimulationStatus,
  determineErrorType,
  processCompileLog,
  processSimLog,
  formatCompileErrorsForAI,
  formatSimErrorsForAI,

  /**
   * 完整的错误分析流程
   *
   * @param caseName 用例名称
   * @param cwd 工作目录
   * @returns 错误类型、格式化后的错误上下文、日志路径
   */
  analyzeErrors(caseName: string, cwd?: string): {
    errorType: ErrorType;
    errorContext: string;
    compileLogPath: string;
    simLogPath: string;
  } {
    const compileLogPath = getCompileLogPath(caseName, cwd);
    const simLogPath = getSimulationLogPath(caseName, cwd);
    const errorType = determineErrorType(caseName, cwd);

    let errorContext = '';

    if (errorType === 'compile_error') {
      const result = processCompileLog(compileLogPath, {
        contextLines: DEFAULT_CONTEXT_LINES,
        maxErrors: DEFAULT_MAX_ERRORS,
      });
      errorContext = formatCompileErrorsForAI(result);
    } else {
      const result = processSimLog(simLogPath, {
        contextLines: DEFAULT_CONTEXT_LINES,
        maxErrors: DEFAULT_MAX_ERRORS,
      });
      errorContext = formatSimErrorsForAI(result);
    }

    return { errorType, errorContext, compileLogPath, simLogPath };
  },
};
