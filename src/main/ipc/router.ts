import { initTRPC, TRPCError } from '@trpc/server';
import { sessionManager } from '../omp/session-manager';
import { resolveOmpRuntime, resolveBunPath, resolveOmpEntryPath } from '../omp/paths';

const t = initTRPC.create();

function requireSession(sessionId: string) {
  const client = sessionManager.getClient(sessionId);
  if (!client) {
    throw new TRPCError({ code: 'NOT_FOUND', message: `Session not found: ${sessionId}` });
  }
  return client;
}

export const router = t.router({
  ping: t.procedure.query(() => 'pong' as const),

  version: t.procedure.query(() => ({
    app: 'soc-verify',
    version: '0.1.0',
    stage: 'M1' as const,
  })),

  // ─── 系统 ─────────────────────────────────────────────

  system: t.router({
    resolveOmp: t.procedure.query(() => {
      const runtime = resolveOmpRuntime();
      return {
        available: runtime !== null,
        bunPath: resolveBunPath(),
        ompEntryPath: resolveOmpEntryPath(),
      };
    }),
  }),

  // ─── 会话管理 ─────────────────────────────────────────

  session: t.router({
    create: t.procedure
      .input((raw): { projectId: string; cwd: string; provider?: string; model?: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.projectId !== 'string' || typeof r.cwd !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and cwd are required' });
        }
        return {
          projectId: r.projectId,
          cwd: r.cwd,
          provider: typeof r.provider === 'string' ? r.provider : undefined,
          model: typeof r.model === 'string' ? r.model : undefined,
        };
      })
      .mutation(async ({ input }) => {
        const sessionId = await sessionManager.createSession({
          projectId: input.projectId,
          cwd: input.cwd,
          provider: input.provider,
          model: input.model,
        });
        return { sessionId };
      }),

    send: t.procedure
      .input((raw): { sessionId: string; message: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.sessionId !== 'string' || typeof r.message !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'sessionId and message are required' });
        }
        return { sessionId: r.sessionId, message: r.message };
      })
      .mutation(async ({ input }) => {
        const client = requireSession(input.sessionId);
        sessionManager.touchActivity(input.sessionId);
        await client.prompt(input.message);
        return { ok: true };
      }),

    abort: t.procedure
      .input((raw): { sessionId: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.sessionId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'sessionId is required' });
        }
        return { sessionId: r.sessionId };
      })
      .mutation(async ({ input }) => {
        const client = requireSession(input.sessionId);
        await client.abort();
        return { ok: true };
      }),

    destroy: t.procedure
      .input((raw): { sessionId: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.sessionId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'sessionId is required' });
        }
        return { sessionId: r.sessionId };
      })
      .mutation(async ({ input }) => {
        await sessionManager.destroySession(input.sessionId);
        return { ok: true };
      }),

    list: t.procedure.query(() => {
      return sessionManager.listSessions();
    }),

    getState: t.procedure
      .input((raw): { sessionId: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.sessionId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'sessionId is required' });
        }
        return { sessionId: r.sessionId };
      })
      .query(async ({ input }) => {
        const client = requireSession(input.sessionId);
        return client.getState();
      }),

    getMessages: t.procedure
      .input((raw): { sessionId: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.sessionId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'sessionId is required' });
        }
        return { sessionId: r.sessionId };
      })
      .query(async ({ input }) => {
        const client = requireSession(input.sessionId);
        return client.getMessages();
      }),

    setModel: t.procedure
      .input((raw): { sessionId: string; provider: string; modelId: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.sessionId !== 'string' || typeof r.provider !== 'string' || typeof r.modelId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'sessionId, provider and modelId are required' });
        }
        return { sessionId: r.sessionId, provider: r.provider, modelId: r.modelId };
      })
      .mutation(async ({ input }) => {
        await sessionManager.setModel(input.sessionId, input.provider, input.modelId);
        return { ok: true };
      }),

    getAvailableModels: t.procedure
      .input((raw): { sessionId: string } => {
        const r = raw as Record<string, unknown>;
        if (typeof r.sessionId !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'sessionId is required' });
        }
        return { sessionId: r.sessionId };
      })
      .query(async ({ input }) => {
        return sessionManager.getAvailableModels(input.sessionId);
      }),
  }),
});

export type AppRouter = typeof router;
