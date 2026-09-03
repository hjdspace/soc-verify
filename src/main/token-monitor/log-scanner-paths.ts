/**
 * Log Scanner Paths — 外部 AI 工具日志路径解析。
 *
 * 支持环境变量覆盖：
 * - claude-code: 默认 ~/.claude/projects/，可通过 $CLAUDE_CONFIG_DIR 覆盖
 * - codex: 默认 ~/.codex/sessions/，可通过 $CODEX_HOME 覆盖
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';

/** 异步目录枚举让出事件循环前的最大目录数 */
const DISCOVER_YIELD_EVERY = 50;

/**
 * 解析 claude-code 日志目录。
 *
 * 优先级：
 * 1. $CLAUDE_CONFIG_DIR/projects/ （如果设置了 CLAUDE_CONFIG_DIR）
 * 2. ~/.claude/projects/ （默认）
 */
export function resolveClaudeLogDir(): string {
  const customConfigDir = process.env.CLAUDE_CONFIG_DIR;
  if (customConfigDir) {
    return join(customConfigDir, 'projects');
  }
  return join(homedir(), '.claude', 'projects');
}

/**
 * 解析 codex 日志目录。
 *
 * 优先级：
 * 1. $CODEX_HOME/sessions/ （如果设置了 CODEX_HOME）
 * 2. ~/.codex/sessions/ （默认）
 */
export function resolveCodexLogDir(): string {
  const customHome = process.env.CODEX_HOME;
  if (customHome) {
    return join(customHome, 'sessions');
  }
  return join(homedir(), '.codex', 'sessions');
}

/**
 * 递归查找目录下所有 .jsonl 文件（异步流式版本）。
 *
 * 行为与同步版 discoverJsonlFiles 一致（静默降级），但：
 * - 用 fs/promises 的 readdir，不阻塞事件循环
 * - 每 DISCOVER_YIELD_EVERY 个目录让出一次事件循环
 * （GUI 卡顿修复：Electron 主进程扫描期间必须保持 IPC 响应）
 */
export async function discoverJsonlFilesAsync(
  dirPath: string,
  files: string[] = [],
): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return files; // 目录不存在 / 权限错误 → 静默降级
  }

  let discovered = 0;
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await discoverJsonlFilesAsync(fullPath, files);
      if (++discovered % DISCOVER_YIELD_EVERY === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * 递归查找目录下所有 .jsonl 文件。
 *
 * 如果目录不存在或无法访问，返回空数组（静默降级，不抛异常）。
 *
 * @param dirPath 要扫描的目录路径
 * @returns 所有 .jsonl 文件的绝对路径数组
 */
export function discoverJsonlFiles(dirPath: string): string[] {
  if (!existsSync(dirPath)) {
    return [];
  }

  const files: string[] = [];

  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        files.push(...discoverJsonlFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  } catch {
    // 权限错误等——静默降级
  }

  return files;
}

/**
 * 获取所有要扫描的日志目录列表（claude-code + codex）。
 *
 * 只返回存在的目录。
 */
export function getAllScanDirs(): { engine: 'claude-code' | 'codex'; dir: string }[] {
  const result: { engine: 'claude-code' | 'codex'; dir: string }[] = [];

  const claudeDir = resolveClaudeLogDir();
  if (existsSync(claudeDir)) {
    result.push({ engine: 'claude-code', dir: claudeDir });
  }

  const codexDir = resolveCodexLogDir();
  if (existsSync(codexDir)) {
    result.push({ engine: 'codex', dir: codexDir });
  }

  return result;
}

/**
 * 获取所有 .jsonl 文件的完整路径列表（合并所有扫描目录）。
 */
export function getAllJsonlFiles(): { engine: 'claude-code' | 'codex'; filePath: string }[] {
  const result: { engine: 'claude-code' | 'codex'; filePath: string }[] = [];

  for (const { engine, dir } of getAllScanDirs()) {
    const files = discoverJsonlFiles(dir);
    for (const filePath of files) {
      result.push({ engine, filePath });
    }
  }

  return result;
}

/**
 * 获取文件最后一个换行符之后的字节偏移。
 *
 * JSONL writer（claude-code / codex CLI）追加写日志，扫描瞬间最后一行
 * 可能尚未写完（无换行符结尾）。偏移必须停在最后一个完整行边界：
 * - 推进到文件末尾 → 写完后的剩余半行永远落在偏移之前，记录丢失
 * - 停在最后一个 \n 之后 → 不完整行留给下次增量扫描，写完后完整解析
 *
 * 文件尾部无任何换行符（如全新文件写到一半）→ 返回 0，全量重扫
 * （未落盘的半行下次会被完整解析，成本可接受）。
 * stat.size === 0 → 返回 0。
 *
 * 异步实现（从文件尾部倒读 64KB 块），不阻塞事件循环。
 */
export async function lastCompleteLineOffset(
  filePath: string,
): Promise<number> {
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat || fileStat.size === 0) return 0;

  const CHUNK = 64 * 1024;
  const handle = await open(filePath, 'r').catch(() => null);
  if (!handle) return fileStat.size; // 打不开 → 按旧行为推进到末尾

  try {
    // 从尾部往前找最后一个换行符
    let pos = fileStat.size;
    while (pos > 0) {
      const readLen = Math.min(CHUNK, pos);
      pos -= readLen;
      const buf = Buffer.alloc(readLen);
      await handle.read(buf, 0, readLen, pos);

      const idx = buf.lastIndexOf(0x0a); // '\n'
      if (idx >= 0) {
        // 换行符在当前块内 → 绝对偏移 = 块起点 + 块内位置 + 1
        return pos + idx + 1;
      }
      // 本块没有换行符 → 整块都是尾部不完整行的一部分，继续往前读
    }
    // 整个文件没有一个换行符 → 全是未写完的内容，从头扫
    return 0;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * 文件状态信息（用于增量扫描判断）。
 */
export type FileStatInfo = {
  mtimeMs: number;
  size: number;
};

/**
 * 获取文件的 mtime 和 size。
 * 如果文件不存在，返回 null。
 */
export function getFileStat(filePath: string): FileStatInfo | null {
  try {
    const stat = statSync(filePath);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}
