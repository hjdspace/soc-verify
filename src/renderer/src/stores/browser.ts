import { create } from 'zustand';
import type { SurfaceEvent } from '@shared/surface-types';
import { BROWSER_TAB_SOFT_LIMIT, type PersistedBrowserTab, type PersistedBrowserTabs } from '@shared/browser-types';

export type BrowserTabState = {
  surfaceId: string;
  /** The URL currently loaded (empty string = new-tab homepage). */
  url: string;
  /** The URL submitted by the user that initiated the Surface. */
  initialUrl: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string | null;
  /** True when the render process has crashed — UI shows error page with manual reload. */
  crashed: boolean;
  /** Issue #9: Certificate error details — when set, UI shows risk page with single-continue option. */
  certificateError: { url: string; error: string } | null;
  /** Issue #11: Find-in-page bar visibility. */
  findActive: boolean;
  /** Issue #11: Total number of matches from the last find-in-page search. */
  findMatches: number;
  /** Issue #11: 1-based index of the currently active match. */
  findActiveMatch: number;
};

type BrowserStore = {
  tabs: Record<string, BrowserTabState>;
  order: string[];

  /** Create a new browser tab entry (homepage — no URL loaded yet). */
  createTab: (surfaceId: string) => void;
  /** Remove a tab entry. */
  removeTab: (surfaceId: string) => void;
  /** Set the URL to load for a tab (transitions from homepage to loaded state). */
  setUrl: (surfaceId: string, url: string) => void;
  /** Apply a surface event patch to a tab. */
  applyEvent: (event: SurfaceEvent) => void;
  /** Get a tab by surfaceId. */
  getTab: (surfaceId: string) => BrowserTabState | undefined;
  /** Find an existing tab whose current URL matches the given normalized URL. */
  findByUrl: (normalizedUrl: string) => BrowserTabState | undefined;
  /** Export current tabs in the format for main-process persistence. */
  serializeForPersistence: () => PersistedBrowserTabs;
  /** Restore tabs from persisted state (replaces all current tabs). */
  restoreFromPersisted: (data: PersistedBrowserTabs) => void;
  /** Returns true when the number of browser tabs exceeds the soft limit. */
  exceedsSoftLimit: () => boolean;
  /** Clear crashed state for a tab (user clicked reload on crash error page). */
  reloadTab: (surfaceId: string) => void;
  /** Issue #9: Clear certificate error state for a tab (user clicked continue or reload). */
  clearCertificateError: (surfaceId: string) => void;
  /** Issue #11: Toggle the find-in-page bar visibility. */
  toggleFind: (surfaceId: string) => void;
  /** Issue #11: Close the find-in-page bar and clear find state. */
  closeFind: (surfaceId: string) => void;
};

/**
 * Normalize a URL string for comparison:
 * - Trim whitespace
 * - Add `https://` prefix if missing scheme (e.g. "example.com" → "https://example.com")
 * - Remove trailing slash for root paths (e.g. "https://example.com/" → "https://example.com")
 *
 * Returns `null` if the result is not a valid http/https URL.
 */
export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Add https:// prefix only if the input doesn't already have a URL scheme.
  // This prevents prepending https:// to inputs like file:/// or javascript:
  let withScheme = trimmed;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(withScheme)) {
    withScheme = `https://${withScheme}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  // Remove trailing slash for root paths
  let href = parsed.href;
  if (href.endsWith('/') && parsed.pathname === '/') {
    href = href.slice(0, -1);
  }

  return href;
}

export const useBrowserStore = create<BrowserStore>((set, get) => ({
  tabs: {},
  order: [],

  createTab: (surfaceId) => {
    set((state) => {
      if (state.tabs[surfaceId]) return state;
      return {
        tabs: {
          ...state.tabs,
          [surfaceId]: {
            surfaceId,
            url: '',
            initialUrl: '',
            title: '新标签页',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            error: null,
            crashed: false,
            certificateError: null,
            findActive: false,
            findMatches: 0,
            findActiveMatch: 0,
          },
        },
        order: [...state.order, surfaceId],
      };
    });
  },

  removeTab: (surfaceId) => {
    set((state) => {
      const { [surfaceId]: _, ...rest } = state.tabs;
      return {
        tabs: rest,
        order: state.order.filter((id) => id !== surfaceId),
      };
    });
  },

  setUrl: (surfaceId, url) => {
    set((state) => {
      const tab = state.tabs[surfaceId];
      if (!tab) return state;
      return {
        tabs: {
          ...state.tabs,
          [surfaceId]: { ...tab, url, initialUrl: url, loading: true, error: null },
        },
      };
    });
  },

  applyEvent: (event) => {
    set((state) => {
      const tab = state.tabs[event.id];
      if (!tab) return state;

      switch (event.type) {
        case 'url':
          return { tabs: { ...state.tabs, [event.id]: { ...tab, url: event.url } } };
        case 'title':
          return { tabs: { ...state.tabs, [event.id]: { ...tab, title: event.title } } };
        case 'loading':
          return { tabs: { ...state.tabs, [event.id]: { ...tab, loading: event.loading } } };
        case 'navigation':
          return {
            tabs: {
              ...state.tabs,
              [event.id]: { ...tab, canGoBack: event.canGoBack, canGoForward: event.canGoForward },
            },
          };
        case 'failure':
          if (event.isMainFrame) {
            return {
              tabs: {
                ...state.tabs,
                [event.id]: { ...tab, error: event.errorDescription || `Error ${event.errorCode}` },
              },
            };
          }
          return state;
        case 'crash':
          return {
            tabs: {
              ...state.tabs,
              [event.id]: { ...tab, error: `页面崩溃 (${event.reason ?? 'unknown'})`, crashed: true },
            },
          };
        case 'certificate-error':
          return {
            tabs: {
              ...state.tabs,
              [event.id]: { ...tab, certificateError: { url: event.url, error: event.error }, loading: false },
            },
          };
        case 'find-result':
          return {
            tabs: {
              ...state.tabs,
              [event.id]: { ...tab, findMatches: event.matches, findActiveMatch: event.activeMatchOrdinal },
            },
          };
        default:
          return state;
      }
    });
  },

  getTab: (surfaceId) => get().tabs[surfaceId],

  findByUrl: (normalizedUrl) => {
    const { tabs } = get();
    return Object.values(tabs).find((tab) => tab.url === normalizedUrl);
  },

  serializeForPersistence: () => {
    const { tabs, order } = get();
    const persistedTabs: PersistedBrowserTab[] = order
      .map((id) => tabs[id])
      .filter((tab) => tab != null && tab.url !== '')
      .map((tab) => ({
        surfaceId: tab.surfaceId,
        url: tab.url,
        title: tab.title,
      }));
    return { version: 1 as const, tabs: persistedTabs, activeTabId: null };
  },

  restoreFromPersisted: (data) => {
    set(() => {
      const tabs: Record<string, BrowserTabState> = {};
      const order: string[] = [];
      for (const ptab of data.tabs) {
        tabs[ptab.surfaceId] = {
          surfaceId: ptab.surfaceId,
          url: ptab.url,
          initialUrl: ptab.url,
          title: ptab.title,
          loading: false,
          canGoBack: false,
          canGoForward: false,
          error: null,
          crashed: false,
          certificateError: null,
          findActive: false,
          findMatches: 0,
          findActiveMatch: 0,
        };
        order.push(ptab.surfaceId);
      }
      return { tabs, order };
    });
  },

  exceedsSoftLimit: () => {
    return get().order.length > BROWSER_TAB_SOFT_LIMIT;
  },

  reloadTab: (surfaceId) => {
    set((state) => {
      const tab = state.tabs[surfaceId];
      if (!tab) return state;
      return {
        tabs: {
          ...state.tabs,
          [surfaceId]: { ...tab, crashed: false, error: null, certificateError: null, loading: true },
        },
      };
    });
  },

  clearCertificateError: (surfaceId) => {
    set((state) => {
      const tab = state.tabs[surfaceId];
      if (!tab) return state;
      return {
        tabs: {
          ...state.tabs,
          [surfaceId]: { ...tab, certificateError: null },
        },
      };
    });
  },

  toggleFind: (surfaceId) => {
    set((state) => {
      const tab = state.tabs[surfaceId];
      if (!tab) return state;
      return {
        tabs: {
          ...state.tabs,
          [surfaceId]: { ...tab, findActive: !tab.findActive },
        },
      };
    });
  },

  closeFind: (surfaceId) => {
    set((state) => {
      const tab = state.tabs[surfaceId];
      if (!tab) return state;
      return {
        tabs: {
          ...state.tabs,
          [surfaceId]: { ...tab, findActive: false, findMatches: 0, findActiveMatch: 0 },
        },
      };
    });
  },
}));
