import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createMemoryDatabase, closeDatabase, type CaseDatabase } from '../../src/main/case/db/case-database';
import { SimulationRunListener } from '../../src/main/case/sim-run-listener';
import type { SimulationRunRecord } from '../../src/main/simulation/simulation-manager';

// ─── Helpers ────────────────────────────────────────────────

function makeRunRecord(overrides: Partial<SimulationRunRecord> = {}): SimulationRunRecord {
  return {
    runId: 'run-001',
    projectId: 'proj-1',
    options: {
      caseId: 'case-1',
      caseName: 'test_basic',
      subsys: 'cpu',
      options: { corner: 'ssg', seed: '12345', base: 'base_val', block: 'block_a' },
    },
    status: { runId: 'run-001', status: 'pass', startTime: 1700000000000, endTime: 1700000300000 },
    startTime: 1700000000000,
    endTime: 1700000300000,
    ...overrides,
  };
}

/** Query all simulation_runs from DB for verification. */
function queryAllRuns(db: CaseDatabase): Record<string, unknown>[] {
  return db.prepare('SELECT * FROM simulation_runs ORDER BY id').all() as Record<string, unknown>[];
}

// ─── Tests ──────────────────────────────────────────────────

describe('SimulationRunListener', () => {
  let db: CaseDatabase;
  let simManager: EventEmitter;

  beforeEach(() => {
    db = createMemoryDatabase();
    simManager = new EventEmitter();
  });

  afterEach(() => {
    closeDatabase(db);
    simManager.removeAllListeners();
  });

  it('writes a run record to DB when run:completed is emitted', () => {
    const listener = new SimulationRunListener(simManager, db);
    listener.start();

    simManager.emit('run:completed', makeRunRecord());

    const rows = queryAllRuns(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]['case_name']).toBe('test_basic');
    expect(rows[0]['subsys']).toBe('cpu');
    expect(rows[0]['status']).toBe('pass');
  });

  it('converts epoch ms timestamps to ISO format', () => {
    const listener = new SimulationRunListener(simManager, db);
    listener.start();

    const record = makeRunRecord({
      startTime: 1700000000000,
      endTime: 1700000300000,
    });
    simManager.emit('run:completed', record);

    const rows = queryAllRuns(db);
    expect(rows[0]['start_time']).toBe('2023-11-14T22:13:20.000Z');
    expect(rows[0]['end_time']).toBe('2023-11-14T22:18:20.000Z');
  });

  it('calculates duration_ms from start and end times', () => {
    const listener = new SimulationRunListener(simManager, db);
    listener.start();

    simManager.emit('run:completed', makeRunRecord({
      startTime: 1700000000000,
      endTime: 1700000300000,
    }));

    const rows = queryAllRuns(db);
    expect(rows[0]['duration_ms']).toBe(300000);
  });

  it('extracts corner and seed from options', () => {
    const listener = new SimulationRunListener(simManager, db);
    listener.start();

    simManager.emit('run:completed', makeRunRecord());

    const rows = queryAllRuns(db);
    expect(rows[0]['corner']).toBe('ssg');
    expect(rows[0]['seed']).toBe('12345');
  });

  it('serializes all simulation options to options_json', () => {
    const listener = new SimulationRunListener(simManager, db);
    listener.start();

    simManager.emit('run:completed', makeRunRecord());

    const rows = queryAllRuns(db);
    const parsed = JSON.parse(rows[0]['options_json'] as string);
    expect(parsed).toEqual({ corner: 'ssg', seed: '12345', base: 'base_val', block: 'block_a' });
  });

  it('handles missing endTime gracefully (still running or aborted)', () => {
    const listener = new SimulationRunListener(simManager, db);
    listener.start();

    const record = makeRunRecord({
      endTime: undefined,
      status: { runId: 'run-001', status: 'fail', startTime: 1700000000000 },
    });
    simManager.emit('run:completed', record);

    const rows = queryAllRuns(db);
    expect(rows[0]['end_time']).toBeNull();
    expect(rows[0]['duration_ms']).toBeNull();
  });

  it('uses caseId when caseName is not provided', () => {
    const listener = new SimulationRunListener(simManager, db);
    listener.start();

    simManager.emit('run:completed', makeRunRecord({
      options: {
        caseId: 'fallback-id',
        subsys: 'cpu',
        options: {},
      },
    }));

    const rows = queryAllRuns(db);
    expect(rows[0]['case_name']).toBe('fallback-id');
  });

  it('handles missing options.options gracefully', () => {
    const listener = new SimulationRunListener(simManager, db);
    listener.start();

    simManager.emit('run:completed', makeRunRecord({
      options: {
        caseId: 'case-1',
        caseName: 'test_basic',
        subsys: 'cpu',
      },
    }));

    const rows = queryAllRuns(db);
    expect(rows[0]['corner']).toBeNull();
    expect(rows[0]['seed']).toBeNull();
    expect(rows[0]['options_json']).toBe('{}');
  });

  it('writes multiple runs to DB', () => {
    const listener = new SimulationRunListener(simManager, db);
    listener.start();

    simManager.emit('run:completed', makeRunRecord({ runId: 'r1' }));
    simManager.emit('run:completed', makeRunRecord({ runId: 'r2', status: { runId: 'r2', status: 'fail', startTime: 1700000000000 } }));

    const rows = queryAllRuns(db);
    expect(rows).toHaveLength(2);
  });

  it('does not write to DB after stop() is called', () => {
    const listener = new SimulationRunListener(simManager, db);
    listener.start();

    simManager.emit('run:completed', makeRunRecord());
    expect(queryAllRuns(db)).toHaveLength(1);

    listener.stop();

    simManager.emit('run:completed', makeRunRecord({ runId: 'r2' }));
    expect(queryAllRuns(db)).toHaveLength(1);
  });

  it('does not throw when DB write fails (logs warning instead)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const brokenDb = {
      prepare: () => { throw new Error('DB is corrupted'); },
    } as unknown as CaseDatabase;

    const listener = new SimulationRunListener(simManager, brokenDb);
    listener.start();

    // Should not throw
    expect(() => {
      simManager.emit('run:completed', makeRunRecord());
    }).not.toThrow();

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does not throw when insertSimulationRun throws', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Create a DB that works for schema but throw on insert
    const listener = new SimulationRunListener(simManager, db);
    listener.start();

    // Close the DB to make it fail
    closeDatabase(db);

    expect(() => {
      simManager.emit('run:completed', makeRunRecord());
    }).not.toThrow();

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
