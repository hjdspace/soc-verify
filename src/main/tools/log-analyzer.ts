/**
 * Log Analyzer — EDA simulation log analysis logic.
 *
 * Ported from the Python `log_analyzer` plugin.
 * Features: error pattern matching (UVM/SPRD/XRUN/VCS/SDC),
 * similar error merging, context extraction, report export.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// ── Types ──────────────────────────────────────────────────────────

export type ErrorCategory = 'error' | 'fatal' | 'warning';

export type ErrorEntry = {
  type: string;
  label: string;
  category: ErrorCategory;
  time?: string;
  file?: string;
  line?: string;
  message: string;
  context: string[];
  occurrenceCount?: number;
};

export type AnalysisSummary = {
  totalErrors: number;
  totalWarnings: number;
  totalFatals: number;
  entries: ErrorEntry[];
  filePath: string;
  analyzedAt: string;
};

// ── Error patterns (ported from Python) ────────────────────────────

type PatternDef = {
  regex: RegExp;
  label: string;
  category: ErrorCategory;
  groups: 'uvm' | 'sprd' | 'assert' | 'cdc' | 'sdc' | 'generic';
};

const ERROR_PATTERNS: PatternDef[] = [
  // UVM patterns
  { regex: /UVM_ERROR\s*@\s*(\d+(?:\.\d+)?(?:n|p|f)?s):\s*(.*)/i, label: 'UVM错误', category: 'error', groups: 'uvm' },
  { regex: /UVM_FATAL\s*@\s*(\d+(?:\.\d+)?(?:n|p|f)?s):\s*(.*)/i, label: 'UVM致命错误', category: 'fatal', groups: 'uvm' },
  { regex: /UVM_WARNING\s*@\s*(\d+(?:\.\d+)?(?:n|p|f)?s):\s*(.*)/i, label: 'UVM警告', category: 'warning', groups: 'uvm' },

  // SPRD patterns
  { regex: /SPRD_ERROR\s*@\s*(\d+(?:\.\d+)?(?:n|p|f)?s):\s*\[(.*?)\]\s*(.*)/i, label: 'SPRD错误', category: 'error', groups: 'sprd' },
  { regex: /SPRD_FATAL\s*@\s*(\d+(?:\.\d+)?(?:n|p|f)?s):\s*\[(.*?)\]\s*(.*)/i, label: 'SPRD致命错误', category: 'fatal', groups: 'sprd' },
  { regex: /SPRD_WARNING\s*@\s*(\d+(?:\.\d+)?(?:n|p|f)?s):\s*\[(.*?)\]\s*(.*)/i, label: 'SPRD警告', category: 'warning', groups: 'sprd' },

  // XRUN patterns
  { regex: /\*E,\s*Assertion\s+Error,\s*\[(.*?):(\d+)\]/i, label: 'XRUN断言错误', category: 'error', groups: 'assert' },
  { regex: /ncsim:\s*\*E,.*/i, label: 'XRUN仿真器错误', category: 'error', groups: 'generic' },

  // VCS patterns
  { regex: /\*\*\s*Error:\s*\[(.*?):(\d+)\]\s*Assertion\s+Error/i, label: 'VCS断言错误', category: 'error', groups: 'assert' },
  { regex: /Error:\s*"(.*?)"\s*line\s*(\d+):\s*Assertion\s+Error/i, label: 'CDC断言错误', category: 'error', groups: 'cdc' },

  // SDC patterns
  { regex: /\[(\d+)\]\s*\[FP\].*?@\s*Time:\s*(\d+(?:\.\d+)?(?:n|p|f)?s)/i, label: 'SDC假路径错误', category: 'error', groups: 'sdc' },
  { regex: /\[(\d+)\]\s*\[MCP\].*?@\s*Time:\s*(\d+(?:\.\d+)?(?:n|p|f)?s)/i, label: 'SDC多时钟路径错误', category: 'error', groups: 'sdc' },
];

// ── Similarity calculation ─────────────────────────────────────────

function calculateSimilarity(str1: string, str2: string): number {
  if (!str1 || !str2) return 0;
  const len1 = str1.length;
  const len2 = str2.length;
  const maxLen = Math.max(len1, len2);
  if (maxLen === 0) return 1;

  // Simple Levenshtein-based similarity ratio
  const dist = levenshtein(str1, str2);
  return 1 - dist / maxLen;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

const SIMILARITY_THRESHOLD = 0.8;

// ── Core analysis logic ────────────────────────────────────────────

function formatErrorEntry(pattern: PatternDef, match: RegExpMatchArray, contextLines: string[]): ErrorEntry {
  let time: string | undefined;
  let file: string | undefined;
  let line: string | undefined;
  let message = '';

  switch (pattern.groups) {
    case 'uvm':
      time = match[1];
      message = match[2];
      break;
    case 'sprd':
      time = match[1];
      message = `[${match[2]}] ${match[3]}`;
      break;
    case 'assert':
      file = match[1];
      line = match[2];
      message = 'Assertion Error';
      break;
    case 'cdc':
      file = match[1];
      line = match[2];
      message = 'CDC Assertion Error';
      break;
    case 'sdc':
      message = `编号: ${match[1]}, 时间: ${match[2]}`;
      break;
    default:
      message = match[0];
  }

  return {
    type: pattern.label,
    label: pattern.label,
    category: pattern.category,
    time,
    file,
    line,
    message,
    context: contextLines.filter((l) => l.trim()),
  };
}

function mergeSimilarErrors(entries: ErrorEntry[]): ErrorEntry[] {
  const groups: { message: string; entries: ErrorEntry[] }[] = [];

  for (const entry of entries) {
    const found = groups.find(
      (g) => calculateSimilarity(entry.message, g.message) >= SIMILARITY_THRESHOLD,
    );
    if (found) {
      found.entries.push(entry);
    } else {
      groups.push({ message: entry.message, entries: [entry] });
    }
  }

  return groups.map((g) => {
    if (g.entries.length > 1) {
      return { ...g.entries[0], occurrenceCount: g.entries.length };
    }
    return g.entries[0];
  });
}

/** Analyze a log file and extract error/warning information. */
export async function analyzeLogFile(logPath: string): Promise<AnalysisSummary> {
  if (!existsSync(logPath)) {
    throw new Error(`日志文件不存在: ${logPath}`);
  }

  const content = await readFile(logPath, 'utf-8');
  if (!content.trim()) {
    throw new Error('日志文件内容为空');
  }

  return analyzeLogContent(content, logPath);
}

/** Analyze log content string. */
export function analyzeLogContent(content: string, filePath = ''): AnalysisSummary {
  const lines = content.split('\n');
  const rawEntries: ErrorEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    for (const pattern of ERROR_PATTERNS) {
      const match = line.match(pattern.regex);
      if (match) {
        // Get context (±5 lines)
        const startIdx = Math.max(0, i - 5);
        const endIdx = Math.min(lines.length, i + 6);
        const contextLines = lines.slice(startIdx, endIdx);

        rawEntries.push(formatErrorEntry(pattern, match, contextLines));
        break; // Only match one pattern per line
      }
    }
  }

  // Merge similar errors
  const merged = mergeSimilarErrors(rawEntries);

  const totalErrors = merged.filter((e) => e.category === 'error').length;
  const totalFatals = merged.filter((e) => e.category === 'fatal').length;
  const totalWarnings = merged.filter((e) => e.category === 'warning').length;

  return {
    totalErrors,
    totalWarnings,
    totalFatals,
    entries: merged,
    filePath,
    analyzedAt: new Date().toISOString(),
  };
}

/** Generate HTML report from analysis results. */
export function generateHtmlReport(summary: AnalysisSummary): string {
  const errorEntries = summary.entries.filter((e) => e.category === 'error' || e.category === 'fatal');
  const warningEntries = summary.entries.filter((e) => e.category === 'warning');

  const formatEntry = (e: ErrorEntry): string => `
    <div class="${e.category === 'warning' ? 'warning-block' : 'error-block'}">
      <div class="${e.category === 'warning' ? 'warning-header' : 'error-header'}">${e.label}${e.occurrenceCount ? ` <span class="occurrence">(${e.occurrenceCount}次)</span>` : ''}</div>
      ${e.time ? `<div class="info">时间: ${e.time}</div>` : ''}
      ${e.file ? `<div class="info">文件: ${e.file}${e.line ? `:${e.line}` : ''}</div>` : ''}
      <div class="info">信息: ${e.message}</div>
      ${e.context.length > 0 ? `<div class="context-title">上下文:</div><pre class="context-block">${e.context.join('\n')}</pre>` : ''}
    </div>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>EDA仿真日志分析报告</title>
<style>
  body { font-family: 'Consolas', 'Courier New', monospace; padding: 20px; background: #f8f9fa; color: #212529; }
  .title { color: #0056b3; font-size: 16pt; font-weight: bold; margin: 10px 0; }
  .summary { background: #fff; padding: 10px; border-radius: 4px; margin: 10px 0; border: 1px solid #dee2e6; }
  .error-count { color: #dc3545; font-weight: bold; }
  .warning-count { color: #ffc107; font-weight: bold; }
  .fatal-count { color: #b02a37; font-weight: bold; }
  .error-block { margin: 10px 0; padding: 10px; border-left: 4px solid #dc3545; background: #fff; }
  .warning-block { margin: 10px 0; padding: 10px; border-left: 4px solid #ffc107; background: #fff; }
  .error-header { color: #dc3545; font-weight: bold; }
  .warning-header { color: #ffc107; font-weight: bold; }
  .info { color: #495057; margin: 3px 0; }
  .occurrence { color: #0056b3; font-style: italic; }
  .context-title { color: #495057; font-weight: bold; margin: 5px 0; }
  .context-block { font-family: monospace; background: #f8f9fa; padding: 10px; border-radius: 4px; white-space: pre; border: 1px solid #e9ecef; }
</style>
</head>
<body>
  <div class="title">EDA仿真日志分析报告</div>
  <div class="summary">
    <div>分析文件: ${summary.filePath}</div>
    <div>分析时间: ${new Date(summary.analyzedAt).toLocaleString('zh-CN')}</div>
    <div class="fatal-count">致命错误: ${summary.totalFatals}</div>
    <div class="error-count">错误: ${summary.totalErrors}</div>
    <div class="warning-count">警告: ${summary.totalWarnings}</div>
  </div>
  ${errorEntries.length > 0 ? '<h3>错误详情</h3>' + errorEntries.map(formatEntry).join('') : '<div>无错误</div>'}
  ${warningEntries.length > 0 ? '<h3>警告详情</h3>' + warningEntries.map(formatEntry).join('') : ''}
</body>
</html>`;
}

/** Export analysis report to file. */
export async function exportReport(summary: AnalysisSummary, savePath: string, format: 'html' | 'txt'): Promise<void> {
  if (format === 'html') {
    const html = generateHtmlReport(summary);
    await writeFile(savePath, html, 'utf-8');
  } else {
    const lines: string[] = [
      '=== EDA仿真日志分析报告 ===',
      `分析文件: ${summary.filePath}`,
      `分析时间: ${new Date(summary.analyzedAt).toLocaleString('zh-CN')}`,
      `致命错误: ${summary.totalFatals}`,
      `错误: ${summary.totalErrors}`,
      `警告: ${summary.totalWarnings}`,
      '',
    ];
    for (const entry of summary.entries) {
      lines.push(`--- ${entry.label}${entry.occurrenceCount ? ` (${entry.occurrenceCount}次)` : ''} ---`);
      if (entry.time) lines.push(`时间: ${entry.time}`);
      if (entry.file) lines.push(`文件: ${entry.file}${entry.line ? `:${entry.line}` : ''}`);
      lines.push(`信息: ${entry.message}`);
      if (entry.context.length > 0) {
        lines.push('上下文:');
        lines.push(...entry.context);
      }
      lines.push('');
    }
    await writeFile(savePath, lines.join('\n'), 'utf-8');
  }
}
