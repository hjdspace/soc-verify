import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { AgentToolResult, RpcHostToolCallRequest, RpcHostToolDefinition } from './types';
import type { SubsysDiscovery, CaseStatus } from './discovery';
import { NoopDiscovery } from './discovery';
import type { PluginBackedSimulation, PluginBackedCoverage } from './plugin-discovery';

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
  private simulation: PluginBackedSimulation | null = null;
  private coverage: PluginBackedCoverage | null = null;
  /** Working directory for resolving relative file paths in tools */
  cwd: string;

  constructor(discovery?: SubsysDiscovery, cwd?: string) {
    this.discovery = discovery ?? new NoopDiscovery();
    this.cwd = cwd ?? process.cwd();
    this.registerDefaults();
  }

  setSimulationAdapter(sim: PluginBackedSimulation | null): void {
    this.simulation = sim;
  }

  setCoverageAdapter(cov: PluginBackedCoverage | null): void {
    this.coverage = cov;
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
        async (args) => {
          if (!this.simulation?.hasRunner()) {
            return TEXT(JSON.stringify({ error: 'No simulation-runner plugin loaded. Cannot run simulations.' }));
          }
          try {
            const handle = await this.simulation.run({
              caseId: typeof args.testcase === 'string' ? args.testcase : '',
              caseName: typeof args.testcase === 'string' ? args.testcase : undefined,
              subsys: typeof args.subsys === 'string' ? args.subsys : '',
              options: typeof args.options === 'object' && args.options !== null ? args.options as Record<string, unknown> : undefined,
            });
            return TEXT(JSON.stringify({ runId: handle.runId, status: 'pending' }));
          } catch (err) {
            return TEXT(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        },
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
        async (args) => {
          if (!this.simulation?.hasRunner()) {
            return TEXT(JSON.stringify({ error: 'No simulation-runner plugin loaded' }));
          }
          try {
            const runId = typeof args.runId === 'string' ? args.runId : '';
            const status = await this.simulation.getStatus(runId);
            return TEXT(JSON.stringify(status));
          } catch (err) {
            return TEXT(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        },
      ),
    );

    this.register(
      defineTool(
        'get_compile_errors',
        'Retrieve compilation errors for a simulation run.',
        {
          type: 'object',
          properties: {
            runId: { type: 'string', description: 'Run ID returned by run_simulation' },
            subsys: { type: 'string', description: 'Subsystem name' },
            testcase: { type: 'string', description: 'Testcase name' },
          },
          additionalProperties: false,
        },
        async (args) => {
          if (!this.simulation?.hasRunner()) {
            return TEXT('[]');
          }
          try {
            const runId = typeof args.runId === 'string' ? args.runId : '';
            if (runId) {
              const errors = await this.simulation.getCompileErrors(runId);
              return TEXT(JSON.stringify(errors));
            }
            return TEXT('[]');
          } catch (err) {
            return TEXT(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        },
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
            runId: { type: 'string', description: 'Run ID for specific coverage data' },
          },
          additionalProperties: false,
        },
        async (args) => {
          if (!this.coverage?.hasParser()) {
            return TEXT(JSON.stringify({ error: 'No coverage-parser plugin loaded' }));
          }
          try {
            const runId = typeof args.runId === 'string' ? args.runId : '';
            const data = await this.coverage.parse(runId);
            return TEXT(JSON.stringify(data));
          } catch (err) {
            return TEXT(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        },
      ),
    );

    this.register(
      defineTool(
        'read_file',
        'Read the content of a file. The path is resolved relative to the project root.',
        {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (absolute or relative to project root)' },
            maxLines: { type: 'number', description: 'Maximum number of lines to read (default 500)' },
          },
          required: ['path'],
          additionalProperties: false,
        },
        async (args) => {
          try {
            const inputPath = typeof args.path === 'string' ? args.path : '';
            if (!inputPath) return TEXT('Error: path is required');

            const maxLines = typeof args.maxLines === 'number' ? args.maxLines : 500;
            const resolvedPath = isAbsolute(inputPath) ? inputPath : resolve(this.cwd, inputPath);

            const content = await readFile(resolvedPath, 'utf-8');
            const lines = content.split('\n');
            const truncated = lines.length > maxLines ? lines.slice(0, maxLines) : lines;
            const result = truncated.join('\n');
            const suffix = lines.length > maxLines ? `\n... (${lines.length - maxLines} more lines)` : '';
            return TEXT(result + suffix);
          } catch (err) {
            return TEXT(`Error reading file: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
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
