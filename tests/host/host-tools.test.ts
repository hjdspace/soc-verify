import { describe, it, expect } from 'vitest';
import { HostToolsRegistry } from '../../src/main/host/host-tools';
import { NoopDiscovery } from '../../src/main/host/discovery';
import type { SubsysDiscovery, SubsysInfo, CaseInfo, SimOptionsSchema } from '../../src/main/host/discovery';

class MockDiscovery implements SubsysDiscovery {
  constructor(
    private subsys: SubsysInfo[] = [],
    private cases: CaseInfo[] = [],
    private schema: SimOptionsSchema = {},
  ) {}

  async listSubsys(_filter?: string): Promise<SubsysInfo[]> {
    return this.subsys;
  }

  async listCases(_subsys?: string, _status?: string): Promise<CaseInfo[]> {
    return this.cases;
  }

  async getSimOptionsSchema(): Promise<SimOptionsSchema> {
    return this.schema;
  }
}

describe('HostToolsRegistry', () => {
  it('registers 7 default tools', () => {
    const registry = new HostToolsRegistry();
    const names = registry.getToolNames();
    expect(names).toHaveLength(7);
    expect(names).toContain('list_subsys');
    expect(names).toContain('list_cases');
    expect(names).toContain('get_sim_options_schema');
    expect(names).toContain('run_simulation');
    expect(names).toContain('get_run_status');
    expect(names).toContain('get_compile_errors');
    expect(names).toContain('get_coverage');
  });

  it('getDefinitions returns all tool definitions', () => {
    const registry = new HostToolsRegistry();
    const defs = registry.getDefinitions();
    expect(defs).toHaveLength(7);
    for (const def of defs) {
      expect(def.name).toBeDefined();
      expect(def.description).toBeDefined();
      expect(def.parameters).toBeDefined();
    }
  });

  it('hasTool returns true for registered tools', () => {
    const registry = new HostToolsRegistry();
    expect(registry.hasTool('list_subsys')).toBe(true);
    expect(registry.hasTool('nonexistent')).toBe(false);
  });

  it('registerCustom adds a new tool', () => {
    const registry = new HostToolsRegistry();
    registry.registerCustom('custom_tool', 'A custom tool', { type: 'object' }, async () => 'ok');
    expect(registry.hasTool('custom_tool')).toBe(true);
    expect(registry.getToolNames()).toHaveLength(8);
  });

  it('unregister removes a tool', () => {
    const registry = new HostToolsRegistry();
    expect(registry.unregister('list_subsys')).toBe(true);
    expect(registry.hasTool('list_subsys')).toBe(false);
    expect(registry.getToolNames()).toHaveLength(6);
  });

  it('unregister returns false for nonexistent tool', () => {
    const registry = new HostToolsRegistry();
    expect(registry.unregister('nonexistent')).toBe(false);
  });

  it('handleToolCall returns error text for unregistered tool', async () => {
    const registry = new HostToolsRegistry();
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'nonexistent',
      arguments: {},
    });
    expect(result).toEqual({
      content: [{ type: 'text', text: 'Host tool "nonexistent" is not registered' }],
    });
  });

  it('list_subsys calls discovery.listSubsys', async () => {
    const mockSubsys: SubsysInfo[] = [
      { name: 'cpu', path: '/subsystems/cpu', caseCount: 10 },
      { name: 'gpu', path: '/subsystems/gpu', caseCount: 5 },
    ];
    const registry = new HostToolsRegistry(new MockDiscovery(mockSubsys));
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'list_subsys',
      arguments: {},
    });
    expect(typeof result).toBe('object');
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed).toEqual(mockSubsys);
  });

  it('list_cases calls discovery.listCases', async () => {
    const mockCases: CaseInfo[] = [
      { name: 'test_basic', subsys: 'cpu', path: '/cases/test_basic', status: 'pass' },
    ];
    const registry = new HostToolsRegistry(new MockDiscovery([], mockCases));
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'list_cases',
      arguments: { subsys: 'cpu', status: 'pass' },
    });
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed).toEqual(mockCases);
  });

  it('get_sim_options_schema calls discovery.getSimOptionsSchema', async () => {
    const mockSchema = { waves: { type: 'boolean' }, timeout: { type: 'number' } };
    const registry = new HostToolsRegistry(new MockDiscovery([], [], mockSchema));
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'get_sim_options_schema',
      arguments: {},
    });
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed).toEqual(mockSchema);
  });

  it('defaults to NoopDiscovery when no discovery provided', async () => {
    const registry = new HostToolsRegistry();
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'list_subsys',
      arguments: {},
    });
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed).toEqual([]);
  });
});
