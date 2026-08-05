/**
 * useBookmarkStore — renderer-side Zustand store for browser bookmarks.
 *
 * Issue #8: Bookmarks, frequently used pages, and data management.
 *
 * - Loads bookmarks and groups from the main process via tRPC
 * - Provides CRUD operations that sync to the main process
 * - `getFrequentBookmarks()` projects bookmarks for the new-tab homepage
 * - `getBookmarksByGroup()` returns bookmarks within a single-layer group
 *
 * No second URL dataset is maintained — frequent bookmarks are simply a
 * filtered projection of the same bookmark list.
 */
import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import type {
  Bookmark,
  BookmarkGroup,
  BookmarkImportResult,
  CreateBookmarkInput,
  CreateGroupInput,
  PersistedBookmarks,
  UpdateBookmarkInput,
  UpdateGroupInput,
  ReorderBookmarkInput,
} from '@shared/browser-types';

type BookmarkStore = {
  bookmarks: Bookmark[];
  groups: BookmarkGroup[];
  loading: boolean;

  /** Load bookmarks and groups from the main process. */
  load: () => Promise<void>;
  /** Add a new bookmark (syncs to main process). */
  addBookmark: (input: CreateBookmarkInput) => Promise<Bookmark>;
  /** Update an existing bookmark (syncs to main process). */
  updateBookmark: (input: UpdateBookmarkInput) => Promise<Bookmark>;
  /** Delete a bookmark (syncs to main process). */
  deleteBookmark: (id: string) => Promise<void>;
  /** Toggle the frequent flag on a bookmark (syncs to main process). */
  toggleFrequent: (id: string) => Promise<Bookmark>;
  /** Reorder a bookmark within its group (syncs to main process). */
  reorderBookmark: (input: ReorderBookmarkInput) => Promise<void>;
  /** Add a new group (syncs to main process). */
  addGroup: (input: CreateGroupInput) => Promise<BookmarkGroup>;
  /** Update an existing group (syncs to main process). */
  updateGroup: (input: UpdateGroupInput) => Promise<BookmarkGroup>;
  /** Delete a group (syncs to main process, unassigns bookmarks). */
  deleteGroup: (id: string) => Promise<void>;
  /** Export all bookmarks and groups. */
  exportBookmarks: () => Promise<PersistedBookmarks>;
  /** Import bookmarks from JSON data. */
  importBookmarks: (data: PersistedBookmarks) => Promise<BookmarkImportResult>;
  /** Clear browser session data (cookies, cache, site data). */
  clearBrowserData: () => Promise<void>;

  /** Returns only frequent bookmarks (for new-tab homepage). */
  getFrequentBookmarks: () => Bookmark[];
  /** Returns bookmarks in a specific group (null = ungrouped). */
  getBookmarksByGroup: (groupId: string | null) => Bookmark[];
};

export const useBookmarkStore = create<BookmarkStore>((set, get) => ({
  bookmarks: [],
  groups: [],
  loading: false,

  load: async () => {
    set({ loading: true });
    try {
      const data = await trpc.browser.getBookmarks.query();
      set({ bookmarks: data.bookmarks, groups: data.groups, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  addBookmark: async (input) => {
    const bookmark = await trpc.browser.addBookmark.mutate({ input });
    set((state) => ({ bookmarks: [...state.bookmarks, bookmark] }));
    return bookmark;
  },

  updateBookmark: async (input) => {
    const updated = await trpc.browser.updateBookmark.mutate({ input });
    set((state) => ({
      bookmarks: state.bookmarks.map((b) => (b.id === updated.id ? updated : b)),
    }));
    return updated;
  },

  deleteBookmark: async (id) => {
    await trpc.browser.deleteBookmark.mutate({ id });
    set((state) => ({
      bookmarks: state.bookmarks.filter((b) => b.id !== id),
    }));
  },

  toggleFrequent: async (id) => {
    const updated = await trpc.browser.toggleFrequent.mutate({ id });
    set((state) => ({
      bookmarks: state.bookmarks.map((b) => (b.id === updated.id ? updated : b)),
    }));
    return updated;
  },

  reorderBookmark: async (input) => {
    await trpc.browser.reorderBookmarks.mutate({ input });
    // Reload to get the corrected order from the backend
    await get().load();
  },

  addGroup: async (input) => {
    const group = await trpc.browser.addGroup.mutate({ input });
    set((state) => ({ groups: [...state.groups, group] }));
    return group;
  },

  updateGroup: async (input) => {
    const updated = await trpc.browser.updateGroup.mutate({ input });
    set((state) => ({
      groups: state.groups.map((g) => (g.id === updated.id ? updated : g)),
    }));
    return updated;
  },

  deleteGroup: async (id) => {
    await trpc.browser.deleteGroup.mutate({ id });
    set((state) => ({
      groups: state.groups.filter((g) => g.id !== id),
      // Unassign bookmarks from the deleted group
      bookmarks: state.bookmarks.map((b) =>
        b.groupId === id ? { ...b, groupId: null } : b,
      ),
    }));
  },

  exportBookmarks: async () => {
    return trpc.browser.exportBookmarks.query();
  },

  importBookmarks: async (data) => {
    const result = await trpc.browser.importBookmarks.mutate({ data });
    // Reload to reflect the imported data
    await get().load();
    return result;
  },

  clearBrowserData: async () => {
    await trpc.browser.clearBrowserData.mutate();
  },

  getFrequentBookmarks: () => {
    return get()
      .bookmarks.filter((b) => b.frequent)
      .sort((a, b) => a.order - b.order);
  },

  getBookmarksByGroup: (groupId) => {
    return get()
      .bookmarks.filter((b) => b.groupId === groupId)
      .sort((a, b) => a.order - b.order);
  },
}));
