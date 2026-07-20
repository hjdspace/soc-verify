/**
 * Shared renderer utilities for tRPC error handling and toast access.
 *
 * Extracted from individual stores to eliminate boilerplate duplication
 * (previously `tRPCError()` was defined identically in session.ts,
 * simulation.ts, and project.ts; `getToast()` was duplicated in project.ts).
 */

import { useToastStore, type ToastState } from '../stores/toast';

/**
 * Convert an unknown tRPC error value into a human-readable string.
 *
 * Handles Error instances, objects with a `message` property, and
 * primitives by falling back to `String()`.
 */
export function tRPCError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as Record<string, unknown>).message);
  }
  return String(err);
}

/**
 * Get the current toast store state — a convenience wrapper that keeps
 * call sites concise and centralises the import path.
 */
export function getToast(): ToastState {
  return useToastStore.getState();
}
