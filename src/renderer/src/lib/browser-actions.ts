/**
 * browser-actions — unified browser URL opening seam.
 *
 * Issue #11: Business callers (regression, CQP, plugins) must not directly
 * operate the View Manager or workbench store. Instead they call openInBrowser(url),
 * which normalizes the URL, checks for an existing tab, and opens or activates
 * a Browser Surface tab.
 *
 * Chat markdown, help, and settings links continue using the system browser
 * via trpc.system.openExternal.
 */
import { normalizeUrl, useBrowserStore } from '@renderer/stores/browser';
import { useWorkbenchStore } from '@renderer/stores/workbench';

/**
 * Open a URL in the Browser Surface.
 *
 * - Normalizes the input (prepends https:// if missing scheme, strips trailing slash on root).
 * - If a browser tab already has this URL, activates that tab instead of creating a new one.
 * - If no existing tab matches, creates a new browser destination.
 * - Non-http(s) URLs are silently rejected.
 */
export function openInBrowser(input: string): void {
  const normalized = normalizeUrl(input);
  if (!normalized) return;

  // Check if a tab already has this URL — activate it instead of duplicating
  const existing = useBrowserStore.getState().findByUrl(normalized);
  if (existing) {
    useWorkbenchStore.getState().activate(`browser:${existing.surfaceId}`);
    return;
  }

  // No existing tab — open a new browser destination
  const surfaceId = `browser-${crypto.randomUUID()}`;
  useWorkbenchStore.getState().open({
    type: 'browser',
    surfaceId,
    url: normalized,
    title: normalized,
  });
}
