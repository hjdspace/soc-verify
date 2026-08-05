/**
 * useBrowserShortcuts — keyboard shortcuts for Browser Surface.
 *
 * Issue #11: When a Browser Surface tab is active, the following shortcuts
 * are handled globally:
 *
 * - Ctrl+F: toggle find-in-page bar
 * - Ctrl+L: focus the address bar
 * - Ctrl+R / F5: reload the active surface
 * - Alt+Left: navigate back
 * - Alt+Right: navigate forward
 * - Ctrl+D: bookmark the current page
 * - Ctrl+W: close the active workbench tab
 *
 * Shortcuts are ignored when no browser tab is active, so they don't
 * interfere with other workbench destinations.
 */
import { useEffect } from 'react';
import { useWorkbenchStore } from '@renderer/stores/workbench';
import { useBrowserStore } from '@renderer/stores/browser';
import { useBookmarkStore } from '@renderer/stores/bookmarks';

export function useBrowserShortcuts(): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const { tabs, activeTabId } = useWorkbenchStore.getState();
      const activeTab = tabs.find((t) => t.id === activeTabId);
      if (!activeTab || activeTab.destination.type !== 'browser') return;

      const { surfaceId, url } = activeTab.destination;
      const ctrl = e.ctrlKey || e.metaKey;

      // Ctrl+F — toggle find bar
      if (ctrl && e.key === 'f') {
        e.preventDefault();
        useBrowserStore.getState().toggleFind(surfaceId);
        return;
      }

      // Ctrl+L — focus address bar
      if (ctrl && e.key === 'l') {
        e.preventDefault();
        const addressBar = document.querySelector<HTMLInputElement>('input[aria-label="地址栏"]');
        addressBar?.focus();
        addressBar?.select();
        return;
      }

      // Ctrl+R or F5 — reload
      if ((ctrl && e.key === 'r') || e.key === 'F5') {
        e.preventDefault();
        void window.surfaceBridge?.reload(surfaceId);
        return;
      }

      // Alt+Left — go back
      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        void window.surfaceBridge?.goBack(surfaceId);
        return;
      }

      // Alt+Right — go forward
      if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        void window.surfaceBridge?.goForward(surfaceId);
        return;
      }

      // Ctrl+D — bookmark current page
      if (ctrl && e.key === 'd') {
        e.preventDefault();
        if (!url) return;
        const bookmarkStore = useBookmarkStore.getState();
        const existing = bookmarkStore.bookmarks.find((b) => b.url === url);
        if (existing) {
          void bookmarkStore.toggleFrequent(existing.id);
        } else {
          const tab = useBrowserStore.getState().tabs[surfaceId];
          void bookmarkStore.addBookmark({ url, title: tab?.title || url, frequent: true });
        }
        return;
      }

      // Ctrl+W — close active tab (workbench close logic)
      if (ctrl && e.key === 'w') {
        e.preventDefault();
        useWorkbenchStore.getState().closeActive();
        return;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
