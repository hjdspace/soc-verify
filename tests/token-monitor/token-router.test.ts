/**
 * token-router 端到端测试。
 *
 * 测试缝：tRPC server-side caller（router.createCaller）。
 * mock requireProject 返回固定项目路径，tokenMonitorRegistry 返回内存 DB。
 * 先例：tests/dashboard-router.test.ts
 */

import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import type Database from 'better-sqlite3';

// ─── Hoisted tmp dir ───────────────────────────────────────

const { tmpDir } = vi.hoisted(() => {
  const os = require('node:os');
  const fs = require('node:fs');
  const dir = os.tmpdir() + `/sv-tok-router-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  fs.mkdirSync(dir, { recursive: true });
  return { tmpDir: dir };
});

// ─── Shared DB ref ─────────────────────────────────────────

const dbRef: { current: Database.Database | null } = { current: null };

// ─── Mocks ─────────────────────────────────────────────────

vi.mock('../../src/main/services/project-service', () => ({
  requireProject: vi.fn((projectId: string) => ({
    id: projectId,
    rootPath: tmpDir,
    name: 'Test Project',
  })),
}));

vi.mock('../../src/main/token-monitor/token-monitor-registry', () => ({
  tokenMonitorRegistry: {
    getOrCreateDb: vi.fn(() => dbRef.current),
  },
}));

// ─── Imports (after mocks) ─────────────────────────────────

import { createMemoryDatabase, closeDatabase, recordUsage, type TokenUsageRecord } from '../../src/main/token-monitor/token-monitor-db';
import { tokenRouter } from '../../src/main/ipc/routers/token-router';

// ─── Setup ─────────────────────────────────────────────────

dbRef.current = createMemoryDatabase();
const memDb = dbRef.current;

const caller = tokenRouter.createCaller({});

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

describe('token-router — summary procedure', () => {
  beforeEach(() => {
    memDb.exec('DELETE FROM token_usage');
  });

  it('返回空数据库的全零汇总', async () => {
    const summary = await caller.summary({ projectId: 'test-project-id' });
    expect(summary.todayTokens).toBe(0);
    expect(summary.monthTokens).toBe(0);
    expect(summary.totalTokens).toBe(0);
    expect(summary.todayCostUsd).toBe(0);
  });

  it('返回正确的今日/本月/总 token 聚合', async () => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const todayTs = todayStart.getTime() + 3600000;

    // Today
    recordUsage(memDb, makeRecord({
      sessionId: 's1', messageId: 'm1',
      totalTokens: 1000, costUsd: 0.05,
      timestamp: todayTs,
    }));

    // This month but not today
    const dayOfMonth = now.getDate();
    let monthTs: number;
    if (dayOfMonth > 1) {
      monthTs = new Date(now.getFullYear(), now.getMonth(), Math.max(1, dayOfMonth - 1), 10, 0, 0, 0).getTime();
    } else {
      monthTs = new Date(now.getFullYear(), now.getMonth() - 1, 15, 10, 0, 0, 0).getTime();
    }
    recordUsage(memDb, makeRecord({
      sessionId: 's2', messageId: 'm2',
      totalTokens: 2000, costUsd: 0.10,
      timestamp: monthTs,
    }));

    // Old (3 months ago)
    const oldTs = now.getTime() - 90 * 24 * 60 * 60 * 1000;
    recordUsage(memDb, makeRecord({
      sessionId: 's3', messageId: 'm3',
      totalTokens: 500, costUsd: 0.02,
      timestamp: oldTs,
    }));

    const summary = await caller.summary({ projectId: 'test-project-id' });
    expect(summary.todayTokens).toBe(1000);
    expect(summary.monthTokens).toBe(3000);
    expect(summary.totalTokens).toBe(3500);
    expect(summary.todayCostUsd).toBeCloseTo(0.05, 5);
  });

  it('支持时间范围过滤（最近 7 天）', async () => {
    const now = Date.now();
    // 3 days ago — within 7d range
    recordUsage(memDb, makeRecord({
      sessionId: 's1', messageId: 'm1',
      totalTokens: 500, timestamp: now - 3 * 24 * 60 * 60 * 1000,
    }));
    // 10 days ago — outside 7d range
    recordUsage(memDb, makeRecord({
      sessionId: 's2', messageId: 'm2',
      totalTokens: 1000, timestamp: now - 10 * 24 * 60 * 60 * 1000,
    }));

    const summary7d = await caller.summary({ projectId: 'test-project-id', timeRange: '7d' });
    expect(summary7d.todayTokens).toBe(0); // no records today
    expect(summary7d.totalTokens).toBe(500); // only 3 days ago within 7d

    const summaryAll = await caller.summary({ projectId: 'test-project-id', timeRange: 'all' });
    expect(summaryAll.totalTokens).toBe(1500);
  });
});

describe('token-router — trends procedure', () => {
  beforeEach(() => {
    memDb.exec('DELETE FROM token_usage');
  });

  it('空数据库返回空数组', async () => {
    const trends = await caller.trends({ projectId: 'test-project-id' });
    expect(trends).toEqual([]);
  });

  it('按引擎分组返回按日聚合数据', async () => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const ts = todayStart.getTime() + 3600000;

    // Today — omp + claude-code
    recordUsage(memDb, makeRecord({
      engine: 'omp', sessionId: 's1', messageId: 'm1',
      totalTokens: 1000, timestamp: ts,
    }));
    recordUsage(memDb, makeRecord({
      engine: 'claude-code', sessionId: 's2', messageId: 'm2',
      totalTokens: 500, timestamp: ts,
    }));

    // Yesterday — omp
    const yesterdayTs = ts - 24 * 60 * 60 * 1000;
    recordUsage(memDb, makeRecord({
      engine: 'omp', sessionId: 's3', messageId: 'm3',
      totalTokens: 2000, timestamp: yesterdayTs,
    }));

    const trends = await caller.trends({ projectId: 'test-project-id' });
    expect(trends).toHaveLength(2);

    // Yesterday is first (ascending)
    const yesterdayDate = new Date(yesterdayTs);
    const ydStr = `${yesterdayDate.getFullYear()}-${String(yesterdayDate.getMonth() + 1).padStart(2, '0')}-${String(yesterdayDate.getDate()).padStart(2, '0')}`;
    expect(trends[0].date).toBe(ydStr);
    expect(trends[0].groups).toHaveLength(1);
    expect(trends[0].groups[0].group).toBe('omp');
    expect(trends[0].groups[0].totalTokens).toBe(2000);

    // Today has omp + claude-code
    const todayDate = new Date(ts);
    const tdStr = `${todayDate.getFullYear()}-${String(todayDate.getMonth() + 1).padStart(2, '0')}-${String(todayDate.getDate()).padStart(2, '0')}`;
    expect(trends[1].date).toBe(tdStr);
    expect(trends[1].groups).toHaveLength(2);
  });

  it('支持按模型分组', async () => {
    const now = Date.now();
    recordUsage(memDb, makeRecord({
      engine: 'omp', model: 'gpt-4o', sessionId: 's1', messageId: 'm1',
      totalTokens: 1000, timestamp: now,
    }));
    recordUsage(memDb, makeRecord({
      engine: 'claude-code', model: 'claude-sonnet-4-20250514', sessionId: 's2', messageId: 'm2',
      totalTokens: 500, timestamp: now,
    }));
    recordUsage(memDb, makeRecord({
      engine: 'omp', model: 'gpt-4o', sessionId: 's3', messageId: 'm3',
      totalTokens: 300, timestamp: now,
    }));

    const trends = await caller.trends({ projectId: 'test-project-id', groupBy: 'model' });
    expect(trends).toHaveLength(1);
    const day = trends[0];
    expect(day.groups).toHaveLength(2);
    const gpt4 = day.groups.find((g) => g.group === 'gpt-4o');
    const sonnet = day.groups.find((g) => g.group === 'claude-sonnet-4-20250514');
    expect(gpt4?.totalTokens).toBe(1300); // 1000 + 300
    expect(sonnet?.totalTokens).toBe(500);
  });

  it('支持时间范围过滤（7d）', async () => {
    const now = Date.now();
    // 3 days ago — within 7d
    recordUsage(memDb, makeRecord({
      sessionId: 's1', messageId: 'm1',
      totalTokens: 500, timestamp: now - 3 * 24 * 60 * 60 * 1000,
    }));
    // 10 days ago — outside 7d
    recordUsage(memDb, makeRecord({
      sessionId: 's2', messageId: 'm2',
      totalTokens: 1000, timestamp: now - 10 * 24 * 60 * 60 * 1000,
    }));

    const trends7d = await caller.trends({ projectId: 'test-project-id', timeRange: '7d' });
    const trendsAll = await caller.trends({ projectId: 'test-project-id', timeRange: 'all' });

    expect(trends7d).toHaveLength(1); // only 3 days ago
    expect(trendsAll).toHaveLength(2); // both
  });
});

describe('token-router — engineBreakdown procedure', () => {
  beforeEach(() => {
    memDb.exec('DELETE FROM token_usage');
  });

  it('空数据库返回三引擎全零', async () => {
    const result = await caller.engineBreakdown({ projectId: 'test-project-id' });
    expect(result).toHaveLength(3);
    for (const entry of result) {
      expect(entry.todayTokens).toBe(0);
      expect(entry.monthTokens).toBe(0);
      expect(entry.totalTokens).toBe(0);
      expect(entry.todayCost).toBe(0);
      expect(entry.totalCost).toBe(0);
      expect(entry.inputTokens).toBe(0);
      expect(entry.outputTokens).toBe(0);
      expect(entry.cacheReadTokens).toBe(0);
      expect(entry.cacheWriteTokens).toBe(0);
    }
  });

  it('返回三引擎的今日/本月/总 token + cost + cache 细节', async () => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const todayTs = todayStart.getTime() + 3600000;

    // Today — omp
    recordUsage(memDb, makeRecord({
      engine: 'omp', sessionId: 's1', messageId: 'm1',
      totalTokens: 1000, costUsd: 0.05,
      inputTokens: 800, outputTokens: 200, cacheReadTokens: 100, cacheWriteTokens: 50,
      timestamp: todayTs,
    }));

    // Today — claude-code
    recordUsage(memDb, makeRecord({
      engine: 'claude-code', sessionId: 's2', messageId: 'm2',
      totalTokens: 500, costUsd: 0.03,
      inputTokens: 400, outputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 0,
      timestamp: todayTs,
    }));

    // Old — codex (3 months ago)
    const oldTs = now.getTime() - 90 * 24 * 60 * 60 * 1000;
    recordUsage(memDb, makeRecord({
      engine: 'codex', sessionId: 's3', messageId: 'm3',
      totalTokens: 2000, costUsd: 0.10,
      inputTokens: 1500, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 100,
      timestamp: oldTs,
    }));

    const result = await caller.engineBreakdown({ projectId: 'test-project-id' });
    expect(result).toHaveLength(3);

    const omp = result.find((e) => e.engine === 'omp')!;
    expect(omp.todayTokens).toBe(1000);
    expect(omp.monthTokens).toBe(1000);
    expect(omp.totalTokens).toBe(1000);
    expect(omp.todayCost).toBeCloseTo(0.05, 5);
    expect(omp.inputTokens).toBe(800);
    expect(omp.outputTokens).toBe(200);
    expect(omp.cacheReadTokens).toBe(100);
    expect(omp.cacheWriteTokens).toBe(50);

    const claude = result.find((e) => e.engine === 'claude-code')!;
    expect(claude.todayTokens).toBe(500);
    expect(claude.totalTokens).toBe(500);

    const codex = result.find((e) => e.engine === 'codex')!;
    expect(codex.todayTokens).toBe(0); // old record
    expect(codex.totalTokens).toBe(2000);
    expect(codex.cacheReadTokens).toBe(200);
  });

  it('时间范围过滤只影响"总"统计', async () => {
    const now = Date.now();
    // 3 days ago — within 7d
    recordUsage(memDb, makeRecord({
      engine: 'omp', sessionId: 's1', messageId: 'm1',
      totalTokens: 500, costUsd: 0.02,
      timestamp: now - 3 * 24 * 60 * 60 * 1000,
    }));
    // 10 days ago — outside 7d
    recordUsage(memDb, makeRecord({
      engine: 'omp', sessionId: 's2', messageId: 'm2',
      totalTokens: 1000, costUsd: 0.05,
      timestamp: now - 10 * 24 * 60 * 60 * 1000,
    }));

    const result7d = await caller.engineBreakdown({ projectId: 'test-project-id', timeRange: '7d' });
    const resultAll = await caller.engineBreakdown({ projectId: 'test-project-id', timeRange: 'all' });

    const omp7d = result7d.find((e) => e.engine === 'omp')!;
    expect(omp7d.totalTokens).toBe(500); // only 3 days ago within 7d

    const ompAll = resultAll.find((e) => e.engine === 'omp')!;
    expect(ompAll.totalTokens).toBe(1500); // both
  });
});

describe('token-router — modelBreakdown procedure', () => {
  beforeEach(() => {
    memDb.exec('DELETE FROM token_usage');
  });

  it('空数据库返回空数组', async () => {
    const result = await caller.modelBreakdown({ projectId: 'test-project-id' });
    expect(result).toEqual([]);
  });

  it('按模型聚合 token/cost/cache 数据', async () => {
    const now = Date.now();
    // Model A — two records
    recordUsage(memDb, makeRecord({
      model: 'claude-sonnet-4-20250514', sessionId: 's1', messageId: 'm1',
      totalTokens: 1000, costUsd: 0.05,
      inputTokens: 800, outputTokens: 200, cacheReadTokens: 100, cacheWriteTokens: 50,
      timestamp: now,
    }));
    recordUsage(memDb, makeRecord({
      model: 'claude-sonnet-4-20250514', sessionId: 's2', messageId: 'm2',
      totalTokens: 500, costUsd: 0.02,
      inputTokens: 400, outputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 0,
      timestamp: now,
    }));
    // Model B — one record
    recordUsage(memDb, makeRecord({
      model: 'gpt-4o', sessionId: 's3', messageId: 'm3',
      totalTokens: 2000, costUsd: 0.10,
      inputTokens: 1500, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 100,
      timestamp: now,
    }));

    const result = await caller.modelBreakdown({ projectId: 'test-project-id' });
    expect(result).toHaveLength(2);

    const modelA = result.find((e) => e.model === 'claude-sonnet-4-20250514')!;
    expect(modelA.totalTokens).toBe(1500);
    expect(modelA.costUsd).toBeCloseTo(0.07, 5);
    expect(modelA.inputTokens).toBe(1200);
    expect(modelA.outputTokens).toBe(300);
    expect(modelA.cacheReadTokens).toBe(150);
    expect(modelA.cacheWriteTokens).toBe(50);

    const modelB = result.find((e) => e.model === 'gpt-4o')!;
    expect(modelB.totalTokens).toBe(2000);
    expect(modelB.costUsd).toBeCloseTo(0.10, 5);
  });

  it('支持时间范围过滤（7d）', async () => {
    const now = Date.now();
    // 3 days ago — within 7d
    recordUsage(memDb, makeRecord({
      model: 'gpt-4o', sessionId: 's1', messageId: 'm1',
      totalTokens: 1000, timestamp: now - 3 * 24 * 60 * 60 * 1000,
    }));
    // 10 days ago — outside 7d
    recordUsage(memDb, makeRecord({
      model: 'gpt-4o', sessionId: 's2', messageId: 'm2',
      totalTokens: 2000, timestamp: now - 10 * 24 * 60 * 60 * 1000,
    }));

    const result7d = await caller.modelBreakdown({ projectId: 'test-project-id', timeRange: '7d' });
    expect(result7d).toHaveLength(1);
    expect(result7d[0].totalTokens).toBe(1000);

    const resultAll = await caller.modelBreakdown({ projectId: 'test-project-id', timeRange: 'all' });
    expect(resultAll).toHaveLength(1);
    expect(resultAll[0].totalTokens).toBe(3000);
  });
});

// ─── Sessions + SessionDetail Tests (Issue #4) ────────────

describe('token-router — sessions procedure', () => {
  beforeEach(() => {
    memDb.exec('DELETE FROM token_USAGE');
  });

  it('空数据库返回空数组和零总数', async () => {
    const result = await caller.sessions({ projectId: 'test-project-id' });
    expect(result.sessions).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('按会话聚合返回正确的 token/cost 汇总', async () => {
    const now = Date.now();
    const ts = now - 60 * 1000; // 1 minute ago

    // Session 1 — 2 messages
    recordUsage(memDb, makeRecord({
      engine: 'omp', sessionId: 'sess-1', messageId: 'm1',
      model: 'claude-sonnet-4-20250514',
      totalTokens: 1000, costUsd: 0.05, timestamp: ts,
    }));
    recordUsage(memDb, makeRecord({
      engine: 'omp', sessionId: 'sess-1', messageId: 'm2',
      totalTokens: 500, costUsd: 0.02, timestamp: ts + 1000,
    }));

    // Session 2 — 1 message
    recordUsage(memDb, makeRecord({
      engine: 'claude-code', sessionId: 'sess-2', messageId: 'm3',
      model: 'gpt-4o',
      totalTokens: 2000, costUsd: 0.10, timestamp: ts + 2000,
    }));

    const result = await caller.sessions({ projectId: 'test-project-id' });
    expect(result.total).toBe(2);
    expect(result.sessions).toHaveLength(2);

    const s1 = result.sessions.find((s) => s.sessionId === 'sess-1')!;
    expect(s1.engine).toBe('omp');
    expect(s1.model).toBe('claude-sonnet-4-20250514');
    expect(s1.totalTokens).toBe(1500);
    expect(s1.totalCost).toBeCloseTo(0.07, 5);
    expect(s1.messageCount).toBe(2);

    const s2 = result.sessions.find((s) => s.sessionId === 'sess-2')!;
    expect(s2.engine).toBe('claude-code');
    expect(s2.totalTokens).toBe(2000);
    expect(s2.messageCount).toBe(1);
  });

  it('支持按引擎筛选', async () => {
    const now = Date.now();
    recordUsage(memDb, makeRecord({
      engine: 'omp', sessionId: 's1', messageId: 'm1',
      totalTokens: 1000, timestamp: now,
    }));
    recordUsage(memDb, makeRecord({
      engine: 'claude-code', sessionId: 's2', messageId: 'm2',
      totalTokens: 500, timestamp: now,
    }));
    recordUsage(memDb, makeRecord({
      engine: 'codex', sessionId: 's3', messageId: 'm3',
      totalTokens: 200, timestamp: now,
    }));

    const resultAll = await caller.sessions({ projectId: 'test-project-id' });
    expect(resultAll.total).toBe(3);

    const resultOmp = await caller.sessions({ projectId: 'test-project-id', engine: 'omp' });
    expect(resultOmp.total).toBe(1);
    expect(resultOmp.sessions[0].engine).toBe('omp');

    const resultClaude = await caller.sessions({ projectId: 'test-project-id', engine: 'claude-code' });
    expect(resultClaude.total).toBe(1);
    expect(resultClaude.sessions[0].engine).toBe('claude-code');
  });

  it('支持按时间降序排序（默认）', async () => {
    const now = Date.now();
    recordUsage(memDb, makeRecord({
      sessionId: 's1', messageId: 'm1', totalTokens: 100,
      timestamp: now - 2 * 60 * 1000,
    }));
    recordUsage(memDb, makeRecord({
      sessionId: 's2', messageId: 'm2', totalTokens: 200,
      timestamp: now - 1 * 60 * 1000,
    }));
    recordUsage(memDb, makeRecord({
      sessionId: 's3', messageId: 'm3', totalTokens: 300,
      timestamp: now,
    }));

    const result = await caller.sessions({ projectId: 'test-project-id' });
    expect(result.sessions[0].sessionId).toBe('s3'); // newest first
    expect(result.sessions[1].sessionId).toBe('s2');
    expect(result.sessions[2].sessionId).toBe('s1');
  });

  it('支持按 token 升序排序', async () => {
    const now = Date.now();
    recordUsage(memDb, makeRecord({
      sessionId: 's1', messageId: 'm1', totalTokens: 300, timestamp: now,
    }));
    recordUsage(memDb, makeRecord({
      sessionId: 's2', messageId: 'm2', totalTokens: 100, timestamp: now,
    }));
    recordUsage(memDb, makeRecord({
      sessionId: 's3', messageId: 'm3', totalTokens: 200, timestamp: now,
    }));

    const result = await caller.sessions({
      projectId: 'test-project-id',
      sortBy: 'tokens',
      sortDir: 'asc',
    });
    expect(result.sessions[0].sessionId).toBe('s2'); // 100 tokens
    expect(result.sessions[1].sessionId).toBe('s3'); // 200 tokens
    expect(result.sessions[2].sessionId).toBe('s1'); // 300 tokens
  });

  it('支持按 cost 降序排序', async () => {
    const now = Date.now();
    recordUsage(memDb, makeRecord({
      sessionId: 's1', messageId: 'm1', totalTokens: 100, costUsd: 0.05, timestamp: now,
    }));
    recordUsage(memDb, makeRecord({
      sessionId: 's2', messageId: 'm2', totalTokens: 100, costUsd: 0.20, timestamp: now,
    }));
    recordUsage(memDb, makeRecord({
      sessionId: 's3', messageId: 'm3', totalTokens: 100, costUsd: 0.10, timestamp: now,
    }));

    const result = await caller.sessions({
      projectId: 'test-project-id',
      sortBy: 'cost',
      sortDir: 'desc',
    });
    expect(result.sessions[0].sessionId).toBe('s2'); // 0.20
    expect(result.sessions[1].sessionId).toBe('s3'); // 0.10
    expect(result.sessions[2].sessionId).toBe('s1'); // 0.05
  });

  it('支持分页（每页 50 条）', async () => {
    const now = Date.now();
    // Create 60 sessions
    for (let i = 0; i < 60; i++) {
      recordUsage(memDb, makeRecord({
        sessionId: `sess-${String(i).padStart(3, '0')}`,
        messageId: 'm1',
        totalTokens: 100,
        timestamp: now - i * 1000,
      }));
    }

    const page1 = await caller.sessions({ projectId: 'test-project-id', page: 1, pageSize: 50 });
    expect(page1.total).toBe(60);
    expect(page1.sessions).toHaveLength(50);

    const page2 = await caller.sessions({ projectId: 'test-project-id', page: 2, pageSize: 50 });
    expect(page2.sessions).toHaveLength(10);
  });

  it('计算会话持续时间', async () => {
    const now = Date.now();
    recordUsage(memDb, makeRecord({
      sessionId: 's1', messageId: 'm1', totalTokens: 100,
      timestamp: now - 5 * 60 * 1000,
    }));
    recordUsage(memDb, makeRecord({
      sessionId: 's1', messageId: 'm2', totalTokens: 100,
      timestamp: now,
    }));

    const result = await caller.sessions({ projectId: 'test-project-id' });
    expect(result.sessions[0].durationMs).toBeCloseTo(5 * 60 * 1000, -2);
  });
});

describe('token-router — sessionDetail procedure', () => {
  beforeEach(() => {
    memDb.exec('DELETE FROM token_usage');
  });

  it('空 session_id 返回空数组', async () => {
    const result = await caller.sessionDetail({ projectId: 'test-project-id', sessionId: 'nonexistent' });
    expect(result).toEqual([]);
  });

  it('返回单会话所有 per-request 记录', async () => {
    const now = Date.now();
    recordUsage(memDb, makeRecord({
      engine: 'omp', sessionId: 'sess-1', messageId: 'm1',
      model: 'claude-sonnet-4-20250514',
      inputTokens: 800, outputTokens: 200,
      cacheReadTokens: 100, cacheWriteTokens: 50,
      totalTokens: 1000, costUsd: 0.05,
      timestamp: now,
    }));
    recordUsage(memDb, makeRecord({
      engine: 'omp', sessionId: 'sess-1', messageId: 'm2',
      model: 'claude-sonnet-4-20250514',
      inputTokens: 400, outputTokens: 100,
      cacheReadTokens: 50, cacheWriteTokens: 0,
      totalTokens: 500, costUsd: 0.02,
      timestamp: now + 1000,
    }));
    // Another session
    recordUsage(memDb, makeRecord({
      engine: 'omp', sessionId: 'sess-2', messageId: 'm3',
      totalTokens: 999, timestamp: now + 2000,
    }));

    const result = await caller.sessionDetail({ projectId: 'test-project-id', sessionId: 'sess-1' });
    expect(result).toHaveLength(2);

    const m1 = result.find((r) => r.messageId === 'm1')!;
    expect(m1.model).toBe('claude-sonnet-4-20250514');
    expect(m1.inputTokens).toBe(800);
    expect(m1.outputTokens).toBe(200);
    expect(m1.cacheReadTokens).toBe(100);
    expect(m1.cacheWriteTokens).toBe(50);
    expect(m1.totalTokens).toBe(1000);
    expect(m1.costUsd).toBeCloseTo(0.05, 5);

    const m2 = result.find((r) => r.messageId === 'm2')!;
    expect(m2.totalTokens).toBe(500);
    expect(m2.costUsd).toBeCloseTo(0.02, 5);
  });

  it('per-request 记录按时间升序排列', async () => {
    const now = Date.now();
    recordUsage(memDb, makeRecord({
      sessionId: 's1', messageId: 'm1', totalTokens: 100, timestamp: now + 2000,
    }));
    recordUsage(memDb, makeRecord({
      sessionId: 's1', messageId: 'm2', totalTokens: 200, timestamp: now,
    }));
    recordUsage(memDb, makeRecord({
      sessionId: 's1', messageId: 'm3', totalTokens: 300, timestamp: now + 1000,
    }));

    const result = await caller.sessionDetail({ projectId: 'test-project-id', sessionId: 's1' });
    expect(result.map((r) => r.messageId)).toEqual(['m2', 'm3', 'm1']);
  });
});

// ─── Heatmap + Streaks Tests (Issue #6) ────────────────────

describe('token-router — heatmap procedure', () => {
  beforeEach(() => {
    memDb.exec('DELETE FROM token_usage');
  });

  it('空数据库返回空数组', async () => {
    const result = await caller.heatmap({ projectId: 'test-project-id' });
    expect(result).toEqual([]);
  });

  it('返回 365 天按日聚合数据', async () => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const todayTs = todayStart.getTime() + 3600000;

    recordUsage(memDb, makeRecord({
      sessionId: 's1', messageId: 'm1',
      totalTokens: 1000, costUsd: 0.05,
      timestamp: todayTs,
    }));
    recordUsage(memDb, makeRecord({
      sessionId: 's2', messageId: 'm2',
      totalTokens: 500, costUsd: 0.02,
      timestamp: todayTs,
    }));

    const result = await caller.heatmap({ projectId: 'test-project-id' });
    expect(result.length).toBeGreaterThanOrEqual(1);

    const todayDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const todayEntry = result.find((e) => e.date === todayDate);
    expect(todayEntry).toBeDefined();
    expect(todayEntry!.totalTokens).toBe(1500);
    expect(todayEntry!.costUsd).toBeCloseTo(0.07, 5);
  });

  it('同一天多条记录聚合为一天', async () => {
    const now = Date.now();
    recordUsage(memDb, makeRecord({ sessionId: 's1', messageId: 'm1', totalTokens: 100, timestamp: now }));
    recordUsage(memDb, makeRecord({ sessionId: 's2', messageId: 'm2', totalTokens: 200, timestamp: now + 5000 }));
    recordUsage(memDb, makeRecord({ sessionId: 's3', messageId: 'm3', totalTokens: 300, timestamp: now + 10000 }));

    const result = await caller.heatmap({ projectId: 'test-project-id' });
    expect(result).toHaveLength(1);
    expect(result[0].totalTokens).toBe(600);
  });
});

describe('token-router — summary 扩展 streak 数据', () => {
  beforeEach(() => {
    memDb.exec('DELETE FROM token_usage');
  });

  it('空数据库 streak 全零', async () => {
    const summary = await caller.summary({ projectId: 'test-project-id' });
    expect(summary.currentStreak).toBe(0);
    expect(summary.longestStreak).toBe(0);
  });

  it('今天有记录返回 currentStreak >= 1', async () => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    recordUsage(memDb, makeRecord({
      sessionId: 's1', messageId: 'm1',
      totalTokens: 100, timestamp: todayStart.getTime() + 3600000,
    }));

    const summary = await caller.summary({ projectId: 'test-project-id' });
    expect(summary.currentStreak).toBe(1);
    expect(summary.longestStreak).toBe(1);
  });

  it('连续 3 天返回 currentStreak = 3', async () => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    for (let i = 0; i < 3; i++) {
      recordUsage(memDb, makeRecord({
        sessionId: `s${i}`, messageId: `m${i}`,
        totalTokens: 100, timestamp: todayStart.getTime() - i * 24 * 60 * 60 * 1000 + 3600000,
      }));
    }

    const summary = await caller.summary({ projectId: 'test-project-id' });
    expect(summary.currentStreak).toBe(3);
    expect(summary.longestStreak).toBe(3);
  });

  it('今天无记录返回 currentStreak = 0', async () => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    recordUsage(memDb, makeRecord({
      sessionId: 's1', messageId: 'm1',
      totalTokens: 100, timestamp: todayStart.getTime() - 24 * 60 * 60 * 1000 + 3600000,
    }));

    const summary = await caller.summary({ projectId: 'test-project-id' });
    expect(summary.currentStreak).toBe(0);
    expect(summary.longestStreak).toBe(1);
  });
});

afterAll(() => {
  closeDatabase(memDb);
});
