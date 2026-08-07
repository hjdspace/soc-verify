/**
 * env-checker sub-router — environment check (force/wait statement scanner).
 *
 * Procedures: discoverSubsystems · scan · confirm · exportReport
 */

import { t, TRPCError } from '../../ipc/router-context';
import {
  discoverSubsystems,
  loadFilters,
  scanSubsys,
  addCheckComment,
  generateReport,
  type CheckType,
} from '../env-checker';
import { reqString, cast } from './shared';
import { writeFile } from 'node:fs/promises';

export const envCheckerRouter = t.router({
  discoverSubsystems: t.procedure
    .input((raw): { projectRoot: string } => {
      const r = raw as Record<string, unknown>;
      return { projectRoot: reqString(r, 'projectRoot') };
    })
    .query(async ({ input }) => {
      const subsystems = await discoverSubsystems(input.projectRoot);
      return { subsystems: subsystems.map((s) => s.name) };
    }),

  scan: t.procedure
    .input((raw): { projectRoot: string; subsys: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectRoot !== 'string' || typeof r.subsys !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectRoot and subsys are required' });
      }
      return { projectRoot: r.projectRoot, subsys: r.subsys };
    })
    .mutation(async ({ input }) => {
      const filters = await loadFilters(input.projectRoot, input.subsys);
      const results = await scanSubsys(input.projectRoot, input.subsys, filters);
      return results;
    }),

  confirm: t.procedure
    .input((raw): { filePath: string; checkType: CheckType; comment?: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.filePath !== 'string' || typeof r.checkType !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'filePath and checkType are required' });
      }
      return {
        filePath: r.filePath,
        checkType: r.checkType as CheckType,
        comment: typeof r.comment === 'string' ? r.comment : '',
      };
    })
    .mutation(async ({ input }) => {
      const success = await addCheckComment(input.filePath, input.checkType, input.comment);
      return { success };
    }),

  exportReport: t.procedure
    .input((raw): { savePath: string; subsys: string; results: unknown } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.savePath !== 'string' || typeof r.subsys !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'savePath and subsys are required' });
      }
      return {
        savePath: r.savePath,
        subsys: r.subsys,
        results: cast<{ force: unknown[]; wait: unknown[] }>(r, 'results'),
      };
    })
    .mutation(async ({ input }) => {
      const html = generateReport(input.subsys, input.results as never);
      await writeFile(input.savePath, html, 'utf-8');
      return { success: true };
    }),
});
