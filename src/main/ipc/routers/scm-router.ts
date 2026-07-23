/**
 * SCM (Source Control Management) router — git status, stage/unstage, discard, commit, AI commit message.
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

  stage: t.procedure
    .input((raw): { projectId: string; filePaths: string[] } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return {
        projectId: r.projectId,
        filePaths: Array.isArray(r.filePaths) ? r.filePaths.filter((f): f is string => typeof f === 'string') : [],
      };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      try {
        await sourceControlService.stageFiles(project.rootPath, input.filePaths);
        return sourceControlService.getStatus(project.rootPath);
      } catch (err) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),

  unstage: t.procedure
    .input((raw): { projectId: string; filePaths: string[] } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return {
        projectId: r.projectId,
        filePaths: Array.isArray(r.filePaths) ? r.filePaths.filter((f): f is string => typeof f === 'string') : [],
      };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      try {
        await sourceControlService.unstageFiles(project.rootPath, input.filePaths);
        return sourceControlService.getStatus(project.rootPath);
      } catch (err) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),

  discard: t.procedure
    .input((raw): { projectId: string; filePaths: string[] } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return {
        projectId: r.projectId,
        filePaths: Array.isArray(r.filePaths) ? r.filePaths.filter((f): f is string => typeof f === 'string') : [],
      };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      try {
        await sourceControlService.discardChanges(project.rootPath, input.filePaths);
        return sourceControlService.getStatus(project.rootPath);
      } catch (err) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),

  generateCommitMessage: t.procedure
    .input((raw): { projectId: string; modelId?: string; providerId?: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return {
        projectId: r.projectId,
        modelId: typeof r.modelId === 'string' ? r.modelId : undefined,
        providerId: typeof r.providerId === 'string' ? r.providerId : undefined,
      };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      // Resolve the credential by providerId when available so the model ID
      // matches the API key / base URL of the correct provider.
      const credential = input.providerId
        ? await credentialManager.get(input.providerId)
        : await credentialManager.getDefaultCredential();
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

  commit: t.procedure
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
        return await sourceControlService.commit(project.rootPath, input.message);
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
