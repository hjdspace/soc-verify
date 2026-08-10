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

function isoDaysAgo(days: number, hour = 10): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

function dateStrDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
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
});
