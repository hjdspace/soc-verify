/**
 * BookmarkStore tests — persistence layer for browser bookmarks.
 *
 * Seam: BookmarkStore class (public methods: load, save, addBookmark,
 *   updateBookmark, deleteBookmark, reorderBookmark, toggleFrequent,
 *   addGroup, updateGroup, deleteGroup, importData, exportData)
 *
 * Tests verify:
 * - CRUD operations on bookmarks and groups
 * - In-group ordering
 * - Frequent marking
 * - Import validation (version, fields, URL protocol, duplicates)
 * - Export round-trip
 * - Corruption recovery
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BookmarkStore } from '../../src/main/browser/bookmark-store';
import type { Bookmark, BookmarkGroup, PersistedBookmarks } from '../../src/shared/browser-types';

const TMP_BASE = tmpdir();

describe('BookmarkStore', () => {
  let tmpDir: string;
  let store: BookmarkStore;

  beforeEach(() => {
    tmpDir = join(TMP_BASE, `sv-bookmark-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(tmpDir, { recursive: true });
    store = new BookmarkStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('load', () => {
    it('returns empty state when no file exists', async () => {
      const result = await store.load();
      expect(result.bookmarks).toEqual([]);
      expect(result.groups).toEqual([]);
    });

    it('returns empty state when file is corrupted', async () => {
      writeFileSync(join(tmpDir, 'browser-bookmarks.json'), '{ broken !!!', 'utf-8');
      const result = await store.load();
      expect(result.bookmarks).toEqual([]);
      expect(result.groups).toEqual([]);
    });

    it('returns empty state when version is unsupported', async () => {
      const data = { version: 999, bookmarks: [], groups: [] };
      writeFileSync(join(tmpDir, 'browser-bookmarks.json'), JSON.stringify(data), 'utf-8');
      const result = await store.load();
      expect(result.bookmarks).toEqual([]);
      expect(result.groups).toEqual([]);
    });

    it('loads valid persisted state', async () => {
      const data: PersistedBookmarks = {
        version: 1,
        bookmarks: [
          { id: 'bm-1', url: 'https://example.com', title: 'Example', groupId: null, frequent: true, order: 0 },
        ],
        groups: [
          { id: 'grp-1', name: 'Work', order: 0 },
        ],
      };
      writeFileSync(join(tmpDir, 'browser-bookmarks.json'), JSON.stringify(data), 'utf-8');
      const result = await store.load();
      expect(result.bookmarks).toHaveLength(1);
      expect(result.bookmarks[0].title).toBe('Example');
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].name).toBe('Work');
    });
  });

  describe('addBookmark', () => {
    it('creates a bookmark with generated id and correct order', async () => {
      const bm = await store.addBookmark({ url: 'https://example.com', title: 'Example' });
      expect(bm.id).toBeTruthy();
      expect(bm.url).toBe('https://example.com');
      expect(bm.title).toBe('Example');
      expect(bm.groupId).toBeNull();
      expect(bm.frequent).toBe(false);
      expect(bm.order).toBe(0);
    });

    it('assigns incrementing order within a group', async () => {
      await store.addBookmark({ url: 'https://a.com', title: 'A', groupId: 'grp-1' });
      const bm2 = await store.addBookmark({ url: 'https://b.com', title: 'B', groupId: 'grp-1' });
      expect(bm2.order).toBe(1);
    });

    it('assigns order 0 for first bookmark in a different group', async () => {
      await store.addBookmark({ url: 'https://a.com', title: 'A', groupId: 'grp-1' });
      const bm2 = await store.addBookmark({ url: 'https://b.com', title: 'B', groupId: 'grp-2' });
      expect(bm2.order).toBe(0);
    });

    it('persists the bookmark to disk', async () => {
      await store.addBookmark({ url: 'https://example.com', title: 'Example' });
      const reloaded = await store.load();
      expect(reloaded.bookmarks).toHaveLength(1);
      expect(reloaded.bookmarks[0].url).toBe('https://example.com');
    });
  });

  describe('updateBookmark', () => {
    it('updates bookmark fields', async () => {
      const bm = await store.addBookmark({ url: 'https://example.com', title: 'Example' });
      const updated = await store.updateBookmark({ id: bm.id, title: 'Updated', frequent: true });
      expect(updated.title).toBe('Updated');
      expect(updated.frequent).toBe(true);
    });

    it('throws when bookmark not found', async () => {
      await expect(store.updateBookmark({ id: 'nonexistent', title: 'X' })).rejects.toThrow('not found');
    });
  });

  describe('deleteBookmark', () => {
    it('removes a bookmark', async () => {
      const bm = await store.addBookmark({ url: 'https://example.com', title: 'Example' });
      await store.deleteBookmark(bm.id);
      const reloaded = await store.load();
      expect(reloaded.bookmarks).toEqual([]);
    });

    it('is idempotent (no error on missing bookmark)', async () => {
      await store.deleteBookmark('nonexistent');
      // Should not throw
    });
  });

  describe('reorderBookmark', () => {
    it('reorders bookmarks within a group', async () => {
      const bm1 = await store.addBookmark({ url: 'https://a.com', title: 'A', groupId: 'grp-1' });
      const bm2 = await store.addBookmark({ url: 'https://b.com', title: 'B', groupId: 'grp-1' });
      const bm3 = await store.addBookmark({ url: 'https://c.com', title: 'C', groupId: 'grp-1' });

      // Move bm3 to position 0
      await store.reorderBookmark({ id: bm3.id, newOrder: 0 });

      const all = (await store.load()).bookmarks;
      expect(all.find((b) => b.id === bm3.id)?.order).toBe(0);
      expect(all.find((b) => b.id === bm1.id)?.order).toBe(1);
      expect(all.find((b) => b.id === bm2.id)?.order).toBe(2);
    });
  });

  describe('toggleFrequent', () => {
    it('toggles frequent flag', async () => {
      const bm = await store.addBookmark({ url: 'https://example.com', title: 'Example' });
      expect(bm.frequent).toBe(false);

      const toggled = await store.toggleFrequent(bm.id);
      expect(toggled.frequent).toBe(true);

      const toggledAgain = await store.toggleFrequent(bm.id);
      expect(toggledAgain.frequent).toBe(false);
    });
  });

  describe('addGroup', () => {
    it('creates a group with generated id and correct order', async () => {
      const grp = await store.addGroup({ name: 'Work' });
      expect(grp.id).toBeTruthy();
      expect(grp.name).toBe('Work');
      expect(grp.order).toBe(0);
    });

    it('assigns incrementing order', async () => {
      await store.addGroup({ name: 'A' });
      const grp2 = await store.addGroup({ name: 'B' });
      expect(grp2.order).toBe(1);
    });
  });

  describe('updateGroup', () => {
    it('updates group name', async () => {
      const grp = await store.addGroup({ name: 'Work' });
      const updated = await store.updateGroup({ id: grp.id, name: 'Updated' });
      expect(updated.name).toBe('Updated');
    });

    it('throws when group not found', async () => {
      await expect(store.updateGroup({ id: 'nonexistent', name: 'X' })).rejects.toThrow('not found');
    });
  });

  describe('deleteGroup', () => {
    it('removes a group and unassigns its bookmarks', async () => {
      const grp = await store.addGroup({ name: 'Work' });
      const bm = await store.addBookmark({ url: 'https://a.com', title: 'A', groupId: grp.id });

      await store.deleteGroup(grp.id);

      const reloaded = await store.load();
      expect(reloaded.groups).toEqual([]);
      // Bookmark should still exist but with groupId null
      const survivingBm = reloaded.bookmarks.find((b) => b.id === bm.id);
      expect(survivingBm).toBeDefined();
      expect(survivingBm?.groupId).toBeNull();
    });

    it('is idempotent', async () => {
      await store.deleteGroup('nonexistent');
      // Should not throw
    });
  });

  describe('exportData', () => {
    it('returns all bookmarks and groups', async () => {
      await store.addBookmark({ url: 'https://a.com', title: 'A', frequent: true });
      await store.addGroup({ name: 'Work' });

      const data = await store.exportData();
      expect(data.version).toBe(1);
      expect(data.bookmarks).toHaveLength(1);
      expect(data.groups).toHaveLength(1);
    });
  });

  describe('importData', () => {
    it('imports valid bookmarks and groups', async () => {
      const data: PersistedBookmarks = {
        version: 1,
        bookmarks: [
          { id: 'imp-1', url: 'https://imported.com', title: 'Imported', groupId: 'imp-grp', frequent: false, order: 0 },
        ],
        groups: [
          { id: 'imp-grp', name: 'Imported Group', order: 0 },
        ],
      };

      const result = await store.importData(data);
      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.errors).toEqual([]);

      const all = await store.load();
      expect(all.bookmarks.find((b) => b.id === 'imp-1')).toBeDefined();
    });

    it('skips bookmarks with invalid URL protocol', async () => {
      const data: PersistedBookmarks = {
        version: 1,
        bookmarks: [
          { id: 'imp-1', url: 'file:///secret', title: 'Bad', groupId: null, frequent: false, order: 0 },
          { id: 'imp-2', url: 'javascript:alert(1)', title: 'Bad2', groupId: null, frequent: false, order: 0 },
        ],
        groups: [],
      };

      const result = await store.importData(data);
      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(2);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('skips bookmarks with missing required fields', async () => {
      const data = {
        version: 1,
        bookmarks: [
          { id: 'imp-1', url: '', title: 'No URL' },
          { id: 'imp-2', url: 'https://valid.com', title: '' },
        ],
        groups: [],
      };

      const result = await store.importData(data as unknown as PersistedBookmarks);
      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(2);
    });

    it('skips duplicate URLs (already existing)', async () => {
      await store.addBookmark({ url: 'https://existing.com', title: 'Existing' });

      const data: PersistedBookmarks = {
        version: 1,
        bookmarks: [
          { id: 'imp-1', url: 'https://existing.com', title: 'Duplicate', groupId: null, frequent: false, order: 0 },
          { id: 'imp-2', url: 'https://new.com', title: 'New', groupId: null, frequent: false, order: 0 },
        ],
        groups: [],
      };

      const result = await store.importData(data);
      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(1);
    });

    it('rejects unsupported version', async () => {
      const data = { version: 999, bookmarks: [], groups: [] };
      const result = await store.importData(data as unknown as PersistedBookmarks);
      expect(result.imported).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('export → import round-trip preserves all data', async () => {
      // Setup original data
      const grp = await store.addGroup({ name: 'Work' });
      const bm1 = await store.addBookmark({ url: 'https://a.com', title: 'A', groupId: grp.id, frequent: true });
      const bm2 = await store.addBookmark({ url: 'https://b.com', title: 'B', groupId: grp.id });

      // Export
      const exported = await store.exportData();

      // Import into a fresh store
      const store2 = new BookmarkStore(join(tmpDir, 'store2'));
      const result = await store2.importData(exported);
      expect(result.imported).toBe(2);

      const reloaded = await store2.load();
      expect(reloaded.bookmarks).toHaveLength(2);
      expect(reloaded.groups).toHaveLength(1);

      const importedBm1 = reloaded.bookmarks.find((b) => b.url === 'https://a.com');
      expect(importedBm1?.title).toBe('A');
      expect(importedBm1?.frequent).toBe(true);
      expect(importedBm1?.groupId).toBe(grp.id);

      const importedGrp = reloaded.groups[0];
      expect(importedGrp.name).toBe('Work');
    });
  });
});
