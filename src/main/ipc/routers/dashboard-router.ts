/**
 * Dashboard router — aggregate metrics, layout persistence.
 */

import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { t, TRPCError, requireProject } from '../router-context';
import { pluginLoader } from '../../plugins/loader';
import { PluginBackedCoverage, PluginBackedSimulation } from '../../host/plugin-discovery';
import { CoverageManager } from '../../coverage/coverage-manager';
import { RegressionManager } from '../../regression/regression-manager';
import type { SimulationHistoryEntry, CoverageSummary } from '@shared/types';

export const dashboardRouter = t.router({
  getMetrics: t.procedure
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

      // Aggregate metrics from simulation history and coverage
      const simHistoryPath = join(project.rootPath, '.socverify', 'sim-history.json');
      let totalRuns = 0;
      let passRate = 0;
      try {
        const data = await readFile(simHistoryPath, 'utf-8');
        const history = JSON.parse(data) as SimulationHistoryEntry[];
        totalRuns = history.length;
        const passed = history.filter((h) => h.status === 'pass').length;
        passRate = totalRuns > 0 ? (passed / totalRuns) * 100 : 0;
      } catch {
        // No history yet
      }

      // Coverage overview
      let coverageOverview: CoverageSummary | null = null;
      try {
        const covAdapter = new PluginBackedCoverage(project.rootPath, registry);
        const covMgr = new CoverageManager({ projectRoot: project.rootPath, coverageAdapter: covAdapter });
        coverageOverview = (await covMgr.getOverview()).summary;
      } catch {
        // No coverage data
      }

      // Regression history
      let regressionCount = 0;
      try {
        const simAdapter = new PluginBackedSimulation(registry);
        const regMgr = new RegressionManager({ projectRoot: project.rootPath, simulationAdapter: simAdapter });
        const history = await regMgr.getHistory();
        regressionCount = history.length;
      } catch {
        // No regression data
      }

      return {
        passRate,
        totalRuns,
        coverage: coverageOverview,
        regressionCount,
      };
    }),

  saveLayout: t.procedure
    .input((raw): { projectId: string; layout: unknown } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId, layout: r.layout };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      const layoutPath = join(project.rootPath, '.socverify', 'dashboard-layout.json');
      await mkdir(join(project.rootPath, '.socverify'), { recursive: true });
      await writeFile(layoutPath, JSON.stringify(input.layout, null, 2), 'utf-8');
      return { ok: true };
    }),

  getLayout: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      const layoutPath = join(project.rootPath, '.socverify', 'dashboard-layout.json');
      try {
        const data = await readFile(layoutPath, 'utf-8');
        return JSON.parse(data);
      } catch {
        return null;
      }
    }),
});
