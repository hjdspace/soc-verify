/**
 * Coverage analysis router — overview, per-subsystem, detail, trends, export.
 */

import { t, TRPCError, requireProject } from '../router-context';
import { CoverageManager } from '../../coverage/coverage-manager';
import { pluginLoader } from '../../plugins/loader';
import { PluginBackedCoverage } from '../../host/plugin-discovery';

export const coverageRouter = t.router({
  getOverview: t.procedure
    .input((raw): { projectId: string; runId?: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId, runId: typeof r.runId === 'string' ? r.runId : undefined };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      const registry = pluginLoader.getRegistry(project.rootPath);
      const adapter = new PluginBackedCoverage(project.rootPath, registry);
      const mgr = new CoverageManager({ projectRoot: project.rootPath, coverageAdapter: adapter });
      return mgr.getOverview(input.runId);
    }),

  getBySubsys: t.procedure
    .input((raw): { projectId: string; runId?: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId, runId: typeof r.runId === 'string' ? r.runId : undefined };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      const registry = pluginLoader.getRegistry(project.rootPath);
      const adapter = new PluginBackedCoverage(project.rootPath, registry);
      const mgr = new CoverageManager({ projectRoot: project.rootPath, coverageAdapter: adapter });
      return mgr.getBySubsys(input.runId);
    }),

  getDetail: t.procedure
    .input((raw): { projectId: string; runId?: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId, runId: typeof r.runId === 'string' ? r.runId : undefined };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      const registry = pluginLoader.getRegistry(project.rootPath);
      const adapter = new PluginBackedCoverage(project.rootPath, registry);
      const mgr = new CoverageManager({ projectRoot: project.rootPath, coverageAdapter: adapter });
      return mgr.getDetail(input.runId);
    }),

  listCachedRuns: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      const registry = pluginLoader.getRegistry(project.rootPath);
      const adapter = new PluginBackedCoverage(project.rootPath, registry);
      const mgr = new CoverageManager({ projectRoot: project.rootPath, coverageAdapter: adapter });
      return mgr.listCachedRuns();
    }),

  getTrend: t.procedure
    .input((raw): { projectId: string; limit?: number } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId, limit: typeof r.limit === 'number' ? r.limit : undefined };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      const registry = pluginLoader.getRegistry(project.rootPath);
      const adapter = new PluginBackedCoverage(project.rootPath, registry);
      const mgr = new CoverageManager({ projectRoot: project.rootPath, coverageAdapter: adapter });
      return mgr.getTrend(input.limit);
    }),

  getUncovered: t.procedure
    .input((raw): { projectId: string; runId: string; type: 'line' | 'toggle' | 'functional' | 'assertion' } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.runId !== 'string' || typeof r.type !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId, runId and type are required' });
      }
      return { projectId: r.projectId, runId: r.runId, type: r.type as 'line' | 'toggle' | 'functional' | 'assertion' };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      const registry = pluginLoader.getRegistry(project.rootPath);
      const adapter = new PluginBackedCoverage(project.rootPath, registry);
      const mgr = new CoverageManager({ projectRoot: project.rootPath, coverageAdapter: adapter });
      return mgr.getUncovered(input.runId, input.type);
    }),

  exportReport: t.procedure
    .input((raw): { projectId: string; runId: string; format: 'html' | 'json'; outputPath: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.runId !== 'string' || typeof r.format !== 'string' || typeof r.outputPath !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId, runId, format and outputPath are required' });
      }
      return { projectId: r.projectId, runId: r.runId, format: r.format as 'html' | 'json', outputPath: r.outputPath };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      const registry = pluginLoader.getRegistry(project.rootPath);
      const adapter = new PluginBackedCoverage(project.rootPath, registry);
      const mgr = new CoverageManager({ projectRoot: project.rootPath, coverageAdapter: adapter });
      return mgr.exportReport(input.runId, input.format, input.outputPath);
    }),
});
