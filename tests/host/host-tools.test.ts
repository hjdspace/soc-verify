import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HostToolsRegistry } from '../../src/main/host/host-tools';
import type { SubsysDiscovery, SubsysInfo, CaseInfo, SimOptionsSchema } from '../../src/main/host/discovery';
import { CaseStatsService } from '../../src/main/case/case-stats-service';
import { createMemoryDatabase, closeDatabase, type CaseDatabase } from '../../src/main/case/db/case-database';
import { insertSubsystems, insertCases, insertSimulationRun } from '../../src/main/case/db/case-repository';
import type { SimulationManager } from '../../src/main/simulation/simulation-manager';
import type { SimulationHistoryEntry } from '../../src/shared/types';
import type { SimulationRunRecord } from '../../src/main/simulation/simulation-manager';

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

/** Per-subsys mock: returns cases filtered by subsys (for CaseStatsService tests). */
class MockPerSubsysDiscovery implements SubsysDiscovery {
  constructor(
    private subsys: SubsysInfo[] = [],
    private casesBySubsys: Map<string, CaseInfo[]> = new Map(),
    private schema: SimOptionsSchema = {},
  ) {}

  async listSubsys(_filter?: string): Promise<SubsysInfo[]> {
    return this.subsys;
  }

  async listCases(subsys?: string, _status?: string): Promise<CaseInfo[]> {
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

describe('HostToolsRegistry', () => {
  it('registers 15 default tools (8 base + 5 document tools + 2 xlsx edit tools)', () => {
    const registry = new HostToolsRegistry();
    const names = registry.getToolNames();
    expect(names).toHaveLength(15);
    expect(names).toContain('list_subsys');
    expect(names).toContain('list_cases');
    expect(names).toContain('get_sim_options_schema');
    expect(names).toContain('run_simulation');
    expect(names).toContain('get_run_status');
    expect(names).toContain('get_compile_errors');
    expect(names).toContain('get_coverage');
    expect(names).toContain('read_file');
    // 文档工具（Issue #6）
    expect(names).toContain('create_docx');
    expect(names).toContain('create_xlsx');
    expect(names).toContain('create_pptx');
    expect(names).toContain('create_pdf');
    expect(names).toContain('read_document');
    // xlsx 细粒度编辑工具（Issue #7）
    expect(names).toContain('append_xlsx_row');
    expect(names).toContain('update_xlsx_cell');
  });

  it('getDefinitions returns all tool definitions', () => {
    const registry = new HostToolsRegistry();
    const defs = registry.getDefinitions();
    expect(defs).toHaveLength(15);
    for (const def of defs) {
      expect(def.name).toBeDefined();
      expect(def.description).toBeDefined();
      expect(def.parameters).toBeDefined();
    }
  });

  it('hasTool returns true for registered tools', () => {
    const registry = new HostToolsRegistry();
    expect(registry.hasTool('list_subsys')).toBe(true);
    expect(registry.hasTool('create_docx')).toBe(true);
    expect(registry.hasTool('nonexistent')).toBe(false);
  });

  it('registerCustom adds a new tool', () => {
    const registry = new HostToolsRegistry();
    registry.registerCustom('custom_tool', 'A custom tool', { type: 'object' }, async () => 'ok');
    expect(registry.hasTool('custom_tool')).toBe(true);
    expect(registry.getToolNames()).toHaveLength(16);
  });

  it('unregister removes a tool', () => {
    const registry = new HostToolsRegistry();
    expect(registry.unregister('list_subsys')).toBe(true);
    expect(registry.hasTool('list_subsys')).toBe(false);
    expect(registry.getToolNames()).toHaveLength(14);
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

// ─── CaseStatsService-backed tools (get_case_stats / get_project_overview) ──

describe('HostToolsRegistry with CaseStatsService', () => {
  let db: CaseDatabase;

  beforeEach(() => {
    db = createMemoryDatabase();
  });

  afterEach(() => {
    closeDatabase(db);
  });

  function makeStatsRegistry(simManager?: SimulationManager): {
    registry: HostToolsRegistry;
    statsService: CaseStatsService;
  } {
    const subsys: SubsysInfo[] = [
      { name: 'cpu', path: '/subsystems/cpu' },
    ];
    const cases: CaseInfo[] = [
      { name: 'cpu_alu_basic', subsys: 'cpu', path: '/cases/alu', filePath: '/tests/alu.cfg' },
      { name: 'cpu_alu_overflow', subsys: 'cpu', path: '/cases/alu', filePath: '/tests/alu.cfg', baseCase: 'cpu_alu_basic' },
      { name: 'cpu_reg_write', subsys: 'cpu', path: '/cases/reg', filePath: '/tests/reg.cfg' },
    ];
    // Seed DB with subsystem and case data
    insertSubsystems(db, subsys.map((s) => ({ name: s.name, path: s.path })));
    insertCases(db, cases.map((c) => ({
      name: c.name, subsys: c.subsys, path: c.path, filePath: c.filePath, baseCase: c.baseCase,
    })));
    // MockPerSubsysDiscovery still needed for HostToolsRegistry (get_sim_options_schema etc.)
    const discovery = new MockPerSubsysDiscovery(subsys, new Map([['cpu', cases]]));
    const statsService = new CaseStatsService({ db, simulationManager: simManager ?? null });
    const registry = new HostToolsRegistry(discovery);
    registry.setCaseStatsService(statsService);
    return { registry, statsService };
  }

  it('registers get_case_stats and get_project_overview when CaseStatsService is set', () => {
    const { registry } = makeStatsRegistry();
    expect(registry.hasTool('get_case_stats')).toBe(true);
    expect(registry.hasTool('get_project_overview')).toBe(true);
  });

  it('unregisters case stats tools when CaseStatsService is set to null', () => {
    const { registry } = makeStatsRegistry();
    registry.setCaseStatsService(null);
    expect(registry.hasTool('get_case_stats')).toBe(false);
    expect(registry.hasTool('get_project_overview')).toBe(false);
  });

  it('get_case_stats returns flat summary', async () => {
    const { registry } = makeStatsRegistry();
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'get_case_stats',
      arguments: { subsys: 'cpu' },
    });
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.subsys).toBe('cpu');
    expect(parsed.total).toBe(3);
    expect(parsed.byStatus.pending).toBe(3);
    expect(parsed.byFile).toHaveLength(2);
  });

  it('get_project_overview returns project-wide aggregate', async () => {
    const { registry } = makeStatsRegistry();
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'get_project_overview',
      arguments: {},
    });
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.subsysCount).toBe(1);
    expect(parsed.totalCases).toBe(3);
    expect(parsed.bySubsys[0].name).toBe('cpu');
    expect(parsed.bySubsys[0].caseCount).toBe(3);
  });

  it('list_cases with CaseStatsService joins status from simulation_runs DB', async () => {
    // Seed a simulation run into the DB (ADR 0017 Issue #4: status from DB, not SimulationManager history)
    insertSimulationRun(db, {
      caseName: 'cpu_alu_basic',
      subsys: 'cpu',
      status: 'pass',
      startTime: '2024-01-01T10:00:00',
    });
    const simManager = makeMockSimulationManager();
    const { registry } = makeStatsRegistry(simManager);
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'list_cases',
      arguments: { subsys: 'cpu' },
    });
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed).toHaveLength(3);
    const aluBasic = parsed.find((c: CaseInfo) => c.name === 'cpu_alu_basic');
    expect(aluBasic.status).toBe('pass');
    const regWrite = parsed.find((c: CaseInfo) => c.name === 'cpu_reg_write');
    expect(regWrite.status).toBe('pending');
  });

  it('list_cases requires subsys argument', async () => {
    const { registry } = makeStatsRegistry();
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'list_cases',
      arguments: {},
    });
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.error).toBeDefined();
  });

  it('list_subsys with CaseStatsService fills real caseCount', async () => {
    const { registry } = makeStatsRegistry();
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'list_subsys',
      arguments: {},
    });
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed[0].caseCount).toBe(3);
  });
});
