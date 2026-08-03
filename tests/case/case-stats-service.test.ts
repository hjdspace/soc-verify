import { describe, it, expect } from 'vitest';
import { CaseStatsService } from '../../src/main/case/case-stats-service';
import type { SubsysDiscovery, SubsysInfo, CaseInfo, SimOptionsSchema } from '../../src/main/host/discovery';
import type { SimulationManager } from '../../src/main/simulation/simulation-manager';
import type { SimulationHistoryEntry, SimulationStatus } from '../../src/shared/types';
import type { SimulationRunRecord } from '../../src/main/simulation/simulation-manager';

// ─── Mocks ─────────────────────────────────────────────────

class MockDiscovery implements SubsysDiscovery {
  constructor(
    private subsys: SubsysInfo[] = [],
    private casesBySubsys: Map<string, CaseInfo[]> = new Map(),
    private schema: SimOptionsSchema = {},
  ) {}

  async listSubsys(_filter?: string): Promise<SubsysInfo[]> {
    return this.subsys;
  }

  async listCases(subsys?: string): Promise<CaseInfo[]> {
    if (!subsys) return [];
    return this.casesBySubsys.get(subsys) ?? [];
  }

  async getSimOptionsSchema(): Promise<SimOptionsSchema> {
    return this.schema;
  }
}

function makeMockSimulationManager(
  history: SimulationHistoryEntry[] = [],
  activeRuns: SimulationRunRecord[] = [],
): SimulationManager {
  return {
    getHistory: () => history,
    getActiveRuns: () => activeRuns,
  } as unknown as SimulationManager;
}

// ─── Fixtures ─────────────────────────────────────────────

function makeCase(overrides: Partial<CaseInfo> & { name: string; subsys: string }): CaseInfo {
  return {
    path: `/cases/${overrides.name}`,
    ...overrides,
  };
}

const SUBSYS_CPU: SubsysInfo = { name: 'cpu', path: '/subsystems/cpu' };
const SUBSYS_GPU: SubsysInfo = { name: 'gpu', path: '/subsystems/gpu' };

const CPU_CASES: CaseInfo[] = [
  // File A: 2 root cases + 1 child of root1
  makeCase({ name: 'cpu_alu_basic', subsys: 'cpu', filePath: '/tests/alu_tests.cfg' }),
  makeCase({ name: 'cpu_alu_overflow', subsys: 'cpu', filePath: '/tests/alu_tests.cfg', baseCase: 'cpu_alu_basic' }),
  makeCase({ name: 'cpu_reg_write', subsys: 'cpu', filePath: '/tests/alu_tests.cfg' }),
  // File B: 1 root case
  makeCase({ name: 'cpu_pipeline_stall', subsys: 'cpu', filePath: '/tests/pipeline.cfg' }),
];

const GPU_CASES: CaseInfo[] = [
  makeCase({ name: 'gpu_render_basic', subsys: 'gpu', filePath: '/tests/gpu_render.cfg' }),
  makeCase({ name: 'gpu_texture_load', subsys: 'gpu', filePath: '/tests/gpu_render.cfg' }),
];

function makeDiscovery(): MockDiscovery {
  const casesBySubsys = new Map<string, CaseInfo[]>([
    ['cpu', CPU_CASES],
    ['gpu', GPU_CASES],
  ]);
  return new MockDiscovery([SUBSYS_CPU, SUBSYS_GPU], casesBySubsys);
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

// ─── Tests ────────────────────────────────────────────────

describe('CaseStatsService', () => {
  describe('listCasesWithStatus', () => {
    it('returns cases with status=pending when no simulation manager', async () => {
      const service = new CaseStatsService({ discovery: makeDiscovery() });
      const cases = await service.listCasesWithStatus('cpu');
      expect(cases).toHaveLength(4);
      for (const c of cases) {
        expect(c.status).toBe('pending');
      }
    });

    it('joins status from simulation history (latest run wins)', async () => {
      // SimulationManager.history is newest-first (uses unshift).
      const history: SimulationHistoryEntry[] = [
        // newest: cpu_alu_basic pass at 300
        makeHistoryEntry({ caseName: 'cpu_alu_basic', subsys: 'cpu', status: 'pass', startTime: 300 }),
        // cpu_pipeline_stall: fail at 200
        makeHistoryEntry({ caseName: 'cpu_pipeline_stall', subsys: 'cpu', status: 'fail', startTime: 200 }),
        // oldest: cpu_alu_basic fail at 100 (should be superseded by pass at 300)
        makeHistoryEntry({ caseName: 'cpu_alu_basic', subsys: 'cpu', status: 'fail', startTime: 100 }),
        // gpu_render_basic: different subsys, should not affect cpu
        makeHistoryEntry({ caseName: 'gpu_render_basic', subsys: 'gpu', status: 'pass', startTime: 500 }),
      ];
      const simManager = makeMockSimulationManager(history);
      const service = new CaseStatsService({ discovery: makeDiscovery(), simulationManager: simManager });

      const cases = await service.listCasesWithStatus('cpu');
      const byName = new Map(cases.map((c) => [c.name, c.status]));

      expect(byName.get('cpu_alu_basic')).toBe('pass');
      expect(byName.get('cpu_alu_overflow')).toBe('pending');
      expect(byName.get('cpu_reg_write')).toBe('pending');
      expect(byName.get('cpu_pipeline_stall')).toBe('fail');
    });

    it('running status from activeRuns overrides history', async () => {
      const history: SimulationHistoryEntry[] = [
        makeHistoryEntry({ caseName: 'cpu_alu_basic', subsys: 'cpu', status: 'pass', startTime: 100 }),
      ];
      const activeRuns: SimulationRunRecord[] = [
        {
          runId: 'run_active_1',
          projectId: 'p1',
          options: { caseId: 'cpu_alu_basic', caseName: 'cpu_alu_basic', subsys: 'cpu' },
          status: { runId: 'run_active_1', status: 'running', startTime: 200 },
          startTime: 200,
        },
      ];
      const simManager = makeMockSimulationManager(history, activeRuns);
      const service = new CaseStatsService({ discovery: makeDiscovery(), simulationManager: simManager });

      const cases = await service.listCasesWithStatus('cpu');
      const aluBasic = cases.find((c) => c.name === 'cpu_alu_basic');
      expect(aluBasic?.status).toBe('running');
    });

    it('returns empty array for undefined subsys', async () => {
      const service = new CaseStatsService({ discovery: makeDiscovery() });
      const cases = await service.listCasesWithStatus(undefined);
      expect(cases).toEqual([]);
    });
  });

  describe('listSubsysWithCaseCount', () => {
    it('fills real caseCount (was always 0 in PluginBackedDiscovery)', async () => {
      const service = new CaseStatsService({ discovery: makeDiscovery() });
      const subsys = await service.listSubsysWithCaseCount();
      expect(subsys).toHaveLength(2);
      const cpu = subsys.find((s) => s.name === 'cpu');
      const gpu = subsys.find((s) => s.name === 'gpu');
      expect(cpu?.caseCount).toBe(4);
      expect(gpu?.caseCount).toBe(2);
    });
  });

  describe('getCaseStats', () => {
    it('returns flat summary with total, byStatus, byFile', async () => {
      const history: SimulationHistoryEntry[] = [
        makeHistoryEntry({ caseName: 'cpu_alu_basic', subsys: 'cpu', status: 'pass', startTime: 100 }),
        makeHistoryEntry({ caseName: 'cpu_pipeline_stall', subsys: 'cpu', status: 'fail', startTime: 200 }),
      ];
      const simManager = makeMockSimulationManager(history);
      const service = new CaseStatsService({ discovery: makeDiscovery(), simulationManager: simManager });

      const stats = await service.getCaseStats('cpu');
      expect(stats).not.toBeNull();
      expect(stats!.subsys).toBe('cpu');
      expect(stats!.total).toBe(4);
      expect(stats!.byStatus.pass).toBe(1);
      expect(stats!.byStatus.fail).toBe(1);
      expect(stats!.byStatus.pending).toBe(2);
    });

    it('groups by filePath with rootCases and childCount', async () => {
      const service = new CaseStatsService({ discovery: makeDiscovery() });
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
      expect(pipelineFile!.rootCases).toHaveLength(1);
    });

    it('sorts byFile by caseCount descending', async () => {
      const service = new CaseStatsService({ discovery: makeDiscovery() });
      const stats = await service.getCaseStats('cpu');
      expect(stats!.byFile[0]!.caseCount).toBeGreaterThanOrEqual(stats!.byFile[1]!.caseCount);
    });

    it('returns null for undefined subsys', async () => {
      const service = new CaseStatsService({ discovery: makeDiscovery() });
      const stats = await service.getCaseStats(undefined);
      expect(stats).toBeNull();
    });

    it('returns zero stats for nonexistent subsys', async () => {
      const service = new CaseStatsService({ discovery: makeDiscovery() });
      const stats = await service.getCaseStats('nonexistent');
      expect(stats).toEqual({
        subsys: 'nonexistent',
        total: 0,
        byStatus: { pass: 0, fail: 0, running: 0, pending: 0, error: 0, aborted: 0 },
        byFile: [],
      });
    });
  });

  describe('getProjectOverview', () => {
    it('returns project-wide aggregate in a single call', async () => {
      const history: SimulationHistoryEntry[] = [
        makeHistoryEntry({ caseName: 'cpu_alu_basic', subsys: 'cpu', status: 'pass', startTime: 100 }),
        makeHistoryEntry({ caseName: 'gpu_render_basic', subsys: 'gpu', status: 'fail', startTime: 200 }),
      ];
      const simManager = makeMockSimulationManager(history);
      const service = new CaseStatsService({ discovery: makeDiscovery(), simulationManager: simManager });

      const overview = await service.getProjectOverview();
      expect(overview.subsysCount).toBe(2);
      expect(overview.totalCases).toBe(6); // 4 cpu + 2 gpu
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
      const service = new CaseStatsService({ discovery: new MockDiscovery() });
      const overview = await service.getProjectOverview();
      expect(overview).toEqual({ subsysCount: 0, totalCases: 0, bySubsys: [] });
    });
  });

  describe('setSimulationManager', () => {
    it('allows late injection of simulation manager', async () => {
      const service = new CaseStatsService({ discovery: makeDiscovery() });
      // Before injection: all pending
      let cases = await service.listCasesWithStatus('cpu');
      expect(cases.every((c) => c.status === 'pending')).toBe(true);

      // After injection: status joined
      const history: SimulationHistoryEntry[] = [
        makeHistoryEntry({ caseName: 'cpu_alu_basic', subsys: 'cpu', status: 'pass', startTime: 100 }),
      ];
      service.setSimulationManager(makeMockSimulationManager(history));
      cases = await service.listCasesWithStatus('cpu');
      const aluBasic = cases.find((c) => c.name === 'cpu_alu_basic');
      expect(aluBasic?.status).toBe('pass');
    });
  });
});
