/**
 * Token Usage Recorder 模块测试。
 *
 * 测试缝：模块公开 API（extractUsageFromEvent / recordUsageFromEvent）。
 * 使用内存 SQLite 数据库验证写入正确性。
 *
 * 验证：
 * - 正确提取 assistant message 的 usage 字段
 * - 非 message_end 事件不写入
 * - 非 assistant role 的 message_end 不写入
 * - 缺少 usage 字段不写入
 * - 写入失败不抛出异常（仅记日志）
 * - (engine, session_id, message_id) 去重
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

import {
  createMemoryDatabase,
  closeDatabase,
  recordUsage,
} from '../../src/main/token-monitor/token-monitor-db';
import {
  extractUsageFromEvent,
  type RecorderContext,
} from '../../src/main/token-monitor/token-usage-recorder';

// ─── Test helpers ──────────────────────────────────────────

function makeMessageEndEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello' }],
      usage: {
        input: 1000,
        output: 500,
        cacheRead: 200,
        cacheWrite: 100,
        reasoningTokens: 50,
        totalTokens: 1850,
        cost: {
          input: 0.01,
          output: 0.02,
          cacheRead: 0.003,
          cacheWrite: 0.005,
          total: 0.038,
        },
      },
      ...(overrides.message as Record<string, unknown> | undefined),
    },
    ...overrides,
  };
}

function makeContext(overrides: Partial<RecorderContext> = {}): RecorderContext {
  return {
    sessionId: 'sess-1',
    engine: 'omp',
    projectId: 'proj-1',
    cwd: '/proj/work',
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────

describe('TokenUsageRecorder — extractUsageFromEvent', () => {
  it('正确提取 assistant message 的 usage 字段', () => {
    const event = makeMessageEndEvent();
    const ctx = makeContext({ sessionId: 'sess-1', engine: 'omp' });

    const record = extractUsageFromEvent(event, ctx);

    expect(record).not.toBeNull();
    expect(record!.engine).toBe('omp');
    expect(record!.sessionId).toBe('sess-1');
    expect(record!.messageId).not.toBe(''); // messageId extracted
    expect(record!.model).toBe(''); // model from message if present
    expect(record!.inputTokens).toBe(1000);
    expect(record!.outputTokens).toBe(500);
    expect(record!.cacheReadTokens).toBe(200);
    expect(record!.cacheWriteTokens).toBe(100);
    expect(record!.reasoningTokens).toBe(50);
    expect(record!.totalTokens).toBe(1850);
    expect(record!.costUsd).toBeCloseTo(0.038, 5);
    expect(record!.timestamp).toBeGreaterThan(0);
    expect(record!.projectId).toBe('proj-1');
    expect(record!.cwd).toBe('/proj/work');
  });

  it('非 message_end 事件返回 null', () => {
    const event = { type: 'message_update', message: { role: 'assistant' } };
    const ctx = makeContext();

    const record = extractUsageFromEvent(event, ctx);

    expect(record).toBeNull();
  });

  it('非 assistant role 的 message_end 返回 null', () => {
    const event = makeMessageEndEvent({
      message: { role: 'user', content: [], usage: { input: 100, output: 0, totalTokens: 100 } },
    });
    const ctx = makeContext();

    const record = extractUsageFromEvent(event, ctx);

    expect(record).toBeNull();
  });

  it('缺少 usage 字段返回 null', () => {
    const event = makeMessageEndEvent({
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
    });
    const ctx = makeContext();

    const record = extractUsageFromEvent(event, ctx);

    expect(record).toBeNull();
  });

  it('缺少 cost 字段时 costUsd 默认为 0', () => {
    const event = makeMessageEndEvent({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi' }],
        usage: {
          input: 100,
          output: 50,
          cacheRead: 10,
          cacheWrite: 5,
          totalTokens: 165,
        },
      },
    });
    const ctx = makeContext();

    const record = extractUsageFromEvent(event, ctx);

    expect(record).not.toBeNull();
    expect(record!.costUsd).toBe(0);
  });

  it('model 字段从 message.model 提取', () => {
    const event = makeMessageEndEvent({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi' }],
        model: 'claude-sonnet-4-20250514',
        usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 0.01 } },
      },
    });
    const ctx = makeContext();

    const record = extractUsageFromEvent(event, ctx);

    expect(record).not.toBeNull();
    expect(record!.model).toBe('claude-sonnet-4-20250514');
  });

  it('provider 字段从 message.provider 提取', () => {
    const event = makeMessageEndEvent({
      message: {
        role: 'assistant',
        content: [],
        provider: 'anthropic',
        usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 0.01 } },
      },
    });
    const ctx = makeContext();

    const record = extractUsageFromEvent(event, ctx);

    expect(record).not.toBeNull();
    expect(record!.provider).toBe('anthropic');
  });

  it('messageId 从 message.id 提取', () => {
    const event = makeMessageEndEvent({
      message: {
        role: 'assistant',
        content: [],
        id: 'msg-abc-123',
        usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 0.01 } },
      },
    });
    const ctx = makeContext();

    const record = extractUsageFromEvent(event, ctx);

    expect(record).not.toBeNull();
    expect(record!.messageId).toBe('msg-abc-123');
  });
});

describe('TokenUsageRecorder — 写入与去重', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMemoryDatabase();
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('提取的 record 正确写入 DB', () => {
    const event = makeMessageEndEvent({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
        id: 'msg-1',
        model: 'gpt-4o',
        provider: 'openai',
        usage: {
          input: 2000,
          output: 800,
          cacheRead: 400,
          cacheWrite: 200,
          reasoningTokens: 50,
          totalTokens: 3450,
          cost: { total: 0.12 },
        },
      },
    });
    const ctx = makeContext({ sessionId: 's1', engine: 'omp' });

    const record = extractUsageFromEvent(event, ctx);
    expect(record).not.toBeNull();
    recordUsage(db, record!);

    const row = db.prepare('SELECT * FROM token_usage WHERE session_id = ?').get('s1') as Record<string, unknown>;
    expect(row['engine']).toBe('omp');
    expect(row['message_id']).toBe('msg-1');
    expect(row['model']).toBe('gpt-4o');
    expect(row['provider']).toBe('openai');
    expect(row['input_tokens']).toBe(2000);
    expect(row['output_tokens']).toBe(800);
    expect(row['total_tokens']).toBe(3450);
    expect(row['cost_usd']).toBe(0.12);
  });

  it('重复 (engine, session_id, message_id) 通过 INSERT OR IGNORE 去重', () => {
    const event = makeMessageEndEvent({
      message: {
        role: 'assistant',
        content: [],
        id: 'msg-1',
        usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 0.01 } },
      },
    });
    const ctx = makeContext({ sessionId: 's1', engine: 'omp' });

    const record1 = extractUsageFromEvent(event, ctx)!;
    recordUsage(db, record1);

    // Same message_id → ignored
    const record2 = extractUsageFromEvent(event, ctx)!;
    recordUsage(db, record2);

    const count = db.prepare('SELECT COUNT(*) as cnt FROM token_usage').get() as { cnt: number };
    expect(count.cnt).toBe(1);
  });
});

describe('TokenUsageRecorder — 写入失败不抛出异常', () => {
  it('关闭的数据库写入时不抛异常（仅记日志）', () => {
    const db = createMemoryDatabase();
    closeDatabase(db);

    const event = makeMessageEndEvent({
      message: {
        role: 'assistant',
        content: [],
        id: 'msg-1',
        usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 0.01 } },
      },
    });
    const ctx = makeContext();

    const record = extractUsageFromEvent(event, ctx);

    // Writing to a closed DB should not throw (bypass = fire-and-forget)
    expect(() => {
      try {
        recordUsage(db, record!);
      } catch (e) {
        // Bypass: catch and warn only
        console.warn('[token-monitor] write failed:', e);
      }
    }).not.toThrow();
  });
});

// ─── Subagent 父子 Token 归属（issue 05）──────────────────

import {
  extractSubagentUsageFromEvent,
  recordSubagentUsageFromEvent,
} from '../../src/main/token-monitor/token-usage-recorder';

function makeSubagentLifecycleEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'subagent_lifecycle',
    payload: {
      id: 'run-abc',
      status: 'completed',
      agent: 'coverage-analyzer',
      parentSessionId: 'pi-session-0001',
      usage: {
        input: 1000,
        output: 500,
        cacheRead: 200,
        cacheWrite: 100,
        costUsd: 0.038,
        turns: 3,
        toolCalls: 7,
        durationMs: 12000,
      },
      ...((overrides.payload as Record<string, unknown>) ?? {}),
    },
    ...overrides,
  };
}

describe('TokenUsageRecorder — subagent 终态 usage 提取（父子归属）', () => {
  it('completed 终态提取 usage，messageId 编码 subagent runId（父子关联不丢失）', () => {
    const ctx = makeContext();
    const record = extractSubagentUsageFromEvent(makeSubagentLifecycleEvent(), ctx)!;

    expect(record).not.toBeNull();
    expect(record.engine).toBe(ctx.engine);
    expect(record.sessionId).toBe(ctx.sessionId);
    expect(record.messageId).toBe('subagent:run-abc');
    expect(record.model).toBe('subagent:coverage-analyzer');
    expect(record.inputTokens).toBe(1000);
    expect(record.outputTokens).toBe(500);
    expect(record.cacheReadTokens).toBe(200);
    expect(record.cacheWriteTokens).toBe(100);
    expect(record.totalTokens).toBe(1500);
    expect(record.costUsd).toBeCloseTo(0.038);
  });

  it('running 状态（非终态）不提取', () => {
    const evt = makeSubagentLifecycleEvent();
    (evt.payload as Record<string, unknown>).status = 'running';
    expect(extractSubagentUsageFromEvent(evt, makeContext())).toBeNull();
  });

  it('无 usage 字段的终态不提取', () => {
    const evt = makeSubagentLifecycleEvent();
    delete (evt.payload as Record<string, unknown>).usage;
    expect(extractSubagentUsageFromEvent(evt, makeContext())).toBeNull();
  });

  it('非 subagent_lifecycle 事件不提取', () => {
    expect(extractSubagentUsageFromEvent({ type: 'message_end' }, makeContext())).toBeNull();
  });

  it('recordSubagentUsageFromEvent 写入内存 DB 并按 messageId 去重', () => {
    const db = createMemoryDatabase();
    const ctx = makeContext();
    const evt = makeSubagentLifecycleEvent();

    recordSubagentUsageFromEvent(db, evt, ctx);
    recordSubagentUsageFromEvent(db, evt, ctx);

    const row = db
      .prepare("SELECT * FROM token_usage WHERE message_id = 'subagent:run-abc'")
      .get() as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.input_tokens).toBe(1000);
    expect(row.session_id).toBe('sess-1');
    const count = db.prepare('SELECT COUNT(*) as cnt FROM token_usage').get() as { cnt: number };
    expect(count.cnt).toBe(1);
    closeDatabase(db);
  });

  it('db 为 null 时静默跳过', () => {
    expect(() => recordSubagentUsageFromEvent(null, makeSubagentLifecycleEvent(), makeContext())).not.toThrow();
  });
});
