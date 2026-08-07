/**
 * coverage-merger sub-router — merge multiple coverage databases.
 *
 * Procedures: previewCommand · execute · loadHistory · saveHistory · deleteHistory · clearHistory
 */

import { t, TRPCError } from '../../ipc/router-context';
import { BrowserWindow } from 'electron';
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
} from '../coverage-merger';
import { cast } from './shared';

export const coverageMergerRouter = t.router({
  previewCommand: t.procedure
    .input((raw): { config: MergeConfig } => {
      const r = raw as Record<string, unknown>;
      return { config: cast<MergeConfig>(r, 'config') };
    })
    .query(({ input }) => {
      return { command: buildMergeCommand(input.config) };
    }),

  execute: t.procedure
    .input((raw): { config: MergeConfig; cwd: string } => {
      const r = raw as Record<string, unknown>;
      return {
        config: cast<MergeConfig>(r, 'config'),
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
      return { config: cast<MergeConfig>(r, 'config') };
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
