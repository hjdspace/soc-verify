import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDatabase, closeDatabase, type CaseDatabase } from '../../src/main/case/db/case-database';
import {
  insertSubsystems,
  getSubsystems,
  insertCases,
  getCases,
  getSubsysWithCaseCount,
  searchCases,
  insertSimulationRun,
  getLatestRunStatus,
  getScanMetadata,
  setScanMetadata,
  clearAllCases,
  type SubsysRow,
  type CaseRow,
  type SimulationRunRow,
} from '../../src/main/case/db/case-repository';

describe('Case Database Repository', () => {
  let db: CaseDatabase;

  beforeEach(() => {
    db = createMemoryDatabase();
  });

  afterEach(() => {
    closeDatabase(db);
  });

  // ─── Helpers ────────────────────────────────────────────

  function makeSubsys(overrides: Partial<SubsysRow> = {}): SubsysRow {
    return {
      name: 'cpu_subsys',
      path: '/proj/cpu',
      description: 'CPU subsystem',
      ...overrides,
    };
  }

  function makeCase(overrides: Partial<CaseRow> = {}): CaseRow {
    return {
      name: 'test_basic',
      subsys: 'cpu_subsys',
      path: '/proj/cpu/test_basic',
      filePath: '/proj/cpu/case_cfg.py',
      baseCase: undefined,
      base: undefined,
      block: undefined,
      phase: undefined,
      ...overrides,
    };
  }

  // ─── subsystems CRUD ────────────────────────────────────

  describe('insertSubsystems', () => {
    it('inserts subsystems and returns count', () => {
      const subsys = [
        makeSubsys({ name: 'cpu' }),
        makeSubsys({ name: 'gpu', path: '/proj/gpu' }),
      ];
      const result = insertSubsystems(db, subsys);
      expect(result.inserted).toBe(2);
    });

    it('replaces existing subsystem on duplicate name (INSERT OR REPLACE)', () => {
      insertSubsystems(db, [makeSubsys({ name: 'cpu', description: 'old' })]);
      const result = insertSubsystems(db, [makeSubsys({ name: 'cpu', description: 'new desc' })]);
      expect(result.inserted).toBe(1);

      const subsys = getSubsystems(db);
      expect(subsys).toHaveLength(1);
      expect(subsys[0].description).toBe('new desc');
    });

    it('handles empty array', () => {
      const result = insertSubsystems(db, []);
      expect(result.inserted).toBe(0);
    });
  });

  describe('getSubsystems', () => {
    it('returns empty array when no subsystems', () => {
      expect(getSubsystems(db)).toEqual([]);
    });

    it('returns all subsystems', () => {
      insertSubsystems(db, [
        makeSubsys({ name: 'cpu' }),
        makeSubsys({ name: 'gpu' }),
      ]);
      const result = getSubsystems(db);
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('cpu');
      expect(result[1].name).toBe('gpu');
    });

    it('filters subsystems by name', () => {
      insertSubsystems(db, [
        makeSubsys({ name: 'cpu' }),
        makeSubsys({ name: 'gpu' }),
      ]);
      const result = getSubsystems(db, 'cp');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('cpu');
    });
  });

  // ─── cases CRUD ─────────────────────────────────────────

  describe('insertCases', () => {
    it('inserts cases and returns count', () => {
      // Need a subsystem first (foreign key)
      insertSubsystems(db, [makeSubsys({ name: 'cpu' })]);
      const cases = [
        makeCase({ name: 'test1', subsys: 'cpu' }),
        makeCase({ name: 'test2', subsys: 'cpu' }),
      ];
      const result = insertCases(db, cases);
      expect(result.inserted).toBe(2);
    });

    it('replaces existing case on duplicate (name, subsys) pair', () => {
      insertSubsystems(db, [makeSubsys({ name: 'cpu' })]);
      insertCases(db, [makeCase({ name: 'test1', subsys: 'cpu', filePath: '/old.py' })]);
      const result = insertCases(db, [makeCase({ name: 'test1', subsys: 'cpu', filePath: '/new.py' })]);
      expect(result.inserted).toBe(1);

      const cases = getCases(db, 'cpu');
      expect(cases).toHaveLength(1);
      expect(cases[0].filePath).toBe('/new.py');
    });

    it('handles empty array', () => {
      const result = insertCases(db, []);
      expect(result.inserted).toBe(0);
    });
  });

  describe('getCases', () => {
    it('returns empty array when no cases', () => {
      expect(getCases(db)).toEqual([]);
    });

    it('returns cases filtered by subsys', () => {
      insertSubsystems(db, [makeSubsys({ name: 'cpu' }), makeSubsys({ name: 'gpu' })]);
      insertCases(db, [
        makeCase({ name: 'test1', subsys: 'cpu' }),
        makeCase({ name: 'test2', subsys: 'cpu' }),
        makeCase({ name: 'test3', subsys: 'gpu' }),
      ]);
      const cpuCases = getCases(db, 'cpu');
      expect(cpuCases).toHaveLength(2);
      expect(cpuCases[0].name).toBe('test1');
    });

    it('returns all cases when no subsys filter', () => {
      insertSubsystems(db, [makeSubsys({ name: 'cpu' }), makeSubsys({ name: 'gpu' })]);
      insertCases(db, [
        makeCase({ name: 'test1', subsys: 'cpu' }),
        makeCase({ name: 'test3', subsys: 'gpu' }),
      ]);
      const allCases = getCases(db);
      expect(allCases).toHaveLength(2);
    });
  });

  // ─── aggregation: getSubsysWithCaseCount ────────────────

  describe('getSubsysWithCaseCount', () => {
    it('returns empty array when no subsystems', () => {
      expect(getSubsysWithCaseCount(db)).toEqual([]);
    });

    it('returns subsystems with case counts', () => {
      insertSubsystems(db, [makeSubsys({ name: 'cpu' }), makeSubsys({ name: 'gpu' })]);
      insertCases(db, [
        makeCase({ name: 't1', subsys: 'cpu' }),
        makeCase({ name: 't2', subsys: 'cpu' }),
        makeCase({ name: 't3', subsys: 'gpu' }),
      ]);
      const result = getSubsysWithCaseCount(db);
      expect(result).toHaveLength(2);
      const cpu = result.find((s) => s.name === 'cpu');
      const gpu = result.find((s) => s.name === 'gpu');
      expect(cpu?.caseCount).toBe(2);
      expect(gpu?.caseCount).toBe(1);
    });

    it('returns zero caseCount for subsystems with no cases', () => {
      insertSubsystems(db, [makeSubsys({ name: 'empty_subsys' })]);
      const result = getSubsysWithCaseCount(db);
      expect(result).toHaveLength(1);
      expect(result[0].caseCount).toBe(0);
    });

    it('filters subsystems by name', () => {
      insertSubsystems(db, [makeSubsys({ name: 'cpu' }), makeSubsys({ name: 'gpu' })]);
      insertCases(db, [
        makeCase({ name: 't1', subsys: 'cpu' }),
        makeCase({ name: 't2', subsys: 'gpu' }),
      ]);
      const result = getSubsysWithCaseCount(db, 'cp');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('cpu');
      expect(result[0].caseCount).toBe(1);
    });
  });

  // ─── search: LIKE query ─────────────────────────────────

  describe('searchCases', () => {
    beforeEach(() => {
      insertSubsystems(db, [makeSubsys({ name: 'cpu' })]);
      insertCases(db, [
        makeCase({ name: 'test_basic', subsys: 'cpu' }),
        makeCase({ name: 'test_advanced', subsys: 'cpu' }),
        makeCase({ name: 'smoke_test', subsys: 'cpu' }),
      ]);
    });

    it('finds cases by substring match', () => {
      const results = searchCases(db, 'basic');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('test_basic');
    });

    it('returns empty for no match', () => {
      expect(searchCases(db, 'nonexistent')).toEqual([]);
    });

    it('finds multiple matches', () => {
      const results = searchCases(db, 'test');
      expect(results).toHaveLength(3);
    });

    it('filters by subsys', () => {
      const results = searchCases(db, 'test', 'cpu');
      expect(results).toHaveLength(3);
    });

    it('respects limit', () => {
      const results = searchCases(db, 'test', undefined, 1);
      expect(results).toHaveLength(1);
    });

    it('returns empty on empty query', () => {
      expect(searchCases(db, '')).toEqual([]);
    });
  });

  // ─── simulation_runs ────────────────────────────────────

  describe('insertSimulationRun', () => {
    it('inserts a simulation run record', () => {
      insertSubsystems(db, [makeSubsys({ name: 'cpu' })]);
      insertCases(db, [makeCase({ name: 'test1', subsys: 'cpu' })]);

      const run: SimulationRunRow = {
        caseName: 'test1',
        subsys: 'cpu',
        status: 'pass',
        startTime: '2024-01-01T10:00:00',
        endTime: '2024-01-01T10:05:00',
        durationMs: 300000,
        corner: 'ssg',
        seed: '1',
        optionsJson: '{}',
      };
      const result = insertSimulationRun(db, run);
      expect(result.inserted).toBe(1);
    });
  });

  describe('getLatestRunStatus', () => {
    it('returns null when no runs exist', () => {
      expect(getLatestRunStatus(db, 'test1', 'cpu')).toBeNull();
    });

    it('returns the most recent run status', () => {
      insertSubsystems(db, [makeSubsys({ name: 'cpu' })]);
      insertCases(db, [makeCase({ name: 'test1', subsys: 'cpu' })]);

      insertSimulationRun(db, {
        caseName: 'test1',
        subsys: 'cpu',
        status: 'fail',
        startTime: '2024-01-01T10:00:00',
      });
      insertSimulationRun(db, {
        caseName: 'test1',
        subsys: 'cpu',
        status: 'pass',
        startTime: '2024-01-02T10:00:00',
      });

      const status = getLatestRunStatus(db, 'test1', 'cpu');
      expect(status).toBe('pass');
    });
  });

  // ─── scan_metadata ──────────────────────────────────────

  describe('scan metadata', () => {
    it('returns null for missing key', () => {
      expect(getScanMetadata(db, 'lastScanTime')).toBeNull();
    });

    it('stores and retrieves a value', () => {
      setScanMetadata(db, 'lastScanTime', '2024-01-01T10:00:00');
      expect(getScanMetadata(db, 'lastScanTime')).toBe('2024-01-01T10:00:00');
    });

    it('overwrites existing value', () => {
      setScanMetadata(db, 'status', 'scanning');
      setScanMetadata(db, 'status', 'complete');
      expect(getScanMetadata(db, 'status')).toBe('complete');
    });
  });

  // ─── clearAllCases ──────────────────────────────────────

  describe('clearAllCases', () => {
    it('removes all cases but keeps subsystems', () => {
      insertSubsystems(db, [makeSubsys({ name: 'cpu' })]);
      insertCases(db, [makeCase({ name: 't1', subsys: 'cpu' })]);

      clearAllCases(db);

      expect(getCases(db)).toEqual([]);
      expect(getSubsystems(db)).toHaveLength(1);
    });
  });
});
