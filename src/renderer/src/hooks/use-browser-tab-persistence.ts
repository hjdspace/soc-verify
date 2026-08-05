/**
 * useBrowserTabPersistence — restores browser tabs on app startup and
 * auto-saves them (debounced) when the browser store changes.
 *
 * Issue #7: Global browser tab persistence.
 *
 * - On mount: queries `browser.getTabs` and restores each tab as a
 *   workbench browser destination + browser store entry.
 * - On browser store change: debounces (500ms) and calls `browser.saveTabs`.
 * - On `before-quit` event: flushes synchronously via `browser.flushTabs`.
 *
 * Browser tabs are independent of project state — switching/closing projects
 * does not close browser tabs.
 */
import { useEffect, useRef } from 'react';
import { trpc } from '@renderer/lib/trpc';
import { useBrowserStore } from '@renderer/stores/browser';
import { useWorkbenchStore } from '@renderer/stores/workbench';
import type { PersistedBrowserTabs } from '@shared/browser-types';

const SAVE_DEBOUNCE_MS = 500;

export function useBrowserTabPersistence(): void {
  const restoreAttempted = useRef(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const restoreFromPersisted = useBrowserStore((s) => s.restoreFromPersisted);
  const serializeForPersistence = useBrowserStore((s) => s.serializeForPersistence);
  const openDestination = useWorkbenchStore((s) => s.open);
  const tabs = useBrowserStore((s) => s.tabs);
  const order = useBrowserStore((s) => s.order);

  // ── Restore on startup ──────────────────────────────────────
  useEffect(() => {
    if (restoreAttempted.current) return;
    restoreAttempted.current = true;

    let cancelled = false;

    void (async () => {
      try {
        const persisted = await trpc.browser.getTabs.query();
        if (cancelled || !persisted.tabs.length) return;

        // Restore browser store state
        restoreFromPersisted(persisted as PersistedBrowserTabs);

        // Open workbench destinations for each restored tab
        for (const tab of persisted.tabs) {
          openDestination({
            type: 'browser',
            surfaceId: tab.surfaceId,
            url: tab.url,
            title: tab.title,
          });
        }

        // Activate the last active tab if it exists
        if (persisted.activeTabId) {
          useWorkbenchStore.getState().activate(`browser:${persisted.activeTabId}`);
        }
      } catch {
        // Best-effort restore — if it fails, user just starts with no tabs
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [restoreFromPersisted, openDestination]);

  // ── Debounced auto-save on store changes ────────────────────
  useEffect(() => {
    if (!restoreAttempted.current) return; // Don't save before restore attempt

    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }

    debounceTimer.current = setTimeout(() => {
      const data = serializeForPersistence();
      void trpc.browser.saveTabs.mutate({
        tabs: data.tabs,
        activeTabId: data.activeTabId,
      }).catch(() => {
        // Best-effort save
      });
    }, SAVE_DEBOUNCE_MS);

    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, [tabs, order, serializeForPersistence]);

  // ── Flush on beforeunload ───────────────────────────────────
  useEffect(() => {
    const handleBeforeUnload = () => {
      const data = serializeForPersistence();
      // Use flushTabs for synchronous write during shutdown
      void trpc.browser.flushTabs.mutate({
        tabs: data.tabs,
        activeTabId: data.activeTabId,
      }).catch(() => {
        // Best-effort flush
      });
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [serializeForPersistence]);
}
