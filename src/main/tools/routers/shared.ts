/**
 * Shared input-validation helpers for tool sub-routers.
 *
 * Each tool sub-router uses inline validators (no zod) to stay lightweight.
 * These helpers eliminate the repetitive `raw as Record<string, unknown>`
 * + `typeof` boilerplate that appears in every procedure.
 */

import { TRPCError } from '../../ipc/router-context';

// ── String helpers ──────────────────────────────────────────────────

/** Assert that `raw[key]` is a string; throw BAD_REQUEST if not. */
export function reqString(raw: Record<string, unknown>, key: string): string {
  if (typeof raw[key] !== 'string') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `${key} is required` });
  }
  return raw[key] as string;
}

/** Return `raw[key]` as a string, or `def` when absent / wrong type. */
export function optString(raw: Record<string, unknown>, key: string, def: string): string {
  return typeof raw[key] === 'string' ? (raw[key] as string) : def;
}

/** Return `raw[key]` as a string, or `undefined` when absent / wrong type. */
export function optStringUndef(raw: Record<string, unknown>, key: string): string | undefined {
  return typeof raw[key] === 'string' ? (raw[key] as string) : undefined;
}

// ── Array helpers ───────────────────────────────────────────────────

/** Assert that `raw[key]` is an array; throw BAD_REQUEST if not. */
export function reqArray(raw: Record<string, unknown>, key: string): unknown[] {
  if (!Array.isArray(raw[key])) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `${key} array is required` });
  }
  return raw[key] as unknown[];
}

/** Return `raw[key]` as an array, or `def` when absent / wrong type. */
export function optArray<T>(raw: Record<string, unknown>, key: string, def: T[]): T[] {
  return Array.isArray(raw[key]) ? (raw[key] as T[]) : def;
}

// ── Scalar helpers ──────────────────────────────────────────────────

/** Return `raw[key]` as a boolean, or `def` when absent / wrong type. */
export function optBoolean(raw: Record<string, unknown>, key: string, def: boolean): boolean {
  return typeof raw[key] === 'boolean' ? (raw[key] as boolean) : def;
}

/** Return `raw[key]` as a number, or `def` when absent / wrong type. */
export function optNumber(raw: Record<string, unknown>, key: string, def: number): number {
  return typeof raw[key] === 'number' ? (raw[key] as number) : def;
}

// ── Cast helper ─────────────────────────────────────────────────────

/**
 * Cast `raw[key]` to type `T` without runtime validation.
 * Use when the type is too complex for a simple runtime check
 * (e.g. `MergeConfig`, `AnalysisResult`) and the renderer is trusted.
 */
export function cast<T>(raw: Record<string, unknown>, key: string): T {
  return raw[key] as T;
}

/** Cast `raw` itself to type `T` (for whole-input casts). */
export function castInput<T>(raw: unknown): T {
  return raw as T;
}
