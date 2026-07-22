import { describe, it, expect } from 'vitest';
import { PluginBackedDiscovery, PluginBackedSimulation, PluginBackedCoverage } from '../../src/main/host/plugin-discovery';
import type { PluginRegistry, SubsysDiscoveryPlugin, CaseParserPlugin, SimOptionSchemaProvider, SimulationRunnerPlugin, CoverageParserPlugin } from '@shared/plugin-types';

// ─── Mock Plugins ─────────────────────────────────────

function makeMockSubsysDiscoverer(): SubsysDiscoveryPlugin {
  return {
    manifest: { id: 'mock-sd', name: 'Mock SD', version: '1.0.0', kind: 'subsys-discoverer' },
    async discover(_root: string) {
      return [
        { id: 'cpu', name: 'cpu', path: '/proj/cpu', kind: 'subsys' as const },
        { id: 'gpu', name: 'gpu', path: '/proj/gpu', kind: 'subsys' as const },
      ];
    },
  };
}

function makeMockCaseParser(): CaseParserPlugin {
  return {
    manifest: { id: 'mock-cp', name: 'Mock CP', version: '1.0.0', kind: 'case-parser' },
    async parse(_root: string, subsys: string) {
      if (subsys === 'cpu') {
        return [
          { id: 'test1', name: 'test_basic', path: '/proj/cpu/test_basic' },
          { id: 'test2', name: 'test_advanced', path: '/proj/cpu/test_advanced' },
        ];
      }
      return [];
    },
  };
}

function makeMockSimOptionProvider(): SimOptionSchemaProvider {
  return {
    manifest: { id: 'mock-sos', name: 'Mock SOS', version: '1.0.0', kind: 'sim-option-schema' },
    async getSchema(_subsys: string) {
      return {
        fields: [
          { key: 'waves', label: 'Enable Waves', type: 'boolean' as const, default: false },
          { key: 'timeout', label: 'Timeout (ms)', type: 'number' as const, default: 10000 },
        ],
      };
    },
  };
}

function makeMockSimulationRunner(): SimulationRunnerPlugin {
  const runs = new Map<string, { status: string; errors: unknown[] }>();
  return {
    manifest: { id: 'mock-sr', name: 'Mock SR', version: '1.0.0', kind: 'simulation-runner' },
    async run(opts) {
      const runId = `run_${Date.now()}`;
      runs.set(runId, { status: 'running', errors: [] });
      return { runId };
    },
    async getStatus(runId: string) {
      const run = runs.get(runId);
      return {
        runId,
        status: (run?.status ?? 'unknown') as 'pending' | 'running' | 'pass' | 'fail' | 'error' | 'aborted',
      };
    },
    async getCompileErrors(_runId: string) {
      return [];
    },
    async abort(runId: string) {
      const run = runs.get(runId);
      if (run) run.status = 'aborted';
    },
  };
}

function makeMockCoverageParser(): CoverageParserPlugin {
  return {
    manifest: { id: 'mock-cov', name: 'Mock Cov', version: '1.0.0', kind: 'coverage-parser' },
    async parse(_root: string, sessionId: string, _reportDir: string) {
      return {
        sessionId,
        source: { covMergeDir: '/mock', edaTool: 'imc' as const, reportGeneratedAt: 0 },
        root: {
          name: 'top',
          path: 'top',
          depth: 0,
          metrics: {
            line: { percentage: 90.0, covered: 900, total: 1000 },
            branch: { percentage: 85.0, covered: 850, total: 1000 },
            toggle: { percentage: 80.0, covered: 800, total: 1000 },
            condition: { percentage: 75.0, covered: 750, total: 1000 },
            fsm_state: { percentage: 100, covered: 50, total: 50 },
            fsm_transition: { percentage: 85, covered: 85, total: 100 },
            functional: { percentage: 85.0, covered: 850, total: 1000 },
            assertion: { percentage: 87.0, covered: 870, total: 1000 },
          },
          children: [],
        },
        targets: { line: 95 },
      };
    },
  };
}

// ─── Tests ────────────────────────────────────────────

describe('PluginBackedDiscovery', () => {
  const projectRoot = '/mock/project';

  it('returns empty array when no subsys discoverer plugin', async () => {
    const registry: PluginRegistry = {
      caseParsers: [],
      subsysDiscoverers: [],
      coverageParsers: [],
      simulationRunners: [],
      simOptionSchemaProviders: [],
    };
    const discovery = new PluginBackedDiscovery(projectRoot, registry);
    const result = await discovery.listSubsys();
    expect(result).toEqual([]);
  });

  it('lists subsystems from plugin', async () => {
    const registry: PluginRegistry = {
      caseParsers: [],
      subsysDiscoverers: [makeMockSubsysDiscoverer()],
      coverageParsers: [],
      simulationRunners: [],
      simOptionSchemaProviders: [],
    };
    const discovery = new PluginBackedDiscovery(projectRoot, registry);
    const result = await discovery.listSubsys();
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('cpu');
    expect(result[1].name).toBe('gpu');
  });

  it('filters subsystems by name', async () => {
    const registry: PluginRegistry = {
      caseParsers: [],
      subsysDiscoverers: [makeMockSubsysDiscoverer()],
      coverageParsers: [],
      simulationRunners: [],
      simOptionSchemaProviders: [],
    };
    const discovery = new PluginBackedDiscovery(projectRoot, registry);
    const result = await discovery.listSubsys('cp');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('cpu');
  });

  it('returns empty cases when no case parser plugin', async () => {
    const registry: PluginRegistry = {
      caseParsers: [],
      subsysDiscoverers: [makeMockSubsysDiscoverer()],
      coverageParsers: [],
      simulationRunners: [],
      simOptionSchemaProviders: [],
    };
    const discovery = new PluginBackedDiscovery(projectRoot, registry);
    const result = await discovery.listCases('cpu');
    expect(result).toEqual([]);
  });

  it('lists cases from plugin', async () => {
    const registry: PluginRegistry = {
      caseParsers: [makeMockCaseParser()],
      subsysDiscoverers: [],
      coverageParsers: [],
      simulationRunners: [],
      simOptionSchemaProviders: [],
    };
    const discovery = new PluginBackedDiscovery(projectRoot, registry);
    const result = await discovery.listCases('cpu');
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('test_basic');
    expect(result[0].subsys).toBe('cpu');
  });

  it('returns empty array when subsys is empty', async () => {
    const registry: PluginRegistry = {
      caseParsers: [makeMockCaseParser()],
      subsysDiscoverers: [],
      coverageParsers: [],
      simulationRunners: [],
      simOptionSchemaProviders: [],
    };
    const discovery = new PluginBackedDiscovery(projectRoot, registry);
    const result = await discovery.listCases();
    expect(result).toEqual([]);
  });

  it('caches case results', async () => {
    let callCount = 0;
    const mockParser: CaseParserPlugin = {
      manifest: { id: 'mock-cp', name: 'Mock CP', version: '1.0.0', kind: 'case-parser' },
      async parse() {
        callCount++;
        return [{ id: 'test1', name: 'test1', path: '/test1' }];
      },
    };
    const registry: PluginRegistry = {
      caseParsers: [mockParser],
      subsysDiscoverers: [],
      coverageParsers: [],
      simulationRunners: [],
      simOptionSchemaProviders: [],
    };
    const discovery = new PluginBackedDiscovery(projectRoot, registry);

    await discovery.listCases('cpu');
    await discovery.listCases('cpu');
    expect(callCount).toBe(1);
  });

  it('returns sim options schema from plugin', async () => {
    const registry: PluginRegistry = {
      caseParsers: [],
      subsysDiscoverers: [],
      coverageParsers: [],
      simulationRunners: [],
      simOptionSchemaProviders: [makeMockSimOptionProvider()],
    };
    const discovery = new PluginBackedDiscovery(projectRoot, registry);
    const result = await discovery.getSimOptionsSchema();
    expect(result.waves).toBeDefined();
    expect(result.timeout).toBeDefined();
  });

  it('returns empty schema when no sim-option-schema plugin', async () => {
    const registry: PluginRegistry = {
      caseParsers: [],
      subsysDiscoverers: [],
      coverageParsers: [],
      simulationRunners: [],
      simOptionSchemaProviders: [],
    };
    const discovery = new PluginBackedDiscovery(projectRoot, registry);
    const result = await discovery.getSimOptionsSchema();
    expect(result).toEqual({});
  });
});

describe('PluginBackedSimulation', () => {
  it('hasRunner returns false when no runner plugin', () => {
    const registry: PluginRegistry = {
      caseParsers: [],
      subsysDiscoverers: [],
      coverageParsers: [],
      simulationRunners: [],
      simOptionSchemaProviders: [],
    };
    const sim = new PluginBackedSimulation(registry);
    expect(sim.hasRunner()).toBe(false);
  });

  it('hasRunner returns true when runner plugin exists', () => {
    const registry: PluginRegistry = {
      caseParsers: [],
      subsysDiscoverers: [],
      coverageParsers: [],
      simulationRunners: [makeMockSimulationRunner()],
      simOptionSchemaProviders: [],
    };
    const sim = new PluginBackedSimulation(registry);
    expect(sim.hasRunner()).toBe(true);
  });

  it('run returns a runId', async () => {
    const registry: PluginRegistry = {
      caseParsers: [],
      subsysDiscoverers: [],
      coverageParsers: [],
      simulationRunners: [makeMockSimulationRunner()],
      simOptionSchemaProviders: [],
    };
    const sim = new PluginBackedSimulation(registry);
    const handle = await sim.run({ caseId: 'test1', subsys: 'cpu' });
    expect(handle.runId).toBeDefined();
    expect(handle.runId).toMatch(/^run_/);
  });

  it('throws when no runner plugin', async () => {
    const registry: PluginRegistry = {
      caseParsers: [],
      subsysDiscoverers: [],
      coverageParsers: [],
      simulationRunners: [],
      simOptionSchemaProviders: [],
    };
    const sim = new PluginBackedSimulation(registry);
    await expect(sim.run({ caseId: 'test1', subsys: 'cpu' })).rejects.toThrow('No simulation-runner plugin loaded');
  });

  it('getStatus returns status', async () => {
    const registry: PluginRegistry = {
      caseParsers: [],
      subsysDiscoverers: [],
      coverageParsers: [],
      simulationRunners: [makeMockSimulationRunner()],
      simOptionSchemaProviders: [],
    };
    const sim = new PluginBackedSimulation(registry);
    const handle = await sim.run({ caseId: 'test1', subsys: 'cpu' });
    const status = await sim.getStatus(handle.runId);
    expect(status.runId).toBe(handle.runId);
    expect(status.status).toBeDefined();
  });

  it('getCompileErrors returns empty array', async () => {
    const registry: PluginRegistry = {
      caseParsers: [],
      subsysDiscoverers: [],
      coverageParsers: [],
      simulationRunners: [makeMockSimulationRunner()],
      simOptionSchemaProviders: [],
    };
    const sim = new PluginBackedSimulation(registry);
    const handle = await sim.run({ caseId: 'test1', subsys: 'cpu' });
    const errors = await sim.getCompileErrors(handle.runId);
    expect(errors).toEqual([]);
  });
});

describe('PluginBackedCoverage', () => {
  it('hasParser returns false when no coverage plugin', () => {
    const registry: PluginRegistry = {
      caseParsers: [],
      subsysDiscoverers: [],
      coverageParsers: [],
      simulationRunners: [],
      simOptionSchemaProviders: [],
    };
    const cov = new PluginBackedCoverage('/proj', registry);
    expect(cov.hasParser()).toBe(false);
  });

  it('hasParser returns true when coverage plugin exists', () => {
    const registry: PluginRegistry = {
      caseParsers: [],
      subsysDiscoverers: [],
      coverageParsers: [makeMockCoverageParser()],
      simulationRunners: [],
      simOptionSchemaProviders: [],
    };
    const cov = new PluginBackedCoverage('/proj', registry);
    expect(cov.hasParser()).toBe(true);
  });

  it('parse returns coverage data', async () => {
    const registry: PluginRegistry = {
      caseParsers: [],
      subsysDiscoverers: [],
      coverageParsers: [makeMockCoverageParser()],
      simulationRunners: [],
      simOptionSchemaProviders: [],
    };
    const cov = new PluginBackedCoverage('/proj', registry);
    const data = await cov.parse('session_1', '/report/dir');
    expect(data.sessionId).toBe('session_1');
    expect(data.root.name).toBe('top');
    expect(data.root.metrics.line.percentage).toBe(90.0);
  });

  it('throws when no coverage plugin', async () => {
    const registry: PluginRegistry = {
      caseParsers: [],
      subsysDiscoverers: [],
      coverageParsers: [],
      simulationRunners: [],
      simOptionSchemaProviders: [],
    };
    const cov = new PluginBackedCoverage('/proj', registry);
    await expect(cov.parse('session_1', '/report/dir')).rejects.toThrow(
      'No coverage-parser plugin loaded',
    );
  });
});
