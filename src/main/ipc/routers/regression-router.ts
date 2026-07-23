/**
 * Regression suite router — create, update, delete, list, run, compare, history.
 */

import { t, TRPCError } from '../router-context';
import { requireProject } from '../../services/project-service';
import { RegressionManager } from '../../regression/regression-manager';
import { pluginLoader } from '../../plugins/loader';
import { PluginBackedSimulation } from '../../plugin-adapters';

export const regressionRouter = t.router({
  create: t.procedure
    .input((raw): { projectId: string; name: string; caseIds: string[]; options: Record<string, unknown> } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.name !== 'string' || !Array.isArray(r.caseIds)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId, name and caseIds are required' });
      }
      return { projectId: r.projectId, name: r.name, caseIds: r.caseIds as string[], options: (r.options as Record<string, unknown>) ?? {} };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      const registry = pluginLoader.getRegistry(project.rootPath);
      const adapter = new PluginBackedSimulation(registry);
      const mgr = new RegressionManager({ projectRoot: project.rootPath, simulationAdapter: adapter });
      return mgr.createSuite(input.name, input.caseIds, input.options);
    }),

  update: t.procedure
    .input((raw): { projectId: string; name: string; caseIds?: string[]; options?: Record<string, unknown> } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.name !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and name are required' });
      }
      return {
        projectId: r.projectId,
        name: r.name,
        caseIds: Array.isArray(r.caseIds) ? r.caseIds as string[] : undefined,
        options: typeof r.options === 'object' ? r.options as Record<string, unknown> : undefined,
      };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      const registry = pluginLoader.getRegistry(project.rootPath);
      const adapter = new PluginBackedSimulation(registry);
      const mgr = new RegressionManager({ projectRoot: project.rootPath, simulationAdapter: adapter });
      return mgr.updateSuite(input.name, { caseIds: input.caseIds, options: input.options });
    }),

  delete: t.procedure
    .input((raw): { projectId: string; name: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.name !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and name are required' });
      }
      return { projectId: r.projectId, name: r.name };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      const registry = pluginLoader.getRegistry(project.rootPath);
      const adapter = new PluginBackedSimulation(registry);
      const mgr = new RegressionManager({ projectRoot: project.rootPath, simulationAdapter: adapter });
      await mgr.deleteSuite(input.name);
      return { ok: true };
    }),

  list: t.procedure
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
      const adapter = new PluginBackedSimulation(registry);
      const mgr = new RegressionManager({ projectRoot: project.rootPath, simulationAdapter: adapter });
      return mgr.listSuites();
    }),

  run: t.procedure
    .input((raw): { projectId: string; name: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.name !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and name are required' });
      }
      return { projectId: r.projectId, name: r.name };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      const registry = pluginLoader.getRegistry(project.rootPath);
      const adapter = new PluginBackedSimulation(registry);
      const mgr = new RegressionManager({ projectRoot: project.rootPath, simulationAdapter: adapter });
      return mgr.runSuite(input.name);
    }),

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
      const registry = pluginLoader.getRegistry(project.rootPath);
      const adapter = new PluginBackedSimulation(registry);
      const mgr = new RegressionManager({ projectRoot: project.rootPath, simulationAdapter: adapter });
      return mgr.getResult(input.runId);
    }),

  compareRuns: t.procedure
    .input((raw): { projectId: string; runId1: string; runId2: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.runId1 !== 'string' || typeof r.runId2 !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId, runId1 and runId2 are required' });
      }
      return { projectId: r.projectId, runId1: r.runId1, runId2: r.runId2 };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      const registry = pluginLoader.getRegistry(project.rootPath);
      const adapter = new PluginBackedSimulation(registry);
      const mgr = new RegressionManager({ projectRoot: project.rootPath, simulationAdapter: adapter });
      return mgr.compareRuns(input.runId1, input.runId2);
    }),

  getHistory: t.procedure
    .input((raw): { projectId: string; suiteName?: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId, suiteName: typeof r.suiteName === 'string' ? r.suiteName : undefined };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      const registry = pluginLoader.getRegistry(project.rootPath);
      const adapter = new PluginBackedSimulation(registry);
      const mgr = new RegressionManager({ projectRoot: project.rootPath, simulationAdapter: adapter });
      return mgr.getHistory(input.suiteName);
    }),
});
