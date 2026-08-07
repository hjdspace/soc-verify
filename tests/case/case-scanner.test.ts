import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDatabase, closeDatabase, type CaseDatabase } from '../../src/main/case/db/case-database';
import { getSubsystems, getCases, getSubsysWithCaseCount, getScanMetadata } from '../../src/main/case/db/case-repository';
import { CaseScanner } from '../../src/main/case/case-scanner';
import type { PluginRegistry, SubsysDiscoveryPlugin, CaseParserPlugin } from '@shared/plugin-types';

// ─── Mock Plugins ─────────────────────────────────────────

function makeMockSubsysDiscoverer(subsysNames: string[]): SubsysDiscoveryPlugin {
  return {
    manifest: { id: 'mock-sd', name: 'Mock SD', version: '1.0.0', kind: 'subsys-discoverer' },
    async discover(_root: string) {
      return subsysNames.map((name) => ({
        id: `id_${name}`,
        name,
        path: `/proj/${name}`,
        kind: 'subsys' as const,
      }));
    },
  };
}

function makeMockCaseParser(casesBySubsys: Record<string, Array<{ id: string; name: string; path: string; filePath?: string; baseCase?: string; base?: string; block?: string; phase?: string }>>): CaseParserPlugin {
  return {
    manifest: { id: 'mock-cp', name: 'Mock CP', version: '1.0.0', kind: 'case-parser' },
    async parse(_root: string, subsys: string) {
      return casesBySubsys[subsys] ?? [];
    },
  };
}

function makeRegistry(subsysPlugin: SubsysDiscoveryPlugin, casePlugin: CaseParserPlugin): PluginRegistry {
  return {
    subsysDiscoverers: [subsysPlugin],
    caseParsers: [casePlugin],
    coverageParsers: [],
    simulationRunners: [],
    simOptionSchemaProviders: [],
  };
}

// ─── Tests ────────────────────────────────────────────────

describe('Case Scanner', () => {
  let db: CaseDatabase;
  const projectRoot = '/mock/project';

  beforeEach(() => {
    db = createMemoryDatabase();
  });

  afterEach(() => {
    closeDatabase(db);
  });

  describe('fullScan', () => {
    it('writes subsystems and cases to DB from plugin scan', async () => {
      const subsysPlugin = makeMockSubsysDiscoverer(['cpu', 'gpu']);
      const casePlugin = makeMockCaseParser({
        cpu: [
          { id: 't1', name: 'test_basic', path: '/proj/cpu/test_basic', filePath: '/proj/cpu/cfg.py' },
          { id: 't2', name: 'test_advanced', path: '/proj/cpu/test_advanced' },
        ],
        gpu: [
          { id: 't3', name: 'smoke_test', path: '/proj/gpu/smoke_test' },
        ],
      });
      const registry = makeRegistry(subsysPlugin, casePlugin);
      const scanner = new CaseScanner(projectRoot, registry, db);

      const result = await scanner.fullScan();

      expect(result.subsysCount).toBe(2);
      expect(result.caseCount).toBe(3);

      // Verify subsystems in DB
      const subsys = getSubsystems(db);
      expect(subsys).toHaveLength(2);
      expect(subsys.map((s) => s.name).sort()).toEqual(['cpu', 'gpu']);

      // Verify cases in DB
      const cpuCases = getCases(db, 'cpu');
      expect(cpuCases).toHaveLength(2);
      expect(cpuCases.map((c) => c.name).sort()).toEqual(['test_advanced', 'test_basic']);

      const gpuCases = getCases(db, 'gpu');
      expect(gpuCases).toHaveLength(1);
      expect(gpuCases[0].name).toBe('smoke_test');
    });

    it('handles empty project (no subsystems)', async () => {
      const subsysPlugin = makeMockSubsysDiscoverer([]);
      const casePlugin = makeMockCaseParser({});
      const registry = makeRegistry(subsysPlugin, casePlugin);
      const scanner = new CaseScanner(projectRoot, registry, db);

      const result = await scanner.fullScan();

      expect(result.subsysCount).toBe(0);
      expect(result.caseCount).toBe(0);
      expect(getSubsystems(db)).toEqual([]);
    });

    it('handles subsystem with no cases', async () => {
      const subsysPlugin = makeMockSubsysDiscoverer(['empty_sys']);
      const casePlugin = makeMockCaseParser({});
      const registry = makeRegistry(subsysPlugin, casePlugin);
      const scanner = new CaseScanner(projectRoot, registry, db);

      await scanner.fullScan();

      const subsysWithCount = getSubsysWithCaseCount(db);
      expect(subsysWithCount).toHaveLength(1);
      expect(subsysWithCount[0].caseCount).toBe(0);
    });

    it('stores scan metadata after scan', async () => {
      const subsysPlugin = makeMockSubsysDiscoverer(['cpu']);
      const casePlugin = makeMockCaseParser({
        cpu: [{ id: 't1', name: 'test1', path: '/proj/cpu/test1' }],
      });
      const registry = makeRegistry(subsysPlugin, casePlugin);
      const scanner = new CaseScanner(projectRoot, registry, db);

      await scanner.fullScan();

      const status = getScanMetadata(db, 'scanStatus');
      expect(status).toBe('complete');
      const lastScanTime = getScanMetadata(db, 'lastScanTime');
      expect(lastScanTime).toBeTruthy();
    });

    it('updates existing cases on re-scan (INSERT OR REPLACE)', async () => {
      const subsysPlugin = makeMockSubsysDiscoverer(['cpu']);
      const casePlugin = makeMockCaseParser({
        cpu: [{ id: 't1', name: 'test1', path: '/proj/cpu/test1', filePath: '/old.py' }],
      });
      const registry = makeRegistry(subsysPlugin, casePlugin);
      const scanner = new CaseScanner(projectRoot, registry, db);

      // First scan
      await scanner.fullScan();
      expect(getCases(db, 'cpu')).toHaveLength(1);
      expect(getCases(db, 'cpu')[0].filePath).toBe('/old.py');

      // Second scan with updated file path
      const updatedPlugin = makeMockCaseParser({
        cpu: [{ id: 't1', name: 'test1', path: '/proj/cpu/test1', filePath: '/new.py' }],
      });
      const updatedRegistry = makeRegistry(subsysPlugin, updatedPlugin);
      const scanner2 = new CaseScanner(projectRoot, updatedRegistry, db);
      await scanner2.fullScan();

      expect(getCases(db, 'cpu')).toHaveLength(1);
      expect(getCases(db, 'cpu')[0].filePath).toBe('/new.py');
    });

    it('preserves simulation_runs on re-scan', async () => {
      const subsysPlugin = makeMockSubsysDiscoverer(['cpu']);
      const casePlugin = makeMockCaseParser({
        cpu: [{ id: 't1', name: 'test1', path: '/proj/cpu/test1' }],
      });
      const registry = makeRegistry(subsysPlugin, casePlugin);
      const scanner = new CaseScanner(projectRoot, registry, db);

      await scanner.fullScan();

      // Insert a simulation run
      const { insertSimulationRun } = await import('../../src/main/case/db/case-repository');
      insertSimulationRun(db, {
        caseName: 'test1',
        subsys: 'cpu',
        status: 'pass',
        startTime: '2024-01-01T10:00:00',
      });

      // Re-scan
      await scanner.fullScan();

      const { getLatestRunStatus } = await import('../../src/main/case/db/case-repository');
      const status = getLatestRunStatus(db, 'test1', 'cpu');
      expect(status).toBe('pass');
    });
  });

  describe('hasExistingData', () => {
    it('returns false for empty DB', () => {
      const subsysPlugin = makeMockSubsysDiscoverer([]);
      const casePlugin = makeMockCaseParser({});
      const registry = makeRegistry(subsysPlugin, casePlugin);
      const scanner = new CaseScanner(projectRoot, registry, db);

      expect(scanner.hasExistingData()).toBe(false);
    });

    it('returns true after scan', async () => {
      const subsysPlugin = makeMockSubsysDiscoverer(['cpu']);
      const casePlugin = makeMockCaseParser({
        cpu: [{ id: 't1', name: 'test1', path: '/proj/cpu/test1' }],
      });
      const registry = makeRegistry(subsysPlugin, casePlugin);
      const scanner = new CaseScanner(projectRoot, registry, db);

      await scanner.fullScan();
      expect(scanner.hasExistingData()).toBe(true);
    });
  });

  describe('incrementalScan', () => {
    it('detects new subsystem added after initial scan', async () => {
      // First scan with 2 subsystems
      let subsysPlugin = makeMockSubsysDiscoverer(['cpu', 'gpu']);
      const casePlugin = makeMockCaseParser({
        cpu: [{ id: 't1', name: 'test1', path: '/proj/cpu/test1' }],
        gpu: [{ id: 't2', name: 'test2', path: '/proj/gpu/test2' }],
      });
      let registry = makeRegistry(subsysPlugin, casePlugin);
      let scanner = new CaseScanner(projectRoot, registry, db);
      await scanner.fullScan();

      expect(getSubsystems(db)).toHaveLength(2);

      // Second scan with a new subsystem added
      subsysPlugin = makeMockSubsysDiscoverer(['cpu', 'gpu', 'ai']);
      const updatedCasePlugin = makeMockCaseParser({
        cpu: [{ id: 't1', name: 'test1', path: '/proj/cpu/test1' }],
        gpu: [{ id: 't2', name: 'test2', path: '/proj/gpu/test2' }],
        ai: [{ id: 't3', name: 'test3', path: '/proj/ai/test3' }],
      });
      registry = makeRegistry(subsysPlugin, updatedCasePlugin);
      scanner = new CaseScanner(projectRoot, registry, db);

      const result = await scanner.fullScan();

      expect(result.subsysCount).toBe(3);
      expect(result.caseCount).toBe(3);
      expect(getSubsystems(db)).toHaveLength(3);
    });

    it('detects cases removed from project', async () => {
      // First scan with 2 cases
      const subsysPlugin = makeMockSubsysDiscoverer(['cpu']);
      let casePlugin = makeMockCaseParser({
        cpu: [
          { id: 't1', name: 'test1', path: '/proj/cpu/test1' },
          { id: 't2', name: 'test2', path: '/proj/cpu/test2' },
        ],
      });
      let registry = makeRegistry(subsysPlugin, casePlugin);
      let scanner = new CaseScanner(projectRoot, registry, db);
      await scanner.fullScan();

      expect(getCases(db, 'cpu')).toHaveLength(2);

      // Second scan with only 1 case (test2 removed)
      casePlugin = makeMockCaseParser({
        cpu: [{ id: 't1', name: 'test1', path: '/proj/cpu/test1' }],
      });
      registry = makeRegistry(subsysPlugin, casePlugin);
      scanner = new CaseScanner(projectRoot, registry, db);

      // fullScan with sync mode removes stale cases
      await scanner.fullScan({ sync: true });

      expect(getCases(db, 'cpu')).toHaveLength(1);
      expect(getCases(db, 'cpu')[0].name).toBe('test1');
    });

    it('sync mode removes old subsystems no longer present after env config change', async () => {
      // First scan with 2 subsystems
      let subsysPlugin = makeMockSubsysDiscoverer(['cpu', 'gpu']);
      const casePlugin = makeMockCaseParser({
        cpu: [{ id: 't1', name: 'test1', path: '/proj/cpu/test1' }],
        gpu: [{ id: 't2', name: 'test2', path: '/proj/gpu/test2' }],
      });
      let registry = makeRegistry(subsysPlugin, casePlugin);
      let scanner = new CaseScanner(projectRoot, registry, db);
      await scanner.fullScan();

      expect(getSubsystems(db)).toHaveLength(2);

      // Second scan with only 1 subsystem (gpu removed — e.g. PROJ_RTL changed)
      subsysPlugin = makeMockSubsysDiscoverer(['cpu']);
      const updatedCasePlugin = makeMockCaseParser({
        cpu: [{ id: 't1', name: 'test1', path: '/proj/cpu/test1' }],
      });
      registry = makeRegistry(subsysPlugin, updatedCasePlugin);
      scanner = new CaseScanner(projectRoot, registry, db);

      await scanner.fullScan({ sync: true });

      const subsys = getSubsystems(db);
      expect(subsys).toHaveLength(1);
      expect(subsys[0].name).toBe('cpu');
      // gpu's cases should also be gone
      expect(getCases(db, 'gpu')).toHaveLength(0);
    });
  });

  describe('phase field', () => {
    it('stores phase from plugin parse result', async () => {
      const subsysPlugin = makeMockSubsysDiscoverer(['cpu']);
      const casePlugin = makeMockCaseParser({
        cpu: [
          { id: 't1', name: 'test1', path: '/proj/cpu/test1', phase: 'DVR1' },
          { id: 't2', name: 'test2', path: '/proj/cpu/test2', phase: 'POST' },
          { id: 't3', name: 'test3', path: '/proj/cpu/test3' }, // no phase
        ],
      });
      const registry = makeRegistry(subsysPlugin, casePlugin);
      const scanner = new CaseScanner(projectRoot, registry, db);

      await scanner.fullScan();

      const cases = getCases(db, 'cpu');
      expect(cases).toHaveLength(3);
      expect(cases[0].phase).toBe('DVR1');
      expect(cases[1].phase).toBe('POST');
      expect(cases[2].phase).toBeUndefined();
    });

    it('backward compat: plugin returning no phase field does not error, phase is undefined in DB', async () => {
      // Plugin returns cases without phase — simulates existing plugins
      // that haven't been updated to support the phase field yet.
      const subsysPlugin = makeMockSubsysDiscoverer(['cpu', 'gpu']);
      const casePlugin = makeMockCaseParser({
        cpu: [
          { id: 't1', name: 'test1', path: '/proj/cpu/test1' },
          { id: 't2', name: 'test2', path: '/proj/cpu/test2' },
        ],
        gpu: [
          { id: 't3', name: 'test3', path: '/proj/gpu/test3' },
        ],
      });
      const registry = makeRegistry(subsysPlugin, casePlugin);
      const scanner = new CaseScanner(projectRoot, registry, db);

      // Should not throw
      const result = await scanner.fullScan();
      expect(result.subsysCount).toBe(2);
      expect(result.caseCount).toBe(3);

      // All cases should have undefined phase in DB
      const cpuCases = getCases(db, 'cpu');
      expect(cpuCases).toHaveLength(2);
      for (const c of cpuCases) {
        expect(c.phase).toBeUndefined();
      }

      const gpuCases = getCases(db, 'gpu');
      expect(gpuCases).toHaveLength(1);
      expect(gpuCases[0].phase).toBeUndefined();
    });

    it('mixed phase: some cases have phase, some do not, in same subsys', async () => {
      const subsysPlugin = makeMockSubsysDiscoverer(['cpu']);
      const casePlugin = makeMockCaseParser({
        cpu: [
          { id: 't1', name: 'test_dvr1', path: '/proj/cpu/test_dvr1', phase: 'DVR1' },
          { id: 't2', name: 'test_dvr2', path: '/proj/cpu/test_dvr2', phase: 'DVR2' },
          { id: 't3', name: 'test_nophase', path: '/proj/cpu/test_nophase' },
          { id: 't4', name: 'test_post', path: '/proj/cpu/test_post', phase: 'POST' },
        ],
      });
      const registry = makeRegistry(subsysPlugin, casePlugin);
      const scanner = new CaseScanner(projectRoot, registry, db);

      await scanner.fullScan();

      const cases = getCases(db, 'cpu');
      expect(cases).toHaveLength(4);
      const byName = new Map(cases.map((c) => [c.name, c.phase]));
      expect(byName.get('test_dvr1')).toBe('DVR1');
      expect(byName.get('test_dvr2')).toBe('DVR2');
      expect(byName.get('test_nophase')).toBeUndefined();
      expect(byName.get('test_post')).toBe('POST');
    });
  });
});
