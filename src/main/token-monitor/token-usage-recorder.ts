/**
 * Token Usage Recorder — 旁路拦截 message_end 事件，提取 usage 字段写入 Token Monitor DB。
 *
 * 在 SessionManager 的 attachEventForwarding 中调用：
 * 1. 检查事件类型是否为 message_end
 * 2. 检查 message.role 是否为 assistant
 * 3. 提取 usage 字段（input/output/cacheRead/cacheWrite/reasoningTokens/totalTokens/cost.total）
 * 4. 异步写入 Token Monitor DB（INSERT OR IGNORE 去重）
 *
 * 不阻塞事件转发到渲染进程，写入失败仅记 console.warn 日志。
 *
 * 参考 docs/prd/prd-token-monitor.md → omp message_end 事件 usage 字段映射
 */

import type { TokenUsageRecord, TokenEngine, TokenMonitorDb } from './token-monitor-db';

/** Recorder 上下文：从 SessionManager 传入的会话级元信息 */
export type RecorderContext = {
  sessionId: string;
  engine: TokenEngine;
  projectId: string;
  cwd: string;
};

// ─── Usage field extraction ───────────────────────────────

/**
 * 从 message_end 事件中提取 TokenUsageRecord。
 *
 * 事件 payload 格式（omp）：
 * {
 *   type: 'message_end',
 *   message: {
 *     role: 'assistant',
 *     id: 'msg-xxx',
 *     model: 'claude-sonnet-4-20250514',
 *     provider: 'anthropic',
 *     content: [...],
 *     usage: {
 *       input: number,
 *       output: number,
 *       cacheRead: number,
 *       cacheWrite: number,
 *       reasoningTokens?: number,
 *       totalTokens: number,
 *       cost: { input: number, output: number, cacheRead: number, cacheWrite: number, total: number }
 *     }
 *   }
 * }
 *
 * @returns TokenUsageRecord 或 null（事件不符合条件时）
 */
export function extractUsageFromEvent(
  event: unknown,
  ctx: RecorderContext,
): TokenUsageRecord | null {
  const evt = event as Record<string, unknown> | null;
  if (!evt || evt.type !== 'message_end') return null;

  const msg = evt.message as Record<string, unknown> | undefined;
  if (!msg || msg.role !== 'assistant') return null;

  const usage = msg.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== 'object') return null;

  // Extract numeric fields with safe defaults
  const num = (v: unknown): number => (typeof v === 'number' && !isNaN(v) ? v : 0);

  // Extract cost.total
  const cost = usage.cost as Record<string, unknown> | undefined;
  const costUsd = cost && typeof cost === 'object' ? num(cost.total) : 0;

  // messageId: use message.id, fallback to session + timestamp
  const messageId = typeof msg.id === 'string' && msg.id.length > 0
    ? msg.id
    : `${ctx.sessionId}-${Date.now()}`;

  // model and provider from message
  const model = typeof msg.model === 'string' ? msg.model : '';
  const provider = typeof msg.provider === 'string' ? msg.provider : '';

  return {
    engine: ctx.engine,
    sessionId: ctx.sessionId,
    messageId,
    model,
    provider,
    inputTokens: num(usage.input),
    outputTokens: num(usage.output),
    cacheReadTokens: num(usage.cacheRead),
    cacheWriteTokens: num(usage.cacheWrite),
    reasoningTokens: num(usage.reasoningTokens),
    totalTokens: num(usage.totalTokens),
    costUsd,
    timestamp: Date.now(),
    projectId: ctx.projectId,
    cwd: ctx.cwd,
  };
}

/**
 * 旁路写入：从 message_end 事件提取 usage 并写入 DB。
 *
 * 不阻塞事件转发，写入失败仅记 console.warn 日志。
 * 调用方在事件转发路径中同步调用此函数（fire-and-forget 语义）。
 *
 * @param db Token Monitor DB 实例（可能为 null，表示 DB 未初始化）
 * @param event 原始事件 payload
 * @param ctx 会话上下文
 */
export function recordUsageFromEvent(
  db: TokenMonitorDb | null,
  event: unknown,
  ctx: RecorderContext,
): void {
  if (!db) return;

  let record: TokenUsageRecord | null;
  try {
    record = extractUsageFromEvent(event, ctx);
  } catch (err) {
    console.warn('[token-monitor] extract usage failed:', err);
    return;
  }

  if (!record) return;

  try {
    // Inline the INSERT to avoid circular import with token-monitor-db
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO token_usage (
        engine, session_id, message_id, model, provider,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, total_tokens, cost_usd, timestamp, project_id, cwd
      ) VALUES (
        @engine, @sessionId, @messageId, @model, @provider,
        @inputTokens, @outputTokens, @cacheReadTokens, @cacheWriteTokens,
        @reasoningTokens, @totalTokens, @costUsd, @timestamp, @projectId, @cwd
      )
    `);
    stmt.run(record);
  } catch (err) {
    // Bypass: write failure should not affect the AI session
    console.warn('[token-monitor] record usage failed:', err);
  }
}
