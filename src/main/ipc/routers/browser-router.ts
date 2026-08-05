/**
 * browser-router — tRPC procedures for browser tab persistence and bookmark management.
 *
 * Issue #7: Browser tab persistence (getTabs / saveTabs / flushTabs)
 * Issue #8: Bookmark CRUD + import/export + clearBrowserData
 */
import { app, session } from 'electron';
import { join } from 'node:path';
import { t, TRPCError } from '../router-context';
import { BrowserTabStore } from '../../browser/browser-tab-store';
import { BookmarkStore } from '../../browser/bookmark-store';
import type {
  Bookmark,
  BookmarkGroup,
  BookmarkImportResult,
  CreateBookmarkInput,
  CreateGroupInput,
  PersistedBrowserTab,
  PersistedBrowserTabs,
  PersistedBookmarks,
  ReorderBookmarkInput,
  UpdateBookmarkInput,
  UpdateGroupInput,
} from '@shared/browser-types';

// ── Singleton stores ──────────────────────────────────────────

let tabStore: BrowserTabStore | null = null;
let bookmarkStore: BookmarkStore | null = null;
let storeDir: string | null = null;

function getStoreDir(): string {
  if (storeDir) return storeDir;
  return join(app.getPath('userData'), 'socverify-data');
}

function getTabStore(): BrowserTabStore {
  if (!tabStore) {
    tabStore = new BrowserTabStore(getStoreDir());
  }
  return tabStore;
}

function getBookmarkStore(): BookmarkStore {
  if (!bookmarkStore) {
    bookmarkStore = new BookmarkStore(getStoreDir());
  }
  return bookmarkStore;
}

/** Override the store directory (for testing). */
export function setBrowserStoreDir(dir: string): void {
  storeDir = dir;
  tabStore = null;
  bookmarkStore = null;
  cachedTabs = null;
}

/** Flush and reset the store singletons (for testing cleanup). */
export function flushBrowserStore(): void {
  tabStore = null;
  bookmarkStore = null;
  cachedTabs = null;
}

// ── In-memory cache (avoids reading file on every getTabs call) ──

let cachedTabs: PersistedBrowserTabs | null = null;

async function loadTabs(): Promise<PersistedBrowserTabs> {
  if (cachedTabs) return cachedTabs;
  cachedTabs = await getTabStore().load();
  return cachedTabs;
}

// ── Procedures ─────────────────────────────────────────────────

export const browserRouter = t.router({
  /**
   * Get persisted browser tabs for restart recovery.
   * Returns empty state if no tabs have been saved or if the file is corrupted.
   */
  getTabs: t.procedure.query(async (): Promise<PersistedBrowserTabs> => {
    return loadTabs();
  }),

  /**
   * Save browser tabs (debounced by renderer, called on tab changes).
   * Persists URL, title, order, and activeTabId.
   */
  saveTabs: t.procedure
    .input((raw): { tabs: PersistedBrowserTab[]; activeTabId: string | null } => {
      const r = raw as Record<string, unknown>;
      if (!Array.isArray(r.tabs)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'tabs must be an array' });
      }
      const tabs = r.tabs.map((t: unknown) => {
        const tab = t as Record<string, unknown>;
        if (typeof tab.surfaceId !== 'string' || typeof tab.url !== 'string' || typeof tab.title !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Each tab must have surfaceId, url, and title' });
        }
        return { surfaceId: tab.surfaceId, url: tab.url, title: tab.title };
      });
      const activeTabId = r.activeTabId === null || typeof r.activeTabId === 'string' ? r.activeTabId : null;
      return { tabs, activeTabId };
    })
    .mutation(async ({ input }) => {
      cachedTabs = { version: 1, tabs: input.tabs, activeTabId: input.activeTabId };
      await getTabStore().save(input.tabs, input.activeTabId);
      return { ok: true as const };
    }),

  /**
   * Synchronously flush tabs to disk — called during app shutdown (before-quit).
   */
  flushTabs: t.procedure
    .input((raw): { tabs: PersistedBrowserTab[]; activeTabId: string | null } => {
      const r = raw as Record<string, unknown>;
      if (!Array.isArray(r.tabs)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'tabs must be an array' });
      }
      const tabs = r.tabs.map((t: unknown) => {
        const tab = t as Record<string, unknown>;
        if (typeof tab.surfaceId !== 'string' || typeof tab.url !== 'string' || typeof tab.title !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Each tab must have surfaceId, url, and title' });
        }
        return { surfaceId: tab.surfaceId, url: tab.url, title: tab.title };
      });
      const activeTabId = r.activeTabId === null || typeof r.activeTabId === 'string' ? r.activeTabId : null;
      return { tabs, activeTabId };
    })
    .mutation(async ({ input }) => {
      cachedTabs = { version: 1, tabs: input.tabs, activeTabId: input.activeTabId };
      getTabStore().saveSync(input.tabs, input.activeTabId);
      return { ok: true as const };
    }),

  // ── Issue #8: Bookmark CRUD ──────────────────────────────────

  /** Get all bookmarks and groups. */
  getBookmarks: t.procedure.query(async (): Promise<PersistedBookmarks> => {
    return getBookmarkStore().load();
  }),

  /** Add a new bookmark. */
  addBookmark: t.procedure
    .input((raw): { input: CreateBookmarkInput } => {
      const r = raw as Record<string, unknown>;
      const inp = r.input as Partial<CreateBookmarkInput>;
      if (!inp || typeof inp.url !== 'string' || typeof inp.title !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'url and title are required' });
      }
      return { input: inp as CreateBookmarkInput };
    })
    .mutation(async ({ input }): Promise<Bookmark> => {
      return getBookmarkStore().addBookmark(input.input);
    }),

  /** Update an existing bookmark. */
  updateBookmark: t.procedure
    .input((raw): { input: UpdateBookmarkInput } => {
      const r = raw as Record<string, unknown>;
      const inp = r.input as Partial<UpdateBookmarkInput>;
      if (!inp || typeof inp.id !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'id is required' });
      }
      return { input: inp as UpdateBookmarkInput };
    })
    .mutation(async ({ input }): Promise<Bookmark> => {
      try {
        return await getBookmarkStore().updateBookmark(input.input);
      } catch (err) {
        throw new TRPCError({ code: 'NOT_FOUND', message: err instanceof Error ? err.message : String(err) });
      }
    }),

  /** Delete a bookmark. */
  deleteBookmark: t.procedure
    .input((raw): { id: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.id !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'id is required' });
      }
      return { id: r.id };
    })
    .mutation(async ({ input }): Promise<{ ok: true }> => {
      await getBookmarkStore().deleteBookmark(input.id);
      return { ok: true as const };
    }),

  /** Toggle the frequent flag on a bookmark. */
  toggleFrequent: t.procedure
    .input((raw): { id: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.id !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'id is required' });
      }
      return { id: r.id };
    })
    .mutation(async ({ input }): Promise<Bookmark> => {
      try {
        return await getBookmarkStore().toggleFrequent(input.id);
      } catch (err) {
        throw new TRPCError({ code: 'NOT_FOUND', message: err instanceof Error ? err.message : String(err) });
      }
    }),

  /** Reorder a bookmark within its group. */
  reorderBookmarks: t.procedure
    .input((raw): { input: ReorderBookmarkInput } => {
      const r = raw as Record<string, unknown>;
      const inp = r.input as Partial<ReorderBookmarkInput>;
      if (!inp || typeof inp.id !== 'string' || typeof inp.newOrder !== 'number') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'id and newOrder are required' });
      }
      return { input: inp as ReorderBookmarkInput };
    })
    .mutation(async ({ input }): Promise<{ ok: true }> => {
      try {
        await getBookmarkStore().reorderBookmark(input.input);
        return { ok: true as const };
      } catch (err) {
        throw new TRPCError({ code: 'NOT_FOUND', message: err instanceof Error ? err.message : String(err) });
      }
    }),

  // ── Issue #8: Group CRUD ─────────────────────────────────────

  /** Add a new group. */
  addGroup: t.procedure
    .input((raw): { input: CreateGroupInput } => {
      const r = raw as Record<string, unknown>;
      const inp = r.input as Partial<CreateGroupInput>;
      if (!inp || typeof inp.name !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'name is required' });
      }
      return { input: inp as CreateGroupInput };
    })
    .mutation(async ({ input }): Promise<BookmarkGroup> => {
      return getBookmarkStore().addGroup(input.input);
    }),

  /** Update an existing group. */
  updateGroup: t.procedure
    .input((raw): { input: UpdateGroupInput } => {
      const r = raw as Record<string, unknown>;
      const inp = r.input as Partial<UpdateGroupInput>;
      if (!inp || typeof inp.id !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'id is required' });
      }
      return { input: inp as UpdateGroupInput };
    })
    .mutation(async ({ input }): Promise<BookmarkGroup> => {
      try {
        return await getBookmarkStore().updateGroup(input.input);
      } catch (err) {
        throw new TRPCError({ code: 'NOT_FOUND', message: err instanceof Error ? err.message : String(err) });
      }
    }),

  /** Delete a group (bookmarks are unassigned, not deleted). */
  deleteGroup: t.procedure
    .input((raw): { id: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.id !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'id is required' });
      }
      return { id: r.id };
    })
    .mutation(async ({ input }): Promise<{ ok: true }> => {
      await getBookmarkStore().deleteGroup(input.id);
      return { ok: true as const };
    }),

  // ── Issue #8: Import / Export ────────────────────────────────

  /** Export all bookmarks and groups as JSON. */
  exportBookmarks: t.procedure.query(async (): Promise<PersistedBookmarks> => {
    return getBookmarkStore().exportData();
  }),

  /** Import bookmarks from JSON data with validation. */
  importBookmarks: t.procedure
    .input((raw): { data: PersistedBookmarks } => {
      const r = raw as Record<string, unknown>;
      if (!r.data || typeof r.data !== 'object') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'data is required' });
      }
      return { data: r.data as PersistedBookmarks };
    })
    .mutation(async ({ input }): Promise<BookmarkImportResult> => {
      return getBookmarkStore().importData(input.data);
    }),

  // ── Issue #8: Browser data management ────────────────────────

  /**
   * Clear Browser session data: cookies, cache, and site data.
   * Uses the `persist:soc-verify-browser` partition.
   */
  clearBrowserData: t.procedure.mutation(async (): Promise<{ ok: true }> => {
    const browserSession = session.fromPartition('persist:soc-verify-browser');
    await browserSession.clearStorageData();
    await browserSession.clearCache();
    await browserSession.clearHostResolverCache();
    await browserSession.clearAuthCache();
    return { ok: true as const };
  }),
});
