/**
 * Token Monitor DB 模块测试。
 *
 * 测试缝：模块公开 API（createMemoryDatabase / initDatabase / recordUsage / getSummary）。
 * 使用内存 SQLite 数据库（:memory:），与 dashboard-router.test.ts 先例一致。
 *
 * 验证：
 * - 表结构和索引正确创建
 * - INSERT OR IGNORE 去重（engine, session_id, message_id 组合唯一）
 * - recordUsage 写入字段正确
 * - getSummary 聚合查询正确
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

// ─── Hoisted tmp dir ───────────────────────────────────────

const { tmpDir } = vi.hoisted(() => {
  const os = require('node:os');
  const fs = require('node:fs');
  const dir = os.tmpdir() + `/sv-tok-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  fs.mkdirSync(dir, { recursive: true });
    return { tmpDir: dir };
});

// ─── Imports ───────────────────────────────────────────────

import {
  createMemoryDatabase,
  initDatabase,
  closeDatabase,
  recordUsage,
  getSummary,
  type TokenUsageRecord,
} from '../../src/main/token-monitor/token-monitor-db';

// ─── Test helpers ──────────────────────────────────────────

function makeRecord(overrides: Partial<TokenUsageRecord> = {}): TokenUsageRecord {
  return {
    engine: 'omp',
    sessionId: 'sess-1',
    messageId: 'msg-1',
    model: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 200,
    cacheWriteTokens: 100,
    reasoningTokens: 0,
    totalTokens: 1800,
    costUsd: 0.05,
    timestamp: Date.now(),
    projectId: 'test-project-id',
    cwd: '/proj/test',
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────

describe('Token Monitor DB — 表结构与索引', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMemoryDatabase();
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('token_usage 表包含所有必需字段', () => {
    const columns = db.prepare("PRAGMA table_info('token_usage')").all() as { name: string }[];
    const colNames = columns.map((c) => c.name);
    const expected = [
      'id', 'engine', 'session_id', 'message_id', 'model', 'provider',
      'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens',
      'reasoning_tokens', 'total_tokens', 'cost_usd', 'timestamp',
      'project_id', 'cwd',
    ];
    for (const col of expected) {
      expect(colNames).toContain(col);
    }
  });

  it('(engine, session_id, message_id) 组合唯一索引存在', () => {
    const indexes = db.prepare("PRAGMA index_list('token_usage')").all() as { name: string; origin: string }[];
    // UNIQUE constraint creates an index with origin 'u'
    const _uniqueIndexes = indexes.filter((i) => i.origin === 'u');
    // Verify by attempting duplicate insert
    const rec = makeRecord();
    recordUsage(db, rec);
    // Second insert with same (engine, session_id, message_id) should be ignored
    expect(() => recordUsage(db, { ...rec, totalTokens: 9999 })).not.toThrow();
    // Verify only one row exists
    const count = db.prepare('SELECT COUNT(*) as cnt FROM token_usage').get() as { cnt: number };
    expect(count.cnt).toBe(1);
    // And the first record's data is preserved (INSERT OR IGNORE keeps the original)
    const row = db.prepare('SELECT total_tokens FROM token_usage').get() as { total_tokens: number };
    expect(row.total_tokens).toBe(1800);
  });

  it('timestamp/engine/session_id/model 字段有索引', () => {
    const indexes = db.prepare("PRAGMA index_list('token_usage')").all() as { name: string }[];
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain('idx_token_usage_timestamp');
    expect(indexNames).toContain('idx_token_usage_engine');
    expect(indexNames).toContain('idx_token_usage_session');
    expect(indexNames).toContain('idx_token_usage_model');
  });
});

describe('Token Monitor DB — recordUsage 写入', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMemoryDatabase();
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('正确写入所有字段', () => {
    const rec = makeRecord({
      engine: 'omp',
      sessionId: 's1',
      messageId: 'm1',
      model: 'gpt-4o',
      provider: 'openai',
      inputTokens: 2000,
      outputTokens: 800,
      cacheReadTokens: 400,
      cacheWriteTokens: 200,
      reasoningTokens: 50,
      totalTokens: 3450,
      costUsd: 0.12,
      timestamp: 1700000000000,
      projectId: 'proj-1',
      cwd: '/proj/work',
    });
    recordUsage(db, rec);

    const row = db.prepare('SELECT * FROM token_usage WHERE session_id = ?').get('s1') as Record<string, unknown>;
    expect(row['engine']).toBe('omp');
    expect(row['session_id']).toBe('s1');
    expect(row['message_id']).toBe('m1');
    expect(row['model']).toBe('gpt-4o');
    expect(row['provider']).toBe('openai');
    expect(row['input_tokens']).toBe(2000);
    expect(row['output_tokens']).toBe(800);
    expect(row['cache_read_tokens']).toBe(400);
    expect(row['cache_write_tokens']).toBe(200);
    expect(row['reasoning_tokens']).toBe(50);
    expect(row['total_tokens']).toBe(3450);
    expect(row['cost_usd']).toBe(0.12);
    expect(row['timestamp']).toBe(1700000000000);
    expect(row['project_id']).toBe('proj-1');
    expect(row['cwd']).toBe('/proj/work');
  });

  it('重复 (engine, session_id, message_id) 通过 INSERT OR IGNORE 去重', () => {
    const rec = makeRecord({ engine: 'omp', sessionId: 's1', messageId: 'm1' });
    recordUsage(db, rec);
    recordUsage(db, { ...rec, totalTokens: 99999 }); // should be ignored
    recordUsage(db, { ...rec, totalTokens: 88888 }); // should be ignored

    const count = db.prepare('SELECT COUNT(*) as cnt FROM token_usage WHERE session_id = ?').get('s1') as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it('不同 engine 或 session_id 或 message_id 不去重', () => {
    recordUsage(db, makeRecord({ engine: 'omp', sessionId: 's1', messageId: 'm1' }));
    recordUsage(db, makeRecord({ engine: 'codex', sessionId: 's1', messageId: 'm1' }));
    recordUsage(db, makeRecord({ engine: 'omp', sessionId: 's2', messageId: 'm1' }));
    recordUsage(db, makeRecord({ engine: 'omp', sessionId: 's1', messageId: 'm2' }));

    const count = db.prepare('SELECT COUNT(*) as cnt FROM token_usage').get() as { cnt: number };
    expect(count.cnt).toBe(4);
  });
});

describe('Token Monitor DB — getSummary 聚合查询', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMemoryDatabase();
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('返回今日/本月/总 token 和今日 cost', () => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const todayTs = todayStart.getTime() + 3600000; // 1am today

    // Use a timestamp that is earlier this month, but not today.
    // If today is the 1st, use the 15th of last month instead.
    const dayOfMonth = now.getDate();
    let monthNotTodayTs: number;
    if (dayOfMonth > 1) {
      // Earlier this month
      monthNotTodayTs = new Date(now.getFullYear(), now.getMonth(), Math.max(1, dayOfMonth - 1), 10, 0, 0, 0).getTime();
    } else {
      // 1st of month — use 15th of last month
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15, 10, 0, 0, 0);
      monthNotTodayTs = lastMonth.getTime();
    }

    // Today's record
    recordUsage(db, makeRecord({
      sessionId: 's1', messageId: 'm1',
      totalTokens: 1000, costUsd: 0.05,
      timestamp: todayTs,
    }));
    // This month (but not today)
    recordUsage(db, makeRecord({
      sessionId: 's2', messageId: 'm2',
      totalTokens: 2000, costUsd: 0.10,
      timestamp: monthNotTodayTs,
    }));
    // Old record (3 months ago)
    const oldTs = now.getTime() - 90 * 24 * 60 * 60 * 1000;
    recordUsage(db, makeRecord({
      sessionId: 's3', messageId: 'm3',
      totalTokens: 500, costUsd: 0.02,
      timestamp: oldTs,
    }));

    const summary = getSummary(db);
    expect(summary.todayTokens).toBe(1000);
    expect(summary.monthTokens).toBe(3000); // today + 10 days ago
    expect(summary.totalTokens).toBe(3500); // all three
    expect(summary.todayCostUsd).toBeCloseTo(0.05, 5);
  });

  it('空数据库返回全零', () => {
    const summary = getSummary(db);
    expect(summary.todayTokens).toBe(0);
    expect(summary.monthTokens).toBe(0);
    expect(summary.totalTokens).toBe(0);
    expect(summary.todayCostUsd).toBe(0);
  });
});

describe('Token Monitor DB — 文件数据库初始化', () => {
  const _dbPath = join(tmpDir, 'token-monitor.db');

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('initDatabase 创建 .socverify/token-monitor.db 文件并初始化表', () => {
    const fullDbPath = join(tmpDir, '.socverify', 'token-monitor.db');
    const db = initDatabase(fullDbPath);
    expect(existsSync(fullDbPath)).toBe(true);

    // Tables exist
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expect(tables.some((t) => t.name === 'token_usage')).toBe(true);

    closeDatabase(db);
  });

  it('WAL 模式启用', () => {
    const fullDbPath = join(tmpDir, '.socverify', 'token-monitor-2.db');
    const db = initDatabase(fullDbPath);
    const pragmaResult = db.pragma('journal_mode') as { journal_mode: string }[];
    expect(pragmaResult[0].journal_mode).toBe('wal');
    closeDatabase(db);
  });
});
