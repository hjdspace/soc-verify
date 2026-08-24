/**
 * Regression router — discover, parse, run, and track regressions.
 *
 * See ADR 0020 for the redesign rationale.
 *
 * Procedures:
 *   discover     — scan $PROJ_ENV for regression lists/groups grouped by subsystem
 *   parseList    — parse a .lst file into entries
 *   parseGroup   — parse a .grp file into referenced file paths
 *   run          — submit `runsim -regr` with options
 *   getHistory   — list past regression runs
 *   getResult    — get details of a specific regression run
 *   abort        — abort an active regression run
 */

import { readFile } from 'node:fs/promises';
import { t, TRPCError } from '../router-context';
import { requireProject } from '../../services/project-service';
import { resolveProjEnv } from '../../env/env-manager';
import {
  discoverRegressions,
  parseRegressionList,
  parseRegressionGroup,
  resolveGroupRefs,
} from '../../regression/regression-discovery';
import { RegressionRunner } from '../../regression/regression-runner';
import { regressionRunTracker } from '../../regression/regression-run-tracker';
import type { RegressionRunOptions } from '@shared/types/regression';
import { caseStatsRegistry } from '../../case/case-stats-registry';

// ── Discovery cache ───────────────────────────────────

const discoveryCache = new Map<string, ReturnType<typeof discoverRegressions>>();

/** Clear cached discovery results for a project. */
export function clearDiscoveryCache(projectId: string): void {
  discoveryCache.delete(projectId);
}

export const regressionRouter = t.router({
  /**
   * Discover regression items from $PROJ_ENV directory tree.
   * Results are cached in-memory; cleared on project switch or manual refresh.
   */
  discover: t.procedure
    .input((raw): { projectId: string; refresh?: boolean } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId, refresh: r.refresh === true };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);

      // Return cached result unless refresh is requested
      if (!input.refresh && discoveryCache.has(input.projectId)) {
        return discoveryCache.get(input.projectId);
      }

      // 优先从系统环境变量解析 PROJ_ENV（终端启动场景），其次回退到 .socverify/env.json
      const projEnv = await resolveProjEnv(project.rootPath);
      if (!projEnv) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'PROJ_ENV 环境变量未配置，请在环境设置中配置 PROJ_ENV。',
        });
      }

      const result = discoverRegressions(project.rootPath, projEnv);
      discoveryCache.set(input.projectId, result);
      return result;
    }),

  /**
   * Parse a regression list file (`.lst`) into entries.
   */
  parseList: t.procedure
    .input((raw): { filePath: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.filePath !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'filePath is required' });
      }
      return { filePath: r.filePath };
    })
    .query(async ({ input }) => {
      try {
        const content = await readFile(input.filePath, 'utf-8');
        return parseRegressionList(content);
      } catch {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `无法读取文件: ${input.filePath}` });
      }
    }),

  /**
   * Parse a regression group file (`.grp`) into referenced file paths.
   * Recursively resolves nested groups (max depth 10, cycle detection).
   */
  parseGroup: t.procedure
    .input((raw): { filePath: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.filePath !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'filePath is required' });
      }
      return { filePath: r.filePath };
    })
    .query(async ({ input }) => {
      try {
        const content = await readFile(input.filePath, 'utf-8');
        const refPaths = parseRegressionGroup(content);
        // Resolve nested groups
        const resolved = await resolveGroupRefs(
          input.filePath,
          async (path: string) => readFile(path, 'utf-8'),
        );
        return { refPaths, resolved };
      } catch {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `无法读取文件: ${input.filePath}` });
      }
    }),

  /**
   * Submit a regression run via `runsim -regr`.
   */
  run: t.procedure
    .input((raw): {
      projectId: string;
      filePath: string;
      subsys: string;
      options: RegressionRunOptions;
    } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.filePath !== 'string' || typeof r.subsys !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId, filePath, and subsys are required' });
      }
      const opts = (r.options as Record<string, unknown>) ?? {};
      const options: RegressionRunOptions = {
        tags: Array.isArray(opts.tags) ? opts.tags as string[] : undefined,
        nonTags: Array.isArray(opts.nonTags) ? opts.nonTags as string[] : undefined,
        failMode: typeof opts.failMode === 'boolean' ? opts.failMode : undefined,
        coverage: typeof opts.coverage === 'boolean' ? opts.coverage : undefined,
        regrWork: typeof opts.regrWork === 'string' ? opts.regrWork : undefined,
        merge: typeof opts.merge === 'boolean' ? opts.merge : undefined,
      };
      return { projectId: r.projectId, filePath: r.filePath, subsys: r.subsys, options };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);

      // Validate merge requires coverage
      if (input.options.merge && !input.options.coverage) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: '-merge 选项需要同时启用 -cov' });
      }

      const db = caseStatsRegistry.getDb(project.rootPath);
      const runner = new RegressionRunner(project.rootPath, db);
      const result = await runner.run(
        input.filePath,
        input.subsys,
        input.options,
        project.rootPath,
      );

      // 登记运行中回归（TitleBar 徽章 / 回归终态通知 / regression:event 数据源）
      regressionRunTracker.track({
        runId: result.runId,
        terminalId: result.terminalId,
        projectId: input.projectId,
        subsys: input.subsys,
        filePath: input.filePath,
      });

      return result;
    }),

  /**
   * Abort an active regression run.
   */
  abort: t.procedure
    .input((raw): { projectId: string; runId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.runId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and runId are required' });
      }
      return { projectId: r.projectId, runId: r.runId };
    })
    .mutation(({ input }) => {
      const project = requireProject(input.projectId);
      // 优先走单例 tracker（运行中的回归都登记在此；销毁终端后 exit 监听统一落终态），
      // 兜底走 runner（tracker 未覆盖到的历史路径）
      const ok = regressionRunTracker.abort(input.runId);
      if (ok) return { ok };
      const db = caseStatsRegistry.getDb(project.rootPath);
      const runner = new RegressionRunner(project.rootPath, db);
      return { ok: runner.abort(input.runId) };
    }),

  /**
   * List active regression runs (TitleBar 回归徽章数据源；
   * 启动时拉取，此后经 regression:event 事件流同步).
   */
  getActiveRuns: t.procedure
    .input((raw): { projectId?: string } => {
      const r = raw as Record<string, unknown>;
      return { projectId: typeof r.projectId === 'string' ? r.projectId : undefined };
    })
    .query(({ input }) => regressionRunTracker.getActive(input.projectId)),

  /**
   * Get regression history (past runs).
   */
  getHistory: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      const runner = new RegressionRunner(project.rootPath);
      return runner.getHistory();
    }),

  /**
   * Get details of a specific regression run.
   */
  getResult: t.procedure
    .input((raw): { projectId: string; runId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.runId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and runId are required' });
      }
      return { projectId: r.projectId, runId: r.runId };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      const runner = new RegressionRunner(project.rootPath);
      return runner.getHistoryEntry(input.runId);
    }),
});
