import type { CoverageMetric } from '@shared/types';
import { TEXT, defineTool, type HostToolEntry, type ToolContext } from './shared';

/**
 * 覆盖率深度分析工具（仅 CoverageManager 可用时注册）：
 * get_coverage_detail / get_coverage_uncovered / get_coverage_grade / get_coverage_csv
 */
export function createCoverageAnalysisTools(ctx: ToolContext): HostToolEntry[] {
  return [
    defineTool(
      'get_coverage_detail',
      'Get detailed coverage for a specific module and its direct children (ADR 0009 drill-down). Use after get_coverage to inspect a specific low-coverage module.',
      {
        type: 'object',
        properties: {
          module: { type: 'string', description: 'Module path (e.g. "top/cpu_core")' },
          sessionId: {
            type: 'string',
            description: 'Coverage Merge Session ID. If omitted, the most recent session is used.',
          },
        },
        required: ['module'],
        additionalProperties: false,
      },
      async (args) => {
        if (!ctx.coverageManager) {
          return TEXT(JSON.stringify({ error: 'Coverage manager not available' }));
        }
        try {
          const modulePath = typeof args.module === 'string' ? args.module : '';
          const sessionId = typeof args.sessionId === 'string' ? args.sessionId : undefined;
          const result = await ctx.coverageManager.getCoverageDetail(modulePath, sessionId);
          return TEXT(JSON.stringify(result));
        } catch (err) {
          return TEXT(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      },
    ),

    defineTool(
      'get_coverage_uncovered',
      'Get uncovered coverage items (bins, lines, branches) for a coverage session. Returns a list of uncovered items with module/signal/file info. Useful for AI to identify what needs to be tested to close coverage gaps.',
      {
        type: 'object',
        properties: {
          metric: {
            type: 'string',
            enum: ['line', 'branch', 'toggle', 'condition', 'fsm_state', 'fsm_transition', 'functional', 'assertion'],
            description: 'Filter by coverage metric type. If omitted, returns all uncovered items.',
          },
          sessionId: {
            type: 'string',
            description: 'Coverage Merge Session ID. If omitted, the most recent session is used.',
          },
        },
        additionalProperties: false,
      },
      async (args) => {
        if (!ctx.coverageManager) {
          return TEXT(JSON.stringify({ error: 'Coverage manager not available' }));
        }
        try {
          const metric = typeof args.metric === 'string' ? (args.metric as CoverageMetric) : undefined;
          const sessionId = typeof args.sessionId === 'string' ? args.sessionId : undefined;
          const result = await ctx.coverageManager.getCoverageUncovered(sessionId, metric);
          return TEXT(JSON.stringify(result));
        } catch (err) {
          return TEXT(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      },
    ),

    defineTool(
      'get_coverage_grade',
      'Get test case coverage contribution ranking. Returns a list of test cases with their coverage scores and ranks. Useful for AI to identify which tests contribute most to coverage and which tests are redundant. Data source: urg -grade testfile (VCS) or imc report -test (Cadence).',
      {
        type: 'object',
        properties: {
          sessionId: {
            type: 'string',
            description: 'Coverage Merge Session ID. If omitted, the most recent session is used.',
          },
        },
        additionalProperties: false,
      },
      async (args) => {
        if (!ctx.coverageManager) {
          return TEXT(JSON.stringify({ error: 'Coverage manager not available' }));
        }
        try {
          const sessionId = typeof args.sessionId === 'string' ? args.sessionId : undefined;
          const result = await ctx.coverageManager.getTestContributions(sessionId);
          return TEXT(JSON.stringify(result));
        } catch (err) {
          return TEXT(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      },
    ),

    defineTool(
      'get_coverage_csv',
      'Get raw CSV coverage data (from urg -format csv). Returns structured CSV text that can be parsed for detailed analysis. Only available when VCS urg is used as the EDA tool. Returns null if no CSV data was generated.',
      {
        type: 'object',
        properties: {
          sessionId: {
            type: 'string',
            description: 'Coverage Merge Session ID. If omitted, the most recent session is used.',
          },
        },
        additionalProperties: false,
      },
      async (args) => {
        if (!ctx.coverageManager) {
          return TEXT(JSON.stringify({ error: 'Coverage manager not available' }));
        }
        try {
          const sessionId = typeof args.sessionId === 'string' ? args.sessionId : undefined;
          const result = await ctx.coverageManager.getCsvData(sessionId);
          return TEXT(JSON.stringify(result));
        } catch (err) {
          return TEXT(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      },
    ),
  ];
}

/**
 * 用例聚合统计工具（仅 CaseStatsService 可用时注册）：
 * get_case_stats / get_project_overview
 */
export function createCaseStatsTools(ctx: ToolContext): HostToolEntry[] {
  return [
    defineTool(
      'get_case_stats',
      'Get aggregate case statistics for a single subsystem. Returns total count, breakdown by status (pass/fail/running/pending), and breakdown by file (each file = a "feature" or "category" of cases). Use this to answer "how many cases", "how many pass/fail", "what kinds of cases" without dumping the full case list. Use list_cases to drill down into specific cases.',
      {
        type: 'object',
        properties: {
          subsys: { type: 'string', description: 'Subsystem name (required)' },
        },
        required: ['subsys'],
        additionalProperties: false,
      },
      async (args) => {
        if (!ctx.caseStatsService) {
          return TEXT(JSON.stringify({ error: 'Case stats service not available' }));
        }
        const subsys = typeof args.subsys === 'string' ? args.subsys : undefined;
        if (!subsys) {
          return TEXT(JSON.stringify({ error: 'subsys is required' }));
        }
        const stats = await ctx.caseStatsService.getCaseStats(subsys);
        return TEXT(JSON.stringify(stats));
      },
    ),

    defineTool(
      'get_project_overview',
      'Get project-wide case overview in a single call (avoids N+1 list_subsys + list_cases). Returns total subsystem count, total case count, and per-subsystem breakdown (name, caseCount, byStatus). Use this to answer "how many cases in the whole project" or "which subsystem has the most cases".',
      {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      async () => {
        if (!ctx.caseStatsService) {
          return TEXT(JSON.stringify({ error: 'Case stats service not available' }));
        }
        const overview = await ctx.caseStatsService.getProjectOverview();
        return TEXT(JSON.stringify(overview));
      },
    ),
  ];
}
