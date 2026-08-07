import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDatabase, closeDatabase, type CaseDatabase } from '../../src/main/case/db/case-database';
import { insertSubsystems, insertCases, insertSimulationRun } from '../../src/main/case/db/case-repository';
import { CaseStatsService } from '../../src/main/case/case-stats-service';
import type { SimulationHistoryEntry, SimulationStatus } from '@shared/types';
import type { SimulationRunRecord } from '../../src/main/simulation/simulation-manager';

// ─── Mock SimulationManager ─────────────────────────────────

function makeMockSimManager(
  history: SimulationHistoryEntry[] = [],
  activeRuns: SimulationRunRecord[] = [],
): { getHistory: () => SimulationHistoryEntry[]; getActiveRuns: () => SimulationRunRecord[] } {
  return {
    getHistory: () => history,
    getActiveRuns: () => activeRuns,
  };
}

function makeHistoryEntry(opts: {
  caseName: string;
  subsys: string;
  status: SimulationStatus;
  startTime: number;
}): SimulationHistoryEntry {
  return {
    runId: `run_${opts.caseName}_${opts.startTime}`,
    caseId: opts.caseName,
    caseName: opts.caseName,
    subsys: opts.subsys,
    options: {},
    status: opts.status,
    startTime: opts.startTime,
    endTime: opts.startTime + 1000,
    duration: 1000,
  };
}

function makeActiveRun(opts: {
  caseName: string;
  subsys: string;
  startTime?: number;
}): SimulationRunRecord {
  const startTime = opts.startTime ?? Date.now();
  return {
    runId: `active_${opts.caseName}`,
    projectId: 'p1',
    options: { caseId: opts.caseName, caseName: opts.caseName, subsys: opts.subsys },
    status: { runId: `active_${opts.caseName}`, status: 'running' as SimulationStatus, startTime },
    startTime,
  };
}

// ─── Fixtures ─────────────────────────────────────────────

function seedDb(db: CaseDatabase): void {
  insertSubsystems(db, [
    { name: 'cpu', path: '/subsystems/cpu' },
    { name: 'gpu', path: '/subsystems/gpu' },
  ]);
  insertCases(db, [
    // cpu: 4 cases across 2 files
    { name: 'cpu_alu_basic', subsys: 'cpu', path: '/cases/alu_basic', filePath: '/tests/alu_tests.cfg' },
    { name: 'cpu_alu_overflow', subsys: 'cpu', path: '/cases/alu_overflow', filePath: '/tests/alu_tests.cfg', baseCase: 'cpu_alu_basic' },
    { name: 'cpu_reg_write', subsys: 'cpu', path: '/cases/reg_write', filePath: '/tests/alu_tests.cfg' },
    { name: 'cpu_pipeline_stall', subsys: 'cpu', path: '/cases/pipeline_stall', filePath: '/tests/pipeline.cfg' },
    // gpu: 2 cases in 1 file
    { name: 'gpu_render_basic', subsys: 'gpu', path: '/cases/render_basic', filePath: '/tests/gpu_render.cfg' },
    { name: 'gpu_texture_load', subsys: 'gpu', path: '/cases/texture_load', filePath: '/tests/gpu_render.cfg' },
  ]);
}

function seedRun(db: CaseDatabase, caseName: string, subsys: string, status: string, startTime: string): void {
  insertSimulationRun(db, { caseName, subsys, status, startTime });
}

// ─── Tests ────────────────────────────────────────────────

describe('CaseStatsService — DB-backed (ADR 0017 Issue #4)', () => {
  let db: CaseDatabase;

  beforeEach(() => {
    db = createMemoryDatabase();
  });

  afterEach(() => {
    closeDatabase(db);
  });

  // ─── listSubsysWithCaseCount ────────────────────────────

  describe('listSubsysWithCaseCount', () => {
    it('reads subsystems with case counts from DB', async () => {
      seedDb(db);
      const service = new CaseStatsService({ db });

      const result = await service.listSubsysWithCaseCount();
      expect(result).toHaveLength(2);
      const cpu = result.find((s) => s.name === 'cpu');
      const gpu = result.find((s) => s.name === 'gpu');
      expect(cpu?.caseCount).toBe(4);
      expect(gpu?.caseCount).toBe(2);
    });

    it('returns empty array when DB has no subsystems', async () => {
      const service = new CaseStatsService({ db });
      const result = await service.listSubsysWithCaseCount();
      expect(result).toEqual([]);
    });

    it('filters subsystems by name from DB', async () => {
      seedDb(db);
      const service = new CaseStatsService({ db });

      const result = await service.listSubsysWithCaseCount('cp');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('cpu');
      expect(result[0].caseCount).toBe(4);
    });

    it('returns zero caseCount for subsystems with no cases', async () => {
      insertSubsystems(db, [{ name: 'empty_subsys', path: '/proj/empty' }]);
      const service = new CaseStatsService({ db });

      const result = await service.listSubsysWithCaseCount();
      expect(result).toHaveLength(1);
      expect(result[0].caseCount).toBe(0);
    });

    it('returns path from DB in subsystem result', async () => {
      insertSubsystems(db, [{ name: 'cpu', path: '/proj/cpu' }]);
      const service = new CaseStatsService({ db });

      const result = await service.listSubsysWithCaseCount();
      expect(result[0].path).toBe('/proj/cpu');
    });
  });

  // ─── listCasesWithStatus ────────────────────────────────

  describe('listCasesWithStatus', () => {
    it('reads cases from DB with pending status when no simulation runs', async () => {
      seedDb(db);
      const service = new CaseStatsService({ db });

      const result = await service.listCasesWithStatus('cpu');
      expect(result).toHaveLength(4);
      for (const c of result) {
        expect(c.status).toBe('pending');
      }
    });

    it('joins pass/fail status from simulation_runs table', async () => {
      seedDb(db);
      seedRun(db, 'cpu_alu_basic', 'cpu', 'pass', '2024-01-01T10:00:00');
      seedRun(db, 'cpu_pipeline_stall', 'cpu', 'fail', '2024-01-01T10:00:00');

      const service = new CaseStatsService({ db });
      const result = await service.listCasesWithStatus('cpu');
      const byName = new Map(result.map((c) => [c.name, c.status]));

      expect(byName.get('cpu_alu_basic')).toBe('pass');
      expect(byName.get('cpu_pipeline_stall')).toBe('fail');
      expect(byName.get('cpu_alu_overflow')).toBe('pending');
      expect(byName.get('cpu_reg_write')).toBe('pending');
    });

    it('takes the latest run status from simulation_runs', async () => {
      seedDb(db);
      // fail then pass → latest = pass
      seedRun(db, 'cpu_alu_basic', 'cpu', 'fail', '2024-01-01T10:00:00');
      seedRun(db, 'cpu_alu_basic', 'cpu', 'pass', '2024-01-02T10:00:00');

      const service = new CaseStatsService({ db });
      const result = await service.listCasesWithStatus('cpu');
      const aluBasic = result.find((c) => c.name === 'cpu_alu_basic');
      expect(aluBasic?.status).toBe('pass');
    });

    it('overlays running status from SimulationManager activeRuns', async () => {
      seedDb(db);
      // DB has a terminal status (pass)
      seedRun(db, 'cpu_alu_basic', 'cpu', 'pass', '2024-01-01T10:00:00');

      // But activeRuns shows it's currently running
      const mockSim = makeMockSimManager([], [
        makeActiveRun({ caseName: 'cpu_alu_basic', subsys: 'cpu' }),
      ]);

      const service = new CaseStatsService({ db, simulationManager: mockSim as never });
      const result = await service.listCasesWithStatus('cpu');
      const aluBasic = result.find((c) => c.name === 'cpu_alu_basic');
      expect(aluBasic?.status).toBe('running');
    });

    it('running from activeRuns does not bleed into other subsys', async () => {
      seedDb(db);
      const mockSim = makeMockSimManager([], [
        makeActiveRun({ caseName: 'cpu_alu_basic', subsys: 'cpu' }),
      ]);

      const service = new CaseStatsService({ db, simulationManager: mockSim as never });
      const gpuResult = await service.listCasesWithStatus('gpu');
      // No running status should appear in gpu results
      for (const c of gpuResult) {
        expect(c.status).not.toBe('running');
      }
    });

    it('returns empty array when subsys has no cases in DB', async () => {
      insertSubsystems(db, [{ name: 'cpu', path: '/proj/cpu' }]);
      const service = new CaseStatsService({ db });

      const result = await service.listCasesWithStatus('cpu');
      expect(result).toEqual([]);
    });

    it('returns empty array when subsys is undefined', async () => {
      seedDb(db);
      const service = new CaseStatsService({ db });

      const result = await service.listCasesWithStatus();
      expect(result).toEqual([]);
    });

    it('preserves case fields (filePath, baseCase, etc.) from DB', async () => {
      seedDb(db);
      const service = new CaseStatsService({ db });

      const result = await service.listCasesWithStatus('cpu');
      const overflow = result.find((c) => c.name === 'cpu_alu_overflow');
      expect(overflow?.filePath).toBe('/tests/alu_tests.cfg');
      expect(overflow?.baseCase).toBe('cpu_alu_basic');
    });

    it('does not read from SimulationManager history (status from DB only)', async () => {
      seedDb(db);
      // SimulationManager has history entries, but no simulation_runs in DB
      const mockSim = makeMockSimManager([
        makeHistoryEntry({ caseName: 'cpu_alu_basic', subsys: 'cpu', status: 'pass', startTime: 100 }),
      ]);

      const service = new CaseStatsService({ db, simulationManager: mockSim as never });
      const result = await service.listCasesWithStatus('cpu');
      // Status should be pending because no simulation_runs in DB
      const aluBasic = result.find((c) => c.name === 'cpu_alu_basic');
      expect(aluBasic?.status).toBe('pending');
    });
  });

  // ─── searchCases ────────────────────────────────────────

  describe('searchCases', () => {
    it('finds cases by substring match from DB', async () => {
      seedDb(db);
      const service = new CaseStatsService({ db });

      const result = await service.searchCases('alu');
      expect(result).toHaveLength(2);
      expect(result.some((c) => c.name === 'cpu_alu_basic')).toBe(true);
      expect(result.some((c) => c.name === 'cpu_alu_overflow')).toBe(true);
    });

    it('returns empty for no match', async () => {
      seedDb(db);
      const service = new CaseStatsService({ db });

      const result = await service.searchCases('nonexistent');
      expect(result).toEqual([]);
    });

    it('filters by subsys', async () => {
      seedDb(db);
      const service = new CaseStatsService({ db });

      const cpuResults = await service.searchCases('cpu', 'cpu');
      expect(cpuResults).toHaveLength(4);
    });

    it('respects limit', async () => {
      seedDb(db);
      const service = new CaseStatsService({ db });

      const result = await service.searchCases('cpu', undefined, 2);
      expect(result).toHaveLength(2);
    });

    it('returns empty on empty query', async () => {
      seedDb(db);
      const service = new CaseStatsService({ db });

      const result = await service.searchCases('');
      expect(result).toEqual([]);
    });
  });

  // ─── getCaseToSubsysMap ─────────────────────────────────

  describe('getCaseToSubsysMap', () => {
    it('returns caseName → subsys map from DB', async () => {
      seedDb(db);
      const service = new CaseStatsService({ db });

      const map = await service.getCaseToSubsysMap();
      expect(map.size).toBe(6);
      expect(map.get('cpu_alu_basic')).toBe('cpu');
      expect(map.get('gpu_render_basic')).toBe('gpu');
    });

    it('returns empty map when no cases in DB', async () => {
      const service = new CaseStatsService({ db });
      const map = await service.getCaseToSubsysMap();
      expect(map.size).toBe(0);
    });
  });

  // ─── getCaseStats ───────────────────────────────────────

  describe('getCaseStats', () => {
    it('returns flat summary with total, byStatus, byFile', async () => {
      seedDb(db);
      seedRun(db, 'cpu_alu_basic', 'cpu', 'pass', '2024-01-01T10:00:00');
      seedRun(db, 'cpu_pipeline_stall', 'cpu', 'fail', '2024-01-01T10:00:00');

      const service = new CaseStatsService({ db });
      const stats = await service.getCaseStats('cpu');

      expect(stats).not.toBeNull();
      expect(stats!.subsys).toBe('cpu');
      expect(stats!.total).toBe(4);
      expect(stats!.byStatus.pass).toBe(1);
      expect(stats!.byStatus.fail).toBe(1);
      expect(stats!.byStatus.pending).toBe(2);
    });

    it('groups by filePath with rootCases and childCount', async () => {
      seedDb(db);
      const service = new CaseStatsService({ db });

      const stats = await service.getCaseStats('cpu');
      expect(stats).not.toBeNull();

      // 2 files: alu_tests.cfg (3 cases) and pipeline.cfg (1 case)
      expect(stats!.byFile).toHaveLength(2);

      const aluFile = stats!.byFile.find((f) => f.fileName === 'alu_tests.cfg');
      expect(aluFile).toBeDefined();
      expect(aluFile!.caseCount).toBe(3);
      // rootCases: cpu_alu_basic (1 child) + cpu_reg_write (0 children)
      expect(aluFile!.rootCases).toHaveLength(2);
      const aluBasic = aluFile!.rootCases.find((r) => r.name === 'cpu_alu_basic');
      expect(aluBasic?.childCount).toBe(1);
      const regWrite = aluFile!.rootCases.find((r) => r.name === 'cpu_reg_write');
      expect(regWrite?.childCount).toBe(0);

      const pipelineFile = stats!.byFile.find((f) => f.fileName === 'pipeline.cfg');
      expect(pipelineFile).toBeDefined();
      expect(pipelineFile!.caseCount).toBe(1);
    });

    it('sorts byFile by caseCount descending', async () => {
      seedDb(db);
      const service = new CaseStatsService({ db });

      const stats = await service.getCaseStats('cpu');
      expect(stats!.byFile[0]!.caseCount).toBeGreaterThanOrEqual(stats!.byFile[1]!.caseCount);
    });

    it('returns null for undefined subsys', async () => {
      const service = new CaseStatsService({ db });
      const stats = await service.getCaseStats(undefined);
      expect(stats).toBeNull();
    });

    it('returns zero stats for nonexistent subsys', async () => {
      const service = new CaseStatsService({ db });
      const stats = await service.getCaseStats('nonexistent');
      expect(stats).toEqual({
        subsys: 'nonexistent',
        total: 0,
        byStatus: { pass: 0, fail: 0, running: 0, pending: 0, error: 0, aborted: 0 },
        byFile: [],
      });
    });

    it('overlays running status from activeRuns in byStatus', async () => {
      seedDb(db);
      seedRun(db, 'cpu_alu_basic', 'cpu', 'pass', '2024-01-01T10:00:00');

      const mockSim = makeMockSimManager([], [
        makeActiveRun({ caseName: 'cpu_reg_write', subsys: 'cpu' }),
      ]);

      const service = new CaseStatsService({ db, simulationManager: mockSim as never });
      const stats = await service.getCaseStats('cpu');

      expect(stats!.byStatus.pass).toBe(1);
      expect(stats!.byStatus.running).toBe(1);
      expect(stats!.byStatus.pending).toBe(2);
    });
  });

  // ─── getProjectOverview ─────────────────────────────────

  describe('getProjectOverview', () => {
    it('returns project-wide aggregate from DB', async () => {
      seedDb(db);
      seedRun(db, 'cpu_alu_basic', 'cpu', 'pass', '2024-01-01T10:00:00');
      seedRun(db, 'gpu_render_basic', 'gpu', 'fail', '2024-01-01T10:00:00');

      const service = new CaseStatsService({ db });
      const overview = await service.getProjectOverview();

      expect(overview.subsysCount).toBe(2);
      expect(overview.totalCases).toBe(6);
      expect(overview.bySubsys).toHaveLength(2);

      const cpu = overview.bySubsys.find((s) => s.name === 'cpu');
      expect(cpu?.caseCount).toBe(4);
      expect(cpu?.byStatus.pass).toBe(1);
      expect(cpu?.byStatus.pending).toBe(3);

      const gpu = overview.bySubsys.find((s) => s.name === 'gpu');
      expect(gpu?.caseCount).toBe(2);
      expect(gpu?.byStatus.fail).toBe(1);
      expect(gpu?.byStatus.pending).toBe(1);
    });

    it('returns empty overview when no subsystems', async () => {
      const service = new CaseStatsService({ db });
      const overview = await service.getProjectOverview();
      expect(overview).toEqual({ subsysCount: 0, totalCases: 0, bySubsys: [] });
    });

    it('does not cache overview (no TTL — DB is fast enough)', async () => {
      seedDb(db);
      const service = new CaseStatsService({ db });

      // First call
      const overview1 = await service.getProjectOverview();
      expect(overview1.totalCases).toBe(6);

      // Add a new case to DB
      insertCases(db, [{ name: 'cpu_new_case', subsys: 'cpu', path: '/cases/new' }]);

      // Second call should reflect the new data (no stale cache)
      const overview2 = await service.getProjectOverview();
      expect(overview2.totalCases).toBe(7);
    });

    it('overlays running status from activeRuns in overview', async () => {
      seedDb(db);
      const mockSim = makeMockSimManager([], [
        makeActiveRun({ caseName: 'cpu_alu_basic', subsys: 'cpu' }),
      ]);

      const service = new CaseStatsService({ db, simulationManager: mockSim as never });
      const overview = await service.getProjectOverview();

      const cpu = overview.bySubsys.find((s) => s.name === 'cpu')!;
      expect(cpu.byStatus.running).toBe(1);
      expect(cpu.byStatus.pending).toBe(3);
    });
  });

  // ─── setSimulationManager ───────────────────────────────

  describe('setSimulationManager', () => {
    it('allows late injection of simulation manager for running status overlay', async () => {
      seedDb(db);
      const service = new CaseStatsService({ db });

      // Before injection: all pending
      let result = await service.listCasesWithStatus('cpu');
      expect(result.every((c) => c.status === 'pending')).toBe(true);

      // After injection: running overlay works
      const mockSim = makeMockSimManager([], [
        makeActiveRun({ caseName: 'cpu_alu_basic', subsys: 'cpu' }),
      ]);
      service.setSimulationManager(mockSim as never);

      result = await service.listCasesWithStatus('cpu');
      const aluBasic = result.find((c) => c.name === 'cpu_alu_basic');
      expect(aluBasic?.status).toBe('running');
    });
  });

  // ─── clearDiscoveryCache (no-op) ───────────────────────

  describe('clearDiscoveryCache', () => {
    it('is a no-op (no discovery cache to clear, DB is source of truth)', async () => {
      seedDb(db);
      const service = new CaseStatsService({ db });

      // Should not throw
      service.clearDiscoveryCache();
      service.clearDiscoveryCache('cpu');

      // Data should still be accessible
      const result = await service.listSubsysWithCaseCount();
      expect(result).toHaveLength(2);
    });
  });
});
