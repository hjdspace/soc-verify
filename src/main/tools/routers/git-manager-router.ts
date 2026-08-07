/**
 * git-manager sub-router — git repository management (tags, checkout, update).
 *
 * Procedures: discoverRepos · getRepoTags · checkoutTag · updateAllRepos · updateSubsysRepos · refreshRepoInfo · updateRepoToMaster
 */

import { t } from '../../ipc/router-context';
import {
  discoverRepos as discoverGitRepos,
  getRepoTags,
  checkoutTag,
  updateAllRepos,
  updateSubsysRepos,
  refreshRepoInfo,
  updateRepoToMaster,
} from '../git-manager';
import { cast, optString } from './shared';

type GitRepo = { name: string; path: string; repoType: 'de' | 'dv' };

export const gitManagerRouter = t.router({
  discoverRepos: t.procedure
    .input((raw): { projectDir: string; repoType: 'de' | 'dv' | 'all' } => {
      const r = raw as Record<string, unknown>;
      return {
        projectDir: optString(r, 'projectDir', ''),
        repoType: r.repoType === 'de' || r.repoType === 'dv' ? r.repoType : 'all',
      };
    })
    .mutation(({ input }) => {
      const repos = discoverGitRepos(input.projectDir, input.repoType);
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

  refreshRepoInfo: t.procedure
    .input((raw): { repo: GitRepo } => {
      const r = raw as Record<string, unknown>;
      const repo = cast<GitRepo>(r, 'repo');
      return { repo };
    })
    .mutation(({ input }) => {
      const refreshed = refreshRepoInfo(input.repo);
      return { repo: refreshed };
    }),

  updateRepoToMaster: t.procedure
    .input((raw): { repo: GitRepo } => {
      const r = raw as Record<string, unknown>;
      const repo = cast<GitRepo>(r, 'repo');
      return { repo };
    })
    .mutation(async ({ input }) => {
      return await updateRepoToMaster(input.repo);
    }),
});
