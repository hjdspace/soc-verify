/**
 * find-replace sub-router — text search & batch replace with undo.
 *
 * Procedures: search · replace · undo · canUndo
 */

import { t, TRPCError } from '../../ipc/router-context';
import { searchText, replaceText, undoLastReplace, canUndo } from '../find-replace';
import { optBoolean, optArray } from './shared';

export const findReplaceRouter = t.router({
  search: t.procedure
    .input((raw): { directory: string; searchText: string; useRegex: boolean; extensions: string[] } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.directory !== 'string' || typeof r.searchText !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'directory and searchText are required' });
      }
      return {
        directory: r.directory,
        searchText: r.searchText,
        useRegex: optBoolean(r, 'useRegex', false),
        extensions: optArray(r, 'extensions', []),
      };
    })
    .mutation(async ({ input }) => {
      const matches = await searchText(input.directory, input.searchText, input.useRegex, input.extensions);
      return { matches };
    }),

  replace: t.procedure
    .input((raw): { directory: string; searchText: string; replaceText: string; useRegex: boolean; extensions: string[] } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.directory !== 'string' || typeof r.searchText !== 'string' || typeof r.replaceText !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'directory, searchText and replaceText are required' });
      }
      return {
        directory: r.directory,
        searchText: r.searchText,
        replaceText: r.replaceText,
        useRegex: optBoolean(r, 'useRegex', false),
        extensions: optArray(r, 'extensions', []),
      };
    })
    .mutation(async ({ input }) => {
      const count = await replaceText(input.directory, input.searchText, input.replaceText, input.useRegex, input.extensions);
      return { count };
    }),

  undo: t.procedure
    .mutation(async () => {
      const count = await undoLastReplace();
      return { count, canUndoMore: canUndo() };
    }),

  canUndo: t.procedure
    .query(() => ({ canUndo: canUndo() })),
});
