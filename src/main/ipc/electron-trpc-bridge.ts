/**
 * Custom IPC handler bridging electron-trpc's renderer client with tRPC v11 server.
 *
 * electron-trpc 0.7.1 was built for tRPC v10. Three breaking changes in v11
 * prevent it from working:
 *
 * 1. `procedure._def[type]` → v11 uses `procedure._def.type` (a string, not a fn)
 * 2. Calling a procedure directly (`procedure(opts)`) → throws "client-only function"
 * 3. `router.getErrorShape()` → removed in v11; use standalone `getErrorShape()`
 *
 * This handler:
 * - Listens on the same `"electron-trpc"` IPC channel (compatible with `exposeElectronTRPC` + `ipcLink`)
 * - Calls procedures via `procedure._def.resolver()` (v11 internal API)
 * - Formats responses/errors with `transformTRPCResponse` + `getErrorShape` (v11 exports)
 */

import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron';
import {
  getErrorShape,
  getTRPCErrorFromUnknown,
  transformTRPCResponse,
  TRPCError,
  type AnyRouter,
} from '@trpc/server';

const CHANNEL = 'electron-trpc';

interface IpcRequestMessage {
  method: 'request' | 'subscription.stop';
  operation?: {
    type: 'query' | 'mutation' | 'subscription';
    path: string;
    input?: unknown;
    id: number | string;
  };
  id?: number | string;
}

export function createIPCHandler<TRouter extends AnyRouter>({
  router,
  createContext,
  windows = [],
}: {
  router: TRouter;
  createContext?: (opts: { event: IpcMainEvent }) => Promise<Record<string, unknown>> | Record<string, unknown>;
  windows?: BrowserWindow[];
}): void {
  const config = router._def._config;
  const procedures = router._def.procedures;

  async function handleMessage(
    event: IpcMainEvent,
    message: IpcRequestMessage,
  ): Promise<void> {
    // Handle subscription stop (no-op for now; subscriptions are placeholder)
    if (message.method === 'subscription.stop') {
      return;
    }

    const operation = message.operation;
    if (!operation) return;

    const { type, path, input: rawInput, id } = operation;

    // Deserialize input using the router's transformer
    const input = rawInput !== undefined
      ? config.transformer.input.deserialize(rawInput)
      : undefined;

    // Create context
    const ctx = (await createContext?.({ event })) ?? {};

    // Send helper
    const send = (payload: Record<string, unknown>) => {
      if (!event.sender.isDestroyed()) {
        event.reply(CHANNEL, transformTRPCResponse(config, payload as never));
      }
    };

    try {
      // Look up the procedure
      const procedure = procedures[path];
      if (!procedure || procedure._def.type !== type) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `No "${type}"-procedure on path "${path}"`,
        });
      }

      // Call the procedure's resolver (v11 internal API)
      const result = await procedure._def.resolver({
        ctx,
        path,
        input,
        type,
      });

      send({ id, result: { type: 'data', data: result } });
    } catch (cause) {
      const error = getTRPCErrorFromUnknown(cause);
      const errorShape = getErrorShape({
        error,
        type,
        path,
        input,
        ctx,
        config,
      });
      send({ id, error: errorShape });
    }
  }

  // Register the IPC listener
  ipcMain.on(CHANNEL, (event, message: IpcRequestMessage) => {
    handleMessage(event, message).catch((err) => {
      console.error('[electron-trpc-bridge] Unhandled error:', err);
    });
  });

  // Attach windows (for API compatibility with electron-trpc)
  for (const win of windows) {
    // Windows are automatically handled since we use event.reply()
    // This is just for API compatibility
    void win;
  }
}
