import { createTRPCProxyClient, type TRPCLink } from '@trpc/client';
import { ipcLink as originalIpcLink } from 'electron-trpc/renderer';
import type { AppRouter } from '@main/ipc/router';

/**
 * electron-trpc 0.7.1 was built for @trpc/client v10, where the client runtime
 * always has a `transformer` object with `serialize` / `deserialize` methods.
 * In @trpc/client v11, this property no longer exists on the runtime by default.
 *
 * This wrapper patches the runtime to include a passthrough transformer when
 * one is not already present, restoring v10-compatible behaviour for ipcLink.
 */
const passthroughTransformer = {
  serialize: (data: unknown) => data,
  deserialize: (data: unknown) => data,
};

function patchedIpcLink(): TRPCLink<AppRouter> {
  const link = originalIpcLink() as unknown as (runtime: Record<string, unknown>) => unknown;
  return ((runtime: Record<string, unknown>) => {
    const patchedRuntime = {
      ...runtime,
      transformer: (runtime as { transformer?: unknown }).transformer ?? passthroughTransformer,
    };
    return link(patchedRuntime);
  }) as unknown as TRPCLink<AppRouter>;
}

export const trpc = createTRPCProxyClient<AppRouter>({
  links: [patchedIpcLink()],
});
