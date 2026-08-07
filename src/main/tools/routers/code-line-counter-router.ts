/**
 * code-line-counter sub-router — Verilog/SystemVerilog code line counting.
 *
 * Procedures: getDefaultExtensions · count · exportCsv
 */

import { t, TRPCError } from '../../ipc/router-context';
import { countCodeLines, exportCsv, VERILOG_EXTENSIONS, type CountOptions } from '../code-line-counter';
import { reqArray, cast } from './shared';
import { writeFile } from 'node:fs/promises';

export const codeLineCounterRouter = t.router({
  getDefaultExtensions: t.procedure
    .query(() => ({ extensions: VERILOG_EXTENSIONS })),

  count: t.procedure
    .input((raw): { paths: string[]; options: CountOptions } => {
      const r = raw as Record<string, unknown>;
      const paths = reqArray(r, 'paths') as string[];
      const opts = cast<CountOptions>(r, 'options');
      if (!opts || !Array.isArray(opts.extensions)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'options.extensions is required' });
      }
      return { paths, options: opts };
    })
    .mutation(async ({ input }) => {
      const result = await countCodeLines(input.paths, input.options);
      return result;
    }),

  exportCsv: t.procedure
    .input((raw): { savePath: string; result: unknown } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.savePath !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'savePath is required' });
      }
      return { savePath: r.savePath, result: r.result };
    })
    .mutation(async ({ input }) => {
      const csv = exportCsv(input.result as never);
      await writeFile(input.savePath, csv, 'utf-8');
      return { success: true };
    }),
});
