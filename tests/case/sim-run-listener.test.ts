import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createMemoryDatabase, closeDatabase, type CaseDatabase } from '../../src/main/case/db/case-database';
import { SimulationRunListener } from '../../src/main/case/sim-run-listener';
import { TerminalSimulationRunListener } from '../../src/main/case/sim-run-listener';
import { insertSubsystems, insertCases } from '../../src/main/case/db/case-repository';
import type { TerminalSimRun } from '../../src/main/simulation/sim-terminal-linker';
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

  it('以 cases 表为准校正 subsys（启动入口传入的选中子系统不正确时）', () => {
    // 场景：命令栏在全局选中子系统 ai_sys 下启动了 top 的用例 ——
    // 持久化时应写用例真实所属子系统 top，而非 ai_sys
    insertSubsystems(db, [{ name: 'top' }]);
    insertCases(db, [{ name: 'test_basic', subsys: 'top', path: '/p/test_basic' }]);

    const listener = new SimulationRunListener(simManager, db);
    listener.start();

    simManager.emit('run:completed', makeRunRecord({
      options: {
        caseId: 'case-1',
        caseName: 'test_basic',
        subsys: 'ai_sys',
        options: {},
      },
    }));

    const rows = queryAllRuns(db);
    expect(rows[0]['subsys']).toBe('top');
  });

  it('cases 表查不到用例时保留原 subsys（未扫描的新用例）', () => {
    const listener = new SimulationRunListener(simManager, db);
    listener.start();

    simManager.emit('run:completed', makeRunRecord({
      options: {
        caseId: 'case-1',
        caseName: 'unscanned_case',
        subsys: 'cpu',
        options: {},
      },
    }));

    const rows = queryAllRuns(db);
    expect(rows[0]['subsys']).toBe('cpu');
  });
});

describe('TerminalSimulationRunListener', () => {
  let db: CaseDatabase;
  let linker: EventEmitter;

  beforeEach(() => {
    db = createMemoryDatabase();
    linker = new EventEmitter();
  });

  afterEach(() => {
    closeDatabase(db);
    linker.removeAllListeners();
  });

  it('persists terminal completion and keeps the stable run id', () => {
    const listener = new TerminalSimulationRunListener(linker, db, 'proj-1');
    listener.start();
    const record: TerminalSimRun = {
      runId: 'terminal-run-1',
      projectId: 'proj-1',
      terminalId: 'term-1',
      command: 'runsim smoke',
      cwd: 'D:/project',
      caseId: 'smoke',
      caseName: 'smoke',
      subsys: 'cpu',
      options: { seed: '7' },
      status: 'pass',
      startTime: 1700000000000,
      endTime: 1700000005000,
      logMode: false,
    };

    linker.emit('run:completed', record);

    const row = db.prepare('SELECT run_id, status, seed, duration_ms FROM simulation_runs').get() as Record<string, unknown>;
    expect(row.run_id).toBe('terminal-run-1');
    expect(row.status).toBe('pass');
    expect(row.seed).toBe('7');
    expect(row.duration_ms).toBe(5000);
  });

  it('persists with the case\'s real subsys from the cases table', () => {
    // 终端仿真入口传入错误 subsys（全局选中的子系统）时，
    // 持久化以 cases 表为准校正
    insertSubsystems(db, [{ name: 'top' }]);
    insertCases(db, [{ name: 'smoke', subsys: 'top', path: '/p/smoke' }]);

    const listener = new TerminalSimulationRunListener(linker, db, 'proj-1');
    listener.start();
    linker.emit('run:completed', {
      runId: 'terminal-run-2',
      projectId: 'proj-1',
      terminalId: 'term-2',
      command: 'runsim smoke',
      cwd: 'D:/project',
      caseId: 'smoke',
      caseName: 'smoke',
      subsys: 'ai_sys',
      options: {},
      status: 'fail',
      startTime: 1700000000000,
      endTime: 1700000005000,
      logMode: true,
    } satisfies TerminalSimRun);

    const row = db.prepare('SELECT subsys FROM simulation_runs').get() as Record<string, unknown>;
    expect(row.subsys).toBe('top');
  });

  it('ignores terminal events from another project', () => {
    const listener = new TerminalSimulationRunListener(linker, db, 'proj-1');
    listener.start();
    linker.emit('run:completed', {
      runId: 'other-run', projectId: 'proj-2', terminalId: 'term-2', command: '', cwd: '',
      caseId: 'case', subsys: 'cpu', options: {}, status: 'fail', startTime: 1700000000000,
      logMode: false,
    } satisfies TerminalSimRun);

    expect(db.prepare('SELECT COUNT(*) AS count FROM simulation_runs').get()).toEqual({ count: 0 });
  });
});
