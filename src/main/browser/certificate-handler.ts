/**
 * certificate-handler — certificate error state management for Browser Surfaces.
 *
 * Issue #9: 证书错误默认阻止并显示风险信息。
 *            用户只能对当前访问单次继续，不写入永久信任。
 *
 * Policy:
 *   1. Certificate errors are denied by default.
 *   2. The renderer can call `allowProceed(surfaceId, url)` to let the user
 *      single-continue for a specific URL on a specific surface.
 *   3. The proceed is consumed after one use (single-continue).
 *   4. No permanent trust is written to the session or OS certificate store.
 */

/** Key: `${surfaceId}::${url}` — proceed is scoped to both surface and URL. */
type ProceedKey = string;

function proceedKey(surfaceId: string, url: string): ProceedKey {
  return `${surfaceId}::${url}`;
}

/**
 * Tracks single-use certificate proceed decisions per surface+URL.
 *
 * Thread-safety: Electron main process is single-threaded for JS execution,
 * so no locking is needed.
 */
export class CertificateErrorTracker {
  private readonly proceeding = new Set<ProceedKey>();

  /** Allow a single proceed for the given surface+URL. */
  allowProceed(surfaceId: string, url: string): void {
    this.proceeding.add(proceedKey(surfaceId, url));
  }

  /**
   * Check whether a proceed has been granted for the given surface+URL.
   * Does NOT consume the proceed — call `consumeProceed` after using it.
   */
  shouldProceed(surfaceId: string, url: string): boolean {
    return this.proceeding.has(proceedKey(surfaceId, url));
  }

  /** Consume (remove) a single-use proceed after it has been used. */
  consumeProceed(surfaceId: string, url: string): void {
    this.proceeding.delete(proceedKey(surfaceId, url));
  }

  /** Clear all proceed states (for cleanup). */
  clearAll(): void {
    this.proceeding.clear();
  }
}
