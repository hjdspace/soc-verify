/**
 * reg2c sub-router — register table to C driver header conversion.
 *
 * Procedures: parse · preview · export
 */

import { t, TRPCError } from '../../ipc/router-context';
import { parseRegisterFile, generatePreview } from '../reg2c';
import { cast } from './shared';
import { writeFile } from 'node:fs/promises';

export const reg2cRouter = t.router({
  parse: t.procedure
    .input((raw): { filePath: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.filePath !== 'string') throw new TRPCError({ code: 'BAD_REQUEST', message: 'filePath is required' });
      return { filePath: r.filePath };
    })
    .mutation(async ({ input }) => {
      return await parseRegisterFile(input.filePath);
    }),

  preview: t.procedure
    .input((raw): { regData: Record<string, unknown> } => {
      const r = raw as Record<string, unknown>;
      return { regData: cast<Record<string, unknown>>(r, 'regData') };
    })
    .query(({ input }) => {
      return generatePreview(input.regData as Parameters<typeof generatePreview>[0]);
    }),

  export: t.procedure
    .input((raw): { content: string; savePath: string } => {
      const r = raw as Record<string, unknown>;
      return {
        content: typeof r.content === 'string' ? r.content : '',
        savePath: typeof r.savePath === 'string' ? r.savePath : '',
      };
    })
    .mutation(async ({ input }) => {
      await writeFile(input.savePath, input.content, 'utf-8');
      return { success: true };
    }),
});
