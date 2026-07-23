/**
 * Shared tRPC builder.
 *
 * This module owns only the tRPC builder instance (`t`) and re-exports
 * `TRPCError` for convenience. Domain helpers live in src/main/services/ —
 * import directly from there.
 */

import { initTRPC, TRPCError } from '@trpc/server';

export { TRPCError };
export const t = initTRPC.create();
