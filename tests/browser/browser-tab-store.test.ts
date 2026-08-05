/**
 * BrowserTabStore tests — persistence layer for browser tabs.
 *
 * Seam: BrowserTabStore class (public methods: load, save, saveSync)
 *
 * Tests verify:
 * - Loading from a valid file returns persisted tabs
 * - Loading from a missing file returns empty state (not an error)
 * - Loading from a corrupted file returns empty state (graceful degradation)
 * - Loading from an unsupported version returns empty state
 * - Save writes atomically (temp file + rename)
 * - saveSync flushes synchronously for app exit
 * - Round-trip: save → load preserves data
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserTabStore } from '../../src/main/browser/browser-tab-store';
import type { PersistedBrowserTabs } from '../../src/shared/browser-types';

const TMP_DIR = join(process.cwd(), '.tmp', 'test-browser-tab-store');

async function setupDir(): Promise<void> {
  await mkdir(TMP_DIR, { recursive: true });
}

async function cleanupDir(): Promise<void> {
  await rm(TMP_DIR, { recursive: true, force: true });
}

function makeStore(): BrowserTabStore {
  return new BrowserTabStore(TMP_DIR);
}

describe('BrowserTabStore', () => {
  beforeEach(async () => {
    await cleanupDir();
    await setupDir();
  });

  afterEach(async () => {
    await cleanupDir();
  });

  it('returns empty state when no file exists', async () => {
    const store = makeStore();
    const result = await store.load();
    expect(result.tabs).toEqual([]);
    expect(result.activeTabId).toBeNull();
  });

  it('loads persisted tabs from a valid file', async () => {
    const data: PersistedBrowserTabs = {
      version: 1,
      tabs: [
        { surfaceId: 'tab-1', url: 'https://example.com', title: 'Example' },
        { surfaceId: 'tab-2', url: 'https://other.com', title: 'Other' },
      ],
      activeTabId: 'tab-1',
    };
    await writeFile(join(TMP_DIR, 'browser-tabs.json'), JSON.stringify(data), 'utf-8');

    const store = makeStore();
    const result = await store.load();
    expect(result.tabs).toHaveLength(2);
    expect(result.tabs[0].surfaceId).toBe('tab-1');
    expect(result.tabs[0].url).toBe('https://example.com');
    expect(result.activeTabId).toBe('tab-1');
  });

  it('returns empty state when file is corrupted (invalid JSON)', async () => {
    await writeFile(join(TMP_DIR, 'browser-tabs.json'), '{ broken json !!!', 'utf-8');

    const store = makeStore();
    const result = await store.load();
    expect(result.tabs).toEqual([]);
    expect(result.activeTabId).toBeNull();
  });

  it('returns empty state when version is unsupported', async () => {
    const data = {
      version: 999,
      tabs: [{ surfaceId: 'tab-1', url: 'https://example.com', title: 'Example' }],
      activeTabId: 'tab-1',
    };
    await writeFile(join(TMP_DIR, 'browser-tabs.json'), JSON.stringify(data), 'utf-8');

    const store = makeStore();
    const result = await store.load();
    expect(result.tabs).toEqual([]);
    expect(result.activeTabId).toBeNull();
  });

  it('saves tabs and loads them back (round-trip)', async () => {
    const store = makeStore();
    const tabs = [
      { surfaceId: 'tab-1', url: 'https://example.com', title: 'Example' },
      { surfaceId: 'tab-2', url: 'https://other.com', title: 'Other' },
    ];
    await store.save(tabs, 'tab-2');

    const result = await store.load();
    expect(result.tabs).toEqual(tabs);
    expect(result.activeTabId).toBe('tab-2');
  });

  it('writes atomically — no partial file on crash during write', async () => {
    const store = makeStore();
    await store.save(
      [{ surfaceId: 'tab-1', url: 'https://example.com', title: 'Example' }],
      'tab-1',
    );

    // The main file should exist and be valid
    const mainFile = join(TMP_DIR, 'browser-tabs.json');
    expect(existsSync(mainFile)).toBe(true);

    // No temp file should remain
    const tempFile = join(TMP_DIR, 'browser-tabs.json.tmp');
    expect(existsSync(tempFile)).toBe(false);

    // Content should be valid JSON
    const content = await readFile(mainFile, 'utf-8');
    const parsed = JSON.parse(content) as PersistedBrowserTabs;
    expect(parsed.version).toBe(1);
    expect(parsed.tabs).toHaveLength(1);
  });

  it('saveSync writes synchronously for app exit', () => {
    const store = makeStore();
    const tabs = [
      { surfaceId: 'tab-1', url: 'https://example.com', title: 'Example' },
    ];
    store.saveSync(tabs, 'tab-1');

    // Verify the file exists and is valid
    const mainFile = join(TMP_DIR, 'browser-tabs.json');
    expect(existsSync(mainFile)).toBe(true);

    // Re-read via load to verify
    return store.load().then((result) => {
      expect(result.tabs).toEqual(tabs);
      expect(result.activeTabId).toBe('tab-1');
    });
  });

  it('overwrites previous save with new state', async () => {
    const store = makeStore();
    await store.save(
      [{ surfaceId: 'tab-1', url: 'https://a.com', title: 'A' }],
      'tab-1',
    );
    await store.save(
      [{ surfaceId: 'tab-2', url: 'https://b.com', title: 'B' }],
      'tab-2',
    );

    const result = await store.load();
    expect(result.tabs).toHaveLength(1);
    expect(result.tabs[0].surfaceId).toBe('tab-2');
    expect(result.activeTabId).toBe('tab-2');
  });

  it('saves empty tab list correctly', async () => {
    const store = makeStore();
    await store.save([], null);

    const result = await store.load();
    expect(result.tabs).toEqual([]);
    expect(result.activeTabId).toBeNull();
  });

  it('preserves tab order from the input array', async () => {
    const store = makeStore();
    const tabs = [
      { surfaceId: 'tab-3', url: 'https://c.com', title: 'C' },
      { surfaceId: 'tab-1', url: 'https://a.com', title: 'A' },
      { surfaceId: 'tab-2', url: 'https://b.com', title: 'B' },
    ];
    await store.save(tabs, 'tab-1');

    const result = await store.load();
    expect(result.tabs.map((t) => t.surfaceId)).toEqual(['tab-3', 'tab-1', 'tab-2']);
  });
});
