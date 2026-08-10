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
import { insertSubsystems } from '../src/main/case/db/case-repository';
import { dashboardRouter } from '../src/main/ipc/routers/dashboard-router';
import { unlink } from 'node:fs/promises';

// Create in-memory DB and wire it into the mock
dbRef.current = createMemoryDatabase();
const memDb = dbRef.current;

const caller = dashboardRouter.createCaller({});

// ─── Test Suite ─────────────────────────────────────────────

describe('dashboard-router', () => {
  beforeEach(() => {
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
});
