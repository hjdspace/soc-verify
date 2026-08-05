/**
 * System router — ping, version, agent runtime resolution, and system browser.
 */

import { shell } from 'electron';
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
  openExternal: t.procedure
    .input((raw): string => {
      if (typeof raw !== 'string') throw new Error('URL must be a string');
      return raw;
    })
    .mutation(async ({ input: url }) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error('Invalid URL');
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Only http/https URLs can be opened in the system browser');
      }
      await shell.openExternal(url);
      return { success: true };
    }),
});
