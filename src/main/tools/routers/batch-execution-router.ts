/**
 * batch-execution sub-router — batch simulation case execution.
 *
 * Procedures: parseCaseFiles · execute
 */

import { t, TRPCError } from '../../ipc/router-context';
import {
  parseCaseFile,
  generateCommand,
  BatchExecutor,
  checkSimStatusFromLog,
  getLogPathFromCommand,
  type ExecutionTask,
} from '../batch-execution';
import { optArray, optNumber, optString } from './shared';

export const batchExecutionRouter = t.router({
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
        tasks: optArray<ExecutionTask>(r, 'tasks', []),
        maxParallel: optNumber(r, 'maxParallel', 1),
        cwd: optString(r, 'cwd', process.cwd()),
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
