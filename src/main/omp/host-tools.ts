import type { AgentToolResult, RpcHostToolCallRequest, RpcHostToolDefinition } from './types';
import type { SubsysDiscovery, CaseStatus } from './discovery';
import { NoopDiscovery } from './discovery';

type HostToolHandler = (args: Record<string, unknown>) => Promise<AgentToolResult | string>;

interface HostToolEntry {
  definition: RpcHostToolDefinition;
  handler: HostToolHandler;
}

const TEXT = (text: string): AgentToolResult => ({ content: [{ type: 'text', text }] });

function defineTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  handler: HostToolHandler,
): HostToolEntry {
  return {
    definition: { name, description, parameters },
    handler,
  };
}

export class HostToolsRegistry {
  private tools = new Map<string, HostToolEntry>();
  private discovery: SubsysDiscovery;

  constructor(discovery?: SubsysDiscovery) {
    this.discovery = discovery ?? new NoopDiscovery();
    this.registerDefaults();
  }

  private registerDefaults(): void {
    this.register(
      defineTool(
        'list_subsys',
        'List all subsystems in the current SoC verification project.',
        {
          type: 'object',
          properties: {
            filter: { type: 'string', description: 'Optional name filter pattern' },
          },
          additionalProperties: false,
        },
        async (args) => {
          const filter = typeof args.filter === 'string' ? args.filter : undefined;
          const subsys = await this.discovery.listSubsys(filter);
          return TEXT(JSON.stringify(subsys));
        },
      ),
    );

    this.register(
      defineTool(
        'list_cases',
        'List verification cases for a subsystem or the entire project.',
        {
          type: 'object',
          properties: {
            subsys: { type: 'string', description: 'Subsystem name to filter by' },
            status: {
              type: 'string',
              enum: ['pass', 'fail', 'running', 'pending', 'all'],
              description: 'Filter by case status',
            },
          },
          additionalProperties: false,
        },
        async (args) => {
          const subsys = typeof args.subsys === 'string' ? args.subsys : undefined;
          const status = typeof args.status === 'string' ? (args.status as CaseStatus) : undefined;
          const cases = await this.discovery.listCases(subsys, status);
          return TEXT(JSON.stringify(cases));
        },
      ),
    );

    this.register(
      defineTool(
        'get_sim_options_schema',
        'Get the JSON schema for simulation run options supported by this project.',
        {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        async () => {
          const schema = await this.discovery.getSimOptionsSchema();
          return TEXT(JSON.stringify(schema));
        },
      ),
    );

    this.register(
      defineTool(
        'run_simulation',
        'Launch a simulation run with the specified options. Returns a run ID for tracking.',
        {
          type: 'object',
          properties: {
            testcase: { type: 'string', description: 'Testcase name to run' },
            subsys: { type: 'string', description: 'Target subsystem' },
            options: { type: 'object', description: 'Simulation options matching the schema', additionalProperties: true },
          },
          required: ['testcase'],
          additionalProperties: false,
        },
        async (_args) => TEXT(JSON.stringify({ runId: '', status: 'pending' })),
      ),
    );

    this.register(
      defineTool(
        'get_run_status',
        'Get the status of a simulation run by its ID.',
        {
          type: 'object',
          properties: {
            runId: { type: 'string', description: 'Run ID returned by run_simulation' },
          },
          required: ['runId'],
          additionalProperties: false,
        },
        async (_args) => TEXT(JSON.stringify({ runId: '', status: 'unknown' })),
      ),
    );

    this.register(
      defineTool(
        'get_compile_errors',
        'Retrieve compilation errors for a subsystem or testcase.',
        {
          type: 'object',
          properties: {
            subsys: { type: 'string', description: 'Subsystem name' },
            testcase: { type: 'string', description: 'Testcase name' },
          },
          additionalProperties: false,
        },
        async (_args) => TEXT('[]'),
      ),
    );

    this.register(
      defineTool(
        'get_coverage',
        'Get coverage data for a subsystem or the entire project.',
        {
          type: 'object',
          properties: {
            subsys: { type: 'string', description: 'Subsystem name' },
            type: {
              type: 'string',
              enum: ['line', 'toggle', 'functional', 'assertion'],
              description: 'Coverage type',
            },
          },
          additionalProperties: false,
        },
        async (_args) => TEXT('{}'),
      ),
    );
  }

  register(entry: HostToolEntry): void {
    this.tools.set(entry.definition.name, entry);
  }

  registerCustom(name: string, description: string, parameters: Record<string, unknown>, handler: HostToolHandler): void {
    this.register(defineTool(name, description, parameters, handler));
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  getDefinitions(): RpcHostToolDefinition[] {
    return Array.from(this.tools.values()).map((e) => e.definition);
  }

  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  async handleToolCall(request: RpcHostToolCallRequest): Promise<AgentToolResult | string> {
    const entry = this.tools.get(request.toolName);
    if (!entry) {
      return TEXT(`Host tool "${request.toolName}" is not registered`);
    }
    return entry.handler(request.arguments);
  }
}
