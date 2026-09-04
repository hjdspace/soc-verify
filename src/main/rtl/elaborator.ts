/**
 * Elaborator — spawn yosys 执行 `read_slang -f <filelist> --top <top> --keep-hierarchy`
 * + `write_json`（ADR 0032 决策 5）。
 *
 * `--keep-hierarchy` 是硬性要求：S0 实测不加时整个设计被 flatten 成顶层门级
 * 原语，层级树完全丢失。
 *
 * 失败时解析 slang 诊断（file:line:col: severity: message）随 RtlElaborationError
 * 抛出 —— slang 的诊断质量是该引擎选型的附加优势，UI 据此呈现可定位错误。
 */

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ElaborationError, SlangDiagnostic } from './types';

export const ELABORATION_TIMEOUT_MS = 10 * 60 * 1000;

export class RtlElaborationError extends Error {
  readonly diagnostics: SlangDiagnostic[];
  readonly logTail: string;

  constructor(message: string, diagnostics: SlangDiagnostic[], logTail: string) {
    super(message);
    this.name = 'RtlElaborationError';
    this.diagnostics = diagnostics;
    this.logTail = logTail;
  }

  toElaborationError(): ElaborationError {
    return { message: this.message, diagnostics: this.diagnostics, logTail: this.logTail };
  }
}

export type ElaborationOptions = {
  /** yosys 可执行文件绝对路径 */
  yosysPath: string;
  /** 工作目录（<projectRoot>/.socverify/design/work），design.ys 与 design.json 产出地 */
  workDir: string;
  /** 已展开的扁平 .f 文件绝对路径（见 filelist.ts） */
  flatFilelistPath: string;
  /** 顶层模块；null = read_slang 自动判定（detectTops 模式） */
  top: string | null;
  timeoutMs?: number;
  /** 逐行日志回调（调试/终端输出用） */
  onLog?: (line: string) => void;
};

export type ElaborationResult = {
  /** write_json 产物路径（调用方提炼后应删除——raw 不持久化） */
  jsonPath: string;
  log: string;
  /** 即使成功也收集的 warning 诊断 */
  warnings: SlangDiagnostic[];
};

/**
 * slang 诊断行解析。`.+?` 惰性匹配兼容 Windows 盘符冒号
 * （`D:\path\a.sv:10:5: error: ...`）。
 */
const DIAG_RE = /^(.+?):(\d+):(?:(\d+):\s*)?(error|warning|info|note|fatal):\s*(.+)$/i;

export function parseDiagnostics(log: string): SlangDiagnostic[] {
  const out: SlangDiagnostic[] = [];
  for (const raw of log.split(/\r?\n/)) {
    const m = DIAG_RE.exec(raw.trim());
    if (!m) continue;
    out.push({
      file: m[1].trim(),
      line: Number(m[2]),
      column: m[3] !== undefined ? Number(m[3]) : null,
      severity: m[4].toLowerCase() as SlangDiagnostic['severity'],
      message: m[5].trim(),
    });
  }
  return out;
}

/** 生成 yosys 脚本（固化 --keep-hierarchy，见 run_yosys.ys 的 S0 结论） */
export function renderYosysScript(flatFilelistPath: string, top: string | null, jsonPath: string): string {
  const topArg = top ? ` --top ${top}` : '';
  return `read_slang -f ${flatFilelistPath}${topArg} --keep-hierarchy\nwrite_json ${jsonPath}\n`;
}

export async function elaborate(opts: ElaborationOptions): Promise<ElaborationResult> {
  const { yosysPath, workDir, flatFilelistPath, top, timeoutMs = ELABORATION_TIMEOUT_MS, onLog } = opts;

  if (!existsSync(flatFilelistPath)) {
    throw new RtlElaborationError(`扁平 filelist 不存在: ${flatFilelistPath}`, [], '');
  }
  const jsonPath = join(workDir, 'design.json');
  const ysPath = join(workDir, 'design.ys');
  writeFileSync(ysPath, renderYosysScript(flatFilelistPath, top, jsonPath), 'utf-8');

  const log = await runYosys(yosysPath, ['-s', ysPath], workDir, timeoutMs, onLog);
  const diagnostics = parseDiagnostics(log);
  const errors = diagnostics.filter((d) => d.severity === 'error' || d.severity === 'fatal');
  const warnings = diagnostics.filter((d) => d.severity === 'warning');

  if (errors.length > 0) {
    throw new RtlElaborationError(
      `elaboration 失败：${errors[0].file}:${errors[0].line} ${errors[0].message}`,
      diagnostics,
      tail(log),
    );
  }

  if (!existsSync(jsonPath)) {
    throw new RtlElaborationError(
      'yosys 正常退出但未产出 write_json 文件（检查 read_slang 是否静默失败）',
      diagnostics,
      tail(log),
    );
  }

  return { jsonPath, log, warnings };
}

function runYosys(
  exe: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  onLog?: (line: string) => void,
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(exe, args, { cwd, windowsHide: true });
    let log = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        rejectPromise(new RtlElaborationError(`yosys 超时（${Math.round(timeoutMs / 1000)}s）被终止`, [], tail(log)));
      }
    }, timeoutMs);

    const collect = (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      log += text;
      if (onLog) {
        for (const line of text.split(/\r?\n/)) {
          if (line) onLog(line);
        }
      }
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(new RtlElaborationError(`yosys 启动失败: ${err.message}`, [], tail(log)));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise(log);
      } else {
        const diags = parseDiagnostics(log);
        const firstError = diags.find((d) => d.severity === 'error' || d.severity === 'fatal');
        rejectPromise(
          new RtlElaborationError(
            firstError
              ? `elaboration 失败：${firstError.file}:${firstError.line} ${firstError.message}`
              : `yosys 退出码 ${code ?? 'signal'}`,
            diags,
            tail(log),
          ),
        );
      }
    });
  });
}

function tail(log: string, lines = 40): string {
  const parts = log.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return parts.slice(-lines).join('\n');
}
