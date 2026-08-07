/**
 * regression-list-gen sub-router — regression test case list generation.
 *
 * Procedures: previewCommand · inferBaseBlock · previewCases · execute · loadHistory · saveHistory · saveConfig
 */

import { t, TRPCError } from '../../ipc/router-context';
import {
  buildCommand,
  generateRegressionList,
  parseBaseBlockFromPath,
  parseCaseCfg,
  loadHistory as loadRegListHistory,
  saveHistory as saveRegListHistory,
  saveConfig as saveRegListConfig,
  type RegressionListConfig,
} from '../regression-list-gen';
import { cast, optStringUndef } from './shared';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

export const regressionListGenRouter = t.router({
  previewCommand: t.procedure
    .input((raw): { config: RegressionListConfig } => {
      const r = raw as Record<string, unknown>;
      return { config: cast<RegressionListConfig>(r, 'config') };
    })
    .query(({ input }) => {
      return { command: buildCommand(input.config) };
    }),

  /** Infer -base and -block from a case cfg file path. */
  inferBaseBlock: t.procedure
    .input((raw): { cfgPath: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.cfgPath !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'cfgPath is required' });
      }
      return { cfgPath: r.cfgPath };
    })
    .query(({ input }) => {
      const { base, block } = parseBaseBlockFromPath(input.cfgPath);
      return { base, block };
    }),

  /** Preview parsed cases from a cfg file (without generating output). */
  previewCases: t.procedure
    .input((raw): { cfgPath: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.cfgPath !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'cfgPath is required' });
      }
      return { cfgPath: r.cfgPath };
    })
    .query(async ({ input }) => {
      if (!existsSync(input.cfgPath)) {
        return { cases: [], error: '配置文件不存在' };
      }
      const content = await readFile(input.cfgPath, 'utf-8');
      const cases = parseCaseCfg(content);
      return { cases, error: undefined as string | undefined };
    }),

  execute: t.procedure
    .input((raw): { config: RegressionListConfig; cwd?: string } => {
      const r = raw as Record<string, unknown>;
      return {
        config: cast<RegressionListConfig>(r, 'config'),
        cwd: optStringUndef(r, 'cwd'),
      };
    })
    .mutation(async ({ input }) => {
      const result = await generateRegressionList(input.config);
      return {
        success: result.success,
        logs: result.logs,
        output: result.output,
        errorMessage: result.errorMessage,
      };
    }),

  loadHistory: t.procedure
    .query(async () => {
      const data = await loadRegListHistory();
      return data;
    }),

  saveHistory: t.procedure
    .input((raw): { config: RegressionListConfig } => {
      const r = raw as Record<string, unknown>;
      return { config: cast<RegressionListConfig>(r, 'config') };
    })
    .mutation(async ({ input }) => {
      await saveRegListHistory(input.config);
      return { success: true };
    }),

  saveConfig: t.procedure
    .input((raw): { config: RegressionListConfig } => {
      const r = raw as Record<string, unknown>;
      return { config: cast<RegressionListConfig>(r, 'config') };
    })
    .mutation(async ({ input }) => {
      await saveRegListConfig(input.config);
      return { success: true };
    }),
});
