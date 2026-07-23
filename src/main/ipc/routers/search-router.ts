/**
 * Global search router — search across simulation history and regression suites.
 */

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { t, TRPCError } from '../router-context';
import { requireProject } from '../../services/project-service';
import { pluginLoader } from '../../plugins/loader';
import { PluginBackedSimulation } from '../../plugin-adapters';
import { RegressionManager } from '../../regression/regression-manager';
import type { SimulationHistoryEntry } from '@shared/types';

export const searchRouter = t.router({
  global: t.procedure
    .input((raw): { projectId: string; query: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.query !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and query are required' });
      }
      return { projectId: r.projectId, query: r.query };
    })
    .query(async ({ input }) => {
      // Search in simulation history
      const project = requireProject(input.projectId);
      const results: Array<{ type: string; label: string; detail: string }> = [];

      // Search sim history
      try {
        const simHistoryPath = join(project.rootPath, '.socverify', 'sim-history.json');
        const data = await readFile(simHistoryPath, 'utf-8');
        const history = JSON.parse(data) as SimulationHistoryEntry[];
        for (const h of history) {
          if (h.caseName.includes(input.query) || h.caseId.includes(input.query)) {
            results.push({
              type: 'simulation',
              label: h.caseName,
              detail: `${h.status} · ${new Date(h.startTime).toLocaleString()}`,
            });
          }
        }
      } catch {
        // No history
      }

      // Search regression suites
      try {
        const registry = pluginLoader.getRegistry(project.rootPath);
        const simAdapter = new PluginBackedSimulation(registry);
        const regMgr = new RegressionManager({ projectRoot: project.rootPath, simulationAdapter: simAdapter });
        const suites = await regMgr.listSuites();
        for (const s of suites) {
          if (s.name.includes(input.query)) {
            results.push({
              type: 'regression',
              label: s.name,
              detail: `${s.caseIds.length} cases`,
            });
          }
        }
      } catch {
        // No suites
      }

      return results;
    }),
});
