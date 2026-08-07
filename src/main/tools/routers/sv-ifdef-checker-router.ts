/**
 * sv-ifdef-checker sub-router — SystemVerilog ifdef conditional compilation checker.
 *
 * Procedures: check · openFile
 */

import { t, TRPCError } from '../../ipc/router-context';
import { checkFiles, scanDirectory } from '../sv-ifdef-checker';
import { existsSync } from 'node:fs';
import { shell } from 'electron';
import { spawn } from 'node:child_process';

export const svIfdefCheckerRouter = t.router({
  check: t.procedure
    .input((raw): { inputPath: string; mode: 'directory' | 'file'; recursive: boolean; includeSvi: boolean } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.inputPath !== 'string') throw new TRPCError({ code: 'BAD_REQUEST', message: 'inputPath is required' });
      return {
        inputPath: r.inputPath,
        mode: r.mode === 'file' ? 'file' : 'directory',
        recursive: r.recursive !== false,
        includeSvi: r.includeSvi !== false,
      };
    })
    .mutation(async ({ input }) => {
      let files: string[] = [];
      if (input.mode === 'directory') {
        const exts = input.includeSvi ? ['.sv', '.svi'] : ['.sv'];
        files = scanDirectory(input.inputPath, { extensions: exts, recursive: input.recursive });
      } else {
        files = [input.inputPath];
      }
      const { results, summary } = await checkFiles(files);
      return { results, summary };
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
});
