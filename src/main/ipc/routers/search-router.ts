/**
 * Global search router — search across simulation history and regression suites.
 */

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { t, TRPCError } from '../router-context';
import { requireProject } from '../../services/project-service';
import { loadEnvConfig } from '../../env/env-manager';
import { discoverRegressions } from '../../regression/regression-discovery';
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

      // Search regression lists
      try {
        const envConfig = await loadEnvConfig(project.rootPath);
        const projEnv = envConfig?.envVars?.PROJ_ENV;
        if (projEnv) {
          const discoveries = await discoverRegressions(project.rootPath, projEnv);
          for (const { subsys, items } of discoveries) {
            for (const item of items) {
              const fileName = item.filePath.split(/[/\\]/).pop() ?? item.filePath;
              if (fileName.includes(input.query) || subsys.includes(input.query)) {
                results.push({
                  type: 'regression',
                  label: fileName,
                  detail: `${subsys} · ${item.type}`,
                });
              }
            }
          }
        }
      } catch {
        // No regression data
      }

      return results;
    }),
});
