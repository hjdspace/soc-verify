/**
 * Shared tRPC builder and backward-compatible re-exports.
 *
 * Previously this file was a kitchen-sink of validation helpers, factory
 * methods, and file I/O utilities. Those have been extracted into focused
 * domain services under src/main/services/. This module now only owns the
 * tRPC builder instance (`t`) and re-exports the service helpers so that
 * existing `import { ... } from '../router-context'` calls continue to work.
 *
 * New code should import directly from the relevant service module:
 *   import { requireProject } from '@main/services/project-service';
 *   import { requireSession } from '@main/services/session-service';
 *   import { getSimulationManager } from '@main/services/simulation-service';
 */

import { initTRPC, TRPCError } from '@trpc/server';

export { TRPCError };
export const t = initTRPC.create();

// ─── Backward-compatible re-exports from domain services ──────────
export { requireProject, ensurePluginsLoaded } from '../services/project-service';
export {
  requireSession,
  storedMessagesPath,
  loadStoredMessages,
  isPlaceholderSessionName,
  filterEmptyPlaceholderSessions,
} from '../services/session-service';
export { getSimulationManager } from '../services/simulation-service';
