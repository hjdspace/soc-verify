/**
 * Tools router — merges all tool sub-routers and provides the `open` procedure.
 *
 * Structure:
 *   tools.open               → open a tool window
 *   tools.envChecker.*       → environment checker procedures
 *   tools.codeLineCounter.*  → code line counter procedures
 *   tools.findReplace.*      → find & replace procedures
 *   tools.systemMonitor.*    → system metrics procedures
 */

import { t, TRPCError } from '../router-context';
import { ALL_TOOLS, type ToolMeta } from '../../../shared/tool-types';
import { openToolWindow } from '../../tools/tool-window-manager';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dialog, BrowserWindow, shell } from 'electron';
import { spawn } from 'node:child_process';

// ── Batch 3 tool imports ──
import { checkFiles, scanDirectory } from '../../tools/sv-ifdef-checker';
import { scanRepos, executePull, type GitQuickPullEvent } from '../../tools/git-quick-pull';
import { parseRegisterTable } from '../../tools/register-table-parser';
import { parseRegisterFile, generatePreview } from '../../tools/reg2c';
import {
  getRepoInfo,
  getTrackedFiles,
  getFileCommits,
  getFileContentAtCommit,
  getCurrentFileContent,
  calculateDiff,
} from '../../tools/git-diff';
import {
  discoverRepos as discoverGitRepos,
  getRepoTags,
  checkoutTag,
  updateAllRepos,
  updateSubsysRepos,
  refreshRepoInfo,
  updateRepoToMaster,
} from '../../tools/git-manager';
import {
  previewCToSv,
  previewSvToC,
  convertCToSv,
  convertSvToC,
  getDefaultTypeMappings,
  getDefaultFunctionMappings,
  type ConversionConfig,
} from '../../tools/c-sv-converter';

// ── Sub-router: env-checker ────────────────────────────────────────
import {
  discoverSubsystems,
  loadFilters,
  scanSubsys,
  addCheckComment,
  generateReport,
  type CheckType,
} from '../../tools/env-checker';

const envCheckerRouter = t.router({
  discoverSubsystems: t.procedure
    .input((raw): { projectRoot: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectRoot !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectRoot is required' });
      }
      return { projectRoot: r.projectRoot };
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
        results: r.results as { force: unknown[]; wait: unknown[] },
      };
    })
    .mutation(async ({ input }) => {
      const html = generateReport(input.subsys, input.results as never);
      await writeFile(input.savePath, html, 'utf-8');
      return { success: true };
    }),
});

// ── Sub-router: code-line-counter ──────────────────────────────────
import {
  countCodeLines,
  exportCsv,
  VERILOG_EXTENSIONS,
  type CountOptions,
} from '../../tools/code-line-counter';

const codeLineCounterRouter = t.router({
  getDefaultExtensions: t.procedure
    .query(() => ({ extensions: VERILOG_EXTENSIONS })),

  count: t.procedure
    .input((raw): { paths: string[]; options: CountOptions } => {
      const r = raw as Record<string, unknown>;
      if (!Array.isArray(r.paths)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'paths array is required' });
      }
      const opts = r.options as CountOptions;
      if (!opts || !Array.isArray(opts.extensions)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'options.extensions is required' });
      }
      return { paths: r.paths, options: opts };
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

// ── Sub-router: find-replace ───────────────────────────────────────
import {
  searchText,
  replaceText,
  undoLastReplace,
  canUndo,
} from '../../tools/find-replace';

const findReplaceRouter = t.router({
  search: t.procedure
    .input((raw): { directory: string; searchText: string; useRegex: boolean; extensions: string[] } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.directory !== 'string' || typeof r.searchText !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'directory and searchText are required' });
      }
      return {
        directory: r.directory,
        searchText: r.searchText,
        useRegex: typeof r.useRegex === 'boolean' ? r.useRegex : false,
        extensions: Array.isArray(r.extensions) ? r.extensions : [],
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
        useRegex: typeof r.useRegex === 'boolean' ? r.useRegex : false,
        extensions: Array.isArray(r.extensions) ? r.extensions : [],
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

// ── Sub-router: system-monitor ─────────────────────────────────────
import { getSystemMetrics, formatBytes, formatUptime } from '../../tools/system-monitor';

const systemMonitorRouter = t.router({
  getMetrics: t.procedure
    .query(async () => {
      const metrics = await getSystemMetrics();
      return {
        ...metrics,
        memoryTotalFormatted: formatBytes(metrics.memoryTotal),
        memoryUsedFormatted: formatBytes(metrics.memoryUsed),
        diskTotalFormatted: formatBytes(metrics.diskTotal),
        diskUsedFormatted: formatBytes(metrics.diskUsed),
        processMemoryFormatted: formatBytes(metrics.processMemory),
        uptimeFormatted: formatUptime(metrics.processUptime),
      };
    }),
});

// ── Sub-router: log-analyzer ──────────────────────────────────────
import {
  analyzeLogFile,
  exportReport as exportLogReport,
  type AnalysisSummary,
} from '../../tools/log-analyzer';

const logAnalyzerRouter = t.router({
  analyze: t.procedure
    .input((raw): { logPath: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.logPath !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'logPath is required' });
      }
      return { logPath: r.logPath };
    })
    .mutation(async ({ input }) => {
      const summary = await analyzeLogFile(input.logPath);
      return summary;
    }),

  exportReport: t.procedure
    .input((raw): { summary: AnalysisSummary; savePath: string; format: 'html' | 'txt' } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.savePath !== 'string' || typeof r.format !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'savePath and format are required' });
      }
      return {
        summary: r.summary as AnalysisSummary,
        savePath: r.savePath,
        format: r.format as 'html' | 'txt',
      };
    })
    .mutation(async ({ input }) => {
      await exportLogReport(input.summary, input.savePath, input.format);
      return { success: true };
    }),
});

// ── Sub-router: time-analyzer ─────────────────────────────────────
import {
  analyzeDirectory,
  exportToCsv,
  getDefaultAnalysisDir,
  type TimeUnit,
  type AnalysisResult,
} from '../../tools/time-analyzer';

const timeAnalyzerRouter = t.router({
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
        data: r.data as AnalysisResult,
        savePath: r.savePath,
        unit: (typeof r.unit === 'string' ? r.unit : 'minutes') as TimeUnit,
      };
    })
    .mutation(async ({ input }) => {
      await exportToCsv(input.data, input.savePath, input.unit);
      return { success: true };
    }),
});

// ── Sub-router: coverage-merger ───────────────────────────────────
import {
  buildMergeCommand,
  executeMergeStream,
  loadHistory as loadMergeHistory,
  saveHistory as saveMergeHistory,
  deleteHistoryItem as deleteMergeHistoryItem,
  clearHistory as clearMergeHistory,
  formatCommandText as formatMergeCommand,
  type MergeConfig,
  type CoverageMergeEvent,
} from '../../tools/coverage-merger';

const coverageMergerRouter = t.router({
  previewCommand: t.procedure
    .input((raw): { config: MergeConfig } => {
      const r = raw as Record<string, unknown>;
      return { config: r.config as MergeConfig };
    })
    .query(({ input }) => {
      return { command: buildMergeCommand(input.config) };
    }),

  execute: t.procedure
    .input((raw): { config: MergeConfig; cwd: string } => {
      const r = raw as Record<string, unknown>;
      return {
        config: r.config as MergeConfig,
        cwd: typeof r.cwd === 'string' ? r.cwd : process.cwd(),
      };
    })
    .mutation(async ({ input }) => {
      const command = buildMergeCommand(input.config);

      // Broadcast real-time log events to all windows (matches git-quick-pull pattern).
      const onEvent = (event: CoverageMergeEvent) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('coverage-merger:log', event);
          }
        }
      };

      const result = await executeMergeStream(command, input.cwd, onEvent);
      return {
        success: result.success,
        logs: result.logs,
        errorMessage: result.success ? undefined : `Process exited with non-zero code`,
      };
    }),

  loadHistory: t.procedure
    .query(async () => {
      const history = await loadMergeHistory();
      // Return both raw history and display-formatted entries for the dropdown
      const displayItems = history.map((h) => ({
        command: h.command,
        displayText: formatMergeCommand(h.command),
        timestamp: h.timestamp,
      }));
      return { history, displayItems };
    }),

  saveHistory: t.procedure
    .input((raw): { config: MergeConfig } => {
      const r = raw as Record<string, unknown>;
      return { config: r.config as MergeConfig };
    })
    .mutation(async ({ input }) => {
      await saveMergeHistory(input.config);
      const history = await loadMergeHistory();
      return { success: true, history };
    }),

  deleteHistory: t.procedure
    .input((raw): { index: number } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.index !== 'number') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'index is required' });
      }
      return { index: r.index };
    })
    .mutation(async ({ input }) => {
      const history = await deleteMergeHistoryItem(input.index);
      return { success: true, history };
    }),

  clearHistory: t.procedure
    .mutation(async () => {
      await clearMergeHistory();
      return { success: true };
    }),
});

// ── Sub-router: batch-execution ───────────────────────────────────
import {
  parseCaseFile,
  generateCommand,
  BatchExecutor,
  checkSimStatusFromLog,
  getLogPathFromCommand,
  type ExecutionTask,
} from '../../tools/batch-execution';

const batchExecutionRouter = t.router({
  parseCaseFiles: t.procedure
    .input((raw): { filePaths: string[] } => {
      const r = raw as Record<string, unknown>;
      if (!Array.isArray(r.filePaths)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'filePaths array is required' });
      }
      return { filePaths: r.filePaths };
    })
    .mutation(async ({ input }) => {
      const allCases: { name: string; block: string; base: string; cfdDef: string; file: string; path: string; command: string }[] = [];
      for (const fp of input.filePaths) {
        try {
          const cases = await parseCaseFile(fp);
          for (const c of cases) {
            allCases.push({ ...c, command: generateCommand(c) });
          }
        } catch {
          // Skip invalid files
        }
      }
      return { cases: allCases };
    }),

  execute: t.procedure
    .input((raw): { tasks: ExecutionTask[]; maxParallel: number; cwd: string } => {
      const r = raw as Record<string, unknown>;
      return {
        tasks: Array.isArray(r.tasks) ? r.tasks as ExecutionTask[] : [],
        maxParallel: typeof r.maxParallel === 'number' ? r.maxParallel : 1,
        cwd: typeof r.cwd === 'string' ? r.cwd : process.cwd(),
      };
    })
    .mutation(async ({ input }) => {
      const results: { rowIndex: number; exitCode: number; status: 'pending' | 'running' | 'success' | 'failed' | 'unknown'; startTime: string; endTime: string; log: string }[] = [];
      const logs = new Map<number, string>();

      await new Promise<void>((resolve) => {
        const executor = new BatchExecutor({
          onStart: (rowIndex, _command) => {
            logs.set(rowIndex, '');
          },
          onOutput: (rowIndex, output) => {
 const prev = logs.get(rowIndex) ?? '';
            logs.set(rowIndex, prev + output);
          },
          onFinish: (rowIndex, exitCode) => {
            const logContent = logs.get(rowIndex) ?? '';
            const task = input.tasks.find((t) => t.rowIndex === rowIndex);
            const logPath = task ? getLogPathFromCommand(task.command, task.caseName) : '';
            const simStatus = logPath ? checkSimStatusFromLog(logPath) : 'unknown' as const;
            const status = simStatus === 'success' ? 'success' as const
              : simStatus === 'failed' ? 'failed' as const
              : exitCode === 0 ? 'success' as const
              : 'failed' as const;
            results.push({
              rowIndex,
              exitCode,
              status,
              startTime: '',
              endTime: '',
              log: logContent,
            });
          },
          onAllDone: () => resolve(),
        });
        executor.setTasks(input.tasks);
        executor.setMaxParallel(input.maxParallel);
        executor.start();
      });

      return { results };
    }),
});

// ── Sub-router: regression-analyzer ──────────────────────────────
import {
  scanRegressionDir,
  parseAllTimes,
  aggregateCaseData,
  exportReport,
  type RegressionData,
} from '../../tools/regression-analyzer';

const regressionAnalyzerRouter = t.router({
  scan: t.procedure
    .input((raw): { regressionDir: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.regressionDir !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'regressionDir is required' });
      }
      return { regressionDir: r.regressionDir };
    })
    .mutation(async ({ input }) => {
      const result = await scanRegressionDir(input.regressionDir);
      return result;
    }),

  parseTimes: t.procedure
    .input((raw): { data: RegressionData } => {
      const r = raw as Record<string, unknown>;
      return { data: r.data as RegressionData };
    })
    .mutation(async ({ input }) => {
      const data = await parseAllTimes(input.data);
      return { data };
    }),

  aggregate: t.procedure
    .input((raw): { data: RegressionData; timestamp?: string } => {
      const r = raw as Record<string, unknown>;
      return {
        data: r.data as RegressionData,
        timestamp: typeof r.timestamp === 'string' ? r.timestamp : undefined,
      };
    })
    .query(({ input }) => {
      const aggregated = aggregateCaseData(input.data, input.timestamp);
      return { aggregated };
    }),

  exportReport: t.procedure
    .input((raw): { data: RegressionData; currentTimestamp: string | null; savePath: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.savePath !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'savePath is required' });
      }
      return {
        data: r.data as RegressionData,
        currentTimestamp: typeof r.currentTimestamp === 'string' ? r.currentTimestamp : null,
        savePath: r.savePath,
      };
    })
    .mutation(async ({ input }) => {
      await exportReport(input.data, input.currentTimestamp, input.savePath);
      return { success: true };
    }),
});

// ── Sub-router: regression-list-gen ───────────────────────────────
import {
  buildCommand,
  generateRegressionList,
  parseBaseBlockFromPath,
  parseCaseCfg,
  loadHistory as loadRegListHistory,
  saveHistory as saveRegListHistory,
  saveConfig as saveRegListConfig,
  type RegressionListConfig,
} from '../../tools/regression-list-gen';

const regressionListGenRouter = t.router({
  previewCommand: t.procedure
    .input((raw): { config: RegressionListConfig } => {
      const r = raw as Record<string, unknown>;
      return { config: r.config as RegressionListConfig };
    })
    .query(({ input }) => {
      return { command: buildCommand(input.config) };
    }),

  /** Infer -base and -block from a case cfg file path. */
  inferBaseBlock: t.procedure
    .input((raw): { cfgPath: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.cfgPath !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'cfgPath is required' });
      }
      return { cfgPath: r.cfgPath };
    })
    .query(({ input }) => {
      const { base, block } = parseBaseBlockFromPath(input.cfgPath);
      return { base, block };
    }),

  /** Preview parsed cases from a cfg file (without generating output). */
  previewCases: t.procedure
    .input((raw): { cfgPath: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.cfgPath !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'cfgPath is required' });
      }
      return { cfgPath: r.cfgPath };
    })
    .query(async ({ input }) => {
      const { readFile } = await import('node:fs/promises');
      const { existsSync } = await import('node:fs');
      if (!existsSync(input.cfgPath)) {
        return { cases: [], error: '配置文件不存在' };
      }
      const content = await readFile(input.cfgPath, 'utf-8');
      const cases = parseCaseCfg(content);
      return { cases, error: undefined as string | undefined };
    }),

  execute: t.procedure
    .input((raw): { config: RegressionListConfig; cwd?: string } => {
      const r = raw as Record<string, unknown>;
      return {
        config: r.config as RegressionListConfig,
        cwd: typeof r.cwd === 'string' ? r.cwd : undefined,
      };
    })
    .mutation(async ({ input }) => {
      const result = await generateRegressionList(input.config);
      return {
        success: result.success,
        logs: result.logs,
        output: result.output,
        errorMessage: result.errorMessage,
      };
    }),

  loadHistory: t.procedure
    .query(async () => {
      const data = await loadRegListHistory();
      return data;
    }),

  saveHistory: t.procedure
    .input((raw): { config: RegressionListConfig } => {
      const r = raw as Record<string, unknown>;
      return { config: r.config as RegressionListConfig };
    })
    .mutation(async ({ input }) => {
      await saveRegListHistory(input.config);
      return { success: true };
    }),

  saveConfig: t.procedure
    .input((raw): { config: RegressionListConfig } => {
      const r = raw as Record<string, unknown>;
      return { config: r.config as RegressionListConfig };
    })
    .mutation(async ({ input }) => {
      await saveRegListConfig(input.config);
      return { success: true };
    }),
});

// ── Sub-router: sv-ifdef-checker ─────────────────────────────────────

const svIfdefCheckerRouter = t.router({
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

// ── Sub-router: git-quick-pull ──────────────────────────────────────

const gitQuickPullRouter = t.router({
  scanRepos: t.procedure
    .input((raw): { projectDir: string; repoType: 'dv' | 'de' | 'all' } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectDir !== 'string') throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectDir is required' });
      return {
        projectDir: r.projectDir,
        repoType: r.repoType === 'dv' || r.repoType === 'de' ? r.repoType : 'all',
      };
    })
    .query(({ input }) => {
      const repos = scanRepos(input.projectDir, input.repoType);
      return { repos };
    }),

  executePull: t.procedure
    .input((raw): {
      repos: Array<{ name: string; path: string; repoType: 'dv' | 'de' }>;
      mode: 'pull' | 'pull_reset' | 'custom';
      customCommand: string | null;
    } => {
      const r = raw as Record<string, unknown>;
      return {
        repos: Array.isArray(r.repos) ? r.repos as Array<{ name: string; path: string; repoType: 'dv' | 'de' }> : [],
        mode: r.mode === 'pull_reset' || r.mode === 'custom' ? r.mode : 'pull',
        customCommand: typeof r.customCommand === 'string' ? r.customCommand : null,
      };
    })
    .mutation(async ({ input }) => {
      // Broadcast real-time log events to all windows (matches violation-router pattern).
      // Tool windows receive the events via the preload eventBridge.
      const onLog = (event: GitQuickPullEvent) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('git-quick-pull:log', event);
          }
        }
      };
      const result = await executePull(input.repos, input.mode, input.customCommand, onLog);
      return result;
    }),
});

// ── Sub-router: register-table-parser ───────────────────────────────

const registerTableParserRouter = t.router({
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

// ── Sub-router: reg2c ───────────────────────────────────────────────

const reg2cRouter = t.router({
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
      return { regData: r.regData as Record<string, unknown> };
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

// ── Sub-router: git-diff ────────────────────────────────────────────

const gitDiffRouter = t.router({
  openRepo: t.procedure
    .input((raw): { repoPath: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.repoPath !== 'string') throw new TRPCError({ code: 'BAD_REQUEST', message: 'repoPath is required' });
      return { repoPath: r.repoPath };
    })
    .query(({ input }) => {
      return getRepoInfo(input.repoPath);
    }),

  getTrackedFiles: t.procedure
    .input((raw): { repoPath: string } => {
      const r = raw as Record<string, unknown>;
      return { repoPath: typeof r.repoPath === 'string' ? r.repoPath : '' };
    })
    .query(({ input }) => {
      const files = getTrackedFiles(input.repoPath);
      return { files };
    }),

  getFileCommits: t.procedure
    .input((raw): { repoPath: string; filePath: string } => {
      const r = raw as Record<string, unknown>;
      return {
        repoPath: typeof r.repoPath === 'string' ? r.repoPath : '',
        filePath: typeof r.filePath === 'string' ? r.filePath : '',
      };
    })
    .query(({ input }) => {
      const commits = getFileCommits(input.repoPath, input.filePath);
      return { commits };
    }),

  calculateDiff: t.procedure
    .input((raw): { repoPath: string; filePath: string; oldCommitSha?: string; newCommitSha?: string } => {
      const r = raw as Record<string, unknown>;
      return {
        repoPath: typeof r.repoPath === 'string' ? r.repoPath : '',
        filePath: typeof r.filePath === 'string' ? r.filePath : '',
        oldCommitSha: typeof r.oldCommitSha === 'string' ? r.oldCommitSha : undefined,
        newCommitSha: typeof r.newCommitSha === 'string' ? r.newCommitSha : undefined,
      };
    })
    .mutation(async ({ input }) => {
      const oldContent = input.oldCommitSha
        ? getFileContentAtCommit(input.repoPath, input.filePath, input.oldCommitSha)
        : getCurrentFileContent(input.filePath);
      const newContent = input.newCommitSha
        ? getFileContentAtCommit(input.repoPath, input.filePath, input.newCommitSha)
        : getCurrentFileContent(input.filePath);
      return calculateDiff(oldContent, newContent);
    }),
});

// ── Sub-router: git-manager ────────────────────────────────────────

const gitManagerRouter = t.router({
  discoverRepos: t.procedure
    .input((raw): { projectDir: string; repoType: 'de' | 'dv' | 'all' } => {
      const r = raw as Record<string, unknown>;
      return {
        projectDir: typeof r.projectDir === 'string' ? r.projectDir : '',
        repoType: r.repoType === 'de' || r.repoType === 'dv' ? r.repoType : 'all',
      };
    })
    .mutation(({ input }) => {
      const repos = discoverGitRepos(input.projectDir, input.repoType);
      return { repos };
    }),

  getRepoTags: t.procedure
    .input((raw): { repo: { name: string; path: string; repoType: 'de' | 'dv' }; projectDir: string } => {
      const r = raw as Record<string, unknown>;
      const repo = r.repo as { name: string; path: string; repoType: 'de' | 'dv' };
      return {
        repo,
        projectDir: typeof r.projectDir === 'string' ? r.projectDir : '',
      };
    })
    .query(({ input }) => {
      const tags = getRepoTags(input.repo, input.projectDir);
      return { tags };
    }),

  checkoutTag: t.procedure
    .input((raw): { repo: { name: string; path: string; repoType: 'de' | 'dv' }; tag: string; projectDir: string } => {
      const r = raw as Record<string, unknown>;
      const repo = r.repo as { name: string; path: string; repoType: 'de' | 'dv' };
      return {
        repo,
        tag: typeof r.tag === 'string' ? r.tag : '',
        projectDir: typeof r.projectDir === 'string' ? r.projectDir : '',
      };
    })
    .mutation(async ({ input }) => {
      const logs = await checkoutTag(input.repo, input.tag, input.projectDir);
      return { logs };
    }),

  updateAllRepos: t.procedure
    .input((raw): { projectDir: string; repoType: 'de' | 'dv' } => {
      const r = raw as Record<string, unknown>;
      return {
        projectDir: typeof r.projectDir === 'string' ? r.projectDir : '',
        repoType: r.repoType === 'de' ? 'de' : 'dv',
      };
    })
    .mutation(async ({ input }) => {
      return await updateAllRepos(input.projectDir, input.repoType);
    }),

  updateSubsysRepos: t.procedure
    .input((raw): { projectDir: string; subsysName: string; repoType: 'de' | 'dv' } => {
      const r = raw as Record<string, unknown>;
      return {
        projectDir: typeof r.projectDir === 'string' ? r.projectDir : '',
        subsysName: typeof r.subsysName === 'string' ? r.subsysName : '',
        repoType: r.repoType === 'de' ? 'de' : 'dv',
      };
    })
    .mutation(async ({ input }) => {
      return await updateSubsysRepos(input.projectDir, input.subsysName, input.repoType);
    }),

  refreshRepoInfo: t.procedure
    .input((raw): { repo: { name: string; path: string; repoType: 'de' | 'dv' } } => {
      const r = raw as Record<string, unknown>;
      const repo = r.repo as { name: string; path: string; repoType: 'de' | 'dv' };
      return { repo };
    })
    .mutation(({ input }) => {
      const refreshed = refreshRepoInfo(input.repo);
      return { repo: refreshed };
    }),

  updateRepoToMaster: t.procedure
    .input((raw): { repo: { name: string; path: string; repoType: 'de' | 'dv' } } => {
      const r = raw as Record<string, unknown>;
      const repo = r.repo as { name: string; path: string; repoType: 'de' | 'dv' };
      return { repo };
    })
    .mutation(async ({ input }) => {
      return await updateRepoToMaster(input.repo);
    }),
});

// ── Sub-router: c-sv-converter ──────────────────────────────────────

const cSvConverterRouter = t.router({
  preview: t.procedure
    .input((raw): {
      filePaths: string[];
      config: {
        preserveComments?: boolean;
        addAutomatic?: boolean;
        coreNameDefault?: string;
        typeMappings?: Record<string, string>;
      };
    } => {
      const r = raw as Record<string, unknown>;
      return {
        filePaths: Array.isArray(r.filePaths) ? r.filePaths as string[] : [],
        config: r.config as {
          preserveComments?: boolean;
          addAutomatic?: boolean;
          coreNameDefault?: string;
          typeMappings?: Record<string, string>;
        },
      };
    })
    .mutation(async ({ input }) => {
      return await previewCToSv(input.filePaths, input.config ?? {});
    }),

  previewSvToC: t.procedure
    .input((raw): {
      filePaths: string[];
      config: {
        preserveComments?: boolean;
        addAutomatic?: boolean;
        coreNameDefault?: string;
        typeMappings?: Record<string, string>;
      };
    } => {
      const r = raw as Record<string, unknown>;
      return {
        filePaths: Array.isArray(r.filePaths) ? r.filePaths as string[] : [],
        config: r.config as {
          preserveComments?: boolean;
          addAutomatic?: boolean;
          coreNameDefault?: string;
          typeMappings?: Record<string, string>;
        },
      };
    })
    .mutation(async ({ input }) => {
      return await previewSvToC(input.filePaths, input.config ?? {});
    }),

  convert: t.procedure
    .input((raw): {
      inputFiles: string[];
      outputPath: string;
      direction: 'c-to-sv' | 'sv-to-c';
      preserveComments: boolean;
      addAutomatic: boolean;
      coreNameDefault: string;
      typeMappings: Record<string, string>;
    } => {
      const r = raw as Record<string, unknown>;
      return {
        inputFiles: Array.isArray(r.inputFiles) ? r.inputFiles as string[] : [],
        outputPath: typeof r.outputPath === 'string' ? r.outputPath : '',
        direction: r.direction === 'sv-to-c' ? 'sv-to-c' : 'c-to-sv',
        preserveComments: typeof r.preserveComments === 'boolean' ? r.preserveComments : true,
        addAutomatic: typeof r.addAutomatic === 'boolean' ? r.addAutomatic : true,
        coreNameDefault: typeof r.coreNameDefault === 'string' ? r.coreNameDefault : 'AON',
        typeMappings: (r.typeMappings && typeof r.typeMappings === 'object') ? r.typeMappings as Record<string, string> : {},
      };
    })
    .mutation(async ({ input }) => {
      const config: ConversionConfig = {
        inputFiles: input.inputFiles,
        outputPath: input.outputPath,
        direction: input.direction,
        preserveComments: input.preserveComments,
        addAutomatic: input.addAutomatic,
        coreNameDefault: input.coreNameDefault,
        typeMappings: input.typeMappings,
        functionMappings: {},
      };
      if (input.direction === 'sv-to-c') {
        return await convertSvToC(config);
      }
      return await convertCToSv(config);
    }),

  getDefaultTypeMappings: t.procedure
    .query(() => ({
      typeMappings: getDefaultTypeMappings(),
      functionMappings: getDefaultFunctionMappings(),
    })),

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

  /** Walk a directory and return files matching the given extensions. */
  scanDirectory: t.procedure
    .input((raw): { directory: string; extensions: string[] } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.directory !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'directory is required' });
      }
      return {
        directory: r.directory,
        extensions: Array.isArray(r.extensions) ? r.extensions as string[] : [],
      };
    })
    .mutation(async ({ input }) => {
      const { readdirSync, statSync } = await import('node:fs');
      const { join } = await import('node:path');
      const results: string[] = [];

      function walk(dir: string): void {
        const entries = readdirSync(dir);
        for (const entry of entries) {
          const fullPath = join(dir, entry);
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            walk(fullPath);
          } else if (input.extensions.length === 0 || input.extensions.some((ext) => entry.endsWith(ext))) {
            results.push(fullPath);
          }
        }
      }

      walk(input.directory);
      return { files: results };
    }),
});

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

  // Tool sub-routers
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

  // Batch 3 tool sub-routers
  svIfdefChecker: svIfdefCheckerRouter,
  gitQuickPull: gitQuickPullRouter,
  registerTableParser: registerTableParserRouter,
  reg2c: reg2cRouter,
  gitDiff: gitDiffRouter,
  gitManager: gitManagerRouter,
  cSvConverter: cSvConverterRouter,
});
