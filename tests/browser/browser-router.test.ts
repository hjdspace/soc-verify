/**
 * browser-router tests — tRPC API for browser tab persistence.
 *
 * Seam: tRPC server-side caller (router.createCaller).
 *
 * Tests verify:
 * - getTabs returns persisted tab state (or empty if none)
 * - saveTabs persists tabs and activeTabId
 * - flushTabs synchronously writes tabs for app exit
 * - Round-trip: saveTabs → getTabs preserves data
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { browserRouter, setBrowserStoreDir, flushBrowserStore } from '../../src/main/ipc/routers/browser-router';
import type { PersistedBrowserTab } from '../../src/shared/browser-types';

const TMP_BASE = tmpdir();

describe('browser-router', () => {
  let tmpDir: string;
  let caller: ReturnType<typeof browserRouter.createCaller>;

  beforeEach(() => {
    tmpDir = join(TMP_BASE, `sv-browser-router-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(tmpDir, { recursive: true });
    setBrowserStoreDir(tmpDir);
    caller = browserRouter.createCaller({});
  });

  afterEach(() => {
    flushBrowserStore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getTabs', () => {
    it('returns empty state when no tabs have been saved', async () => {
      const result = await caller.getTabs();
      expect(result.tabs).toEqual([]);
      expect(result.activeTabId).toBeNull();
    });

    it('returns saved tabs after saveTabs', async () => {
      const tabs: PersistedBrowserTab[] = [
        { surfaceId: 'tab-1', url: 'https://example.com', title: 'Example' },
        { surfaceId: 'tab-2', url: 'https://other.com', title: 'Other' },
      ];
      await caller.saveTabs({ tabs, activeTabId: 'tab-1' });

      const result = await caller.getTabs();
      expect(result.tabs).toHaveLength(2);
      expect(result.tabs[0].surfaceId).toBe('tab-1');
      expect(result.activeTabId).toBe('tab-1');
    });
  });

  describe('saveTabs', () => {
    it('saves tabs with activeTabId', async () => {
      const tabs: PersistedBrowserTab[] = [
        { surfaceId: 'tab-1', url: 'https://a.com', title: 'A' },
      ];
      await caller.saveTabs({ tabs, activeTabId: 'tab-1' });
      const result = await caller.getTabs();
      expect(result.tabs).toEqual(tabs);
      expect(result.activeTabId).toBe('tab-1');
    });

    it('saves empty tab list with null activeTabId', async () => {
      await caller.saveTabs({ tabs: [], activeTabId: null });
      const result = await caller.getTabs();
      expect(result.tabs).toEqual([]);
      expect(result.activeTabId).toBeNull();
    });

    it('overwrites previous state', async () => {
      await caller.saveTabs({
        tabs: [{ surfaceId: 'tab-1', url: 'https://a.com', title: 'A' }],
        activeTabId: 'tab-1',
      });
      await caller.saveTabs({
        tabs: [{ surfaceId: 'tab-2', url: 'https://b.com', title: 'B' }],
        activeTabId: 'tab-2',
      });
      const result = await caller.getTabs();
      expect(result.tabs).toHaveLength(1);
      expect(result.tabs[0].surfaceId).toBe('tab-2');
    });
  });

  describe('flushTabs', () => {
    it('synchronously flushes tabs to disk', async () => {
      const tabs: PersistedBrowserTab[] = [
        { surfaceId: 'tab-1', url: 'https://example.com', title: 'Example' },
      ];
      await caller.flushTabs({ tabs, activeTabId: 'tab-1' });

      // Read back via getTabs (async load)
      const result = await caller.getTabs();
      expect(result.tabs).toEqual(tabs);
      expect(result.activeTabId).toBe('tab-1');
    });
  });
});
