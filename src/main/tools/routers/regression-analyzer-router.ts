/**
 * regression-analyzer sub-router — regression test result parsing & reporting.
 *
 * Procedures: scan · parseTimes · aggregate · exportReport
 */

import { t, TRPCError } from '../../ipc/router-context';
import {
  scanRegressionDir,
  parseAllTimes,
  aggregateCaseData,
  exportReport,
  type RegressionData,
} from '../regression-analyzer';
import { cast, optStringUndef } from './shared';

export const regressionAnalyzerRouter = t.router({
  scan: t.procedure
    .input((raw): { regressionDir: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.regressionDir !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'regressionDir is required' });
      }
      return { regressionDir: r.regressionDir };
    })
    .mutation(async ({ input }) => {
      const result = await scanRegressionDir(input.regressionDir);
      return result;
    }),

  parseTimes: t.procedure
    .input((raw): { data: RegressionData } => {
      const r = raw as Record<string, unknown>;
      return { data: cast<RegressionData>(r, 'data') };
    })
    .mutation(async ({ input }) => {
      const data = await parseAllTimes(input.data);
      return { data };
    }),

  aggregate: t.procedure
    .input((raw): { data: RegressionData; timestamp?: string } => {
      const r = raw as Record<string, unknown>;
      return {
        data: cast<RegressionData>(r, 'data'),
        timestamp: optStringUndef(r, 'timestamp'),
      };
    })
    .query(({ input }) => {
      const aggregated = aggregateCaseData(input.data, input.timestamp);
      return { aggregated };
    }),

  exportReport: t.procedure
    .input((raw): { data: RegressionData; currentTimestamp: string | null; savePath: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.savePath !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'savePath is required' });
      }
      return {
        data: cast<RegressionData>(r, 'data'),
        currentTimestamp: typeof r.currentTimestamp === 'string' ? r.currentTimestamp : null,
        savePath: r.savePath,
      };
    })
    .mutation(async ({ input }) => {
      await exportReport(input.data, input.currentTimestamp, input.savePath);
      return { success: true };
    }),
});
