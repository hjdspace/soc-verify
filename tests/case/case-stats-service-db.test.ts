import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDatabase, closeDatabase, type CaseDatabase } from '../../src/main/case/db/case-database';
import { insertSubsystems, insertCases } from '../../src/main/case/db/case-repository';
import { CaseStatsService } from '../../src/main/case/case-stats-service';
import { NoopDiscovery } from '../../src/main/host/discovery';
import type { SubsysInfo, CaseInfo } from '../../src/main/host/discovery';

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
