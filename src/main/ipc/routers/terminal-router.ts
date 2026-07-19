/**
 * Terminal router — PTY session lifecycle (create, write, resize, destroy, list).
 */

import { t, TRPCError } from '../router-context';
import { terminalManager } from '../../terminal/terminal-manager';
import { projectManager } from '../../project/project-manager';

export const terminalRouter = t.router({
  create: t.procedure
    .input((raw): { projectId?: string; cwd?: string; cols?: number; rows?: number } => {
      const r = raw as Record<string, unknown>;
      return {
        projectId: typeof r.projectId === 'string' ? r.projectId : undefined,
        cwd: typeof r.cwd === 'string' ? r.cwd : undefined,
        cols: typeof r.cols === 'number' ? r.cols : undefined,
        rows: typeof r.rows === 'number' ? r.rows : undefined,
      };
    })
    .mutation(async ({ input }) => {
      let cwd = input.cwd;
      if (!cwd && input.projectId) {
        const project = projectManager.getProject(input.projectId);
        cwd = project?.rootPath;
      }
      const session = await terminalManager.create({
        cwd,
        cols: input.cols,
        rows: input.rows,
      });
      return session;
    }),

  write: t.procedure
    .input((raw): { terminalId: string; data: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.terminalId !== 'string' || typeof r.data !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'terminalId and data are required' });
      }
      return { terminalId: r.terminalId, data: r.data };
    })
    .mutation(async ({ input }) => {
      terminalManager.write(input.terminalId, input.data);
      return { ok: true };
    }),

  resize: t.procedure
    .input((raw): { terminalId: string; cols: number; rows: number } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.terminalId !== 'string' || typeof r.cols !== 'number' || typeof r.rows !== 'number') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'terminalId, cols and rows are required' });
      }
      return { terminalId: r.terminalId, cols: r.cols, rows: r.rows };
    })
    .mutation(async ({ input }) => {
      terminalManager.resize(input.terminalId, input.cols, input.rows);
      return { ok: true };
    }),

  destroy: t.procedure
    .input((raw): { terminalId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.terminalId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'terminalId is required' });
      }
      return { terminalId: r.terminalId };
    })
    .mutation(async ({ input }) => {
      terminalManager.destroy(input.terminalId);
      return { ok: true };
    }),

  list: t.procedure.query(() => {
    return terminalManager.list();
  }),

  /**
   * Get the buffered output for a terminal session.
   * Used by TerminalView to restore output when the component is remounted
   * (e.g., switching tabs and switching back).
   */
  getOutputBuffer: t.procedure
    .input((raw): { terminalId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.terminalId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'terminalId is required' });
      }
      return { terminalId: r.terminalId };
    })
    .query(({ input }) => {
      return terminalManager.getOutputBuffer(input.terminalId);
    }),
});
