import { describe, it, expect } from 'vitest';
import { HostToolsRegistry } from '../../src/main/host/host-tools';
import { PluginBackedDiscovery, PluginBackedSimulation, PluginBackedCoverage } from '../../src/main/plugin-adapters';
import type { PluginRegistry, SubsysDiscoveryPlugin, CaseParserPlugin, SimulationRunnerPlugin, CoverageParserPlugin } from '@shared/plugin-types';

function makeRegistryWithPlugins(): PluginRegistry {
  const subsysDiscoverer: SubsysDiscoveryPlugin = {
    manifest: { id: 'sd', name: 'SD', version: '1.0.0', kind: 'subsys-discoverer' },
    async discover() {
      return [{ id: 'cpu', name: 'cpu', path: '/cpu', kind: 'subsys' as const }];
    },
  };

  const caseParser: CaseParserPlugin = {
    manifest: { id: 'cp', name: 'CP', version: '1.0.0', kind: 'case-parser' },
    async parse(_root: string, subsys: string) {
      if (subsys === 'cpu') return [{ id: 't1', name: 'test1', path: '/cpu/test1' }];
      return [];
    },
  };

  const simRunner: SimulationRunnerPlugin = {
    manifest: { id: 'sr', name: 'SR', version: '1.0.0', kind: 'simulation-runner' },
    async run(opts) { return { runId: `run_${opts.caseId}` }; },
    async getStatus(runId: string) { return { runId, status: 'running' as const }; },
    async getCompileErrors() { return []; },
    async abort() {},
  };

  const covParser: CoverageParserPlugin = {
    manifest: { id: 'cov', name: 'Cov', version: '1.0.0', kind: 'coverage-parser' },
    async parse(_root: string, sessionId: string, _reportDir: string) {
      return {
        sessionId,
        source: { covMergeDir: '/mock', edaTool: 'imc' as const, reportGeneratedAt: 0 },
        root: {
          name: 'top',
          path: 'top',
          depth: 0,
          metrics: {
            line: { percentage: 95.0, covered: 950, total: 1000 },
            branch: { percentage: 88.0, covered: 880, total: 1000 },
            toggle: { percentage: 85.0, covered: 850, total: 1000 },
            condition: { percentage: 80.0, covered: 800, total: 1000 },
            fsm_state: { percentage: 100, covered: 50, total: 50 },
            fsm_transition: { percentage: 90, covered: 90, total: 100 },
            functional: { percentage: 90.0, covered: 900, total: 1000 },
            assertion: { percentage: 92.0, covered: 920, total: 1000 },
          },
          children: [],
        },
        targets: { line: 95, branch: 90 },
      };
    },
  };

  return {
    caseParsers: [caseParser],
    subsysDiscoverers: [subsysDiscoverer],
    coverageParsers: [covParser],
    simulationRunners: [simRunner],
    simOptionSchemaProviders: [],
  };
}

describe('HostToolsRegistry with plugin adapters', () => {
  const projectRoot = '/mock/project';

  it('list_subsys returns real subsystem data via plugin', async () => {
    const registry = makeRegistryWithPlugins();
    const discovery = new PluginBackedDiscovery(projectRoot, registry);
    const hostTools = new HostToolsRegistry(discovery);

    const result = await hostTools.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'list_subsys',
      arguments: {},
    });

    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('cpu');
  });

  it('list_cases returns real case data via plugin', async () => {
    const registry = makeRegistryWithPlugins();
    const discovery = new PluginBackedDiscovery(projectRoot, registry);
    const hostTools = new HostToolsRegistry(discovery);

    const result = await hostTools.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'list_cases',
      arguments: { subsys: 'cpu' },
    });

    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('test1');
  });

  it('run_simulation returns runId when simulation adapter is set', async () => {
    const registry = makeRegistryWithPlugins();
    const discovery = new PluginBackedDiscovery(projectRoot, registry);
    const simulation = new PluginBackedSimulation(registry);
    const hostTools = new HostToolsRegistry(discovery);
    hostTools.setSimulationAdapter(simulation);

    const result = await hostTools.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'run_simulation',
      arguments: { testcase: 'test1', subsys: 'cpu' },
    });

    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.runId).toBe('run_test1');
    expect(parsed.status).toBe('pending');
  });

  it('run_simulation returns error message when no adapter', async () => {
    const hostTools = new HostToolsRegistry();

    const result = await hostTools.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'run_simulation',
      arguments: { testcase: 'test1', subsys: 'cpu' },
    });

    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toBeDefined();
    expect(parsed.error).toContain('No simulation-runner plugin');
  });

  it('get_run_status returns status via adapter', async () => {
    const registry = makeRegistryWithPlugins();
    const discovery = new PluginBackedDiscovery(projectRoot, registry);
    const simulation = new PluginBackedSimulation(registry);
    const hostTools = new HostToolsRegistry(discovery);
    hostTools.setSimulationAdapter(simulation);

    const result = await hostTools.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'get_run_status',
      arguments: { runId: 'run_test1' },
    });

    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.runId).toBe('run_test1');
    expect(parsed.status).toBe('running');
  });

  it('get_coverage returns real data via adapter', async () => {
    const registry = makeRegistryWithPlugins();
    const discovery = new PluginBackedDiscovery(projectRoot, registry);
    const coverage = new PluginBackedCoverage(projectRoot, registry);
    const hostTools = new HostToolsRegistry(discovery);
    hostTools.setCoverageAdapter(coverage);

    const result = await hostTools.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'get_coverage',
      arguments: { sessionId: 'session_1', reportDir: '/reports' },
    });

    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.sessionId).toBe('session_1');
    expect(parsed.root.name).toBe('top');
    expect(parsed.root.metrics.line.percentage).toBe(95.0);
  });

  it('get_coverage returns error when no adapter', async () => {
    const hostTools = new HostToolsRegistry();

    const result = await hostTools.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'get_coverage',
      arguments: {},
    });

    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toBeDefined();
    expect(parsed.error).toContain('No coverage-parser plugin');
  });

  it('get_compile_errors returns empty array when no adapter', async () => {
    const hostTools = new HostToolsRegistry();

    const result = await hostTools.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'get_compile_errors',
      arguments: {},
    });

    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toBe('[]');
  });
});
