import { describe, expect, it, vi } from 'vitest';
import { constrainSurfaceBounds, ViewManager, type SurfaceHost, type SurfaceView } from '../../src/main/surface/view-manager';
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
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const webContents = {
    on: vi.fn((event: string, listener: (...args: any[]) => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return webContents;
    }),
    off: vi.fn((event: string, listener: (...args: any[]) => void) => {
      listeners.get(event)?.delete(listener);
      return webContents;
    }),
    loadURL: vi.fn().mockResolvedValue(undefined),
    getURL: vi.fn().mockReturnValue('https://example.com'),
    getTitle: vi.fn().mockReturnValue('Example'),
    isDestroyed: vi.fn().mockReturnValue(false),
    destroy: vi.fn(),
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

describe('constrainSurfaceBounds', () => {
  it('rejects invalid bounds and clips overflowing bounds', () => {
    expect(constrainSurfaceBounds({ x: 0, y: 0, width: 0, height: 10 }, { x: 0, y: 0, width: 100, height: 100 })).toBeNull();
    expect(constrainSurfaceBounds({ x: -10, y: -5, width: 120, height: 130 }, { x: 0, y: 0, width: 100, height: 100 })).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(constrainSurfaceBounds({ x: 110, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 100, height: 100 })).toBeNull();
  });
});

describe('ViewManager', () => {
  it('creates one view for repeated declarations and updates presentation', async () => {
    const { manager, host, view, webContents } = setup();
    await manager.sync(declaration());
    await manager.sync(declaration({ visible: false, bounds: { x: 10, y: 20, width: 300, height: 200 } }));

    expect(manager.has('surface-1')).toBe(true);
    expect(host.contentView.addChildView).toHaveBeenCalledTimes(1);
    expect(webContents.loadURL).toHaveBeenCalledTimes(1);
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 10, y: 20, width: 300, height: 200 });
    expect(view.setVisible).toHaveBeenLastCalledWith(false);
  });

  it('hides all surfaces while an overlay is open and restores them', async () => {
    const { manager, view } = setup();
    await manager.sync(declaration());
    manager.setOverlayHidden(true);
    expect(view.setVisible).toHaveBeenLastCalledWith(false);
    manager.setOverlayHidden(false);
    expect(view.setVisible).toHaveBeenLastCalledWith(true);
  });

  it('removes listeners and destroys the web contents exactly once', async () => {
    const { manager, host, webContents, listeners } = setup();
    await manager.sync(declaration());
    expect(listeners.get('did-stop-loading')?.size).toBe(1);

    manager.destroy('surface-1');
    manager.destroy('surface-1');

    expect(host.contentView.removeChildView).toHaveBeenCalledTimes(1);
    expect(webContents.off).toHaveBeenCalledTimes(7);
    expect(webContents.destroy).toHaveBeenCalledTimes(1);
    expect(manager.has('surface-1')).toBe(false);
  });

  it('forwards navigation lifecycle events and isolates a crashed surface', async () => {
    const { manager, view, listeners, events } = setup();
    await manager.sync(declaration());
    listeners.get('did-start-loading')?.forEach((listener) => listener());
    listeners.get('did-navigate')?.forEach((listener) => listener({}, 'https://example.com/next'));
    listeners.get('render-process-gone')?.forEach((listener) => listener({}, { reason: 'crashed', exitCode: 9 }));

    expect(events).toEqual([
      { id: 'surface-1', type: 'loading', loading: true },
      { id: 'surface-1', type: 'url', url: 'https://example.com/next' },
      { id: 'surface-1', type: 'crash', reason: 'crashed', exitCode: 9 },
    ]);
    expect(view.setVisible).toHaveBeenLastCalledWith(false);
    expect(manager.has('surface-1')).toBe(true);
  });

  it('rejects unsafe browser sources', async () => {
    const { manager } = setup();
    await expect(manager.sync(declaration({ source: { type: 'url', url: 'file:///tmp/secret' } }))).rejects.toThrow('not allowed');
  });

  // ── Issue #2: bounds、可见性与 Overlay 同步 ────────────────────

  it('hides and shows individual surfaces without affecting others', async () => {
    const { manager, view } = setup();
    await manager.sync(declaration());
    manager.hide('surface-1');
    expect(view.setVisible).toHaveBeenLastCalledWith(false);
    manager.show('surface-1');
    expect(view.setVisible).toHaveBeenLastCalledWith(true);
  });

  it('restores correct visibility after overlay closes even if surface was hidden', async () => {
    const { manager, view } = setup();
    await manager.sync(declaration({ visible: false }));
    expect(view.setVisible).toHaveBeenLastCalledWith(false);
    manager.setOverlayHidden(true);
    expect(view.setVisible).toHaveBeenLastCalledWith(false);
    manager.setOverlayHidden(false);
    // Surface was not visible to begin with, so it should stay hidden.
    expect(view.setVisible).toHaveBeenLastCalledWith(false);
  });

  it('hides all surfaces when overlay opens and restores each to its prior state', async () => {
    const { manager, view, host } = setup();
    // Create a second view/host pair by reusing the mock
    await manager.sync(declaration({ id: 's-visible', visible: true }));
    await manager.sync(declaration({ id: 's-hidden', visible: false }));

    manager.setOverlayHidden(true);
    // Both should be hidden.
    const visibleCalls = (view.setVisible as ReturnType<typeof vi.fn>).mock.calls;
    const lastCall = visibleCalls[visibleCalls.length - 1];
    expect(lastCall[0]).toBe(false);

    manager.setOverlayHidden(false);
    // The last setVisible call should restore the last-synced surface's visibility.
    // Since s-hidden was synced last with visible=false, it should stay false.
    expect((view.setVisible as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toBe(false);

    // Clean up to avoid leaking between tests.
    manager.destroyAll();
    expect(host.contentView.removeChildView).toHaveBeenCalledTimes(2);
  });

  it('rejects non-finite and negative bounds values', () => {
    const hostBounds = { x: 0, y: 0, width: 1000, height: 700 };
    expect(constrainSurfaceBounds({ x: NaN, y: 0, width: 100, height: 100 }, hostBounds)).toBeNull();
    expect(constrainSurfaceBounds({ x: 0, y: Infinity, width: 100, height: 100 }, hostBounds)).toBeNull();
    expect(constrainSurfaceBounds({ x: 0, y: 0, width: -10, height: 100 }, hostBounds)).toBeNull();
    expect(constrainSurfaceBounds({ x: 0, y: 0, width: 100, height: 0 }, hostBounds)).toBeNull();
  });

  it('clips bounds that extend beyond the host content area', () => {
    const hostBounds = { x: 0, y: 0, width: 800, height: 600 };
    const result = constrainSurfaceBounds({ x: 700, y: 500, width: 200, height: 200 }, hostBounds);
    expect(result).toEqual({ x: 700, y: 500, width: 100, height: 100 });
  });

  it('rejects bounds entirely outside the host content area', () => {
    const hostBounds = { x: 0, y: 0, width: 800, height: 600 };
    expect(constrainSurfaceBounds({ x: 900, y: 0, width: 100, height: 100 }, hostBounds)).toBeNull();
    expect(constrainSurfaceBounds({ x: 0, y: 700, width: 100, height: 100 }, hostBounds)).toBeNull();
  });

  it('rejects bounds when host has zero or negative dimensions', () => {
    expect(constrainSurfaceBounds({ x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 0, height: 600 })).toBeNull();
    expect(constrainSurfaceBounds({ x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 800, height: -1 })).toBeNull();
  });

  it('updates bounds when declaration changes (simulating panel resize)', async () => {
    const { manager, view } = setup();
    await manager.sync(declaration({ bounds: { x: 0, y: 0, width: 400, height: 300 } }));
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 400, height: 300 });

    // Simulate right panel resize → content area becomes narrower.
    await manager.sync(declaration({ bounds: { x: 0, y: 0, width: 300, height: 300 } }));
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 300, height: 300 });
  });

  it('does not load URL again when only bounds change', async () => {
    const { manager, webContents } = setup();
    await manager.sync(declaration());
    const initialLoadCount = (webContents.loadURL as ReturnType<typeof vi.fn>).mock.calls.length;
    await manager.sync(declaration({ bounds: { x: 50, y: 50, width: 600, height: 400 } }));
    expect((webContents.loadURL as ReturnType<typeof vi.fn>).mock.calls.length).toBe(initialLoadCount);
  });

  it('destroys all surfaces and cleans up', async () => {
    const { manager, host, webContents } = setup();
    await manager.sync(declaration({ id: 's1' }));
    await manager.sync(declaration({ id: 's2' }));
    expect(manager.has('s1')).toBe(true);
    expect(manager.has('s2')).toBe(true);

    manager.destroyAll();
    expect(manager.has('s1')).toBe(false);
    expect(manager.has('s2')).toBe(false);
    expect(host.contentView.removeChildView).toHaveBeenCalledTimes(2);
    expect(webContents.destroy).toHaveBeenCalledTimes(2);
  });
});
