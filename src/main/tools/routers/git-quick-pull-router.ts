/**
 * git-quick-pull sub-router — batch git pull across multiple repos.
 *
 * Procedures: scanRepos · executePull
 */

import { t, TRPCError } from '../../ipc/router-context';
import { BrowserWindow } from 'electron';
import { scanRepos, executePull, type GitQuickPullEvent } from '../git-quick-pull';

export const gitQuickPullRouter = t.router({
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
