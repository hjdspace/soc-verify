/**
 * Barrel re-export of all shared domain types.
 *
 * This module provides backward compatibility for `import ... from '@shared/types'`
 * after splitting the monolithic types.ts into per-domain files. Each domain
 * file owns the types for exactly one concern.
 */

export * from './project';
export * from './source-control';
export * from './plugin-config';
export * from './simulation';
export * from './coverage';
export * from './regression';
export * from './to-checklist';
export * from './background-task';
export * from './env';
export * from './credential';
export * from './error-analysis';
export * from './diff-review';
