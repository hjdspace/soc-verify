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
  getHeatmap,
  getStreaks,
  getModelBreakdown,
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

describe('Token Monitor DB — getModelBreakdown 聚合查询', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMemoryDatabase();
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('空数据库返回空数组', () => {
    const result = getModelBreakdown(db, 0);
    expect(result).toEqual([]);
  });

  it('按模型聚合 token/cost/cache 细节', () => {
    const now = Date.now();
    // Model A — two records
    recordUsage(db, makeRecord({
      model: 'claude-sonnet-4-20250514', sessionId: 's1', messageId: 'm1',
      totalTokens: 1000, costUsd: 0.05,
      inputTokens: 800, outputTokens: 200, cacheReadTokens: 100, cacheWriteTokens: 50,
      timestamp: now,
    }));
    recordUsage(db, makeRecord({
      model: 'claude-sonnet-4-20250514', sessionId: 's2', messageId: 'm2',
      totalTokens: 500, costUsd: 0.02,
      inputTokens: 400, outputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 0,
      timestamp: now,
    }));
    // Model B — one record
    recordUsage(db, makeRecord({
      model: 'gpt-4o', sessionId: 's3', messageId: 'm3',
      totalTokens: 2000, costUsd: 0.10,
      inputTokens: 1500, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 100,
      timestamp: now,
    }));

    const result = getModelBreakdown(db, 0);
    expect(result).toHaveLength(2);

    const modelA = result.find((e) => e.model === 'claude-sonnet-4-20250514')!;
    expect(modelA.totalTokens).toBe(1500); // 1000 + 500
    expect(modelA.costUsd).toBeCloseTo(0.07, 5);
    expect(modelA.inputTokens).toBe(1200); // 800 + 400
    expect(modelA.outputTokens).toBe(300); // 200 + 100
    expect(modelA.cacheReadTokens).toBe(150); // 100 + 50
    expect(modelA.cacheWriteTokens).toBe(50); // 50 + 0

    const modelB = result.find((e) => e.model === 'gpt-4o')!;
    expect(modelB.totalTokens).toBe(2000);
    expect(modelB.costUsd).toBeCloseTo(0.10, 5);
    expect(modelB.inputTokens).toBe(1500);
    expect(modelB.outputTokens).toBe(500);
    expect(modelB.cacheReadTokens).toBe(200);
    expect(modelB.cacheWriteTokens).toBe(100);
  });

  it('时间范围过滤（sinceTs）排除旧记录', () => {
    const now = Date.now();
    // Recent record
    recordUsage(db, makeRecord({
      model: 'gpt-4o', sessionId: 's1', messageId: 'm1',
      totalTokens: 1000, timestamp: now - 3 * 24 * 60 * 60 * 1000, // 3 days ago
    }));
    // Old record (10 days ago)
    recordUsage(db, makeRecord({
      model: 'gpt-4o', sessionId: 's2', messageId: 'm2',
      totalTokens: 2000, timestamp: now - 10 * 24 * 60 * 60 * 1000,
    }));

    const since7d = now - 7 * 24 * 60 * 60 * 1000;
    const result7d = getModelBreakdown(db, since7d);
    expect(result7d).toHaveLength(1);
    expect(result7d[0].totalTokens).toBe(1000); // only 3 days ago

    const resultAll = getModelBreakdown(db, 0);
    expect(resultAll).toHaveLength(1);
    expect(resultAll[0].totalTokens).toBe(3000); // both
  });

  it('同模型不同引擎记录被聚合到同一模型', () => {
    const now = Date.now();
    recordUsage(db, makeRecord({
      engine: 'omp', model: 'gpt-4o', sessionId: 's1', messageId: 'm1',
      totalTokens: 1000, timestamp: now,
    }));
    recordUsage(db, makeRecord({
      engine: 'claude-code', model: 'gpt-4o', sessionId: 's2', messageId: 'm2',
      totalTokens: 500, timestamp: now,
    }));

    const result = getModelBreakdown(db, 0);
    expect(result).toHaveLength(1);
    expect(result[0].model).toBe('gpt-4o');
    expect(result[0].totalTokens).toBe(1500);
  });
});

describe('Token Monitor DB — getHeatmap 聚合查询', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMemoryDatabase();
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('空数据库返回空数组', () => {
    const result = getHeatmap(db, 365);
    expect(result).toEqual([]);
  });

  it('返回最近 365 天按日聚合的 token 和 cost', () => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const todayTs = todayStart.getTime() + 3600000; // 1am today

    // Yesterday
    const yesterdayTs = todayTs - 24 * 60 * 60 * 1000;

    recordUsage(db, makeRecord({
      sessionId: 's1', messageId: 'm1',
      totalTokens: 1000, costUsd: 0.05,
      timestamp: todayTs,
    }));
    recordUsage(db, makeRecord({
      sessionId: 's2', messageId: 'm2',
      totalTokens: 500, costUsd: 0.02,
      timestamp: todayTs,
    }));
    recordUsage(db, makeRecord({
      sessionId: 's3', messageId: 'm3',
      totalTokens: 2000, costUsd: 0.10,
      timestamp: yesterdayTs,
    }));

    const result = getHeatmap(db, 365);
    expect(result.length).toBeGreaterThanOrEqual(2);

    // Find today's entry
    const todayDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const todayEntry = result.find((e) => e.date === todayDate);
    expect(todayEntry).toBeDefined();
    expect(todayEntry!.totalTokens).toBe(1500); // 1000 + 500
    expect(todayEntry!.costUsd).toBeCloseTo(0.07, 5);

    // Find yesterday's entry
    const yd = new Date(yesterdayTs);
    const ydStr = `${yd.getFullYear()}-${String(yd.getMonth() + 1).padStart(2, '0')}-${String(yd.getDate()).padStart(2, '0')}`;
    const ydEntry = result.find((e) => e.date === ydStr);
    expect(ydEntry).toBeDefined();
    expect(ydEntry!.totalTokens).toBe(2000);
  });

  it('只返回最近 N 天的数据', () => {
    const now = Date.now();
    // 3 days ago
    recordUsage(db, makeRecord({
      sessionId: 's1', messageId: 'm1',
      totalTokens: 1000, timestamp: now - 3 * 24 * 60 * 60 * 1000,
    }));
    // 10 days ago
    recordUsage(db, makeRecord({
      sessionId: 's2', messageId: 'm2',
      totalTokens: 2000, timestamp: now - 10 * 24 * 60 * 60 * 1000,
    }));

    const result7 = getHeatmap(db, 7);
    expect(result7).toHaveLength(1); // only 3 days ago

    const result365 = getHeatmap(db, 365);
    expect(result365).toHaveLength(2); // both
  });

  it('同一天多条记录聚合为一天', () => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const ts = todayStart.getTime() + 3600000;

    recordUsage(db, makeRecord({ sessionId: 's1', messageId: 'm1', totalTokens: 100, timestamp: ts }));
    recordUsage(db, makeRecord({ sessionId: 's2', messageId: 'm2', totalTokens: 200, timestamp: ts + 5000 }));
    recordUsage(db, makeRecord({ sessionId: 's3', messageId: 'm3', totalTokens: 300, timestamp: ts + 10000 }));

    const result = getHeatmap(db, 365);
    expect(result).toHaveLength(1);
    expect(result[0].totalTokens).toBe(600);
  });
});

describe('Token Monitor DB — getStreaks 连续使用天数', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMemoryDatabase();
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('空数据库返回全零', () => {
    const result = getStreaks(db);
    expect(result.currentStreak).toBe(0);
    expect(result.longestStreak).toBe(0);
  });

  it('今天有记录返回 current streak >= 1', () => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const todayTs = todayStart.getTime() + 3600000;

    recordUsage(db, makeRecord({
      sessionId: 's1', messageId: 'm1',
      totalTokens: 100, timestamp: todayTs,
    }));

    const result = getStreaks(db);
    expect(result.currentStreak).toBe(1);
    expect(result.longestStreak).toBe(1);
  });

  it('连续 3 天（今天 + 前 2 天）返回 current streak = 3', () => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);

    for (let i = 0; i < 3; i++) {
      const ts = todayStart.getTime() - i * 24 * 60 * 60 * 1000 + 3600000;
      recordUsage(db, makeRecord({
        sessionId: `s${i}`, messageId: `m${i}`,
        totalTokens: 100, timestamp: ts,
      }));
    }

    const result = getStreaks(db);
    expect(result.currentStreak).toBe(3);
    expect(result.longestStreak).toBe(3);
  });

  it('昨天有记录但今天没有，current streak = 0', () => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const yesterdayTs = todayStart.getTime() - 24 * 60 * 60 * 1000 + 3600000;

    recordUsage(db, makeRecord({
      sessionId: 's1', messageId: 'm1',
      totalTokens: 100, timestamp: yesterdayTs,
    }));

    const result = getStreaks(db);
    expect(result.currentStreak).toBe(0);
    expect(result.longestStreak).toBe(1);
  });

  it('中间断开 1 天，longest streak > current streak', () => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);

    // Day 0 (today)
    recordUsage(db, makeRecord({
      sessionId: 's0', messageId: 'm0',
      totalTokens: 100, timestamp: todayStart.getTime() + 3600000,
    }));
    // Day 1 (yesterday)
    recordUsage(db, makeRecord({
      sessionId: 's1', messageId: 'm1',
      totalTokens: 100, timestamp: todayStart.getTime() - 1 * 24 * 60 * 60 * 1000 + 3600000,
    }));
    // Day 3 (3 days ago — gap at day 2)
    recordUsage(db, makeRecord({
      sessionId: 's3', messageId: 'm3',
      totalTokens: 100, timestamp: todayStart.getTime() - 3 * 24 * 60 * 60 * 1000 + 3600000,
    }));
    // Day 4
    recordUsage(db, makeRecord({
      sessionId: 's4', messageId: 'm4',
      totalTokens: 100, timestamp: todayStart.getTime() - 4 * 24 * 60 * 60 * 1000 + 3600000,
    }));

    const result = getStreaks(db);
    // Today + yesterday = 2 (current)
    expect(result.currentStreak).toBe(2);
    // Day 3 + day 4 = 2 (longest is also 2)
    expect(result.longestStreak).toBe(2);
  });

  it('最长连续 5 天', () => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);

    // 5 consecutive days ending 3 days ago (gap to today)
    for (let i = 3; i <= 7; i++) {
      recordUsage(db, makeRecord({
        sessionId: `s${i}`, messageId: `m${i}`,
        totalTokens: 100, timestamp: todayStart.getTime() - i * 24 * 60 * 60 * 1000 + 3600000,
      }));
    }

    const result = getStreaks(db);
    expect(result.currentStreak).toBe(0); // no record today
    expect(result.longestStreak).toBe(5);
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
