import { initTRPC } from '@trpc/server';

const t = initTRPC.create();

export const router = t.router({
  ping: t.procedure.query(() => 'pong' as const),
  version: t.procedure.query(() => ({
    app: 'soc-verify',
    version: '0.1.0',
    stage: 'M0'
  }))
});

export type AppRouter = typeof router;
