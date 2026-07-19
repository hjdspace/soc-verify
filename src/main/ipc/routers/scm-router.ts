/**
 * SCM (Source Control Management) router — git status, commit, AI commit message.
 */

import { t, TRPCError, requireProject } from '../router-context';
import { sourceControlService } from '../../scm/source-control';
import { credentialManager } from '../../credentials/credential-manager';

export const scmRouter = t.router({
  status: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      return sourceControlService.getStatus(project.rootPath);
    }),

  generateCommitMessage: t.procedure
    .input((raw): { projectId: string; modelId?: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return {
        projectId: r.projectId,
        modelId: typeof r.modelId === 'string' ? r.modelId : undefined,
      };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      const credential = await credentialManager.getDefaultCredential();
      if (!credential) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'No AI credential configured. Add one in Settings first.',
        });
      }
      try {
        const message = await sourceControlService.generateCommitMessage(project.rootPath, credential, input.modelId);
        return { message };
      } catch (err) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),

  commitAll: t.procedure
    .input((raw): { projectId: string; message: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.message !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and message are required' });
      }
      return { projectId: r.projectId, message: r.message };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      try {
        return await sourceControlService.commitAll(project.rootPath, input.message);
      } catch (err) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),
});
