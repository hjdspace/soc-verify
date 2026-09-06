/**
 * Verible Lint — spawn verible-verilog-lint 执行风格检查，解析文本输出为诊断。
 *
 * S0 实测结论：verible lint 无 JSON 输出旗标，输出为文本格式
 * `file:line:col-range: message [Style:] [rule]`。
 *
 * spec 决策 21/25：lint 打开/保存时后台自动；语义诊断由 slang-server 提供，
 * verible 管 style lint — 互补不冗余。
 *
 * 代码归属 src/main/rtl/verible-lint.ts（ADR 0032 决策 22）。
 */

import { spawn } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveVeribleLintPath } from './binary';

/** verible lint 诊断（与 EditorDiagnostic 对齐，0-based 行号） */
export type VeribleLintDiagnostic = {
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source: 'verible';
  code?: string;
};

/** verible lint 执行选项 */
export type VeribleLintOptions = {
  /** verible-verilog-lint 可执行文件路径（若不提供则自动解析） */
  lintPath?: string | null;
  /** 要 lint 的文件绝对路径 */
  filePath: string;
  /** 文件内容（写入临时文件供 verible 读取；若不提供则从磁盘读 filePath） */
  content?: string;
  /** 超时毫秒（默认 30s） */
  timeoutMs?: number;
};

/** verible lint 执行结果 */
export type VeribleLintResult = {
  diagnostics: VeribleLintDiagnostic[];
  /** 原始输出（调试用） */
  rawOutput: string;
};

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 解析 verible lint 的文本输出行。
 *
 * verible 输出格式（S0 实测）：
 *   `path:line:col-range: message [Style: rule-name]`
 *
 * 其中 col-range 形如 `7-8`（起止列号，1-based inclusive）。
 * 无诊断时 verible 无输出或输出空行。
 *
 * 示例行：
 *   `rtl/top.sv:3:7-12: Macro name should be uppercase. [Style: macro-name-style]`
 */
const VERIBLE_LINE_RE = /^(.+?):(\d+):(\d+)-(\d+):\s*(.+)$/;

/** verible 诊断行的 severity 默认为 warning（风格规则） */
function veribleSeverity(_message: string): 'error' | 'warning' | 'info' | 'hint' {
  // verible lint 全部为风格规则，默认 warning
  // 特定规则可在此细化（如 syntax 错误提为 error）
  return 'warning';
}

/** 提取规则名（方括号内的 `Style: rule-name`） */
function extractRuleCode(message: string): string | undefined {
  const m = /\[Style:\s*(.+?)\]/i.exec(message);
  return m?.[1]?.trim();
}

/** 去除消息尾部的 `[Style: ...]` 标记 */
function cleanMessage(message: string): string {
  return message.replace(/\s*\[Style:\s*.+?\]\s*$/i, '').trim();
}

/**
 * 解析 verible lint 输出文本为诊断列表。
 *
 * @param output verible lint 的 stdout 文本
 * @param lintedFilePath 被 lint 的文件路径（用于过滤匹配）
 */
export function parseVeribleLintOutput(output: string, lintedFilePath?: string): VeribleLintDiagnostic[] {
  const diagnostics: VeribleLintDiagnostic[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const m = VERIBLE_LINE_RE.exec(trimmed);
    if (!m) continue;
    const [, file, lineStr, colStartStr, colEndStr, messagePart] = m;
    // 如果指定了文件路径，只保留匹配的行
    if (lintedFilePath && file !== lintedFilePath && file !== lintedFilePath.replace(/\\/g, '/')) continue;

    const line = Number(lineStr);
    const colStart = Number(colStartStr);
    const colEnd = Number(colEndStr);
    const code = extractRuleCode(messagePart);
    const message = cleanMessage(messagePart);

    diagnostics.push({
      line: line - 1,         // 1-based → 0-based
      character: colStart - 1, // 1-based → 0-based
      endLine: line - 1,       // 同一行
      endCharacter: colEnd,    // col-range end is inclusive, 0-based
      severity: veribleSeverity(message),
      message,
      source: 'verible',
      code,
    });
  }
  return diagnostics;
}

/**
 * 执行 verible-verilog-lint 并返回诊断。
 *
 * 流程：
 *   1. 解析 verible-verilog-lint 可执行文件路径
 *   2. 如果提供了 content，写入临时文件（避免磁盘文件与编辑器内容不同步）
 *   3. spawn verible-verilog-lint <file>
 *   4. 解析 stdout 文本输出为诊断列表
 *   5. 清理临时文件
 *
 * verible 不可用时返回空诊断（不抛出，渲染端静默降级）。
 */
export async function runVeribleLint(opts: VeribleLintOptions): Promise<VeribleLintResult> {
  const lintPath = opts.lintPath ?? resolveVeribleLintPath();
  if (!lintPath) {
    return { diagnostics: [], rawOutput: '' };
  }

  // 写入临时文件（内容可能与磁盘不同步——编辑器未保存的修改）
  // 临时文件与原文件同目录，确保 verible 能解析 include 路径
  const lintFile = opts.content !== undefined
    ? join(dirname(opts.filePath), `.verible-lint-${Date.now()}.sv`)
    : opts.filePath;

  if (opts.content !== undefined) {
    writeFileSync(lintFile, opts.content, 'utf-8');
  }

  if (!existsSync(lintFile)) {
    return { diagnostics: [], rawOutput: '' };
  }

  try {
    const { stdout } = await runVeribleProcess(lintPath, [lintFile], opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const diagnostics = parseVeribleLintOutput(stdout, lintFile);
    return { diagnostics, rawOutput: stdout };
  } finally {
    // 清理临时文件
    if (opts.content !== undefined && lintFile !== opts.filePath) {
      try {
        unlinkSync(lintFile);
      } catch {
        // 临时文件清理失败忽略
      }
    }
  }
}

/** spawn verible-verilog-lint 进程并等待完成 */
function runVeribleProcess(
  exe: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; exitCode: number | null }> {
  return new Promise((resolvePromise) => {
    const child = spawn(exe, args, { windowsHide: true });
    let stdout = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        resolvePromise({ stdout, exitCode: null });
      }
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr?.on('data', () => {
      // stderr 忽略（verible 诊断在 stdout）
    });

    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ stdout, exitCode: null });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // verible lint 退出码 0 = 无诊断，非 0 = 有诊断（不是错误）
      resolvePromise({ stdout, exitCode: code });
    });
  });
}
