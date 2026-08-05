/**
 * openInBrowser — unified URL opening seam tests.
 *
 * Seam: openInBrowser(url) function — the single entry point for business
 * callers that want to open a URL in the Browser Surface.
 *
 * Tests verify:
 * - Valid http/https URL opens a new browser destination
 * - Existing tab with the same normalized URL is activated instead of creating a new one
 * - Invalid URL is rejected silently (no destination opened)
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { openInBrowser } from '@renderer/lib/browser-actions';
import { useBrowserStore } from '@renderer/stores/browser';
import { useWorkbenchStore } from '@renderer/stores/workbench';

describe('openInBrowser', () => {
  beforeEach(() => {
    useBrowserStore.setState({ tabs: {}, order: [] });
    useWorkbenchStore.setState({ tabs: [], activeTabId: null });
  });

  it('opens a new browser destination for a valid https URL', () => {
    openInBrowser('https://example.com');

    const state = useWorkbenchStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].destination.type).toBe('browser');
    if (state.tabs[0].destination.type === 'browser') {
      expect(state.tabs[0].destination.url).toBe('https://example.com');
    }
  });

  it('opens a new browser destination for a valid http URL', () => {
    openInBrowser('http://internal.local:8080/dashboard');

    const state = useWorkbenchStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].destination.type).toBe('browser');
    if (state.tabs[0].destination.type === 'browser') {
      expect(state.tabs[0].destination.url).toBe('http://internal.local:8080/dashboard');
    }
  });

  it('normalizes a bare domain by prepending https://', () => {
    openInBrowser('example.com');

    const state = useWorkbenchStore.getState();
    expect(state.tabs).toHaveLength(1);
    if (state.tabs[0].destination.type === 'browser') {
      expect(state.tabs[0].destination.url).toBe('https://example.com');
    }
  });

  it('activates an existing tab when the URL matches instead of creating a new one', () => {
    // Simulate an existing browser tab
    const existingSurfaceId = 'browser-existing';
    useBrowserStore.getState().createTab(existingSurfaceId);
    useBrowserStore.getState().setUrl(existingSurfaceId, 'https://example.com');
    useWorkbenchStore.getState().open({
      type: 'browser',
      surfaceId: existingSurfaceId,
      url: 'https://example.com',
    });

    // Now call openInBrowser with the same URL
    openInBrowser('https://example.com');

    // Should not create a second tab — just activate the existing one
    const state = useWorkbenchStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe(`browser:${existingSurfaceId}`);
  });

  it('rejects non-http(s) URLs silently', () => {
    openInBrowser('javascript:alert(1)');
    openInBrowser('file:///etc/passwd');

    const state = useWorkbenchStore.getState();
    expect(state.tabs).toHaveLength(0);
  });

  it('rejects empty input', () => {
    openInBrowser('');
    openInBrowser('   ');

    const state = useWorkbenchStore.getState();
    expect(state.tabs).toHaveLength(0);
  });
});
