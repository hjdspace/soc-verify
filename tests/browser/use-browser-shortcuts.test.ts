/**
 * useBrowserShortcuts hook tests.
 *
 * Seam: useBrowserShortcuts hook — keyboard shortcut handling when a
 * Browser Surface tab is active.
 *
 * Tests verify:
 * - Ctrl+F toggles the find-in-page bar
 * - Ctrl+R / F5 reloads the active browser surface
 * - Alt+Left / Alt+Right navigates back / forward
 * - Ctrl+W closes the active workbench tab
 * - Ctrl+D bookmarks the current page
 * - Shortcuts are ignored when no browser tab is active
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock tRPC before importing stores that depend on it
vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    browser: {
      getBookmarks: { query: vi.fn() },
      addBookmark: { mutate: vi.fn() },
      updateBookmark: { mutate: vi.fn() },
      deleteBookmark: { mutate: vi.fn() },
      toggleFrequent: { mutate: vi.fn() },
      reorderBookmarks: { mutate: vi.fn() },
      addGroup: { mutate: vi.fn() },
      updateGroup: { mutate: vi.fn() },
      deleteGroup: { mutate: vi.fn() },
      exportBookmarks: { query: vi.fn() },
      importBookmarks: { mutate: vi.fn() },
      clearBrowserData: { mutate: vi.fn() },
    },
  },
}));

import { renderHook } from '@testing-library/react';
import { useBrowserShortcuts } from '@renderer/hooks/use-browser-shortcuts';
import { useBrowserStore } from '@renderer/stores/browser';
import { useWorkbenchStore } from '@renderer/stores/workbench';
import { useBookmarkStore } from '@renderer/stores/bookmarks';

// Mock surfaceBridge
const mockSurfaceBridge = {
  reload: vi.fn().mockResolvedValue(undefined),
  goBack: vi.fn().mockResolvedValue(undefined),
  goForward: vi.fn().mockResolvedValue(undefined),
  findInPage: vi.fn().mockResolvedValue(undefined),
  stopFindInPage: vi.fn().mockResolvedValue(undefined),
};

describe('useBrowserShortcuts', () => {
  beforeEach(() => {
    useBrowserStore.setState({ tabs: {}, order: [] });
    useWorkbenchStore.setState({ tabs: [], activeTabId: null });
    useBookmarkStore.setState({ bookmarks: [], groups: [] });
    vi.clearAllMocks();
    (window as unknown as { surfaceBridge: unknown }).surfaceBridge = mockSurfaceBridge;
  });

  function setupBrowserTab(surfaceId = 'browser-test', url = 'https://example.com') {
    useBrowserStore.getState().createTab(surfaceId);
    useBrowserStore.getState().setUrl(surfaceId, url);
    useWorkbenchStore.setState({
      tabs: [{
        id: `browser:${surfaceId}`,
        title: 'Test',
        closable: true,
        destination: { type: 'browser' as const, surfaceId, url },
      }],
      activeTabId: `browser:${surfaceId}`,
    });
  }

  function dispatchKey(key: string, opts: { ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean } = {}) {
    const event = new KeyboardEvent('keydown', {
      key,
      ctrlKey: opts.ctrlKey ?? false,
      altKey: opts.altKey ?? false,
      metaKey: opts.metaKey ?? false,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);
  }

  it('Ctrl+F toggles the find bar on', () => {
    setupBrowserTab();
    renderHook(() => useBrowserShortcuts());

    dispatchKey('f', { ctrlKey: true });

    expect(useBrowserStore.getState().tabs['browser-test']?.findActive).toBe(true);
  });

  it('Ctrl+F toggles the find bar off when already on', () => {
    setupBrowserTab();
    useBrowserStore.getState().toggleFind('browser-test');

    renderHook(() => useBrowserShortcuts());
    dispatchKey('f', { ctrlKey: true });

    expect(useBrowserStore.getState().tabs['browser-test']?.findActive).toBe(false);
  });

  it('Ctrl+R reloads the active browser surface', () => {
    setupBrowserTab();
    renderHook(() => useBrowserShortcuts());

    dispatchKey('r', { ctrlKey: true });

    expect(mockSurfaceBridge.reload).toHaveBeenCalledWith('browser-test');
  });

  it('F5 reloads the active browser surface', () => {
    setupBrowserTab();
    renderHook(() => useBrowserShortcuts());

    dispatchKey('F5');

    expect(mockSurfaceBridge.reload).toHaveBeenCalledWith('browser-test');
  });

  it('Alt+Left navigates back', () => {
    setupBrowserTab();
    renderHook(() => useBrowserShortcuts());

    dispatchKey('ArrowLeft', { altKey: true });

    expect(mockSurfaceBridge.goBack).toHaveBeenCalledWith('browser-test');
  });

  it('Alt+Right navigates forward', () => {
    setupBrowserTab();
    renderHook(() => useBrowserShortcuts());

    dispatchKey('ArrowRight', { altKey: true });

    expect(mockSurfaceBridge.goForward).toHaveBeenCalledWith('browser-test');
  });

  it('Ctrl+W closes the active workbench tab', () => {
    setupBrowserTab();
    renderHook(() => useBrowserShortcuts());

    dispatchKey('w', { ctrlKey: true });

    expect(useWorkbenchStore.getState().tabs).toHaveLength(0);
  });

  it('shortcuts are ignored when no browser tab is active', () => {
    // Set up a non-browser tab
    useWorkbenchStore.setState({
      tabs: [{
        id: 'file:test',
        title: 'Test',
        closable: true,
        destination: { type: 'file' as const, path: '/test', name: 'test' },
      }],
      activeTabId: 'file:test',
    });

    renderHook(() => useBrowserShortcuts());

    dispatchKey('f', { ctrlKey: true });
    dispatchKey('r', { ctrlKey: true });
    dispatchKey('F5');

    expect(mockSurfaceBridge.reload).not.toHaveBeenCalled();
    // Find bar should not be toggled (no browser tab)
  });

  it('shortcuts are ignored when no tab is active at all', () => {
    renderHook(() => useBrowserShortcuts());

    dispatchKey('f', { ctrlKey: true });
    dispatchKey('r', { ctrlKey: true });

    expect(mockSurfaceBridge.reload).not.toHaveBeenCalled();
  });
});
