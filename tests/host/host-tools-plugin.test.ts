import { describe, it, expect } from 'vitest';
import { HostToolsRegistry } from '../../src/main/host/host-tools';
import { PluginBackedDiscovery, PluginBackedSimulation, PluginBackedCoverage } from '../../src/main/host/plugin-discovery';
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
    async parse(_root: string, runId: string) {
      return { runId, overall: 90.0, line: 95.0, toggle: 85.0, functional: 90.0, assertion: 92.0 };
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
      arguments: { runId: 'run_123' },
    });

    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.overall).toBe(90.0);
    expect(parsed.line).toBe(95.0);
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
