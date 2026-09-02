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
