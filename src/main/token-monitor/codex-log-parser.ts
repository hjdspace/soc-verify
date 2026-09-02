/**
 * Codex Log Parser — 解析 codex CLI 的 JSONL 日志文件。
 *
 * 格式说明（codex JSONL）：
 * 每行是一个 JSON 对象，包含 sessionId、messageId、message 字段。
 * 只有 message.role === 'assistant' 且包含 usage 的行才有效。
 *
 * 字段映射（codex → TokenUsageRecord）：
 * - sessionId → sessionId
 * - messageId → messageId
 * - message.model → model
 * - message.provider → provider
 * - message.usage.input_tokens → inputTokens
 * - message.usage.output_tokens → outputTokens
 * - message.usage.total_tokens → totalTokens
 * - message.cost.total → costUsd
 *
 * 注意：codex 的 JSONL 格式与 claude-code 有一些差异：
 * 1. 顶层直接有 sessionId 和 messageId，而不是嵌套在 message 中
 * 2. usage 字段在 message 内部，不在 message 外部
 * 3. cost 在 message 内部
 */

import { readFileSync, statSync } from 'node:fs';
import type { TokenUsageRecord } from './token-monitor-db';

// ─── Types ─────────────────────────────────────────────────

/** 单行 JSON 解析的中间类型（codex 格式） */
type CodexJsonlRow = {
  sessionId?: string;
  messageId?: string;
  type?: string;
  timestamp?: string;
  cwd?: string;
  message?: {
    role?: string;
    model?: string;
    provider?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
    cost?: {
      input?: number;
      output?: number;
      total?: number;
    };
  };
};

// ─── Field extraction ──────────────────────────────────────

/**
 * 安全获取数字值，NaN/undefined 时返回 0。
 */
function num(v: unknown): number {
  return typeof v === 'number' && !isNaN(v) ? v : 0;
}

/**
 * 解析单行 JSON，提取 TokenUsageRecord（codex 格式）。
 *
 * @param line JSON 行
 * @param fallbackCwd 备用工作目录
 * @param fallbackSessionId 备用 session ID
 * @returns TokenUsageRecord 或 null（行不符合条件时）
 */
export function parseCodexJsonlLine(
  line: string,
  fallbackCwd: string,
  fallbackSessionId: string,
): TokenUsageRecord | null {
  if (!line || !line.trim()) return null;

  let parsed: CodexJsonlRow;
  try {
    parsed = JSON.parse(line) as CodexJsonlRow;
  } catch {
    return null; // 无效 JSON
  }

  const msg = parsed.message;
  if (!msg || msg.role !== 'assistant') return null;

  const usage = msg.usage;
  if (!usage || typeof usage !== 'object') return null;

  const inputTokens = num(usage.input_tokens);
  const outputTokens = num(usage.output_tokens);
  const totalTokens = num(usage.total_tokens);

  // Extract cost
  const cost = msg.cost;
  const costUsd = cost && typeof cost === 'object' ? num(cost.total) : 0;

  const messageId = parsed.messageId || `codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionId = parsed.sessionId || fallbackSessionId;
  const model = msg.model || '';
  const provider = msg.provider || '';

  // Parse timestamp
  let timestamp = Date.now();
  if (parsed.timestamp) {
    const parsedTs = Date.parse(parsed.timestamp);
    if (!isNaN(parsedTs)) {
      timestamp = parsedTs;
    }
  }

  return {
    engine: 'codex',
    sessionId,
    messageId,
    model,
    provider,
    inputTokens,
    outputTokens,
    cacheReadTokens: 0, // codex JSONL 通常不区分 cache
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: totalTokens > 0 ? totalTokens : inputTokens + outputTokens,
    costUsd,
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
export function parseCodexJsonlLines(
  lines: string[],
  fallbackCwd: string,
  fallbackSessionId: string,
): TokenUsageRecord[] {
  const records: TokenUsageRecord[] = [];

  for (const line of lines) {
    const record = parseCodexJsonlLine(line, fallbackCwd, fallbackSessionId);
    if (record) {
      records.push(record);
    }
  }

  return records;
}

// ─── File parsing ─────────────────────────────

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
export function parseCodexJsonlFile(
  filePath: string,
  byteOffset: number = 0,
): TokenUsageRecord[] {
  let content: string | null = null;

  try {
    const stat = statSync(filePath);
    if (byteOffset >= stat.size) {
      return [];
    }
    content = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  if (byteOffset > 0) {
    content = content!.slice(byteOffset);
  }

  const lines = content.split('\n').filter((l) => l.trim().length > 0);

  // 从文件名提取备用 sessionId
  const fileName = filePath.split(/[/\\]/).pop() || 'unknown';
  const fallbackSessionId = fileName.replace(/\.jsonl$/, '');

  // 使用目录作为备用 cwd
  const lastSlash = filePath.lastIndexOf('/');
  const lastBackslash = filePath.lastIndexOf('\\');
  const lastSep = Math.max(lastSlash, lastBackslash);
  const fallbackCwd = lastSep >= 0 ? filePath.slice(0, lastSep) : '';

  return parseCodexJsonlLines(lines, fallbackCwd, fallbackSessionId);
}
