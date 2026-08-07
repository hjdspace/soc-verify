/**
 * time-analyzer sub-router — simulation time consumption analysis.
 *
 * Procedures: getDefaultDir · analyze · exportCsv
 */

import { t, TRPCError } from '../../ipc/router-context';
import { analyzeDirectory, exportToCsv, getDefaultAnalysisDir, type TimeUnit, type AnalysisResult } from '../time-analyzer';
import { cast } from './shared';

export const timeAnalyzerRouter = t.router({
  /** Return the default analysis directory ($PROJ_WORK or cwd). */
  getDefaultDir: t.procedure
    .query(() => {
      return { dir: getDefaultAnalysisDir() };
    }),

  analyze: t.procedure
    .input((raw): { analysisDir: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.analysisDir !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'analysisDir is required' });
      }
      return { analysisDir: r.analysisDir };
    })
    .mutation(async ({ input }) => {
      const result = await analyzeDirectory(input.analysisDir);
      return result;
    }),

  exportCsv: t.procedure
    .input((raw): { data: AnalysisResult; savePath: string; unit: TimeUnit } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.savePath !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'savePath is required' });
      }
      return {
        data: cast<AnalysisResult>(r, 'data'),
        savePath: r.savePath,
        unit: (typeof r.unit === 'string' ? r.unit : 'minutes') as TimeUnit,
      };
    })
    .mutation(async ({ input }) => {
      await exportToCsv(input.data, input.savePath, input.unit);
      return { success: true };
    }),
});
