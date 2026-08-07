/**
 * Tools router — thin merger.
 *
 * Each tool's sub-router lives next to its implementation in
 * `src/main/tools/routers/<tool>-router.ts`. This file only:
 *   1. Imports all sub-routers
 *   2. Provides tool-agnostic shared procedures (open / list / dialogs)
 *   3. Merges everything into one router
 *
 * Adding a new tool: create `src/main/tools/routers/<tool>-router.ts`,
 * export a sub-router, and add one import + one line below.
 */

import { t, TRPCError } from '../router-context';
import { ALL_TOOLS, type ToolMeta } from '../../../shared/tool-types';
import { openToolWindow } from '../../tools/tool-window-manager';
import { dialog, BrowserWindow } from 'electron';

// ── Tool sub-routers (one import per tool) ──────────────────────────
import { envCheckerRouter } from '../../tools/routers/env-checker-router';
import { codeLineCounterRouter } from '../../tools/routers/code-line-counter-router';
import { findReplaceRouter } from '../../tools/routers/find-replace-router';
import { systemMonitorRouter } from '../../tools/routers/system-monitor-router';
import { logAnalyzerRouter } from '../../tools/routers/log-analyzer-router';
import { timeAnalyzerRouter } from '../../tools/routers/time-analyzer-router';
import { coverageMergerRouter } from '../../tools/routers/coverage-merger-router';
import { batchExecutionRouter } from '../../tools/routers/batch-execution-router';
import { regressionAnalyzerRouter } from '../../tools/routers/regression-analyzer-router';
import { regressionListGenRouter } from '../../tools/routers/regression-list-gen-router';
import { svIfdefCheckerRouter } from '../../tools/routers/sv-ifdef-checker-router';
import { gitQuickPullRouter } from '../../tools/routers/git-quick-pull-router';
import { registerTableParserRouter } from '../../tools/routers/register-table-parser-router';
import { reg2cRouter } from '../../tools/routers/reg2c-router';
import { gitDiffRouter } from '../../tools/routers/git-diff-router';
import { gitManagerRouter } from '../../tools/routers/git-manager-router';
import { cSvConverterRouter } from '../../tools/routers/c-sv-converter-router';

// ── Main tools router ──────────────────────────────────────────────

export const toolsRouter = t.router({
  /**
   * Open a tool window (single instance — focuses existing if open).
   * The renderer calls this when the user clicks a tool in the dropdown.
   */
  open: t.procedure
    .input((raw): { toolId: string; projectRoot?: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.toolId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'toolId is required' });
      }
      return {
        toolId: r.toolId,
        projectRoot: typeof r.projectRoot === 'string' ? r.projectRoot : undefined,
      };
    })
    .mutation(async ({ input }) => {
      const tool = ALL_TOOLS.find((t: ToolMeta) => t.id === input.toolId);
      if (!tool) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `Unknown tool: ${input.toolId}` });
      }
      openToolWindow(tool, input.projectRoot ?? null);
      return { success: true, toolId: tool.id };
    }),

  /** List all available tools (for dropdown rendering). */
  list: t.procedure
    .query(() => ({ tools: ALL_TOOLS })),

  /** Show a directory selection dialog. */
  selectDirectory: t.procedure
    .input((raw): { title?: string; defaultPath?: string } => {
      const r = raw as Record<string, unknown>;
      return {
        title: typeof r.title === 'string' ? r.title : '选择目录',
        defaultPath: typeof r.defaultPath === 'string' ? r.defaultPath : undefined,
      };
    })
    .mutation(async ({ input }) => {
      const focusedWin = BrowserWindow.getFocusedWindow();
      const result = await dialog.showOpenDialog(focusedWin ?? undefined as never, {
        title: input.title,
        defaultPath: input.defaultPath,
        properties: ['openDirectory'],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { path: null };
      }
      return { path: result.filePaths[0] };
    }),

  /** Show a file selection dialog. */
  selectFiles: t.procedure
    .input((raw): { title?: string; filters?: { name: string; extensions: string[] }[]; defaultPath?: string } => {
      const r = raw as Record<string, unknown>;
      return {
        title: typeof r.title === 'string' ? r.title : '选择文件',
        defaultPath: typeof r.defaultPath === 'string' ? r.defaultPath : undefined,
        filters: Array.isArray(r.filters) ? r.filters as { name: string; extensions: string[] }[] : undefined,
      };
    })
    .mutation(async ({ input }) => {
      const focusedWin = BrowserWindow.getFocusedWindow();
      const result = await dialog.showOpenDialog(focusedWin ?? undefined as never, {
        title: input.title,
        defaultPath: input.defaultPath,
        filters: input.filters,
        properties: ['openFile', 'multiSelections'],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { paths: [] };
      }
      return { paths: result.filePaths };
    }),

  /** Show a save file dialog. */
  saveFileDialog: t.procedure
    .input((raw): { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] } => {
      const r = raw as Record<string, unknown>;
      return {
        title: typeof r.title === 'string' ? r.title : '保存文件',
        defaultPath: typeof r.defaultPath === 'string' ? r.defaultPath : undefined,
        filters: Array.isArray(r.filters) ? r.filters as { name: string; extensions: string[] }[] : undefined,
      };
    })
    .mutation(async ({ input }) => {
      const focusedWin = BrowserWindow.getFocusedWindow();
      const result = await dialog.showSaveDialog(focusedWin ?? undefined as never, {
        title: input.title,
        defaultPath: input.defaultPath,
        filters: input.filters,
      });
      if (result.canceled || !result.filePath) {
        return { path: null };
      }
      return { path: result.filePath };
    }),

  // ── Tool sub-routers ──────────────────────────────────────────────
  envChecker: envCheckerRouter,
  codeLineCounter: codeLineCounterRouter,
  findReplace: findReplaceRouter,
  systemMonitor: systemMonitorRouter,
  logAnalyzer: logAnalyzerRouter,
  timeAnalyzer: timeAnalyzerRouter,
  coverageMerger: coverageMergerRouter,
  batchExecution: batchExecutionRouter,
  regressionAnalyzer: regressionAnalyzerRouter,
  regressionListGen: regressionListGenRouter,
  svIfdefChecker: svIfdefCheckerRouter,
  gitQuickPull: gitQuickPullRouter,
  registerTableParser: registerTableParserRouter,
  reg2c: reg2cRouter,
  gitDiff: gitDiffRouter,
  gitManager: gitManagerRouter,
  cSvConverter: cSvConverterRouter,
});
