import { describe, it, expect } from 'vitest';
import { HostToolsRegistry } from '../../src/main/host/host-tools';
import { PluginBackedDiscovery } from '../../src/main/host/plugin-discovery';
import type { PluginRegistry, SimOptionSchemaProvider } from '@shared/plugin-types';

function makeRegistryWithSchemaProvider(
  fields: Array<{ key: string; label: string; type: 'string' | 'number' | 'boolean' | 'enum'; default?: unknown; enumValues?: string[]; description?: string }>,
): PluginRegistry {
  const schemaProvider: SimOptionSchemaProvider = {
    manifest: { id: 'sos', name: 'SOS', version: '1.0.0', kind: 'sim-option-schema' },
    async getSchema(_subsys: string) {
      return { fields };
    },
  };

  return {
    caseParsers: [],
    subsysDiscoverers: [],
    coverageParsers: [],
    simulationRunners: [],
    simOptionSchemaProviders: [schemaProvider],
  };
}

describe('get_sim_options_schema Host Tool', () => {
  const projectRoot = '/mock/project';

  it('returns real schema when SimOptionSchemaProvider plugin is loaded', async () => {
    const registry = makeRegistryWithSchemaProvider([
      { key: 'seed', label: 'Random Seed', type: 'number', default: 0 },
      { key: 'waveform', label: 'Dump Waveform', type: 'boolean', default: false },
      { key: 'simulator', label: 'Simulator', type: 'enum', enumValues: ['vcs', 'xrun', 'verilator'], default: 'vcs' },
      { key: 'timeout', label: 'Timeout (ms)', type: 'string', default: '10000' },
    ]);

    const discovery = new PluginBackedDiscovery(projectRoot, registry);
    const hostTools = new HostToolsRegistry(discovery);

    const result = await hostTools.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'get_sim_options_schema',
      arguments: {},
    });

    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);

    // SimOptionsSchema is a Record<string, unknown> with field metadata
    expect(parsed.seed).toBeDefined();
    expect(parsed.seed.type).toBe('number');
    expect(parsed.seed.label).toBe('Random Seed');
    expect(parsed.seed.default).toBe(0);

    expect(parsed.waveform).toBeDefined();
    expect(parsed.waveform.type).toBe('boolean');
    expect(parsed.waveform.default).toBe(false);

    expect(parsed.simulator).toBeDefined();
    expect(parsed.simulator.type).toBe('enum');
    expect(parsed.simulator.enumValues).toEqual(['vcs', 'xrun', 'verilator']);
    expect(parsed.simulator.default).toBe('vcs');

    expect(parsed.timeout).toBeDefined();
    expect(parsed.timeout.type).toBe('string');
    expect(parsed.timeout.default).toBe('10000');
  });

  it('returns empty schema when no SimOptionSchemaProvider plugin is loaded', async () => {
    const registry: PluginRegistry = {
      caseParsers: [],
      subsysDiscoverers: [],
      coverageParsers: [],
      simulationRunners: [],
      simOptionSchemaProviders: [],
    };

    const discovery = new PluginBackedDiscovery(projectRoot, registry);
    const hostTools = new HostToolsRegistry(discovery);

    const result = await hostTools.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'get_sim_options_schema',
      arguments: {},
    });

    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({});
  });

  it('returns empty schema with NoopDiscovery (default)', async () => {
    const hostTools = new HostToolsRegistry();

    const result = await hostTools.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'get_sim_options_schema',
      arguments: {},
    });

    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({});
  });

  it('includes field descriptions in the schema', async () => {
    const registry = makeRegistryWithSchemaProvider([
      { key: 'verbose', label: 'Verbose', type: 'boolean', default: true, description: 'Enable verbose logging' },
    ]);

    const discovery = new PluginBackedDiscovery(projectRoot, registry);
    const hostTools = new HostToolsRegistry(discovery);

    const result = await hostTools.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'get_sim_options_schema',
      arguments: {},
    });

    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.verbose.description).toBe('Enable verbose logging');
  });
});
