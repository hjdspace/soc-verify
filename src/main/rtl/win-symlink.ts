/**
 * Windows 伪 symlink（git symlink 退化文本）检测与解析。
 *
 * OpenTitan 等仓库在 git 中以 symlink 共享文件（如
 * `hw/top_englishbreakfast/rtl/top_pkg.sv -> ../../top_earlgrey/rtl/top_pkg.sv`）。
 * Windows 上未启用 `core.symlinks` 的 checkout 会把 symlink 退化为
 * **内容为目标路径的单行普通文本文件**。把它当 HDL 源交给 slang 解析，
 * 会产生 `file.sv:1:1 error: expected member` 这类首行语法错误
 * （整行路径被当作声明解析）。
 *
 * 判定条件（全部满足才视为伪 symlink）：
 *   1. 文件大小 <= MAX_SYMLINK_TEXT_BYTES（真实 symlink 目标路径不会太长）
 *   2. 内容单行、仅含路径字符（无空白/分号/括号等 SV 语法痕迹）
 *   3. 形如 Windows 绝对路径（盘符开头）或含路径分隔符的相对路径
 *   4. 以 .v/.sv/.vh/.svh 结尾（伪 symlink 文件名本身的扩展集合）
 *   5. 相对文件所在目录 resolve 后目标存在且是文件
 *
 * 误判风险：正常 HDL 文件恰好单行、纯路径字符、且解析出的目标存在 —— 概率为零。
 */

import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const MAX_SYMLINK_TEXT_BYTES = 1024;
const MAX_SYMLINK_CHAIN = 8;

const HDL_TARGET_EXTENSIONS = new Set(['.v', '.sv', '.vh', '.svh']);

/** 盘符开头的 Windows 绝对路径 */
const WINDOWS_ABS_RE = /^[A-Za-z]:[\\/][^\s;(){}[\]`'"=,]+$/;
/** 含至少一个分隔符的相对路径（`../top_earlgrey/rtl/top_pkg.sv` 等） */
const RELATIVE_PATH_RE = /^[^\s;(){}[\]`'"=,\\/]+(?:[\\/][^\s;(){}[\]`'"=,\\/]+)+$/;

export type SymlinkResolution =
  /** 正常文件（非伪 symlink，或为真实 symlink） */
  | { kind: 'normal' }
  /** 伪 symlink，target 为解析后的真实目标绝对路径 */
  | { kind: 'redirect'; target: string }
  /** 伪 symlink 但目标不存在/不是文件 —— 内容是垃圾文本，应跳过 */
  | { kind: 'broken' };

function readSymlinkText(path: string): string | null {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }
  if (size <= 0 || size > MAX_SYMLINK_TEXT_BYTES) return null;
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
  return text.replace(/^\uFEFF/, '').trim();
}

/** 内容是否形如路径文本（伪 symlink 的必要形态） */
function looksLikePathText(text: string): boolean {
  if (text.length === 0 || /[\r\n]/.test(text)) return false;
  if (!WINDOWS_ABS_RE.test(text) && !RELATIVE_PATH_RE.test(text)) return false;
  const dot = text.lastIndexOf('.');
  if (dot === -1) return false;
  return HDL_TARGET_EXTENSIONS.has(text.slice(dot).toLowerCase());
}

/** resolve 目标（相对 path 所在目录），要求存在且为文件 */
function resolveTarget(path: string, text: string): string | null {
  const target = resolve(dirname(path), text);
  try {
    if (!statSync(target).isFile()) return null;
  } catch {
    return null;
  }
  return target;
}

/**
 * 检查源文件是否为 Windows 伪 symlink 文本文件。
 * 支持链式伪 symlink（目标仍是伪 symlink 时递归解析，深度限制防循环）。
 */
export function inspectSourceFile(path: string): SymlinkResolution {
  let current = path;
  for (let depth = 0; depth < MAX_SYMLINK_CHAIN; depth++) {
    const text = readSymlinkText(current);
    if (text === null || !looksLikePathText(text)) return { kind: 'normal' };
    const target = resolveTarget(current, text);
    if (target === null) return { kind: 'broken' };
    // 目标不是伪 symlink 文本 → 解析完成
    const targetText = readSymlinkText(target);
    if (targetText === null || !looksLikePathText(targetText)) {
      return { kind: 'redirect', target };
    }
    current = target;
  }
  return { kind: 'broken' };
}
