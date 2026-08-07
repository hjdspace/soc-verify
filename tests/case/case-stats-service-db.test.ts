import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDatabase, closeDatabase, type CaseDatabase } from '../../src/main/case/db/case-database';
import { insertSubsystems, insertCases } from '../../src/main/case/db/case-repository';
import { CaseStatsService } from '../../src/main/case/case-stats-service';
import { NoopDiscovery } from '../../src/main/host/discovery';
import type { SubsysInfo, CaseInfo } from '../../src/main/host/discovery';
import type { SimulationHistoryEntry, SimulationStatus } from '@shared/types';

describe('CaseStatsService — DB-backed listSubsysWithCaseCount', () => {
  let db: CaseDatabase;

  beforeEach(() => {
    db = createMemoryDatabase();
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('reads subsystems with case counts from DB when db is available', async () => {
    insertSubsystems(db, [
      { name: 'cpu', path: '/proj/cpu' },
      { name: 'gpu', path: '/proj/gpu' },
    ]);
    insertCases(db, [
      { name: 't1', subsys: 'cpu', path: '/p/t1' },
      { name: 't2', subsys: 'cpu', path: '/p/t2' },
      { name: 't3', subsys: 'gpu', path: '/p/t3' },
    ]);

    const service = new CaseStatsService({
      discovery: new NoopDiscovery(),
      db,
    });

    const result = await service.listSubsysWithCaseCount();

    expect(result).toHaveLength(2);
    const cpu = result.find((s) => s.name === 'cpu');
    const gpu = result.find((s) => s.name === 'gpu');
    expect(cpu?.caseCount).toBe(2);
    expect(gpu?.caseCount).toBe(1);
  });

  it('returns empty array when DB has no subsystems', async () => {
    const service = new CaseStatsService({
      discovery: new NoopDiscovery(),
      db,
    });

    const result = await service.listSubsysWithCaseCount();
    expect(result).toEqual([]);
  });

  it('filters subsystems by name from DB', async () => {
    insertSubsystems(db, [
      { name: 'cpu', path: '/proj/cpu' },
      { name: 'gpu', path: '/proj/gpu' },
    ]);
    insertCases(db, [
      { name: 't1', subsys: 'cpu', path: '/p/t1' },
      { name: 't2', subsys: 'gpu', path: '/p/t2' },
    ]);

    const service = new CaseStatsService({
      discovery: new NoopDiscovery(),
      db,
    });

    const result = await service.listSubsysWithCaseCount('cp');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('cpu');
    expect(result[0].caseCount).toBe(1);
  });

  it('returns zero caseCount for subsystems with no cases from DB', async () => {
    insertSubsystems(db, [{ name: 'empty_subsys', path: '/proj/empty' }]);

    const service = new CaseStatsService({
      discovery: new NoopDiscovery(),
      db,
    });

    const result = await service.listSubsysWithCaseCount();
    expect(result).toHaveLength(1);
    expect(result[0].caseCount).toBe(0);
  });

  it('falls back to plugin discovery when db is not available', async () => {
    // Create a mock discovery that returns subsystems
    const mockDiscovery = {
      async listSubsys() {
        return [{ name: 'plugin_subsys', path: '/proj/plugin', caseCount: 0 }] as SubsysInfo[];
      },
      async listCases() {
        return [{ name: 'p1', subsys: 'plugin_subsys', path: '/p/p1', status: 'pending' as const }] as CaseInfo[];
      },
      async getSimOptionsSchema() {
        return {};
      },
      clearCache() {},
    };

    const service = new CaseStatsService({
      discovery: mockDiscovery as unknown as NoopDiscovery,
    });

    const result = await service.listSubsysWithCaseCount();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('plugin_subsys');
    expect(result[0].caseCount).toBe(1);
  });

  it('returns path from DB in subsystem result', async () => {
    insertSubsystems(db, [{ name: 'cpu', path: '/proj/cpu' }]);

    const service = new CaseStatsService({
      discovery: new NoopDiscovery(),
      db,
    });

    const result = await service.listSubsysWithCaseCount();
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('/proj/cpu');
  });
});

// ─── Mock SimulationManager ─────────────────────────────────

function makeMockSimManager(history: SimulationHistoryEntry[] = []): {
  getHistory: () => SimulationHistoryEntry[];
  getActiveRuns: () => never[];
} {
  return {
    getHistory: () => history,
    getActiveRuns: () => [],
  };
}

function makeHistoryEntry(
  overrides: Partial<SimulationHistoryEntry> = {},
): SimulationHistoryEntry {
  return {
    runId: 'run-1',
    caseId: 'case-1',
    caseName: 'test1',
    subsys: 'cpu',
    options: {},
    status: 'pass' as SimulationStatus,
    startTime: 1000,
    endTime: 2000,
    duration: 1000,
    ...overrides,
  };
}

describe('CaseStatsService — DB-backed listCasesWithStatus', () => {
  let db: CaseDatabase;

  beforeEach(() => {
    db = createMemoryDatabase();
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('reads cases from DB when db is available', async () => {
    insertSubsystems(db, [{ name: 'cpu', path: '/proj/cpu' }]);
    insertCases(db, [
      { name: 't1', subsys: 'cpu', path: '/p/t1' },
      { name: 't2', subsys: 'cpu', path: '/p/t2' },
    ]);

    const service = new CaseStatsService({
      discovery: new NoopDiscovery(),
      simulationManager: makeMockSimManager() as never,
      db,
    });

    const result = await service.listCasesWithStatus('cpu');
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('t1');
    expect(result[1].name).toBe('t2');
  });

  it('joins pass status from SimulationManager history', async () => {
    insertSubsystems(db, [{ name: 'cpu', path: '/proj/cpu' }]);
    insertCases(db, [
      { name: 't1', subsys: 'cpu', path: '/p/t1' },
      { name: 't2', subsys: 'cpu', path: '/p/t2' },
    ]);

    const mockSim = makeMockSimManager([
      makeHistoryEntry({ caseName: 't1', subsys: 'cpu', status: 'pass' }),
    ]);

    const service = new CaseStatsService({
      discovery: new NoopDiscovery(),
      simulationManager: mockSim as never,
      db,
    });

    const result = await service.listCasesWithStatus('cpu');
    expect(result).toHaveLength(2);
    const t1 = result.find((c) => c.name === 't1');
    const t2 = result.find((c) => c.name === 't2');
    expect(t1?.status).toBe('pass');
    expect(t2?.status).toBe('pending');
  });

  it('joins fail status from SimulationManager history', async () => {
    insertSubsystems(db, [{ name: 'cpu', path: '/proj/cpu' }]);
    insertCases(db, [
      { name: 't1', subsys: 'cpu', path: '/p/t1' },
    ]);

    const mockSim = makeMockSimManager([
      makeHistoryEntry({ caseName: 't1', subsys: 'cpu', status: 'fail' }),
    ]);

    const service = new CaseStatsService({
      discovery: new NoopDiscovery(),
      simulationManager: mockSim as never,
      db,
    });

    const result = await service.listCasesWithStatus('cpu');
    expect(result[0].status).toBe('fail');
  });

  it('uses latest run status when multiple history entries exist', async () => {
    insertSubsystems(db, [{ name: 'cpu', path: '/proj/cpu' }]);
    insertCases(db, [{ name: 't1', subsys: 'cpu', path: '/p/t1' }]);

    // History is unshift (newest first); so latest is the first entry
    const mockSim = makeMockSimManager([
      makeHistoryEntry({ caseName: 't1', subsys: 'cpu', status: 'pass', startTime: 2000 }),
      makeHistoryEntry({ caseName: 't1', subsys: 'cpu', status: 'fail', startTime: 1000 }),
    ]);

    const service = new CaseStatsService({
      discovery: new NoopDiscovery(),
      simulationManager: mockSim as never,
      db,
    });

    const result = await service.listCasesWithStatus('cpu');
    expect(result[0].status).toBe('pass');
  });

  it('returns pending status for cases with no simulation history', async () => {
    insertSubsystems(db, [{ name: 'cpu', path: '/proj/cpu' }]);
    insertCases(db, [{ name: 'never_run', subsys: 'cpu', path: '/p/never' }]);

    const service = new CaseStatsService({
      discovery: new NoopDiscovery(),
      simulationManager: makeMockSimManager() as never,
      db,
    });

    const result = await service.listCasesWithStatus('cpu');
    expect(result[0].status).toBe('pending');
  });

  it('returns empty array when subsys has no cases in DB', async () => {
    insertSubsystems(db, [{ name: 'cpu', path: '/proj/cpu' }]);

    const service = new CaseStatsService({
      discovery: new NoopDiscovery(),
      db,
    });

    const result = await service.listCasesWithStatus('cpu');
    expect(result).toEqual([]);
  });

  it('returns empty array when subsys is undefined', async () => {
    insertSubsystems(db, [{ name: 'cpu', path: '/proj/cpu' }]);
    insertCases(db, [{ name: 't1', subsys: 'cpu', path: '/p/t1' }]);

    const service = new CaseStatsService({
      discovery: new NoopDiscovery(),
      db,
    });

    const result = await service.listCasesWithStatus();
    expect(result).toEqual([]);
  });

  it('falls back to discovery when db is not available', async () => {
    const mockDiscovery = {
      async listSubsys() {
        return [{ name: 'cpu', path: '/proj/cpu' }] as SubsysInfo[];
      },
      async listCases() {
        return [{ name: 'p1', subsys: 'cpu', path: '/p/p1', status: 'pending' as const }] as CaseInfo[];
      },
      async getSimOptionsSchema() {
        return {};
      },
      clearCache() {},
    };

    const service = new CaseStatsService({
      discovery: mockDiscovery as unknown as NoopDiscovery,
    });

    const result = await service.listCasesWithStatus('cpu');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('p1');
    expect(result[0].status).toBe('pending');
  });

  it('preserves case fields (filePath, baseCase, etc.) from DB', async () => {
    insertSubsystems(db, [{ name: 'cpu', path: '/proj/cpu' }]);
    insertCases(db, [{
      name: 't1',
      subsys: 'cpu',
      path: '/p/t1',
      filePath: '/proj/cfg.py',
      baseCase: 'base_case',
      base: 'base_val',
      block: 'block_val',
    }]);

    const service = new CaseStatsService({
      discovery: new NoopDiscovery(),
      db,
    });

    const result = await service.listCasesWithStatus('cpu');
    expect(result[0].filePath).toBe('/proj/cfg.py');
    expect(result[0].baseCase).toBe('base_case');
    expect(result[0].base).toBe('base_val');
    expect(result[0].block).toBe('block_val');
  });
});

describe('CaseStatsService — DB-backed searchCases', () => {
  let db: CaseDatabase;

  beforeEach(() => {
    db = createMemoryDatabase();
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('finds cases by substring match from DB', async () => {
    insertSubsystems(db, [{ name: 'cpu', path: '/proj/cpu' }]);
    insertCases(db, [
      { name: 'test_basic', subsys: 'cpu', path: '/p/t1' },
      { name: 'test_advanced', subsys: 'cpu', path: '/p/t2' },
      { name: 'smoke_test', subsys: 'cpu', path: '/p/t3' },
    ]);

    const service = new CaseStatsService({
      discovery: new NoopDiscovery(),
      db,
    });

    const result = await service.searchCases('basic');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('test_basic');
  });

  it('finds multiple matches', async () => {
    insertSubsystems(db, [{ name: 'cpu', path: '/proj/cpu' }]);
    insertCases(db, [
      { name: 'test_basic', subsys: 'cpu', path: '/p/t1' },
      { name: 'test_advanced', subsys: 'cpu', path: '/p/t2' },
      { name: 'smoke_test', subsys: 'cpu', path: '/p/t3' },
    ]);

    const service = new CaseStatsService({
      discovery: new NoopDiscovery(),
      db,
    });

    const result = await service.searchCases('test');
    expect(result).toHaveLength(3);
  });

  it('returns empty for no match', async () => {
    insertSubsystems(db, [{ name: 'cpu', path: '/proj/cpu' }]);
    insertCases(db, [{ name: 'test_basic', subsys: 'cpu', path: '/p/t1' }]);

    const service = new CaseStatsService({
      discovery: new NoopDiscovery(),
      db,
    });

    const result = await service.searchCases('nonexistent');
    expect(result).toEqual([]);
  });

  it('filters by subsys', async () => {
    insertSubsystems(db, [
      { name: 'cpu', path: '/proj/cpu' },
      { name: 'gpu', path: '/proj/gpu' },
    ]);
    insertCases(db, [
      { name: 'test1', subsys: 'cpu', path: '/p/t1' },
      { name: 'test2', subsys: 'gpu', path: '/p/t2' },
    ]);

    const service = new CaseStatsService({
      discovery: new NoopDiscovery(),
      db,
    });

    const cpuResults = await service.searchCases('test', 'cpu');
    expect(cpuResults).toHaveLength(1);
    expect(cpuResults[0].name).toBe('test1');
  });

  it('respects limit', async () => {
    insertSubsystems(db, [{ name: 'cpu', path: '/proj/cpu' }]);
    insertCases(db, [
      { name: 'test1', subsys: 'cpu', path: '/p/t1' },
      { name: 'test2', subsys: 'cpu', path: '/p/t2' },
      { name: 'test3', subsys: 'cpu', path: '/p/t3' },
    ]);

    const service = new CaseStatsService({
      discovery: new NoopDiscovery(),
      db,
    });

    const result = await service.searchCases('test', undefined, 2);
    expect(result).toHaveLength(2);
  });

  it('returns empty on empty query', async () => {
    insertSubsystems(db, [{ name: 'cpu', path: '/proj/cpu' }]);
    insertCases(db, [{ name: 'test1', subsys: 'cpu', path: '/p/t1' }]);

    const service = new CaseStatsService({
      discovery: new NoopDiscovery(),
      db,
    });

    const result = await service.searchCases('');
    expect(result).toEqual([]);
  });

  it('returns empty array when db is not available', async () => {
    const service = new CaseStatsService({
      discovery: new NoopDiscovery(),
    });

    const result = await service.searchCases('test');
    expect(result).toEqual([]);
  });

  it('returns CaseInfo-shaped results with all fields', async () => {
    insertSubsystems(db, [{ name: 'cpu', path: '/proj/cpu' }]);
    insertCases(db, [{
      name: 'test1',
      subsys: 'cpu',
      path: '/p/t1',
      filePath: '/proj/cfg.py',
      baseCase: 'base_case',
    }]);

    const service = new CaseStatsService({
      discovery: new NoopDiscovery(),
      db,
    });

    const result = await service.searchCases('test');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('test1');
    expect(result[0].subsys).toBe('cpu');
    expect(result[0].path).toBe('/p/t1');
    expect(result[0].filePath).toBe('/proj/cfg.py');
    expect(result[0].baseCase).toBe('base_case');
  });
});
