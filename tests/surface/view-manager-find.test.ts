/**
 * ViewManager find-in-page tests.
 *
 * Seam: ViewManager.findInPage / stopFindInPage public methods and
 * the find-result surface event emitted when the webContents fires found-in-page.
 *
 * Tests verify:
 * - findInPage delegates to webContents.findInPage with searchText and forward direction
 * - findInPage with forward=false searches backwards
 * - stopFindInPage delegates to webContents.stopFindInPage with clearSelection action
 * - found-in-page event emits a find-result surface event with match count and active ordinal
 */
import { describe, expect, it, vi } from 'vitest';
import { ViewManager, type SurfaceHost, type SurfaceView } from '../../src/main/surface/view-manager';
import type { SurfaceDeclaration } from '../../src/shared/surface-types';

function declaration(overrides: Partial<SurfaceDeclaration> = {}): SurfaceDeclaration {
  return {
    id: 'surface-1',
    kind: 'browser',
    source: { type: 'url', url: 'https://example.com' },
    visible: true,
    bounds: { x: 0, y: 0, width: 800, height: 500 },
    ...overrides,
  };
}

function setup() {
  const listeners = new Map<string, Set<(...args: never[]) => void>>();
  const webContents = {
    on: vi.fn((event: string, listener: (...args: never[]) => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return webContents;
    }),
    off: vi.fn((event: string, listener: (...args: never[]) => void) => {
      listeners.get(event)?.delete(listener);
      return webContents;
    }),
    loadURL: vi.fn().mockResolvedValue(undefined),
    getURL: vi.fn().mockReturnValue('https://example.com'),
    getTitle: vi.fn().mockReturnValue('Example'),
    isDestroyed: vi.fn().mockReturnValue(false),
    destroy: vi.fn(),
    insertCSS: vi.fn().mockResolvedValue('css-key'),
    navigationHistory: {
      canGoBack: vi.fn().mockReturnValue(false),
      canGoForward: vi.fn().mockReturnValue(false),
    },
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    findInPage: vi.fn(),
    stopFindInPage: vi.fn(),
  };
  const view: SurfaceView = {
    webContents,
    setBounds: vi.fn(),
    setVisible: vi.fn(),
  };
  const host: SurfaceHost = {
    contentView: {
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
    },
    getContentBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 1000, height: 700 }),
    isDestroyed: vi.fn().mockReturnValue(false),
  };
  const events: unknown[] = [];
  const manager = new ViewManager(host, {
    createView: vi.fn(() => view),
    emit: (event) => events.push(event),
  });
  return { manager, host, view, webContents, listeners, events };
}

/** Emit a mock found-in-page event on the webContents listener map. */
function emitFoundInPage(
  listeners: Map<string, Set<(...args: never[]) => void>>,
  result: { activeMatchOrdinal: number; matches: number; finalUpdate: boolean },
) {
  const set = listeners.get('found-in-page');
  if (!set) throw new Error('found-in-page listener not bound');
  for (const listener of set) {
    listener({} as never, result as never);
  }
}

describe('ViewManager find-in-page', () => {
  it('findInPage delegates to webContents.findInPage with forward search', async () => {
    const { manager, webContents } = setup();
    await manager.sync(declaration());

    manager.findInPage('surface-1', 'hello');

    expect(webContents.findInPage).toHaveBeenCalledWith('hello', { forward: true });
  });

  it('findInPage with forward=false searches backwards', async () => {
    const { manager, webContents } = setup();
    await manager.sync(declaration());

    manager.findInPage('surface-1', 'hello', { forward: false });

    expect(webContents.findInPage).toHaveBeenCalledWith('hello', { forward: false });
  });

  it('findInPage is a no-op for an unknown surface id', async () => {
    const { manager, webContents } = setup();
    await manager.sync(declaration());

    manager.findInPage('nonexistent', 'hello');

    expect(webContents.findInPage).not.toHaveBeenCalled();
  });

  it('stopFindInPage delegates to webContents.stopFindInPage with clearSelection', async () => {
    const { manager, webContents } = setup();
    await manager.sync(declaration());

    manager.stopFindInPage('surface-1', 'clearSelection');

    expect(webContents.stopFindInPage).toHaveBeenCalledWith('clearSelection');
  });

  it('stopFindInPage defaults to clearSelection action', async () => {
    const { manager, webContents } = setup();
    await manager.sync(declaration());

    manager.stopFindInPage('surface-1');

    expect(webContents.stopFindInPage).toHaveBeenCalledWith('clearSelection');
  });

  it('emits find-result surface event when found-in-page fires', async () => {
    const { manager, listeners, events } = setup();
    await manager.sync(declaration());

    // Simulate Electron's found-in-page event
    emitFoundInPage(listeners, { activeMatchOrdinal: 2, matches: 5, finalUpdate: true });

    const findEvents = events.filter(
      (e) => (e as { type: string }).type === 'find-result',
    );
    expect(findEvents).toHaveLength(1);
    const event = findEvents[0] as { id: string; type: string; activeMatchOrdinal: number; matches: number; finalUpdate: boolean };
    expect(event.id).toBe('surface-1');
    expect(event.activeMatchOrdinal).toBe(2);
    expect(event.matches).toBe(5);
    expect(event.finalUpdate).toBe(true);
  });

  it('does not emit find-result after surface is destroyed', async () => {
    const { manager, listeners, events } = setup();
    await manager.sync(declaration());

    manager.destroy('surface-1');
    events.length = 0;

    // found-in-page listener should have been removed — the set should be empty
    const set = listeners.get('found-in-page');
    expect(set?.size ?? 0).toBe(0);
    expect(events).toHaveLength(0);
  });
});
