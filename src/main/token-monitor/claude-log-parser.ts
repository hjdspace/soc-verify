/**
 * Claude Log Parser — 解析 claude-code CLI 的 JSONL 日志文件。
 *
 * 格式说明（claude-code JSONL）：
 * 每行是一个 JSON 对象，type 字段为 'assistant' 时包含 usage 数据。
 * 只有 message.role === 'assistant' 的行才有效。
 *
 * 字段映射（claude-code → TokenUsageRecord）：
 * - message.id → messageId
 * - message.model → model
 * - usage.input_tokens → inputTokens
 * - usage.output_tokens → outputTokens
 * - usage.cache_read_input_tokens → cacheReadTokens
 * - usage.cache_creation_input_tokens → cacheWriteTokens
 * - totalTokens = input + output + cacheRead + cacheWrite
 *
 * 注意：claude-code 的 JSONL 没有 cost 字段（claude-code CLI 不返回成本），
 * 因此 costUsd 默认为 0。
 */

import { readFileSync, statSync } from 'node:fs';
import type { TokenUsageRecord } from './token-monitor-db';

// ─── Types ─────────────────────────────────────────────────

/** 单行 JSON 解析的中间类型（claude-code 格式） */
type ClaudeJsonlRow = {
  type?: string;
  sessionId?: string;
  cwd?: string;
  message?: {
    role?: string;
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  timestamp?: string;
};

// ─── Field extraction ──────────────────────────────────────

/**
 * 安全获取数字值，NaN/undefined 时返回 0。
 */
function num(v: unknown): number {
  return typeof v === 'number' && !isNaN(v) ? v : 0;
}

/**
 * 解析单行 JSON，提取 TokenUsageRecord（claude-code 格式）。
 *
 * @param line JSON 行
 * @param fallbackCwd 备用工作目录（行内没有 cwd 时使用）
 * @param fallbackSessionId 备用 session ID
 * @returns TokenUsageRecord 或 null（行不符合条件时）
 */
export function parseClaudeJsonlLine(
  line: string,
  fallbackCwd: string,
  fallbackSessionId: string,
): TokenUsageRecord | null {
  if (!line || !line.trim()) return null;

  let parsed: ClaudeJsonlRow;
  try {
    parsed = JSON.parse(line) as ClaudeJsonlRow;
  } catch {
    return null; // 无效 JSON
  }

  // 只处理 assistant 类型
  if (parsed.type !== 'assistant') return null;

  const msg = parsed.message;
  if (!msg || msg.role !== 'assistant') return null;

  const usage = msg.usage;
  if (!usage || typeof usage !== 'object') return null;

  const inputTokens = num(usage.input_tokens);
  const outputTokens = num(usage.output_tokens);
  const cacheReadTokens = num(usage.cache_read_input_tokens);
  const cacheWriteTokens = num(usage.cache_creation_input_tokens);
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;

  const messageId = msg.id || `claude-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionId = parsed.sessionId || fallbackSessionId;
  const model = msg.model || '';

  // Parse timestamp if present, fallback to now
  let timestamp = Date.now();
  if (parsed.timestamp) {
    const parsedTs = Date.parse(parsed.timestamp);
    if (!isNaN(parsedTs)) {
      timestamp = parsedTs;
    }
  }

  return {
    engine: 'claude-code',
    sessionId,
    messageId,
    model,
    provider: 'anthropic', // claude-code uses anthropic models
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: 0,
    totalTokens,
    costUsd: 0, // claude-code JSONL 不返回成本
    timestamp,
    projectId: '',
    cwd: parsed.cwd || fallbackCwd,
  };
}

// ─── Batch parsing ─────────────────────────────────────────

/**
 * 解析多行 JSONL，返回所有有效的 TokenUsageRecord。
 *
 * @param lines JSON 行数组
 * @param fallbackCwd 备用工作目录
 * @param fallbackSessionId 备用 session ID
 * @returns TokenUsageRecord 数组（仅包含有效记录）
 */
export function parseClaudeJsonlLines(
  lines: string[],
  fallbackCwd: string,
  fallbackSessionId: string,
): TokenUsageRecord[] {
  const records: TokenUsageRecord[] = [];

  for (const line of lines) {
    const record = parseClaudeJsonlLine(line, fallbackCwd, fallbackSessionId);
    if (record) {
      records.push(record);
    }
  }

  return records;
}

// ─── File parsing ──────────────────────────────────────────

/**
 * 从指定字节偏移量处读取文件内容（同步版本）。
 * 使用 readFileSync 然后截取，因为 JSONL 解析更适合按行处理。
 */
function readFileFromOffset(filePath: string, byteOffset: number): string | null {
  try {
    const stat = statSync(filePath);
    if (byteOffset >= stat.size) {
      return '';
    }
    // 读整个文件然后截取（对于日志文件通常不大）
    const content = readFileSync(filePath, 'utf8');
    return content.slice(byteOffset);
  } catch {
    return null;
  }
}

/**
 * 解析整个 JSONL 文件，返回所有有效的 TokenUsageRecord。
 *
 * 如果文件不存在或无法读取，返回空数组（静默降级）。
 * 支持增量解析：从 byteOffset 开始读取。
 *
 * @param filePath JSONL 文件的完整路径
 * @param byteOffset 起始字节偏移量（0 = 从头开始）
 * @returns TokenUsageRecord 数组
 */
export function parseClaudeJsonlFile(
  filePath: string,
  byteOffset: number = 0,
): TokenUsageRecord[] {
  try {
    const content = readFileFromOffset(filePath, byteOffset);
    if (!content) return [];

    const lines = content.split('\n').filter((l) => l.trim().length > 0);

    // 从文件名提取备用 sessionId（去掉 .jsonl 后缀）
    const fileName = filePath.split(/[/\\]/).pop() || 'unknown';
    const fallbackSessionId = fileName.replace(/\.jsonl$/, '');

    // 使用目录作为备用 cwd
    const lastSlash = filePath.lastIndexOf('/');
    const lastBackslash = filePath.lastIndexOf('\\');
    const lastSep = Math.max(lastSlash, lastBackslash);
    const fallbackCwd = lastSep >= 0 ? filePath.slice(0, lastSep) : '';

    return parseClaudeJsonlLines(lines, fallbackCwd, fallbackSessionId);
  } catch {
    return []; // 文件不存在或读取失败 → 静默降级
  }
}
