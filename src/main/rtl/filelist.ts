/**
 * VCS 风格 filelist（.f）展开器。
 *
 * Design Source = 用户配置的一个或多个 .f 文件（ADR 0032 决策 3/16）。
 * 展开为 read_slang 可直接消费的扁平清单（全绝对路径，与 yosys cwd 无关）：
 *   - `+incdir+dir1[+dir2...]` → 逐目录拆分（VCS 的 + 分隔惯例）
 *   - `+define+MACRO[=value][+MACRO2...]` → 逐宏拆分
 *   - `-f <file>` / `-F <file>` → 递归展开（-F 相对当前 .f 所在目录，-f 先相对
 *     当前 .f 所在目录、回退 baseDir，兼容两种工程习惯）
 *   - 其他 `-x` / `+xxx+` 旗标 → 原样透传（slang 自行解释，如 +libext+）
 *   - 其余 token → 源文件路径（相对当前 .f 所在目录解析，回退 baseDir）
 *
 * read_slang 的 -f 文件原生支持 `+incdir+` / `+define+` 行（S0 实测：
 * spike.f 即此形态），展开产物保持同语法、按行书写。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export type ParsedFilelist = {
  /** 源文件（绝对路径，按出现顺序） */
  sources: string[];
  /** include 搜索目录（绝对路径，按出现顺序） */
  incdirs: string[];
  /** 宏定义（`NAME` 或 `NAME=value`） */
  defines: string[];
  /** 其他旗标（原样透传给 read_slang） */
  passthrough: string[];
  /** 所有被引用的文件（.f 本身 + 源文件 + include 目录，供 mtime 过期判定） */
  files: string[];
};

const MAX_NESTING_DEPTH = 20;

/** 路径解析：优先相对当前 .f 所在目录，文件系统上不存在时回退 baseDir */
function resolveRelative(p: string, ownDir: string, baseDir: string): string {
  if (isAbsolute(p)) return resolve(p);
  const besideSelf = resolve(ownDir, p);
  if (existsSync(besideSelf)) return besideSelf;
  return resolve(baseDir, p);
}

/** 去掉行注释（// 与 #）与首尾空白；空行返回 null */
function cleanLine(line: string): string | null {
  let s = line;
  const cpp = s.indexOf('//');
  if (cpp !== -1) s = s.slice(0, cpp);
  const hash = s.indexOf('#');
  if (hash !== -1) s = s.slice(0, hash);
  s = s.trim();
  return s.length > 0 ? s : null;
}

function parseInto(
  filePath: string,
  baseDir: string,
  out: ParsedFilelist,
  visited: Set<string>,
  depth: number,
): void {
  if (depth > MAX_NESTING_DEPTH) {
    throw new Error(`filelist 嵌套超过 ${MAX_NESTING_DEPTH} 层（疑似循环引用）: ${filePath}`);
  }
  const normPath = resolve(filePath);
  if (visited.has(normPath)) return; // 循环 -f 引用保护
  visited.add(normPath);
  out.files.push(normPath);

  const ownDir = dirname(normPath);
  const content = existsSync(normPath) ? readLines(normPath) : '';
  const rawLines = content.split(/\r?\n/);

  for (let i = 0; i < rawLines.length; i++) {
    const line = cleanLine(rawLines[i] ?? '');
    if (!line) continue;

    // 逆斜杠续行（VCS 惯例）：行尾 \ 与下一行拼接
    let cur = line;
    while (cur.endsWith('\\') && i + 1 < rawLines.length) {
      cur = cur.slice(0, -1).trimEnd() + ' ' + (cleanLine(rawLines[++i] ?? '') ?? '');
    }

    // -f / -F 递归（可能一行多个文件，空白分隔）
    if (/^-(f|F)$/i.test(cur) || /^-(f|F)\s+/i.test(cur)) {
      const parts = cur.split(/\s+/).slice(1).filter(Boolean);
      for (const ref of parts) {
        // -F 的相对路径语义是相对当前 .f 所在目录
        parseInto(resolve(ownDir, ref), baseDir, out, visited, depth + 1);
      }
      continue;
    }

    if (cur.toLowerCase().startsWith('+incdir+')) {
      for (const dir of cur.slice('+incdir+'.length).split('+').map((t) => t.trim()).filter(Boolean)) {
        const abs = resolveRelative(dir, ownDir, baseDir);
        out.incdirs.push(abs);
        out.files.push(abs);
      }
      continue;
    }

    if (cur.toLowerCase().startsWith('+define+')) {
      for (const def of cur.slice('+define+'.length).split('+').map((t) => t.trim()).filter(Boolean)) {
        out.defines.push(def);
      }
      continue;
    }

    if (cur.startsWith('-') || cur.startsWith('+')) {
      out.passthrough.push(cur);
      continue;
    }

    // 源文件路径（空白分隔可多个）
    for (const src of cur.split(/\s+/).filter(Boolean)) {
      const abs = resolveRelative(src, ownDir, baseDir);
      out.sources.push(abs);
      out.files.push(abs);
    }
  }
}

function readLines(path: string): string {
  return readFileSync(path, 'utf-8');
}

/**
 * 展开一个或多个 .f 文件为扁平清单。
 * @param filelists .f 文件路径（相对 baseDir 或绝对）
 * @param baseDir 项目根目录（相对路径回退基准）
 */
export function flattenFilelists(filelists: string[], baseDir: string): ParsedFilelist {
  const out: ParsedFilelist = { sources: [], incdirs: [], defines: [], passthrough: [], files: [] };
  const visited = new Set<string>();
  for (const f of filelists) {
    parseInto(isAbsolute(f) ? f : join(baseDir, f), baseDir, out, visited, 0);
  }
  return out;
}

/**
 * 生成扁平 .f 内容（写入 work 目录供 read_slang -f 消费）。
 * 全部绝对路径，与 yosys cwd 无关。
 */
export function renderFlatFilelist(parsed: ParsedFilelist): string {
  const lines: string[] = [];
  for (const dir of parsed.incdirs) lines.push(`+incdir+${dir}`);
  for (const def of parsed.defines) lines.push(`+define+${def}`);
  for (const flag of parsed.passthrough) lines.push(flag);
  for (const src of parsed.sources) lines.push(src);
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}
