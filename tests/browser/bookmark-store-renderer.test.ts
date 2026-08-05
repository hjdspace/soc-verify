/**
 * Bookmark store (renderer) tests.
 *
 * Seam: useBookmarkStore (Zustand store public interface)
 *
 * Tests verify:
 * - Initial state is empty
 * - load fetches from tRPC and populates state
 * - addBookmark / updateBookmark / deleteBookmark / toggleFrequent
 * - getFrequentBookmarks returns only frequent bookmarks
 * - Groups CRUD
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useBookmarkStore } from '@renderer/stores/bookmarks';
import { trpc } from '@renderer/lib/trpc';
import type { Bookmark, BookmarkGroup } from '@shared/browser-types';

// Mock tRPC
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

describe('useBookmarkStore', () => {
  beforeEach(() => {
    useBookmarkStore.setState({ bookmarks: [], groups: [] });
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('starts with empty bookmarks and groups', () => {
      expect(useBookmarkStore.getState().bookmarks).toEqual([]);
      expect(useBookmarkStore.getState().groups).toEqual([]);
    });
  });

  describe('load', () => {
    it('fetches bookmarks and groups from tRPC', async () => {
      const mockBookmarks: Bookmark[] = [
        { id: 'bm-1', url: 'https://a.com', title: 'A', groupId: null, frequent: true, order: 0 },
      ];
      const mockGroups: BookmarkGroup[] = [
        { id: 'grp-1', name: 'Work', order: 0 },
      ];
      vi.mocked(trpc.browser.getBookmarks.query).mockResolvedValue({
        version: 1,
        bookmarks: mockBookmarks,
        groups: mockGroups,
      });

      await useBookmarkStore.getState().load();

      expect(useBookmarkStore.getState().bookmarks).toEqual(mockBookmarks);
      expect(useBookmarkStore.getState().groups).toEqual(mockGroups);
    });

    it('handles empty state from backend', async () => {
      vi.mocked(trpc.browser.getBookmarks.query).mockResolvedValue({
        version: 1,
        bookmarks: [],
        groups: [],
      });

      await useBookmarkStore.getState().load();

      expect(useBookmarkStore.getState().bookmarks).toEqual([]);
      expect(useBookmarkStore.getState().groups).toEqual([]);
    });
  });

  describe('getFrequentBookmarks', () => {
    it('returns only bookmarks with frequent=true', () => {
      useBookmarkStore.setState({
        bookmarks: [
          { id: 'bm-1', url: 'https://a.com', title: 'A', groupId: null, frequent: true, order: 0 },
          { id: 'bm-2', url: 'https://b.com', title: 'B', groupId: null, frequent: false, order: 1 },
          { id: 'bm-3', url: 'https://c.com', title: 'C', groupId: null, frequent: true, order: 2 },
        ],
        groups: [],
      });

      const frequent = useBookmarkStore.getState().getFrequentBookmarks();
      expect(frequent).toHaveLength(2);
      expect(frequent.map((b) => b.id)).toEqual(['bm-1', 'bm-3']);
    });

    it('returns empty array when no frequent bookmarks', () => {
      useBookmarkStore.setState({
        bookmarks: [
          { id: 'bm-1', url: 'https://a.com', title: 'A', groupId: null, frequent: false, order: 0 },
        ],
        groups: [],
      });

      expect(useBookmarkStore.getState().getFrequentBookmarks()).toEqual([]);
    });
  });

  describe('getBookmarksByGroup', () => {
    it('returns bookmarks for a specific group', () => {
      useBookmarkStore.setState({
        bookmarks: [
          { id: 'bm-1', url: 'https://a.com', title: 'A', groupId: 'grp-1', frequent: false, order: 0 },
          { id: 'bm-2', url: 'https://b.com', title: 'B', groupId: 'grp-2', frequent: false, order: 0 },
          { id: 'bm-3', url: 'https://c.com', title: 'C', groupId: 'grp-1', frequent: false, order: 1 },
        ],
        groups: [],
      });

      const group1 = useBookmarkStore.getState().getBookmarksByGroup('grp-1');
      expect(group1).toHaveLength(2);
      expect(group1.map((b) => b.id)).toEqual(['bm-1', 'bm-3']);
    });

    it('returns ungrouped bookmarks when groupId is null', () => {
      useBookmarkStore.setState({
        bookmarks: [
          { id: 'bm-1', url: 'https://a.com', title: 'A', groupId: null, frequent: false, order: 0 },
          { id: 'bm-2', url: 'https://b.com', title: 'B', groupId: 'grp-1', frequent: false, order: 0 },
        ],
        groups: [],
      });

      const ungrouped = useBookmarkStore.getState().getBookmarksByGroup(null);
      expect(ungrouped).toHaveLength(1);
      expect(ungrouped[0].id).toBe('bm-1');
    });
  });

  describe('addBookmark', () => {
    it('calls tRPC and adds bookmark to state', async () => {
      const newBm: Bookmark = {
        id: 'bm-new', url: 'https://new.com', title: 'New', groupId: null, frequent: false, order: 0,
      };
      vi.mocked(trpc.browser.addBookmark.mutate).mockResolvedValue(newBm);

      await useBookmarkStore.getState().addBookmark({ url: 'https://new.com', title: 'New' });

      expect(trpc.browser.addBookmark.mutate).toHaveBeenCalledWith({
        input: { url: 'https://new.com', title: 'New' },
      });
      expect(useBookmarkStore.getState().bookmarks).toContainEqual(newBm);
    });
  });

  describe('deleteBookmark', () => {
    it('calls tRPC and removes bookmark from state', async () => {
      useBookmarkStore.setState({
        bookmarks: [
          { id: 'bm-1', url: 'https://a.com', title: 'A', groupId: null, frequent: false, order: 0 },
        ],
        groups: [],
      });
      vi.mocked(trpc.browser.deleteBookmark.mutate).mockResolvedValue({ ok: true });

      await useBookmarkStore.getState().deleteBookmark('bm-1');

      expect(useBookmarkStore.getState().bookmarks).toEqual([]);
    });
  });

  describe('toggleFrequent', () => {
    it('calls tRPC and updates bookmark in state', async () => {
      useBookmarkStore.setState({
        bookmarks: [
          { id: 'bm-1', url: 'https://a.com', title: 'A', groupId: null, frequent: false, order: 0 },
        ],
        groups: [],
      });
      vi.mocked(trpc.browser.toggleFrequent.mutate).mockResolvedValue({
        id: 'bm-1', url: 'https://a.com', title: 'A', groupId: null, frequent: true, order: 0,
      });

      await useBookmarkStore.getState().toggleFrequent('bm-1');

      expect(useBookmarkStore.getState().bookmarks[0].frequent).toBe(true);
    });
  });

  describe('addGroup', () => {
    it('calls tRPC and adds group to state', async () => {
      const newGroup: BookmarkGroup = { id: 'grp-new', name: 'New Group', order: 0 };
      vi.mocked(trpc.browser.addGroup.mutate).mockResolvedValue(newGroup);

      await useBookmarkStore.getState().addGroup({ name: 'New Group' });

      expect(useBookmarkStore.getState().groups).toContainEqual(newGroup);
    });
  });

  describe('deleteGroup', () => {
    it('calls tRPC, removes group, and unassigns bookmarks', async () => {
      useBookmarkStore.setState({
        bookmarks: [
          { id: 'bm-1', url: 'https://a.com', title: 'A', groupId: 'grp-1', frequent: false, order: 0 },
        ],
        groups: [
          { id: 'grp-1', name: 'Work', order: 0 },
        ],
      });
      vi.mocked(trpc.browser.deleteGroup.mutate).mockResolvedValue({ ok: true });

      await useBookmarkStore.getState().deleteGroup('grp-1');

      expect(useBookmarkStore.getState().groups).toEqual([]);
      expect(useBookmarkStore.getState().bookmarks[0].groupId).toBeNull();
    });
  });
});
