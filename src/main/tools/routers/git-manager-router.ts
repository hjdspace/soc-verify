/**
 * git-manager sub-router — git repository management (tags, checkout, update).
 *
 * Procedures: discoverRepos · discoverReposCached · discoverReposParallel
 * · refreshRepoInfoAsync · getRepoTags · checkoutTag
 * · updateAllRepos · updateSubsysRepos · updateRepoToMaster
 *
 * Caching strategy (ported from Python cache_manager.py):
 *   1. discoverReposCached: loads from cache file (instant, non-blocking)
 *   2. discoverRepos: load cache → return immediately → background refresh outdated repos via IPC
 *   3. discoverReposParallel: full parallel scan (for "refresh all" button)
 */

import { BrowserWindow } from 'electron';
import { t } from '../../ipc/router-context';
import {
  discoverReposParallel,
  refreshRepoInfoAsync,
  getRepoTags,
  checkoutTag,
  updateAllRepos,
  updateSubsysRepos,
  updateRepoToMaster,
  type GitRepoInfo,
} from '../git-manager';
import {
  loadCache,
  saveCache,
  getOutdatedRepoPaths,
  hasDirectoryStructureChanged,
  updateSingleRepoCache,
} from '../git-manager-cache';
import { cast, optString } from './shared';

type GitRepo = { name: string; path: string; repoType: 'de' | 'dv' };

/** Broadcast a git-manager event to all renderer windows. */
function broadcastGitManagerEvent(event: GitManagerEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('git-manager:event', event);
    }
  }
}

type GitManagerEvent =
  | { type: 'progress'; completed: number; total: number; repoName: string }
  | { type: 'repoRefreshed'; repo: GitRepoInfo }
  | { type: 'scanComplete'; total: number; fromCache: boolean }
  | { type: 'error'; message: string };

export const gitManagerRouter = t.router({
  /**
   * Load repos from cache (instant). Returns null if no cache exists.
   * The renderer calls this first on mount; if null, falls back to
   * discoverRepos which does a full parallel scan.
   */
  discoverReposCached: t.procedure
    .input((raw): { projectDir: string } => {
      const r = raw as Record<string, unknown>;
      return { projectDir: optString(r, 'projectDir', '') };
    })
    .query(({ input }) => {
      const cached = loadCache(input.projectDir);
      if (!cached) return { repos: null, cacheAge: null };

      const deCount = cached.filter((r) => r.repoType === 'de').length;
      const dvCount = cached.filter((r) => r.repoType === 'dv').length;
      const dirChanged = hasDirectoryStructureChanged(input.projectDir);
      const outdatedPaths = getOutdatedRepoPaths(input.projectDir);

      return {
        repos: cached,
        cacheAge: null as number | null,
        deCount,
        dvCount,
        dirChanged,
        outdatedCount: outdatedPaths.length,
      };
    }),

  /**
   * Smart discover: load from cache → return immediately → background
   * refresh outdated repos via IPC events.
   * If no cache: full parallel scan with progress events.
   */
  discoverRepos: t.procedure
    .input((raw): { projectDir: string; repoType: 'de' | 'dv' | 'all' } => {
      const r = raw as Record<string, unknown>;
      return {
        projectDir: optString(r, 'projectDir', ''),
        repoType: r.repoType === 'de' || r.repoType === 'dv' ? r.repoType : 'all',
      };
    })
    .mutation(async ({ input }): Promise<{ repos: GitRepoInfo[]; fromCache: boolean }> => {
      const { projectDir, repoType } = input;

      // Try cache first
      const cached = loadCache(projectDir);
      if (cached && cached.length > 0) {
        const dirChanged = hasDirectoryStructureChanged(projectDir);
        const outdatedPaths = getOutdatedRepoPaths(projectDir);

        if (!dirChanged && outdatedPaths.length === 0) {
          // Cache is fully up-to-date
          broadcastGitManagerEvent({
            type: 'scanComplete',
            total: cached.length,
            fromCache: true,
          });
          return { repos: cached, fromCache: true };
        }

        // Return cached data immediately, then background-refresh outdated repos
        broadcastGitManagerEvent({
          type: 'scanComplete',
          total: cached.length,
          fromCache: true,
        });

        // Start background refresh (non-blocking, fire-and-forget)
        void backgroundRefreshOutdated(projectDir, outdatedPaths, cached);

        return { repos: cached, fromCache: true };
      }

      // No cache — full parallel scan with progress events
      const repos = await discoverReposParallel(
        projectDir,
        repoType,
        (completed, total, repoName) => {
          broadcastGitManagerEvent({ type: 'progress', completed, total, repoName });
        },
      );

      // Save to cache
      saveCache(projectDir, repos);

      broadcastGitManagerEvent({
        type: 'scanComplete',
        total: repos.length,
        fromCache: false,
      });

      return { repos, fromCache: false };
    }),

  /**
   * Full parallel scan (for the "refresh all" button).
   * Always does a fresh scan, bypassing cache for reading but saving
   * the new results to cache.
   */
  discoverReposParallel: t.procedure
    .input((raw): { projectDir: string; repoType: 'de' | 'dv' | 'all' } => {
      const r = raw as Record<string, unknown>;
      return {
        projectDir: optString(r, 'projectDir', ''),
        repoType: r.repoType === 'de' || r.repoType === 'dv' ? r.repoType : 'all',
      };
    })
    .mutation(async ({ input }) => {
      const repos = await discoverReposParallel(
        input.projectDir,
        input.repoType,
        (completed, total, repoName) => {
          broadcastGitManagerEvent({ type: 'progress', completed, total, repoName });
        },
      );

      saveCache(input.projectDir, repos);

      broadcastGitManagerEvent({
        type: 'scanComplete',
        total: repos.length,
        fromCache: false,
      });

      return { repos };
    }),

  getRepoTags: t.procedure
    .input((raw): { repo: GitRepo; projectDir: string } => {
      const r = raw as Record<string, unknown>;
      const repo = cast<GitRepo>(r, 'repo');
      return {
        repo,
        projectDir: optString(r, 'projectDir', ''),
      };
    })
    .query(({ input }) => {
      const tags = getRepoTags(input.repo, input.projectDir);
      return { tags };
    }),

  checkoutTag: t.procedure
    .input((raw): { repo: GitRepo; tag: string; projectDir: string } => {
      const r = raw as Record<string, unknown>;
      const repo = cast<GitRepo>(r, 'repo');
      return {
        repo,
        tag: optString(r, 'tag', ''),
        projectDir: optString(r, 'projectDir', ''),
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
        projectDir: optString(r, 'projectDir', ''),
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
        projectDir: optString(r, 'projectDir', ''),
        subsysName: optString(r, 'subsysName', ''),
        repoType: r.repoType === 'de' ? 'de' : 'dv',
      };
    })
    .mutation(async ({ input }) => {
      return await updateSubsysRepos(input.projectDir, input.subsysName, input.repoType);
    }),

  /**
   * Refresh a single repo's info (async, non-blocking).
   * Also updates the cache entry.
   */
  refreshRepoInfo: t.procedure
    .input((raw): { repo: GitRepo; projectDir?: string } => {
      const r = raw as Record<string, unknown>;
      const repo = cast<GitRepo>(r, 'repo');
      return {
        repo,
        projectDir: optString(r, 'projectDir', ''),
      };
    })
    .mutation(async ({ input }) => {
      const refreshed = await refreshRepoInfoAsync(input.repo);

      // Update cache if projectDir is provided
      if (input.projectDir) {
        updateSingleRepoCache(input.projectDir, input.repo.path, refreshed);
      }

      return { repo: refreshed };
    }),

  updateRepoToMaster: t.procedure
    .input((raw): { repo: GitRepo; projectDir?: string } => {
      const r = raw as Record<string, unknown>;
      const repo = cast<GitRepo>(r, 'repo');
      return {
        repo,
        projectDir: optString(r, 'projectDir', ''),
      };
    })
    .mutation(async ({ input }) => {
      const result = await updateRepoToMaster(input.repo);

      // After update, refresh repo info in cache
      if (input.projectDir) {
        const refreshed = await refreshRepoInfoAsync(input.repo);
        updateSingleRepoCache(input.projectDir, input.repo.path, refreshed);
      }

      return result;
    }),
});

// ── Background refresh helper ──────────────────────────────────────

/**
 * Background refresh of outdated repos. Non-blocking: runs after
 * the mutation returns, pushing individual repo updates via IPC.
 */
async function backgroundRefreshOutdated(
  projectDir: string,
  outdatedPaths: string[],
  cachedRepos: GitRepoInfo[],
): Promise<void> {
  const outdatedRepos = cachedRepos.filter((r) => outdatedPaths.includes(r.path));
  const total = outdatedRepos.length;
  let completed = 0;

  const CONCURRENCY = 8;
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < total) {
      const i = nextIndex++;
      const repo = outdatedRepos[i];
      try {
        const refreshed = await refreshRepoInfoAsync({
          name: repo.name,
          path: repo.path,
          repoType: repo.repoType,
        });

        // Update cache
        updateSingleRepoCache(projectDir, repo.path, refreshed);

        // Push to renderer
        broadcastGitManagerEvent({ type: 'repoRefreshed', repo: refreshed });
      } catch {
        // Non-fatal — leave stale data
      }
      completed++;
      broadcastGitManagerEvent({
        type: 'progress',
        completed,
        total,
        repoName: repo.name,
      });
    }
  }

  const workers = Array.from(
    { length: Math.min(CONCURRENCY, total) },
    () => worker(),
  );
  await Promise.all(workers);
}
