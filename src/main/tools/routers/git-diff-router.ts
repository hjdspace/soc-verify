/**
 * git-diff sub-router — git file version comparison.
 *
 * Procedures: openRepo · getTrackedFiles · getFileCommits · calculateDiff
 */

import { t, TRPCError } from '../../ipc/router-context';
import {
  getRepoInfo,
  getTrackedFiles,
  getFileCommits,
  getFileContentAtCommit,
  getCurrentFileContent,
  calculateDiff,
} from '../git-diff';
import { optString, optStringUndef } from './shared';

export const gitDiffRouter = t.router({
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
      return { repoPath: optString(r, 'repoPath', '') };
    })
    .query(({ input }) => {
      const files = getTrackedFiles(input.repoPath);
      return { files };
    }),

  getFileCommits: t.procedure
    .input((raw): { repoPath: string; filePath: string } => {
      const r = raw as Record<string, unknown>;
      return {
        repoPath: optString(r, 'repoPath', ''),
        filePath: optString(r, 'filePath', ''),
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
        repoPath: optString(r, 'repoPath', ''),
        filePath: optString(r, 'filePath', ''),
        oldCommitSha: optStringUndef(r, 'oldCommitSha'),
        newCommitSha: optStringUndef(r, 'newCommitSha'),
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
