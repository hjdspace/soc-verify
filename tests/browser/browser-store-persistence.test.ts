/**
 * Browser store persistence and crash handling tests.
 *
 * Seam: useBrowserStore (Zustand store public interface)
 *
 * Tests verify:
 * - serializeForPersistence exports tab state in the correct format
 * - restoreFromPersisted imports tabs from persisted format
 * - 12-tab soft limit detection
 * - Crash state shows error and supports reload
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { useBrowserStore } from '@renderer/stores/browser';
import type { SurfaceEvent } from '@shared/surface-types';
import { BROWSER_TAB_SOFT_LIMIT } from '@shared/browser-types';

describe('BrowserStore persistence & crash', () => {
  beforeEach(() => {
    useBrowserStore.setState({ tabs: {}, order: [] });
  });

  describe('serializeForPersistence', () => {
    it('exports tabs with surfaceId, url, and title', () => {
      useBrowserStore.getState().createTab('s1');
      useBrowserStore.getState().setUrl('s1', 'https://example.com');
      // Simulate title update from surface event
      useBrowserStore.getState().applyEvent({ id: 's1', type: 'title', title: 'Example' });

      const serialized = useBrowserStore.getState().serializeForPersistence();
      expect(serialized.tabs).toHaveLength(1);
      expect(serialized.tabs[0]).toEqual({
        surfaceId: 's1',
        url: 'https://example.com',
        title: 'Example',
      });
    });

    it('excludes tabs with empty URL (new-tab homepage)', () => {
      useBrowserStore.getState().createTab('s1');
      useBrowserStore.getState().createTab('s2');
      useBrowserStore.getState().setUrl('s2', 'https://other.com');

      const serialized = useBrowserStore.getState().serializeForPersistence();
      expect(serialized.tabs).toHaveLength(1);
      expect(serialized.tabs[0].surfaceId).toBe('s2');
    });

    it('preserves tab order', () => {
      useBrowserStore.getState().createTab('s1');
      useBrowserStore.getState().setUrl('s1', 'https://a.com');
      useBrowserStore.getState().createTab('s2');
      useBrowserStore.getState().setUrl('s2', 'https://b.com');
      useBrowserStore.getState().createTab('s3');
      useBrowserStore.getState().setUrl('s3', 'https://c.com');

      const serialized = useBrowserStore.getState().serializeForPersistence();
      expect(serialized.tabs.map((t) => t.surfaceId)).toEqual(['s1', 's2', 's3']);
    });

    it('returns empty array when no tabs exist', () => {
      const serialized = useBrowserStore.getState().serializeForPersistence();
      expect(serialized.tabs).toEqual([]);
    });
  });

  describe('restoreFromPersisted', () => {
    it('imports tabs from persisted format', () => {
      useBrowserStore.getState().restoreFromPersisted({
        version: 1,
        tabs: [
          { surfaceId: 'restored-1', url: 'https://example.com', title: 'Example' },
          { surfaceId: 'restored-2', url: 'https://other.com', title: 'Other' },
        ],
        activeTabId: 'restored-1',
      });

      const tab1 = useBrowserStore.getState().getTab('restored-1');
      expect(tab1).toBeDefined();
      expect(tab1?.url).toBe('https://example.com');
      expect(tab1?.title).toBe('Example');

      const tab2 = useBrowserStore.getState().getTab('restored-2');
      expect(tab2).toBeDefined();
      expect(tab2?.url).toBe('https://other.com');
    });

    it('clears existing tabs before restoring', () => {
      useBrowserStore.getState().createTab('old-tab');
      useBrowserStore.getState().setUrl('old-tab', 'https://old.com');

      useBrowserStore.getState().restoreFromPersisted({
        version: 1,
        tabs: [{ surfaceId: 'new-tab', url: 'https://new.com', title: 'New' }],
        activeTabId: 'new-tab',
      });

      expect(useBrowserStore.getState().getTab('old-tab')).toBeUndefined();
      expect(useBrowserStore.getState().getTab('new-tab')).toBeDefined();
    });

    it('handles empty persisted state', () => {
      useBrowserStore.getState().restoreFromPersisted({
        version: 1,
        tabs: [],
        activeTabId: null,
      });
      expect(Object.keys(useBrowserStore.getState().tabs)).toHaveLength(0);
    });
  });

  describe('tab soft limit', () => {
    it('exceedsSoftLimit returns true when tab count exceeds limit', () => {
      for (let i = 0; i <= BROWSER_TAB_SOFT_LIMIT; i++) {
        useBrowserStore.getState().createTab(`tab-${i}`);
      }
      expect(useBrowserStore.getState().exceedsSoftLimit()).toBe(true);
    });

    it('exceedsSoftLimit returns false when tab count is at or below limit', () => {
      for (let i = 0; i < BROWSER_TAB_SOFT_LIMIT; i++) {
        useBrowserStore.getState().createTab(`tab-${i}`);
      }
      expect(useBrowserStore.getState().exceedsSoftLimit()).toBe(false);
    });
  });

  describe('crash handling', () => {
    it('crash event sets crashed flag and error message', () => {
      useBrowserStore.getState().createTab('s1');
      useBrowserStore.getState().setUrl('s1', 'https://example.com');

      const event: SurfaceEvent = { id: 's1', type: 'crash', reason: 'crashed', exitCode: 9 };
      useBrowserStore.getState().applyEvent(event);

      const tab = useBrowserStore.getState().getTab('s1');
      expect(tab?.crashed).toBe(true);
      expect(tab?.error).toContain('崩溃');
    });

    it('reloadTab clears crashed state', () => {
      useBrowserStore.getState().createTab('s1');
      useBrowserStore.getState().setUrl('s1', 'https://example.com');
      useBrowserStore.getState().applyEvent({ id: 's1', type: 'crash', reason: 'crashed', exitCode: 9 });

      useBrowserStore.getState().reloadTab('s1');

      const tab = useBrowserStore.getState().getTab('s1');
      expect(tab?.crashed).toBe(false);
      expect(tab?.error).toBeNull();
    });
  });
});
