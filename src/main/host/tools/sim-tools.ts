import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { CaseStatus } from '../discovery';
import { TEXT, defineTool, type HostToolEntry, type ToolContext } from './shared';

/**
 * 仿真与用例工具：list_subsys / list_cases / get_sim_options_schema /
 * run_simulation / get_run_status / get_compile_errors / get_coverage / read_file
 */
export function createSimTools(ctx: ToolContext): HostToolEntry[] {
  return [
    defineTool(
      'list_subsys',
      'List all subsystems in the current SoC verification project, with case count for each.',
      {
        type: 'object',
        properties: {
          filter: { type: 'string', description: 'Optional name filter pattern' },
        },
        additionalProperties: false,
      },
      async (args) => {
        const filter = typeof args.filter === 'string' ? args.filter : undefined;
        const subsys = ctx.caseStatsService
          ? await ctx.caseStatsService.listSubsysWithCaseCount(filter)
          : await ctx.discovery.listSubsys(filter);
        return TEXT(JSON.stringify(subsys));
      },
    ),

    defineTool(
      'list_cases',
      'List verification cases for a subsystem. Case status is joined from the latest simulation run (pass/fail/running/pending). For aggregate counts (total / by-status / by-file), prefer get_case_stats which is token-efficient.',
      {
        type: 'object',
        properties: {
          subsys: { type: 'string', description: 'Subsystem name (required)' },
          status: {
            type: 'string',
            enum: ['pass', 'fail', 'running', 'pending', 'all'],
            description: 'Filter by case status',
          },
        },
        required: ['subsys'],
        additionalProperties: false,
      },
      async (args) => {
        const subsys = typeof args.subsys === 'string' ? args.subsys : undefined;
        if (!subsys) {
          return TEXT(JSON.stringify({ error: 'subsys is required. Use list_subsys to discover subsystem names, or get_project_overview for cross-subsystem aggregates.' }));
        }
        const status = typeof args.status === 'string' ? (args.status as CaseStatus) : undefined;
        let cases;
        if (ctx.caseStatsService) {
          cases = await ctx.caseStatsService.listCasesWithStatus(subsys);
        } else {
          cases = await ctx.discovery.listCases(subsys, status);
        }
        if (status && status !== 'all') {
          cases = cases.filter((c) => c.status === status);
        }
        return TEXT(JSON.stringify(cases));
      },
    ),

    defineTool(
      'get_sim_options_schema',
      'Get the JSON schema for simulation run options supported by this project.',
      {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      async () => {
        const schema = await ctx.discovery.getSimOptionsSchema();
        return TEXT(JSON.stringify(schema));
      },
    ),

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
        if (!ctx.simulation?.hasRunner()) {
          return TEXT(JSON.stringify({ error: 'No simulation-runner plugin loaded. Cannot run simulations.' }));
        }
        try {
          const handle = await ctx.simulation.run({
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
        if (!ctx.simulation?.hasRunner()) {
          return TEXT(JSON.stringify({ error: 'No simulation-runner plugin loaded' }));
        }
        try {
          const runId = typeof args.runId === 'string' ? args.runId : '';
          const status = await ctx.simulation.getStatus(runId);
          return TEXT(JSON.stringify(status));
        } catch (err) {
          return TEXT(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      },
    ),

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
        if (!ctx.simulation?.hasRunner()) {
          return TEXT('[]');
        }
        try {
          const runId = typeof args.runId === 'string' ? args.runId : '';
          if (runId) {
            const errors = await ctx.simulation.getCompileErrors(runId);
            return TEXT(JSON.stringify(errors));
          }
          return TEXT('[]');
        } catch (err) {
          return TEXT(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      },
    ),

    defineTool(
      'get_coverage',
      'Get coverage summary for a coverage merge session. Returns top-level summary plus the worst-coverage modules (ADR 0009 summary-first strategy). Use get_coverage_detail to drill down into a specific module.',
      {
        type: 'object',
        properties: {
          sessionId: {
            type: 'string',
            description: 'Coverage Merge Session ID. If omitted, the most recent session is used.',
          },
          worstN: {
            type: 'number',
            description: 'Number of worst-coverage modules to return (default 5)',
          },
        },
        additionalProperties: false,
      },
      async (args) => {
        if (ctx.coverageManager) {
          try {
            const sessionId = typeof args.sessionId === 'string' ? args.sessionId : undefined;
            const worstN = typeof args.worstN === 'number' ? args.worstN : 5;
            const result = await ctx.coverageManager.getCoverageSummary(sessionId, worstN);
            return TEXT(JSON.stringify(result));
          } catch (err) {
            return TEXT(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        }
        if (!ctx.coverage?.hasParser()) {
          return TEXT(JSON.stringify({ error: 'No coverage-parser plugin loaded' }));
        }
        try {
          const sessionId = typeof args.sessionId === 'string' ? args.sessionId : 'latest';
          const reportDir = typeof args.reportDir === 'string' ? args.reportDir : '';
          const data = await ctx.coverage.parse(sessionId, reportDir);
          return TEXT(JSON.stringify(data));
        } catch (err) {
          return TEXT(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      },
    ),

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
          const resolvedPath = isAbsolute(inputPath) ? inputPath : resolve(ctx.cwd, inputPath);

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
  ];
}
