/**
 * System router — ping, version, and agent runtime resolution.
 */

import { t } from '../router-context';
import { resolveAgentRuntime, resolveRunnerBinary, resolveRunnerScript, resolveBunPath } from '../../agent/paths';

export const pingProcedure = t.procedure.query(() => 'pong' as const);

export const versionProcedure = t.procedure.query(() => ({
  app: 'soc-verify',
  version: '0.2.0',
  stage: 'M2' as const,
}));

export const systemRouter = t.router({
  resolveAgent: t.procedure.query(() => {
    const runtime = resolveAgentRuntime();
    return {
      available: runtime !== null,
      mode: runtime?.mode ?? null,
      runnerBinaryPath: resolveRunnerBinary(),
      runnerScriptPath: resolveRunnerScript(),
      bunPath: resolveBunPath(),
      runnerPath: runtime?.runnerPath ?? null,
      bunVersion: runtime?.bunVersion ?? null,
      bunVersionOk: runtime?.bunVersionOk ?? false,
    };
  }),
});
