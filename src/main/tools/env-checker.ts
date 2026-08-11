/**
 * env-checker sub-router — environment check (force/wait statement scanner).
 *
 * Procedures: resolveProjEnv · discoverSubsystems · scan · confirm ·
 *             previewFile · openFile · exportReport ·
 *             loadSuspiciousMarks · saveSuspiciousMarks
 */

import { t, TRPCError } from '../../ipc/router-context';
import {
  discoverSubsystems,
  loadFilters,
  scanSubsys,
  addCheckComment,
  generateReport,
  resolveProjEnv,
  readFileWithContext,
  loadSuspiciousMarks,
  saveSuspiciousMarks,
  loadScanCache,
  saveScanCache,
  type CheckType,
  type ScanMatch,
  type SuspiciousMarks,
} from '../env-checker';
import { reqString, cast } from './shared';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { shell } from 'electron';
import { spawn } from 'node:child_process';

export const envCheckerRouter = t.router({
  /** Resolve $PROJ_ENV from process.env or .socverify/env.json. */
  resolveProjEnv: t.procedure
    .input((raw): { projectDir: string } => {
      const r = raw as Record<string, unknown>;
      return { projectDir: reqString(r, 'projectDir') };
    })
    .query(async ({ input }) => {
      const path = resolveProjEnv(input.projectDir);
      return { path };
    }),

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

  /** Read a file with context lines around each match for preview. */
  previewFile: t.procedure
    .input((raw): { filePath: string; matches: ScanMatch[] } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.filePath !== 'string' || !Array.isArray(r.matches)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'filePath and matches are required' });
      }
      return {
        filePath: r.filePath,
        matches: r.matches as ScanMatch[],
      };
    })
    .query(async ({ input }) => {
      return readFileWithContext(input.filePath, input.matches);
    }),

  /** Open a file with gvim (or fallback editor) at an optional line number. */
  openFile: t.procedure
    .input((raw): { filePath: string; lineNumber?: number | null } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.filePath !== 'string') throw new TRPCError({ code: 'BAD_REQUEST', message: 'filePath is required' });
      return {
        filePath: r.filePath,
        lineNumber: typeof r.lineNumber === 'number' && r.lineNumber > 0 ? r.lineNumber : null,
      };
    })
    .mutation(async ({ input }) => {
      if (!existsSync(input.filePath)) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `文件不存在: ${input.filePath}` });
      }

      const isWindows = process.platform === 'win32';
      const lineArg = input.lineNumber ? `+${input.lineNumber}` : null;

      // Editor candidates in priority order (matching the Python implementation).
      const editorCmds: string[][] = [];
      if (lineArg) {
        editorCmds.push(['gvim', lineArg, input.filePath]);
        if (isWindows) {
          editorCmds.push(['vim', lineArg, input.filePath]);
          editorCmds.push(['notepad++', `-n${input.lineNumber}`, input.filePath]);
        } else {
          editorCmds.push(['vim', lineArg, input.filePath]);
          editorCmds.push(['gedit', lineArg, input.filePath]);
          editorCmds.push(['nano', lineArg, input.filePath]);
        }
      } else {
        editorCmds.push(['gvim', input.filePath]);
        if (isWindows) {
          editorCmds.push(['vim', input.filePath]);
          editorCmds.push(['notepad++', input.filePath]);
          editorCmds.push(['notepad', input.filePath]);
        } else {
          editorCmds.push(['vim', input.filePath]);
          editorCmds.push(['gedit', input.filePath]);
          editorCmds.push(['nano', input.filePath]);
        }
      }

      // Try each editor in order.
      for (const cmd of editorCmds) {
        try {
          const child = spawn(cmd[0], cmd.slice(1), {
            detached: true,
            stdio: 'ignore',
            windowsHide: false,
          });
          child.unref();
          // Wait briefly: if the command doesn't exist, spawn emits 'error' quickly.
          let hadError = false;
          await new Promise<void>((resolve) => {
            child.on('error', () => { hadError = true; resolve(); });
            setTimeout(() => resolve(), 300);
          });
          if (!hadError) {
            return { success: true, editor: cmd[0] };
          }
        } catch {
          // Try next editor.
        }
      }

      // Fallback: use system default program.
      const err = await shell.openPath(input.filePath);
      if (err) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `无法打开文件: ${err}` });
      }
      return { success: true, editor: 'system-default' };
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

  /** Load suspicious marks from the persistence file. */
  loadSuspiciousMarks: t.procedure
    .query(async () => {
      return loadSuspiciousMarks();
    }),

  /** Save suspicious marks to the persistence file. */
  saveSuspiciousMarks: t.procedure
    .input((raw): { marks: SuspiciousMarks } => {
      const r = raw as Record<string, unknown>;
      const marks = r.marks as Record<string, unknown>;
      if (!marks || !Array.isArray(marks.force) || !Array.isArray(marks.wait)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'marks with force[] and wait[] arrays are required' });
      }
      return { marks: { force: marks.force as string[], wait: marks.wait as string[] } };
    })
    .mutation(async ({ input }) => {
      await saveSuspiciousMarks(input.marks);
      return { success: true };
    }),

  /** Load cached scan results for a subsystem. */
  loadScanCache: t.procedure
    .input((raw): { projectRoot: string; subsys: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectRoot !== 'string' || typeof r.subsys !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectRoot and subsys are required' });
      }
      return { projectRoot: r.projectRoot, subsys: r.subsys };
    })
    .query(async ({ input }) => {
      const cached = await loadScanCache(input.projectRoot, input.subsys);
      return { cached };
    }),

  /** Save scan results to the cache for a subsystem. */
  saveScanCache: t.procedure
    .input((raw): { projectRoot: string; subsys: string; results: unknown } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectRoot !== 'string' || typeof r.subsys !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectRoot and subsys are required' });
      }
      return {
        projectRoot: r.projectRoot,
        subsys: r.subsys,
        results: cast<{ force: unknown[]; wait: unknown[] }>(r, 'results'),
      };
    })
    .mutation(async ({ input }) => {
      await saveScanCache(input.projectRoot, input.subsys, input.results as never);
      return { success: true };
    }),
});
