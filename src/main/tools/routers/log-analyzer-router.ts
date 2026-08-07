/**
 * log-analyzer sub-router — EDA simulation log analysis.
 *
 * Procedures: analyze · exportReport
 */

import { t, TRPCError } from '../../ipc/router-context';
import { analyzeLogFile, exportReport as exportLogReport, type AnalysisSummary } from '../log-analyzer';
import { cast } from './shared';

export const logAnalyzerRouter = t.router({
  analyze: t.procedure
    .input((raw): { logPath: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.logPath !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'logPath is required' });
      }
      return { logPath: r.logPath };
    })
    .mutation(async ({ input }) => {
      const summary = await analyzeLogFile(input.logPath);
      return summary;
    }),

  exportReport: t.procedure
    .input((raw): { summary: AnalysisSummary; savePath: string; format: 'html' | 'txt' } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.savePath !== 'string' || typeof r.format !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'savePath and format are required' });
      }
      return {
        summary: cast<AnalysisSummary>(r, 'summary'),
        savePath: r.savePath,
        format: r.format as 'html' | 'txt',
      };
    })
    .mutation(async ({ input }) => {
      await exportLogReport(input.summary, input.savePath, input.format);
      return { success: true };
    }),
});
