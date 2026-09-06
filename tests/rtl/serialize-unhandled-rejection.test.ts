/**
 * Regression test: serialize() must not cause unhandledRejection when the
 * serialized operation rejects.
 *
 * Bug: `void next.finally(...)` in serialize() creates a derived promise that
 * inherits the rejection from `next`. Since this derived promise is never
 * `.catch()`-ed, it becomes an unhandledRejection → triggers the global error
 * handler → shows a transparent red banner at the top of the window with a ✕
 * button that overlaps the desktop window close button.
 *
 * The root cause chain:
 *   1. User clicks "检测顶层" → detectTops() calls serialize()
 *   2. serialize() wraps the operation; `void next.finally(cleanup)` creates
 *      a derived rejected promise that nobody catches
 *   3. Node.js fires `unhandledRejection` → global-error-handler sends it to renderer
 *   4. ErrorBoundary shows the global error banner (fixed top-0, bg-destructive/10)
 *
 * Fix: `.finally()` must be followed by `.catch(() => undefined)` to swallow
 * the derived rejection (the cleanup callback itself never throws).
 */

import { describe, it, expect } from 'vitest';

describe('serialize() unhandled rejection regression', () => {
  it('buggy version (void next.finally) DOES produce unhandledRejection — proof of root cause', async () => {
    const unhandledRejections: unknown[] = [];
    const handler = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    const inflight = new Map<string, Promise<unknown>>();

    function serializeBuggy<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
      const prev = inflight.get(projectId) ?? Promise.resolve();
      const next = prev.catch(() => undefined).then(fn);
      inflight.set(projectId, next);
      void next.finally(() => {
        if (inflight.get(projectId) === next) inflight.delete(projectId);
      });
      return next;
    }

    process.on('unhandledRejection', handler);
    try {
      await expect(
        serializeBuggy('proj-1', async () => {
          throw new Error('yosys 退出码 1');
        }),
      ).rejects.toThrow('yosys 退出码 1');

      await new Promise((r) => setTimeout(r, 50));
      expect(unhandledRejections.length).toBeGreaterThanOrEqual(1);
    } finally {
      process.off('unhandledRejection', handler);
    }
  });

  it('fixed serialize() does NOT produce unhandledRejection when operation rejects', async () => {
    const unhandledRejections: unknown[] = [];
    const handler = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    const inflight = new Map<string, Promise<unknown>>();

    function serialize<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
      const prev = inflight.get(projectId) ?? Promise.resolve();
      const next = prev.catch(() => undefined).then(fn);
      inflight.set(projectId, next);
      next
        .finally(() => {
          if (inflight.get(projectId) === next) inflight.delete(projectId);
        })
        .catch(() => undefined);
      return next;
    }

    process.on('unhandledRejection', handler);
    try {
      await expect(
        serialize('proj-1', async () => {
          throw new Error('yosys 退出码 1');
        }),
      ).rejects.toThrow('yosys 退出码 1');

      await new Promise((r) => setTimeout(r, 50));
      expect(unhandledRejections).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', handler);
    }
  });

  it('fixed serialize() with successful operation produces no unhandledRejection', async () => {
    const unhandledRejections: unknown[] = [];
    const handler = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    const inflight = new Map<string, Promise<unknown>>();

    function serialize<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
      const prev = inflight.get(projectId) ?? Promise.resolve();
      const next = prev.catch(() => undefined).then(fn);
      inflight.set(projectId, next);
      next
        .finally(() => {
          if (inflight.get(projectId) === next) inflight.delete(projectId);
        })
        .catch(() => undefined);
      return next;
    }

    process.on('unhandledRejection', handler);
    try {
      const result = await serialize('proj-1', async () => 42);
      expect(result).toBe(42);

      await new Promise((r) => setTimeout(r, 50));
      expect(unhandledRejections).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', handler);
    }
  });
});
