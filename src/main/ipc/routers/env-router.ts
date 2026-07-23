/**
 * Environment configuration router — EDA tool detection and env var management.
 */

import { t, TRPCError } from '../router-context';
import { requireProject } from '../../services/project-service';
import { detectEdaTools, loadEnvConfig, saveEnvConfig, getKnownEnvVarNames } from '../../env/env-manager';
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
      return { ok: true };
    }),

  getKnownEnvVars: t.procedure.query(() => {
    return getKnownEnvVarNames();
  }),
});
