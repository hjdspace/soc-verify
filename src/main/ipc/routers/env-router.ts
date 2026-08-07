/**
 * Environment configuration router — EDA tool detection and env var management.
 */

import { t, TRPCError } from '../router-context';
import { requireProject, ensurePluginsLoaded } from '../../services/project-service';
import { detectEdaTools, loadEnvConfig, saveEnvConfig, getKnownEnvVarNames } from '../../env/env-manager';
import { pluginLoader } from '../../plugins/loader';
import { caseStatsRegistry } from '../../case/case-stats-registry';
import type { EnvConfig } from '@shared/types';

export const envRouter = t.router({
  detectTools: t.procedure
    .mutation(async () => {
      const tools = await detectEdaTools();
      return { tools };
    }),

  getConfig: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      const config = await loadEnvConfig(project.rootPath);
      return config ?? { tools: [], envVars: {} };
    }),

  saveConfig: t.procedure
    .input((raw): { projectId: string; config: EnvConfig } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      const config = r.config as EnvConfig;
      if (!config || !Array.isArray(config.tools) || typeof config.envVars !== 'object') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid config structure' });
      }
      return { projectId: r.projectId, config };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      await saveEnvConfig(project.rootPath, input.config);

      // After saving env config (e.g. PROJ_RTL / PROJ_ENV), trigger a full
      // rescan so the case database is re-populated with the new env vars.
      // The plugins read PROJ_RTL / PROJ_ENV from .socverify/env.json at scan
      // time, so this picks up the newly saved values.
      //
      // We await the scan so that the frontend — which re-queries
      // getSubsystems when configuredProjRtl changes — sees the updated DB.
      // Errors during rescan are logged but do not fail the save operation.
      let scanResult: { subsysCount: number; caseCount: number } | null = null;
      try {
        await ensurePluginsLoaded(project.rootPath);
        const registry = pluginLoader.getRegistry(project.rootPath);
        if (registry.subsysDiscoverers.length > 0 && registry.caseParsers.length > 0) {
          const scanner = caseStatsRegistry.getOrCreateScanner(project.rootPath, registry);
          scanResult = await scanner.fullScan({ sync: true });
          console.log(
            `[env:saveConfig] rescan complete: ${scanResult.subsysCount} subsystems, ${scanResult.caseCount} cases`,
          );
        }
      } catch (err) {
        console.error(`[env:saveConfig] background rescan failed:`, err);
      }

      return { ok: true, scanResult };
    }),

  getKnownEnvVars: t.procedure.query(() => {
    return getKnownEnvVarNames();
  }),
});
