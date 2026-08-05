/**
 * Browser store 测试。
 *
 * 验证 URL 标准化、标签创建/移除、surface 事件投影和标签复用查找。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { useBrowserStore, normalizeUrl } from '@renderer/stores/browser';
import type { SurfaceEvent } from '@shared/surface-types';

describe('normalizeUrl', () => {
  it('adds https:// prefix when scheme is missing', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com');
  });

  it('preserves http:// scheme', () => {
    expect(normalizeUrl('http://example.com')).toBe('http://example.com');
  });

  it('preserves https:// scheme', () => {
    expect(normalizeUrl('https://example.com')).toBe('https://example.com');
  });

  it('removes trailing slash for root paths', () => {
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com');
  });

  it('preserves trailing slash for non-root paths', () => {
    expect(normalizeUrl('https://example.com/path/')).toBe('https://example.com/path/');
  });

  it('preserves query params and fragments', () => {
    expect(normalizeUrl('example.com/page?id=1#section')).toBe('https://example.com/page?id=1#section');
  });

  it('returns null for empty input', () => {
    expect(normalizeUrl('')).toBeNull();
    expect(normalizeUrl('   ')).toBeNull();
  });

  it('returns null for non-http/https protocols', () => {
    expect(normalizeUrl('file:///tmp/secret')).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
  });

  it('returns null for invalid URLs', () => {
    expect(normalizeUrl('not a url at all')).toBeNull();
  });

  it('trims whitespace', () => {
    expect(normalizeUrl('  https://example.com  ')).toBe('https://example.com');
  });
});

describe('BrowserStore', () => {
  beforeEach(() => {
    useBrowserStore.setState({ tabs: {}, order: [] });
  });

  it('creates a new tab with homepage state', () => {
    useBrowserStore.getState().createTab('surface-1');
    const tab = useBrowserStore.getState().getTab('surface-1');
    expect(tab).toBeDefined();
    expect(tab?.url).toBe('');
    expect(tab?.title).toBe('新标签页');
    expect(tab?.loading).toBe(false);
  });

  it('does not duplicate tab on repeated createTab', () => {
    useBrowserStore.getState().createTab('surface-1');
    useBrowserStore.getState().createTab('surface-1');
    expect(Object.keys(useBrowserStore.getState().tabs)).toHaveLength(1);
  });

  it('removes a tab', () => {
    useBrowserStore.getState().createTab('surface-1');
    useBrowserStore.getState().removeTab('surface-1');
    expect(useBrowserStore.getState().getTab('surface-1')).toBeUndefined();
  });

  it('sets URL and transitions to loading state', () => {
    useBrowserStore.getState().createTab('surface-1');
    useBrowserStore.getState().setUrl('surface-1', 'https://example.com');
    const tab = useBrowserStore.getState().getTab('surface-1');
    expect(tab?.url).toBe('https://example.com');
    expect(tab?.initialUrl).toBe('https://example.com');
    expect(tab?.loading).toBe(true);
    expect(tab?.error).toBeNull();
  });

  it('applies url event from surface', () => {
    useBrowserStore.getState().createTab('surface-1');
    const event: SurfaceEvent = { id: 'surface-1', type: 'url', url: 'https://example.com/page' };
    useBrowserStore.getState().applyEvent(event);
    expect(useBrowserStore.getState().getTab('surface-1')?.url).toBe('https://example.com/page');
  });

  it('applies title event from surface', () => {
    useBrowserStore.getState().createTab('surface-1');
    const event: SurfaceEvent = { id: 'surface-1', type: 'title', title: 'Example Page' };
    useBrowserStore.getState().applyEvent(event);
    expect(useBrowserStore.getState().getTab('surface-1')?.title).toBe('Example Page');
  });

  it('applies loading event from surface', () => {
    useBrowserStore.getState().createTab('surface-1');
    const event: SurfaceEvent = { id: 'surface-1', type: 'loading', loading: true };
    useBrowserStore.getState().applyEvent(event);
    expect(useBrowserStore.getState().getTab('surface-1')?.loading).toBe(true);
  });

  it('applies navigation event from surface', () => {
    useBrowserStore.getState().createTab('surface-1');
    const event: SurfaceEvent = { id: 'surface-1', type: 'navigation', canGoBack: true, canGoForward: false };
    useBrowserStore.getState().applyEvent(event);
    const tab = useBrowserStore.getState().getTab('surface-1');
    expect(tab?.canGoBack).toBe(true);
    expect(tab?.canGoForward).toBe(false);
  });

  it('applies failure event from surface (main frame only)', () => {
    useBrowserStore.getState().createTab('surface-1');
    const event: SurfaceEvent = {
      id: 'surface-1',
      type: 'failure',
      errorCode: -105,
      errorDescription: 'Connection refused',
      validatedURL: 'https://example.com',
      isMainFrame: true,
    };
    useBrowserStore.getState().applyEvent(event);
    expect(useBrowserStore.getState().getTab('surface-1')?.error).toBe('Connection refused');
  });

  it('ignores failure event for sub-frame', () => {
    useBrowserStore.getState().createTab('surface-1');
    const event: SurfaceEvent = {
      id: 'surface-1',
      type: 'failure',
      errorCode: -105,
      errorDescription: 'Connection refused',
      validatedURL: 'https://example.com',
      isMainFrame: false,
    };
    useBrowserStore.getState().applyEvent(event);
    expect(useBrowserStore.getState().getTab('surface-1')?.error).toBeNull();
  });

  it('applies crash event from surface', () => {
    useBrowserStore.getState().createTab('surface-1');
    const event: SurfaceEvent = { id: 'surface-1', type: 'crash', reason: 'crashed', exitCode: 9 };
    useBrowserStore.getState().applyEvent(event);
    expect(useBrowserStore.getState().getTab('surface-1')?.error).toContain('崩溃');
  });

  it('ignores events for unknown surface ids', () => {
    useBrowserStore.getState().createTab('surface-1');
    const event: SurfaceEvent = { id: 'unknown', type: 'url', url: 'https://example.com' };
    useBrowserStore.getState().applyEvent(event);
    // Should not crash and should not affect surface-1
    expect(useBrowserStore.getState().getTab('surface-1')?.url).toBe('');
  });

  it('finds existing tab by URL', () => {
    useBrowserStore.getState().createTab('surface-1');
    useBrowserStore.getState().setUrl('surface-1', 'https://example.com');
    useBrowserStore.getState().createTab('surface-2');
    useBrowserStore.getState().setUrl('surface-2', 'https://other.com');

    const found = useBrowserStore.getState().findByUrl('https://example.com');
    expect(found?.surfaceId).toBe('surface-1');
  });

  it('returns undefined when no tab matches URL', () => {
    useBrowserStore.getState().createTab('surface-1');
    useBrowserStore.getState().setUrl('surface-1', 'https://example.com');
    expect(useBrowserStore.getState().findByUrl('https://nonexistent.com')).toBeUndefined();
  });
});
