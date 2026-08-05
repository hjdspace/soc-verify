/**
 * browser-router bookmark tests — tRPC API for bookmark CRUD + import/export.
 *
 * Seam: tRPC server-side caller (router.createCaller).
 *
 * Tests verify:
 * - getBookmarks returns persisted state
 * - addBookmark / updateBookmark / deleteBookmark / toggleFrequent
 * - reorderBookmarks
 * - getGroups / addGroup / updateGroup / deleteGroup
 * - exportBookmarks / importBookmarks
 * - clearBrowserData clears session partition
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock electron session for clearBrowserData test
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  session: {
    fromPartition: vi.fn(() => ({
      clearStorageData: vi.fn().mockResolvedValue(undefined),
      clearCache: vi.fn().mockResolvedValue(undefined),
      clearHostResolverCache: vi.fn().mockResolvedValue(undefined),
      clearAuthCache: vi.fn().mockResolvedValue(undefined),
    })),
  },
}));

import { browserRouter, setBrowserStoreDir, flushBrowserStore } from '../../src/main/ipc/routers/browser-router';
import { session as electronSession } from 'electron';

const TMP_BASE = tmpdir();

describe('browser-router bookmarks', () => {
  let tmpDir: string;
  let caller: ReturnType<typeof browserRouter.createCaller>;

  beforeEach(() => {
    tmpDir = join(TMP_BASE, `sv-browser-bm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(tmpDir, { recursive: true });
    setBrowserStoreDir(tmpDir);
    caller = browserRouter.createCaller({});
  });

  afterEach(() => {
    flushBrowserStore();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.mocked(electronSession.fromPartition).mockClear();
  });

  describe('getBookmarks', () => {
    it('returns empty state initially', async () => {
      const result = await caller.getBookmarks();
      expect(result.bookmarks).toEqual([]);
      expect(result.groups).toEqual([]);
    });

    it('returns bookmarks after adding', async () => {
      await caller.addBookmark({ input: { url: 'https://example.com', title: 'Example' } });
      const result = await caller.getBookmarks();
      expect(result.bookmarks).toHaveLength(1);
      expect(result.bookmarks[0].title).toBe('Example');
    });
  });

  describe('addBookmark', () => {
    it('creates a bookmark', async () => {
      const result = await caller.addBookmark({ input: { url: 'https://example.com', title: 'Example', frequent: true } });
      expect(result.id).toBeTruthy();
      expect(result.url).toBe('https://example.com');
      expect(result.frequent).toBe(true);
    });
  });

  describe('updateBookmark', () => {
    it('updates a bookmark title', async () => {
      const bm = await caller.addBookmark({ input: { url: 'https://example.com', title: 'Old' } });
      const updated = await caller.updateBookmark({ input: { id: bm.id, title: 'New' } });
      expect(updated.title).toBe('New');
    });

    it('throws on non-existent bookmark', async () => {
      await expect(caller.updateBookmark({ input: { id: 'nope', title: 'X' } })).rejects.toThrow('not found');
    });
  });

  describe('deleteBookmark', () => {
    it('deletes a bookmark', async () => {
      const bm = await caller.addBookmark({ input: { url: 'https://example.com', title: 'Example' } });
      await caller.deleteBookmark({ id: bm.id });
      const result = await caller.getBookmarks();
      expect(result.bookmarks).toEqual([]);
    });
  });

  describe('toggleFrequent', () => {
    it('toggles frequent flag', async () => {
      const bm = await caller.addBookmark({ input: { url: 'https://example.com', title: 'Example' } });
      expect(bm.frequent).toBe(false);
      const toggled = await caller.toggleFrequent({ id: bm.id });
      expect(toggled.frequent).toBe(true);
    });
  });

  describe('reorderBookmarks', () => {
    it('reorders bookmarks within a group', async () => {
      const bm1 = await caller.addBookmark({ input: { url: 'https://a.com', title: 'A', groupId: 'g1' } });
      const bm2 = await caller.addBookmark({ input: { url: 'https://b.com', title: 'B', groupId: 'g1' } });
      const bm3 = await caller.addBookmark({ input: { url: 'https://c.com', title: 'C', groupId: 'g1' } });

      await caller.reorderBookmarks({ input: { id: bm3.id, newOrder: 0 } });

      const result = await caller.getBookmarks();
      const c = result.bookmarks.find((b) => b.id === bm3.id);
      expect(c?.order).toBe(0);
      const a = result.bookmarks.find((b) => b.id === bm1.id);
      expect(a?.order).toBe(1);
      const b = result.bookmarks.find((b) => b.id === bm2.id);
      expect(b?.order).toBe(2);
    });
  });

  describe('groups', () => {
    it('creates a group', async () => {
      const grp = await caller.addGroup({ input: { name: 'Work' } });
      expect(grp.id).toBeTruthy();
      expect(grp.name).toBe('Work');
    });

    it('updates a group name', async () => {
      const grp = await caller.addGroup({ input: { name: 'Work' } });
      const updated = await caller.updateGroup({ input: { id: grp.id, name: 'Updated' } });
      expect(updated.name).toBe('Updated');
    });

    it('deletes a group and unassigns bookmarks', async () => {
      const grp = await caller.addGroup({ input: { name: 'Work' } });
      const bm = await caller.addBookmark({ input: { url: 'https://a.com', title: 'A', groupId: grp.id } });

      await caller.deleteGroup({ id: grp.id });

      const result = await caller.getBookmarks();
      expect(result.groups).toEqual([]);
      const survivingBm = result.bookmarks.find((b) => b.id === bm.id);
      expect(survivingBm?.groupId).toBeNull();
    });
  });

  describe('exportBookmarks', () => {
    it('exports all bookmarks and groups', async () => {
      await caller.addBookmark({ input: { url: 'https://a.com', title: 'A', frequent: true } });
      await caller.addGroup({ input: { name: 'Work' } });

      const data = await caller.exportBookmarks();
      expect(data.version).toBe(1);
      expect(data.bookmarks).toHaveLength(1);
      expect(data.groups).toHaveLength(1);
    });
  });

  describe('importBookmarks', () => {
    it('imports valid bookmarks', async () => {
      const result = await caller.importBookmarks({
        data: {
          version: 1,
          bookmarks: [
            { id: 'imp-1', url: 'https://imported.com', title: 'Imported', groupId: null, frequent: false, order: 0 },
          ],
          groups: [],
        },
      });
      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(0);
    });

    it('skips invalid URLs', async () => {
      const result = await caller.importBookmarks({
        data: {
          version: 1,
          bookmarks: [
            { id: 'imp-1', url: 'file:///secret', title: 'Bad', groupId: null, frequent: false, order: 0 },
          ],
          groups: [],
        },
      });
      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(1);
    });
  });

  describe('clearBrowserData', () => {
    it('clears the browser session partition', async () => {
      await caller.clearBrowserData();
      expect(electronSession.fromPartition).toHaveBeenCalledWith('persist:soc-verify-browser');
    });
  });
});
