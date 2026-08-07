/**
 * register-table-parser sub-router — parse register table files.
 *
 * Procedures: parse
 */

import { t, TRPCError } from '../../ipc/router-context';
import { parseRegisterTable } from '../register-table-parser';

export const registerTableParserRouter = t.router({
  parse: t.procedure
    .input((raw): { filePath: string; autoFix?: boolean } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.filePath !== 'string') throw new TRPCError({ code: 'BAD_REQUEST', message: 'filePath is required' });
      return { filePath: r.filePath, autoFix: typeof r.autoFix === 'boolean' ? r.autoFix : true };
    })
    .mutation(async ({ input }) => {
      return await parseRegisterTable(input.filePath, input.autoFix);
    }),
});
