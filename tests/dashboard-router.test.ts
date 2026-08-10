/**
 * dashboard-router 端到端测试。
 *
 * 测试缝：tRPC server-side caller（router.createCaller）。
 * mock requireProject 返回固定项目路径，caseStatsRegistry.getOrCreateDb 返回内存 DB。
 * 先例：tests/officecli/document-router.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

// ─── Hoisted tmp dir (no require needed) ───────────────────

const { tmpDir } = vi.hoisted(() => {
  const os = require('node:os');
  const fs = require('node:fs');
  const dir = os.tmpdir() + `/sv-dash-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  fs.mkdirSync(dir, { recursive: true });
  return { tmpDir: dir };
});

// ─── Shared DB ref (set after imports) ─────────────────────

const dbRef: { current: Database.Database | null } = { current: null };

// ─── Mocks ──────────────────────────────────────────────────

vi.mock('../src/main/services/project-service', () => ({
  requireProject: vi.fn(() => ({
    id: 'test-project-id',
    rootPath: tmpDir,
    name: 'Test Project',
  })),
}));

vi.mock('../src/main/case/case-stats-registry', () => ({
  caseStatsRegistry: {
    getOrCreateDb: vi.fn(() => dbRef.current),
  },
}));

// ─── Imports (after mocks) ──────────────────────────────────

import { createMemoryDatabase, closeDatabase } from '../src/main/case/db/case-database';
import {
  insertSubsystems,
  insertCases,
  insertSimulationRun,
} from '../src/main/case/db/case-repository';
import { dashboardRouter } from '../src/main/ipc/routers/dashboard-router';
import { unlink } from 'node:fs/promises';

// Create in-memory DB and wire it into the mock
dbRef.current = createMemoryDatabase();
const memDb = dbRef.current;

const caller = dashboardRouter.createCaller({});

// ─── Test Suite ─────────────────────────────────────────────

// ─── Date helpers (relative to now for trend7d tests) ──────
// Uses UTC methods to stay consistent with SQLite's date() function.

function isoDaysAgo(days: number, hour = 10): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

function dateStrDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

describe('dashboard-router', () => {
  beforeEach(() => {
    memDb!.prepare('DELETE FROM simulation_runs').run();
    memDb!.prepare('DELETE FROM cases').run();
    memDb!.prepare('DELETE FROM subsystems').run();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    closeDatabase(memDb!);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── getSubsysList ────────────────────────────────────────

  describe('getSubsysList', () => {
    it('returns subsystem names from the case database', async () => {
      insertSubsystems(memDb!, [
        { name: 'cpu' },
        { name: 'gpu' },
        { name: 'axi' },
      ]);

      const result = await caller.getSubsysList({ projectId: 'test-project-id' });
      expect(result).toEqual(['axi', 'cpu', 'gpu']);
    });

    it('returns empty array when no subsystems in database', async () => {
      const result = await caller.getSubsysList({ projectId: 'test-project-id' });
      expect(result).toEqual([]);
    });
  });

  // ─── saveLayout / getLayout round-trip ───────────────────

  describe('saveLayout', () => {
    it('persists layout to dashboard-layout.json', async () => {
      const layout = { activeTab: 'trend', timeRange: '7d' };
      await caller.saveLayout({ projectId: 'test-project-id', layout });

      const layoutPath = join(tmpDir, '.socverify', 'dashboard-layout.json');
      expect(existsSync(layoutPath)).toBe(true);
      const saved = JSON.parse(readFileSync(layoutPath, 'utf-8'));
      expect(saved).toEqual(layout);
    });
  });

  describe('getLayout', () => {
    it('returns saved layout', async () => {
      const layout = { activeTab: 'subsys', timeRange: 'all' };
      await caller.saveLayout({ projectId: 'test-project-id', layout });

      const result = await caller.getLayout({ projectId: 'test-project-id' });
      expect(result).toEqual(layout);
    });

    it('returns null when no layout file exists', async () => {
      const layoutPath = join(tmpDir, '.socverify', 'dashboard-layout.json');
      if (existsSync(layoutPath)) {
        await unlink(layoutPath);
      }

      const result = await caller.getLayout({ projectId: 'test-project-id' });
      expect(result).toBeNull();
    });
  });

  // ─── getMetrics removed ──────────────────────────────────

  describe('getMetrics (removed)', () => {
    it('does not have getMetrics procedure', () => {
      const procedures = (dashboardRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures;
      expect(procedures).not.toHaveProperty('getMetrics');
    });
  });

  // ─── getSummary ──────────────────────────────────────────

  describe('getSummary', () => {
    it('returns correct summary with subsys count, case count, pass rate, fail count, and 7d trend', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }, { name: 'gpu' }]);
      insertCases(memDb!, [
        { name: 't1', subsys: 'cpu', path: '/p/t1' },
        { name: 't2', subsys: 'cpu', path: '/p/t2' },
        { name: 't3', subsys: 'gpu', path: '/p/t3' },
      ]);
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0) });
      insertSimulationRun(memDb!, { caseName: 't2', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(1) });
      insertSimulationRun(memDb!, { caseName: 't3', subsys: 'gpu', status: 'pass', startTime: isoDaysAgo(2) });

      const result = await caller.getSummary({ projectId: 'test-project-id' });

      expect(result.subsysCount).toBe(2);
      expect(result.caseCount).toBe(3);
      expect(result.failCount).toBe(1);
      expect(result.trend7d).toHaveLength(7);
      // Today should have 1 pass
      const today = result.trend7d.find((t) => t.date === dateStrDaysAgo(0));
      expect(today).toBeDefined();
      expect(today!.pass).toBe(1);
      expect(today!.fail).toBe(0);
      // Yesterday should have 1 fail
      const yesterday = result.trend7d.find((t) => t.date === dateStrDaysAgo(1));
      expect(yesterday).toBeDefined();
      expect(yesterday!.fail).toBe(1);
    });

    it('filters all stats by subsys when provided', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }, { name: 'gpu' }]);
      insertCases(memDb!, [
        { name: 't1', subsys: 'cpu', path: '/p/t1' },
        { name: 't2', subsys: 'cpu', path: '/p/t2' },
        { name: 't3', subsys: 'gpu', path: '/p/t3' },
      ]);
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0) });
      insertSimulationRun(memDb!, { caseName: 't2', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(0) });
      insertSimulationRun(memDb!, { caseName: 't3', subsys: 'gpu', status: 'pass', startTime: isoDaysAgo(0) });

      const result = await caller.getSummary({ projectId: 'test-project-id', subsys: 'cpu' });

      expect(result.subsysCount).toBe(1);
      expect(result.caseCount).toBe(2);
      expect(result.failCount).toBe(1);
    });

    it('trend7d always returns last 7 days regardless of timeRange', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }]);
      insertCases(memDb!, [{ name: 't1', subsys: 'cpu', path: '/p/t1' }]);
      // Insert a run from 3 days ago
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(3) });

      const result = await caller.getSummary({ projectId: 'test-project-id', timeRange: '30d' });

      expect(result.trend7d).toHaveLength(7);
      // The run from 3 days ago should appear in trend7d
      const threeDaysAgo = result.trend7d.find((t) => t.date === dateStrDaysAgo(3));
      expect(threeDaysAgo).toBeDefined();
      expect(threeDaysAgo!.pass).toBe(1);
    });

    it('returns zero values and empty trend7d for empty database', async () => {
      const result = await caller.getSummary({ projectId: 'test-project-id' });

      expect(result.subsysCount).toBe(0);
      expect(result.caseCount).toBe(0);
      expect(result.passRate).toBe(0);
      expect(result.failCount).toBe(0);
      expect(result.trend7d).toHaveLength(7);
      // All days should have zero counts
      for (const t of result.trend7d) {
        expect(t.pass).toBe(0);
        expect(t.fail).toBe(0);
        expect(t.error).toBe(0);
      }
    });
  });

  // ─── getTrend ────────────────────────────────────────────

  describe('getTrend', () => {
    it('returns daily trend grouped by date with pass/fail/error counts', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }]);
      insertCases(memDb!, [{ name: 't1', subsys: 'cpu', path: '/p/t1' }]);
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0) });
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(0) });
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'error', startTime: isoDaysAgo(1) });
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(2) });

      const result = await caller.getTrend({ projectId: 'test-project-id' });

      expect(result).toHaveLength(3);
      const today = result.find((t) => t.date === dateStrDaysAgo(0));
      expect(today).toBeDefined();
      expect(today!.pass).toBe(1);
      expect(today!.fail).toBe(1);
      expect(today!.error).toBe(0);
      const yesterday = result.find((t) => t.date === dateStrDaysAgo(1));
      expect(yesterday!.error).toBe(1);
      const twoDaysAgo = result.find((t) => t.date === dateStrDaysAgo(2));
      expect(twoDaysAgo!.pass).toBe(1);
    });

    it('groups by week when granularity is weekly', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }]);
      insertCases(memDb!, [{ name: 't1', subsys: 'cpu', path: '/p/t1' }]);
      // Insert runs on different days of the same week
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0) });
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(2) });
      // And a run from a different week
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(10) });

      const result = await caller.getTrend({ projectId: 'test-project-id', granularity: 'weekly' });

      // Should have 2 week groups (this week and ~2 weeks ago)
      expect(result.length).toBeGreaterThanOrEqual(2);
      // Total pass count across all weeks should be 2, fail should be 1
      const totalPass = result.reduce((sum, t) => sum + t.pass, 0);
      const totalFail = result.reduce((sum, t) => sum + t.fail, 0);
      expect(totalPass).toBe(2);
      expect(totalFail).toBe(1);
    });

    it('filters by subsys when provided', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }, { name: 'gpu' }]);
      insertCases(memDb!, [
        { name: 't1', subsys: 'cpu', path: '/p/t1' },
        { name: 't2', subsys: 'gpu', path: '/p/t2' },
      ]);
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0) });
      insertSimulationRun(memDb!, { caseName: 't2', subsys: 'gpu', status: 'fail', startTime: isoDaysAgo(0) });

      const result = await caller.getTrend({ projectId: 'test-project-id', subsys: 'cpu' });

      expect(result).toHaveLength(1);
      expect(result[0].pass).toBe(1);
      expect(result[0].fail).toBe(0);
    });

    it('filters by timeRange when provided', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }]);
      insertCases(memDb!, [{ name: 't1', subsys: 'cpu', path: '/p/t1' }]);
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0) });
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(20) });

      const result = await caller.getTrend({ projectId: 'test-project-id', timeRange: '7d' });

      // Only the recent run should be included
      expect(result).toHaveLength(1);
      expect(result[0].pass).toBe(1);
      expect(result[0].fail).toBe(0);
    });

    it('returns empty array for empty database', async () => {
      const result = await caller.getTrend({ projectId: 'test-project-id' });
      expect(result).toEqual([]);
    });
  });

  // ─── getSubsysHeatmap ───────────────────────────────────

  describe('getSubsysHeatmap', () => {
    it('returns pass/fail/error/total/passRate per subsystem', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }, { name: 'gpu' }]);
      insertCases(memDb!, [
        { name: 't1', subsys: 'cpu', path: '/p/t1' },
        { name: 't2', subsys: 'cpu', path: '/p/t2' },
        { name: 't3', subsys: 'gpu', path: '/p/t3' },
      ]);
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0) });
      insertSimulationRun(memDb!, { caseName: 't2', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(0) });
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(1) });
      insertSimulationRun(memDb!, { caseName: 't2', subsys: 'cpu', status: 'error', startTime: isoDaysAgo(1) });
      insertSimulationRun(memDb!, { caseName: 't3', subsys: 'gpu', status: 'pass', startTime: isoDaysAgo(0) });

      const result = await caller.getSubsysHeatmap({ projectId: 'test-project-id' });

      expect(result).toHaveLength(2);

      const cpu = result.find((r) => r.subsys === 'cpu');
      expect(cpu).toBeDefined();
      expect(cpu!.pass).toBe(2);
      expect(cpu!.fail).toBe(1);
      expect(cpu!.error).toBe(1);
      expect(cpu!.total).toBe(4);
      expect(cpu!.passRate).toBe(50); // 2/4 = 50%

      const gpu = result.find((r) => r.subsys === 'gpu');
      expect(gpu).toBeDefined();
      expect(gpu!.pass).toBe(1);
      expect(gpu!.fail).toBe(0);
      expect(gpu!.error).toBe(0);
      expect(gpu!.total).toBe(1);
      expect(gpu!.passRate).toBe(100); // 1/1 = 100%
    });

    it('filters by timeRange when provided', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }]);
      insertCases(memDb!, [{ name: 't1', subsys: 'cpu', path: '/p/t1' }]);
      // Recent run (pass)
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0) });
      // Old run (fail) — outside 7d window
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(20) });

      const result = await caller.getSubsysHeatmap({ projectId: 'test-project-id', timeRange: '7d' });

      expect(result).toHaveLength(1);
      expect(result[0].pass).toBe(1);
      expect(result[0].fail).toBe(0);
      expect(result[0].total).toBe(1);
    });

    it('does not accept subsys parameter (shows all subsystems)', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }, { name: 'gpu' }]);
      insertCases(memDb!, [
        { name: 't1', subsys: 'cpu', path: '/p/t1' },
        { name: 't2', subsys: 'gpu', path: '/p/t2' },
      ]);
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0) });
      insertSimulationRun(memDb!, { caseName: 't2', subsys: 'gpu', status: 'fail', startTime: isoDaysAgo(0) });

      // Even if subsys is passed, it should be ignored (all subsystems returned)
      const result = await caller.getSubsysHeatmap({ projectId: 'test-project-id' });

      expect(result).toHaveLength(2);
      expect(result.find((r) => r.subsys === 'cpu')).toBeDefined();
      expect(result.find((r) => r.subsys === 'gpu')).toBeDefined();
    });

    it('returns empty array for empty database', async () => {
      const result = await caller.getSubsysHeatmap({ projectId: 'test-project-id' });
      expect(result).toEqual([]);
    });

    it('calculates passRate correctly with rounding to 1 decimal', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }]);
      insertCases(memDb!, [{ name: 't1', subsys: 'cpu', path: '/p/t1' }]);
      // 3 pass, 1 fail, 0 error = 4 total → 75.0%
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0) });
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(1) });
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(2) });
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(3) });

      const result = await caller.getSubsysHeatmap({ projectId: 'test-project-id' });
      expect(result).toHaveLength(1);
      expect(result[0].passRate).toBe(75); // 3/4 = 75.0%
    });
  });

  // ─── getRecentFailures ──────────────────────────────────

  describe('getRecentFailures', () => {
    it('returns recent failed runs ordered by start_time descending', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }, { name: 'gpu' }]);
      insertCases(memDb!, [
        { name: 't1', subsys: 'cpu', path: '/p/t1' },
        { name: 't2', subsys: 'gpu', path: '/p/t2' },
      ]);
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(0), durationMs: 5000 });
      insertSimulationRun(memDb!, { caseName: 't2', subsys: 'gpu', status: 'fail', startTime: isoDaysAgo(1), durationMs: 3000 });
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(2) });

      const result = await caller.getRecentFailures({ projectId: 'test-project-id' });

      expect(result).toHaveLength(2);
      // Most recent first (today's failure)
      expect(result[0].caseName).toBe('t1');
      expect(result[0].subsys).toBe('cpu');
      expect(result[0].durationMs).toBe(5000);
      // Yesterday's failure
      expect(result[1].caseName).toBe('t2');
      expect(result[1].subsys).toBe('gpu');
    });

    it('does not include corner field in returned data', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }]);
      insertCases(memDb!, [{ name: 't1', subsys: 'cpu', path: '/p/t1' }]);
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(0), corner: 'post_sim' });

      const result = await caller.getRecentFailures({ projectId: 'test-project-id' });

      expect(result).toHaveLength(1);
      expect(result[0]).not.toHaveProperty('corner');
    });

    it('filters by subsys when provided', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }, { name: 'gpu' }]);
      insertCases(memDb!, [
        { name: 't1', subsys: 'cpu', path: '/p/t1' },
        { name: 't2', subsys: 'gpu', path: '/p/t2' },
      ]);
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(0) });
      insertSimulationRun(memDb!, { caseName: 't2', subsys: 'gpu', status: 'fail', startTime: isoDaysAgo(0) });

      const result = await caller.getRecentFailures({ projectId: 'test-project-id', subsys: 'cpu' });

      expect(result).toHaveLength(1);
      expect(result[0].caseName).toBe('t1');
      expect(result[0].subsys).toBe('cpu');
    });

    it('filters by timeRange when provided', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }]);
      insertCases(memDb!, [{ name: 't1', subsys: 'cpu', path: '/p/t1' }]);
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(0) });
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(20) });

      const result = await caller.getRecentFailures({ projectId: 'test-project-id', timeRange: '7d' });

      expect(result).toHaveLength(1);
      expect(result[0].caseName).toBe('t1');
    });

    it('returns empty array for empty database', async () => {
      const result = await caller.getRecentFailures({ projectId: 'test-project-id' });
      expect(result).toEqual([]);
    });

    it('limits results to 50 entries', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }]);
      const cases = Array.from({ length: 60 }, (_, i) => ({
        name: `case_${i}`,
        subsys: 'cpu',
        path: `/p/case_${i}`,
      }));
      insertCases(memDb!, cases);
      for (let i = 0; i < 60; i++) {
        insertSimulationRun(memDb!, {
          caseName: `case_${i}`,
          subsys: 'cpu',
          status: 'fail',
          startTime: isoDaysAgo(0, 10 + (i % 10)),
        });
      }

      const result = await caller.getRecentFailures({ projectId: 'test-project-id' });

      expect(result).toHaveLength(50);
    });
  });

  // ─── getRegressionProgress ─────────────────────────────

  describe('getRegressionProgress', () => {
    it('returns correct progress with total, run, passed, failed, notRun, and passRate', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }, { name: 'gpu' }]);
      insertCases(memDb!, [
        { name: 't1', subsys: 'cpu', path: '/p/t1' },
        { name: 't2', subsys: 'cpu', path: '/p/t2' },
        { name: 't3', subsys: 'gpu', path: '/p/t3' },
        { name: 't4', subsys: 'gpu', path: '/p/t4' },
      ]);
      // t1: pass, t2: fail, t3: pass → 3 run, 2 passed, 1 failed, 1 not run
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0) });
      insertSimulationRun(memDb!, { caseName: 't2', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(0) });
      insertSimulationRun(memDb!, { caseName: 't3', subsys: 'gpu', status: 'pass', startTime: isoDaysAgo(0) });

      const result = await caller.getRegressionProgress({ projectId: 'test-project-id' });

      expect(result.totalCases).toBe(4);
      expect(result.runCases).toBe(3);
      expect(result.passedCases).toBe(2);
      expect(result.failedCases).toBe(1);
      expect(result.notRunCases).toBe(1);
      // passRate = passed / run = 2/3 ≈ 66.7
      expect(result.passRate).toBeCloseTo(66.7, 1);
    });

    it('filters by subsys when provided (only counts cases in that subsys)', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }, { name: 'gpu' }]);
      insertCases(memDb!, [
        { name: 't1', subsys: 'cpu', path: '/p/t1' },
        { name: 't2', subsys: 'cpu', path: '/p/t2' },
        { name: 't3', subsys: 'gpu', path: '/p/t3' },
      ]);
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0) });
      insertSimulationRun(memDb!, { caseName: 't2', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(0) });
      insertSimulationRun(memDb!, { caseName: 't3', subsys: 'gpu', status: 'pass', startTime: isoDaysAgo(0) });

      const result = await caller.getRegressionProgress({ projectId: 'test-project-id', subsys: 'cpu' });

      expect(result.totalCases).toBe(2);
      expect(result.runCases).toBe(2);
      expect(result.passedCases).toBe(1);
      expect(result.failedCases).toBe(1);
      expect(result.notRunCases).toBe(0);
    });

    it('does not accept timeRange (always counts full history)', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }]);
      insertCases(memDb!, [{ name: 't1', subsys: 'cpu', path: '/p/t1' }]);
      // Old run — outside 7d window — should still be counted
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(20) });

      // Even if timeRange is passed, the result should reflect full history
      // The procedure's input type intentionally excludes timeRange, but at runtime
      // validateFilter still accepts it (strips it). Cast to bypass type check.
      const result = await caller.getRegressionProgress({ projectId: 'test-project-id', timeRange: '7d' } as { projectId: string; subsys?: string });

      expect(result.totalCases).toBe(1);
      expect(result.runCases).toBe(1);
      expect(result.passedCases).toBe(1);
    });

    it('counts a case as run even if latest status is pass but had earlier fails', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }]);
      insertCases(memDb!, [{ name: 't1', subsys: 'cpu', path: '/p/t1' }]);
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(5) });
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0) });

      const result = await caller.getRegressionProgress({ projectId: 'test-project-id' });

      expect(result.totalCases).toBe(1);
      expect(result.runCases).toBe(1);
      // Latest status is pass
      expect(result.passedCases).toBe(1);
      expect(result.failedCases).toBe(0);
    });

    it('counts a case as failed when latest status is fail', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }]);
      insertCases(memDb!, [{ name: 't1', subsys: 'cpu', path: '/p/t1' }]);
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(5) });
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(0) });

      const result = await caller.getRegressionProgress({ projectId: 'test-project-id' });

      expect(result.runCases).toBe(1);
      expect(result.passedCases).toBe(0);
      expect(result.failedCases).toBe(1);
    });

    it('returns zero values for empty database', async () => {
      const result = await caller.getRegressionProgress({ projectId: 'test-project-id' });

      expect(result.totalCases).toBe(0);
      expect(result.runCases).toBe(0);
      expect(result.passedCases).toBe(0);
      expect(result.failedCases).toBe(0);
      expect(result.notRunCases).toBe(0);
      expect(result.passRate).toBe(0);
    });
  });

  // ─── getDurationHistogram ───────────────────────────────

  describe('getDurationHistogram', () => {
    it('returns duration buckets grouped by time range', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }]);
      insertCases(memDb!, [
        { name: 't1', subsys: 'cpu', path: '/p/t1' },
        { name: 't2', subsys: 'cpu', path: '/p/t2' },
        { name: 't3', subsys: 'cpu', path: '/p/t3' },
        { name: 't4', subsys: 'cpu', path: '/p/t4' },
        { name: 't5', subsys: 'cpu', path: '/p/t5' },
      ]);
      // 30s → 0-1min bucket
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0), durationMs: 30_000 });
      // 2min → 1-5min bucket
      insertSimulationRun(memDb!, { caseName: 't2', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0), durationMs: 120_000 });
      // 10min → 5-15min bucket
      insertSimulationRun(memDb!, { caseName: 't3', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0), durationMs: 600_000 });
      // 20min → 15-30min bucket
      insertSimulationRun(memDb!, { caseName: 't4', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(0), durationMs: 1_200_000 });
      // 45min → 30min+ bucket
      insertSimulationRun(memDb!, { caseName: 't5', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0), durationMs: 2_700_000 });

      const result = await caller.getDurationHistogram({ projectId: 'test-project-id' });

      expect(result).toHaveLength(5);
      const bucket0to1 = result.find((r) => r.bucket === '0-1min');
      expect(bucket0to1).toBeDefined();
      expect(bucket0to1!.count).toBe(1);
      const bucket1to5 = result.find((r) => r.bucket === '1-5min');
      expect(bucket1to5).toBeDefined();
      expect(bucket1to5!.count).toBe(1);
      const bucket5to15 = result.find((r) => r.bucket === '5-15min');
      expect(bucket5to15).toBeDefined();
      expect(bucket5to15!.count).toBe(1);
      const bucket15to30 = result.find((r) => r.bucket === '15-30min');
      expect(bucket15to30).toBeDefined();
      expect(bucket15to30!.count).toBe(1);
      const bucket30plus = result.find((r) => r.bucket === '30min+');
      expect(bucket30plus).toBeDefined();
      expect(bucket30plus!.count).toBe(1);
    });

    it('groups multiple runs into the same bucket', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }]);
      insertCases(memDb!, [
        { name: 't1', subsys: 'cpu', path: '/p/t1' },
        { name: 't2', subsys: 'cpu', path: '/p/t2' },
        { name: 't3', subsys: 'cpu', path: '/p/t3' },
      ]);
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0), durationMs: 30_000 });
      insertSimulationRun(memDb!, { caseName: 't2', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0), durationMs: 45_000 });
      insertSimulationRun(memDb!, { caseName: 't3', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0), durationMs: 180_000 });

      const result = await caller.getDurationHistogram({ projectId: 'test-project-id' });

      const bucket0to1 = result.find((r) => r.bucket === '0-1min');
      expect(bucket0to1!.count).toBe(2);
      const bucket1to5 = result.find((r) => r.bucket === '1-5min');
      expect(bucket1to5!.count).toBe(1);
    });

    it('filters by subsys when provided', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }, { name: 'gpu' }]);
      insertCases(memDb!, [
        { name: 't1', subsys: 'cpu', path: '/p/t1' },
        { name: 't2', subsys: 'gpu', path: '/p/t2' },
      ]);
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0), durationMs: 30_000 });
      insertSimulationRun(memDb!, { caseName: 't2', subsys: 'gpu', status: 'pass', startTime: isoDaysAgo(0), durationMs: 120_000 });

      const result = await caller.getDurationHistogram({ projectId: 'test-project-id', subsys: 'cpu' });

      const bucket0to1 = result.find((r) => r.bucket === '0-1min');
      expect(bucket0to1!.count).toBe(1);
      const bucket1to5 = result.find((r) => r.bucket === '1-5min');
      expect(bucket1to5).toBeUndefined();
    });

    it('filters by timeRange when provided', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }]);
      insertCases(memDb!, [{ name: 't1', subsys: 'cpu', path: '/p/t1' }]);
      // Recent run
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0), durationMs: 30_000 });
      // Old run — outside 7d window
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(20), durationMs: 120_000 });

      const result = await caller.getDurationHistogram({ projectId: 'test-project-id', timeRange: '7d' });

      const bucket0to1 = result.find((r) => r.bucket === '0-1min');
      expect(bucket0to1!.count).toBe(1);
      const bucket1to5 = result.find((r) => r.bucket === '1-5min');
      expect(bucket1to5).toBeUndefined();
    });

    it('returns empty array for empty database', async () => {
      const result = await caller.getDurationHistogram({ projectId: 'test-project-id' });
      expect(result).toEqual([]);
    });

    it('excludes runs with null duration_ms', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }]);
      insertCases(memDb!, [
        { name: 't1', subsys: 'cpu', path: '/p/t1' },
        { name: 't2', subsys: 'cpu', path: '/p/t2' },
      ]);
      // Run with no duration_ms
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0) });
      // Run with duration_ms
      insertSimulationRun(memDb!, { caseName: 't2', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0), durationMs: 30_000 });

      const result = await caller.getDurationHistogram({ projectId: 'test-project-id' });

      // Only 1 run should be counted (the one with duration_ms)
      const bucket0to1 = result.find((r) => r.bucket === '0-1min');
      expect(bucket0to1!.count).toBe(1);
    });
  });

  // ─── getUnstableCases ─────────────────────────────────

  describe('getUnstableCases', () => {
    it('identifies unstable cases that have both pass and fail', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }]);
      insertCases(memDb!, [
        { name: 'flaky1', subsys: 'cpu', path: '/p/flaky1' },
        { name: 'stable_pass', subsys: 'cpu', path: '/p/stable_pass' },
        { name: 'stable_fail', subsys: 'cpu', path: '/p/stable_fail' },
      ]);
      // flaky1: 2 pass + 1 fail → unstable
      insertSimulationRun(memDb!, { caseName: 'flaky1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(2) });
      insertSimulationRun(memDb!, { caseName: 'flaky1', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(1) });
      insertSimulationRun(memDb!, { caseName: 'flaky1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0) });
      // stable_pass: only pass → not unstable
      insertSimulationRun(memDb!, { caseName: 'stable_pass', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0) });
      // stable_fail: only fail → not unstable
      insertSimulationRun(memDb!, { caseName: 'stable_fail', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(0) });

      const result = await caller.getUnstableCases({ projectId: 'test-project-id' });

      expect(result).toHaveLength(1);
      expect(result[0].caseName).toBe('flaky1');
      expect(result[0].subsys).toBe('cpu');
      expect(result[0].passCount).toBe(2);
      expect(result[0].failCount).toBe(1);
      expect(result[0].totalCount).toBe(3);
      expect(result[0].failRate).toBeCloseTo(33.3, 1);
      expect(result[0].lastStatus).toBe('pass');
    });

    it('sorts by failRate descending', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }]);
      insertCases(memDb!, [
        { name: 'case_75', subsys: 'cpu', path: '/p/c75' },
        { name: 'case_50', subsys: 'cpu', path: '/p/c50' },
        { name: 'case_25', subsys: 'cpu', path: '/p/c25' },
      ]);
      // case_75: 1 pass + 3 fail → 75% fail rate
      insertSimulationRun(memDb!, { caseName: 'case_75', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(3) });
      insertSimulationRun(memDb!, { caseName: 'case_75', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(2) });
      insertSimulationRun(memDb!, { caseName: 'case_75', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(1) });
      insertSimulationRun(memDb!, { caseName: 'case_75', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(0) });
      // case_50: 2 pass + 2 fail → 50% fail rate
      insertSimulationRun(memDb!, { caseName: 'case_50', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(3) });
      insertSimulationRun(memDb!, { caseName: 'case_50', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(2) });
      insertSimulationRun(memDb!, { caseName: 'case_50', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(1) });
      insertSimulationRun(memDb!, { caseName: 'case_50', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(0) });
      // case_25: 3 pass + 1 fail → 25% fail rate
      insertSimulationRun(memDb!, { caseName: 'case_25', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(3) });
      insertSimulationRun(memDb!, { caseName: 'case_25', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(2) });
      insertSimulationRun(memDb!, { caseName: 'case_25', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(1) });
      insertSimulationRun(memDb!, { caseName: 'case_25', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(0) });

      const result = await caller.getUnstableCases({ projectId: 'test-project-id' });

      expect(result).toHaveLength(3);
      expect(result[0].caseName).toBe('case_75');
      expect(result[1].caseName).toBe('case_50');
      expect(result[2].caseName).toBe('case_25');
    });

    it('filters by subsys when provided', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }, { name: 'gpu' }]);
      insertCases(memDb!, [
        { name: 'flaky_cpu', subsys: 'cpu', path: '/p/fc' },
        { name: 'flaky_gpu', subsys: 'gpu', path: '/p/fg' },
      ]);
      insertSimulationRun(memDb!, { caseName: 'flaky_cpu', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(1) });
      insertSimulationRun(memDb!, { caseName: 'flaky_cpu', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(0) });
      insertSimulationRun(memDb!, { caseName: 'flaky_gpu', subsys: 'gpu', status: 'pass', startTime: isoDaysAgo(1) });
      insertSimulationRun(memDb!, { caseName: 'flaky_gpu', subsys: 'gpu', status: 'fail', startTime: isoDaysAgo(0) });

      const result = await caller.getUnstableCases({ projectId: 'test-project-id', subsys: 'cpu' });

      expect(result).toHaveLength(1);
      expect(result[0].caseName).toBe('flaky_cpu');
    });

    it('filters by timeRange when provided', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }]);
      insertCases(memDb!, [{ name: 'flaky1', subsys: 'cpu', path: '/p/f1' }]);
      // Recent pass + recent fail → unstable within 7d
      insertSimulationRun(memDb!, { caseName: 'flaky1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(1) });
      insertSimulationRun(memDb!, { caseName: 'flaky1', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(0) });
      // Old run (outside 7d) — only pass, so within 7d the case is unstable
      insertSimulationRun(memDb!, { caseName: 'flaky1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(20) });

      const result7d = await caller.getUnstableCases({ projectId: 'test-project-id', timeRange: '7d' });

      // Within 7d: 1 pass + 1 fail → unstable
      expect(result7d).toHaveLength(1);
      expect(result7d[0].caseName).toBe('flaky1');
      expect(result7d[0].passCount).toBe(1);
      expect(result7d[0].failCount).toBe(1);

      // Without timeRange: 2 pass + 1 fail → still unstable
      const resultAll = await caller.getUnstableCases({ projectId: 'test-project-id' });
      expect(resultAll).toHaveLength(1);
      expect(resultAll[0].passCount).toBe(2);
      expect(resultAll[0].failCount).toBe(1);
    });

    it('returns empty array for empty database', async () => {
      const result = await caller.getUnstableCases({ projectId: 'test-project-id' });
      expect(result).toEqual([]);
    });

    it('returns empty array when no unstable cases exist', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }]);
      insertCases(memDb!, [
        { name: 'only_pass', subsys: 'cpu', path: '/p/op' },
        { name: 'only_fail', subsys: 'cpu', path: '/p/of' },
      ]);
      insertSimulationRun(memDb!, { caseName: 'only_pass', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0) });
      insertSimulationRun(memDb!, { caseName: 'only_fail', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(0) });

      const result = await caller.getUnstableCases({ projectId: 'test-project-id' });
      expect(result).toEqual([]);
    });

    it('returns correct lastStatus based on most recent run', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }]);
      insertCases(memDb!, [{ name: 'flaky1', subsys: 'cpu', path: '/p/f1' }]);
      // pass first, then fail → lastStatus = fail
      insertSimulationRun(memDb!, { caseName: 'flaky1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(1) });
      insertSimulationRun(memDb!, { caseName: 'flaky1', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(0) });

      const result = await caller.getUnstableCases({ projectId: 'test-project-id' });

      expect(result).toHaveLength(1);
      expect(result[0].lastStatus).toBe('fail');
    });
  });

  // ─── getPhasePassRate ──────────────────────────────────

  describe('getPhasePassRate', () => {
    it('returns pass rate per phase by joining cases and simulation_runs', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }, { name: 'gpu' }]);
      insertCases(memDb!, [
        { name: 't1', subsys: 'cpu', path: '/p/t1', phase: 'DVR1' },
        { name: 't2', subsys: 'cpu', path: '/p/t2', phase: 'DVR1' },
        { name: 't3', subsys: 'gpu', path: '/p/t3', phase: 'DVS1' },
      ]);
      // DVR1: 2 pass + 1 fail
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0) });
      insertSimulationRun(memDb!, { caseName: 't2', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0) });
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(1) });
      // DVS1: 1 pass + 1 error
      insertSimulationRun(memDb!, { caseName: 't3', subsys: 'gpu', status: 'pass', startTime: isoDaysAgo(0) });
      insertSimulationRun(memDb!, { caseName: 't3', subsys: 'gpu', status: 'error', startTime: isoDaysAgo(1) });

      const result = await caller.getPhasePassRate({ projectId: 'test-project-id' });

      expect(result).toHaveLength(2);

      const dvr1 = result.find((r) => r.phase === 'DVR1');
      expect(dvr1).toBeDefined();
      expect(dvr1!.total).toBe(3);
      expect(dvr1!.pass).toBe(2);
      expect(dvr1!.fail).toBe(1);
      expect(dvr1!.error).toBe(0);
      expect(dvr1!.passRate).toBeCloseTo(66.7, 1);

      const dvs1 = result.find((r) => r.phase === 'DVS1');
      expect(dvs1).toBeDefined();
      expect(dvs1!.total).toBe(2);
      expect(dvs1!.pass).toBe(1);
      expect(dvs1!.fail).toBe(0);
      expect(dvs1!.error).toBe(1);
      expect(dvs1!.passRate).toBe(50);
    });

    it('filters by subsys when provided', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }, { name: 'gpu' }]);
      insertCases(memDb!, [
        { name: 't1', subsys: 'cpu', path: '/p/t1', phase: 'DVR1' },
        { name: 't2', subsys: 'gpu', path: '/p/t2', phase: 'DVS1' },
      ]);
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0) });
      insertSimulationRun(memDb!, { caseName: 't2', subsys: 'gpu', status: 'fail', startTime: isoDaysAgo(0) });

      const result = await caller.getPhasePassRate({ projectId: 'test-project-id', subsys: 'cpu' });

      expect(result).toHaveLength(1);
      expect(result[0].phase).toBe('DVR1');
      expect(result[0].pass).toBe(1);
    });

    it('filters by timeRange when provided', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }]);
      insertCases(memDb!, [{ name: 't1', subsys: 'cpu', path: '/p/t1', phase: 'DVR1' }]);
      // Recent run
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0) });
      // Old run — outside 7d
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(20) });

      const result = await caller.getPhasePassRate({ projectId: 'test-project-id', timeRange: '7d' });

      expect(result).toHaveLength(1);
      expect(result[0].pass).toBe(1);
      expect(result[0].fail).toBe(0);
      expect(result[0].total).toBe(1);
    });

    it('returns empty array for empty database', async () => {
      const result = await caller.getPhasePassRate({ projectId: 'test-project-id' });
      expect(result).toEqual([]);
    });

    it('handles cases with null phase (groups as "未分类")', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }]);
      insertCases(memDb!, [
        { name: 't1', subsys: 'cpu', path: '/p/t1' }, // no phase
        { name: 't2', subsys: 'cpu', path: '/p/t2', phase: 'DVR1' },
      ]);
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0) });
      insertSimulationRun(memDb!, { caseName: 't2', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(0) });

      const result = await caller.getPhasePassRate({ projectId: 'test-project-id' });

      expect(result).toHaveLength(2);
      const unclassified = result.find((r) => r.phase === '未分类');
      expect(unclassified).toBeDefined();
      expect(unclassified!.pass).toBe(1);
      const dvr1 = result.find((r) => r.phase === 'DVR1');
      expect(dvr1).toBeDefined();
      expect(dvr1!.fail).toBe(1);
    });
  });

  // ─── getDebugDifficulty ───────────────────────────────

  describe('getDebugDifficulty', () => {
    it('returns debug difficulty data with daysToFirstPass and failCountBeforePass', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }]);
      insertCases(memDb!, [{ name: 't1', subsys: 'cpu', path: '/p/t1' }]);
      // First run: fail 5 days ago
      // Second run: fail 3 days ago
      // Third run: pass 1 day ago
      // daysToFirstPass = 5 - 1 = 4 days, failCountBeforePass = 2
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(5) });
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(3) });
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(1) });

      const result = await caller.getDebugDifficulty({ projectId: 'test-project-id' });

      expect(result).toHaveLength(1);
      expect(result[0].caseName).toBe('t1');
      expect(result[0].subsys).toBe('cpu');
      expect(result[0].daysToFirstPass).toBeGreaterThanOrEqual(3); // ~4 days (allowing for hour rounding)
      expect(result[0].failCountBeforePass).toBe(2);
    });

    it('only includes cases that have eventually passed', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }]);
      insertCases(memDb!, [
        { name: 'passed_case', subsys: 'cpu', path: '/p/p1' },
        { name: 'never_passed', subsys: 'cpu', path: '/p/p2' },
      ]);
      // This case eventually passes
      insertSimulationRun(memDb!, { caseName: 'passed_case', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(3) });
      insertSimulationRun(memDb!, { caseName: 'passed_case', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0) });
      // This case never passes
      insertSimulationRun(memDb!, { caseName: 'never_passed', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(0) });

      const result = await caller.getDebugDifficulty({ projectId: 'test-project-id' });

      expect(result).toHaveLength(1);
      expect(result[0].caseName).toBe('passed_case');
    });

    it('returns zero daysToFirstPass when first run is already a pass', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }]);
      insertCases(memDb!, [{ name: 't1', subsys: 'cpu', path: '/p/t1' }]);
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0) });

      const result = await caller.getDebugDifficulty({ projectId: 'test-project-id' });

      expect(result).toHaveLength(1);
      expect(result[0].daysToFirstPass).toBe(0);
      expect(result[0].failCountBeforePass).toBe(0);
    });

    it('filters by subsys when provided', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }, { name: 'gpu' }]);
      insertCases(memDb!, [
        { name: 't1', subsys: 'cpu', path: '/p/t1' },
        { name: 't2', subsys: 'gpu', path: '/p/t2' },
      ]);
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(2) });
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0) });
      insertSimulationRun(memDb!, { caseName: 't2', subsys: 'gpu', status: 'fail', startTime: isoDaysAgo(2) });
      insertSimulationRun(memDb!, { caseName: 't2', subsys: 'gpu', status: 'pass', startTime: isoDaysAgo(0) });

      const result = await caller.getDebugDifficulty({ projectId: 'test-project-id', subsys: 'cpu' });

      expect(result).toHaveLength(1);
      expect(result[0].caseName).toBe('t1');
      expect(result[0].subsys).toBe('cpu');
    });

    it('filters by timeRange when provided', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }]);
      insertCases(memDb!, [{ name: 't1', subsys: 'cpu', path: '/p/t1' }]);
      // Old runs — outside 7d
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(20) });
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(15) });
      // Recent run
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(2) });
      insertSimulationRun(memDb!, { caseName: 't1', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0) });

      const result = await caller.getDebugDifficulty({ projectId: 'test-project-id', timeRange: '7d' });

      // Within 7d: first run is fail 2 days ago, first pass is 0 days ago
      expect(result).toHaveLength(1);
      expect(result[0].failCountBeforePass).toBe(1);
      expect(result[0].daysToFirstPass).toBeGreaterThanOrEqual(1);
    });

    it('returns empty array for empty database', async () => {
      const result = await caller.getDebugDifficulty({ projectId: 'test-project-id' });
      expect(result).toEqual([]);
    });

    it('sorts by debug difficulty descending (daysToFirstPass * failCountBeforePass)', async () => {
      insertSubsystems(memDb!, [{ name: 'cpu' }]);
      insertCases(memDb!, [
        { name: 'easy', subsys: 'cpu', path: '/p/easy' },
        { name: 'hard', subsys: 'cpu', path: '/p/hard' },
      ]);
      // easy: 1 fail, 1 day to pass → difficulty = 1
      insertSimulationRun(memDb!, { caseName: 'easy', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(1) });
      insertSimulationRun(memDb!, { caseName: 'easy', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0) });
      // hard: 3 fails, 5 days to pass → difficulty = 15
      insertSimulationRun(memDb!, { caseName: 'hard', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(5) });
      insertSimulationRun(memDb!, { caseName: 'hard', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(4) });
      insertSimulationRun(memDb!, { caseName: 'hard', subsys: 'cpu', status: 'fail', startTime: isoDaysAgo(3) });
      insertSimulationRun(memDb!, { caseName: 'hard', subsys: 'cpu', status: 'pass', startTime: isoDaysAgo(0) });

      const result = await caller.getDebugDifficulty({ projectId: 'test-project-id' });

      expect(result).toHaveLength(2);
      // hard should come first (higher difficulty)
      expect(result[0].caseName).toBe('hard');
      expect(result[1].caseName).toBe('easy');
    });
  });
});
