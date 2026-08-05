/**
 * SurfaceLayer 组件测试。
 *
 * 验证 SurfaceLayer 只在主帧真正加载失败时显示错误页，
 * 而不是在子帧失败或 ERR_ABORTED（重定向导致的正常中止）时误报。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import type { JSX } from 'react';
import type { SurfaceEvent } from '@shared/surface-types';

// ── Mock SurfaceHost to avoid real DOM measurement / IPC ────────────
vi.mock('@renderer/components/surface/SurfaceHost', () => ({
  SurfaceHost: (): JSX.Element => <div data-testid="surface-host" />,
}));

import { SurfaceLayer } from '@renderer/components/surface/SurfaceLayer';

// ── Helpers ─────────────────────────────────────────────────────────

type SurfaceCallback = (event: unknown) => void;

function setupEventBridge(): { emit: (event: SurfaceEvent) => void; unlisten: () => void } {
  let callback: SurfaceCallback | null = null;
  const unlisten = vi.fn(() => { callback = null; });

  Object.defineProperty(window, 'eventBridge', {
    value: {
      onSurfaceEvent: (cb: SurfaceCallback) => {
        callback = cb;
        return unlisten;
      },
    },
    writable: true,
    configurable: true,
  });

  Object.defineProperty(window, 'surfaceBridge', {
    value: {
      sync: vi.fn().mockResolvedValue(undefined),
      show: vi.fn().mockResolvedValue(undefined),
      hide: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
      setOverlayHidden: vi.fn().mockResolvedValue(undefined),
      goBack: vi.fn().mockResolvedValue(undefined),
      goForward: vi.fn().mockResolvedValue(undefined),
      reload: vi.fn().mockResolvedValue(undefined),
      findInPage: vi.fn().mockResolvedValue(undefined),
      stopFindInPage: vi.fn().mockResolvedValue(undefined),
    },
    writable: true,
    configurable: true,
  });

  return {
    emit: (event: SurfaceEvent) => {
      const cb = callback;
      if (cb) act(() => cb(event));
    },
    unlisten,
  };
}

function renderBrowserSurface(surfaceId = 'surface-test') {
  return render(
    <SurfaceLayer
      surfaceId={surfaceId}
      kind="browser"
      source={{ type: 'url', url: 'https://www.baidu.com' }}
      visible
    />,
  );
}

function renderBrowserSurfaceWithUrl(url: string, surfaceId = 'surface-test') {
  return render(
    <SurfaceLayer
      surfaceId={surfaceId}
      kind="browser"
      source={{ type: 'url', url }}
      visible
    />,
  );
}

// ── Tests ───────────────────────────────────────────────────────────

describe('SurfaceLayer failure handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does NOT show error page for sub-frame failure (isMainFrame: false)', () => {
    const bridge = setupEventBridge();
    renderBrowserSurface();

    // Simulate a sub-frame failure (e.g., an ad or iframe fails to load)
    bridge.emit({
      id: 'surface-test',
      type: 'failure',
      errorCode: -105,
      errorDescription: 'ERR_NAME_NOT_RESOLVED',
      validatedURL: 'https://ads.example.com/tracker.js',
      isMainFrame: false,
    });

    // The surface host should still be visible — no error page
    expect(screen.queryByText('网页视图加载失败')).toBeNull();
    expect(screen.getByTestId('surface-host')).toBeInTheDocument();
  });

  it('does NOT show error page for ERR_ABORTED on main frame (redirect)', () => {
    const bridge = setupEventBridge();
    renderBrowserSurface();

    // Simulate ERR_ABORTED (-3) on main frame — this is normal during redirects
    // e.g., http://baidu.com → https://www.baidu.com causes the original request to abort
    bridge.emit({
      id: 'surface-test',
      type: 'failure',
      errorCode: -3,
      errorDescription: 'ERR_ABORTED',
      validatedURL: 'https://www.baidu.com',
      isMainFrame: true,
    });

    expect(screen.queryByText('网页视图加载失败')).toBeNull();
    expect(screen.getByTestId('surface-host')).toBeInTheDocument();
  });

  it('shows error page for genuine main-frame failure', () => {
    const bridge = setupEventBridge();
    renderBrowserSurface();

    // Simulate a real connection failure on the main frame
    bridge.emit({
      id: 'surface-test',
      type: 'failure',
      errorCode: -102,
      errorDescription: 'ERR_CONNECTION_REFUSED',
      validatedURL: 'https://www.baidu.com',
      isMainFrame: true,
    });

    expect(screen.getByText('网页视图加载失败')).toBeInTheDocument();
  });

  it('clears a previous failure when the same tab navigates to a new URL', () => {
    const bridge = setupEventBridge();
    const view = renderBrowserSurfaceWithUrl('https://bad.example');

    bridge.emit({
      id: 'surface-test',
      type: 'failure',
      errorCode: -105,
      errorDescription: 'ERR_NAME_NOT_RESOLVED',
      validatedURL: 'https://bad.example',
      isMainFrame: true,
    });
    expect(screen.getByText('网页视图加载失败')).toBeInTheDocument();

    view.rerender(
      <SurfaceLayer
        surfaceId="surface-test"
        kind="browser"
        source={{ type: 'url', url: 'https://example.com' }}
        visible
      />,
    );

    expect(screen.queryByText('网页视图加载失败')).toBeNull();
    expect(screen.getByTestId('surface-host')).toBeInTheDocument();
  });

  it('shows error page for crash events', () => {
    const bridge = setupEventBridge();
    renderBrowserSurface();

    bridge.emit({
      id: 'surface-test',
      type: 'crash',
      reason: 'crashed',
      exitCode: 9,
    });

    expect(screen.getByText('网页视图加载失败')).toBeInTheDocument();
  });

  it('ignores failure events for other surface ids', () => {
    const bridge = setupEventBridge();
    renderBrowserSurface();

    bridge.emit({
      id: 'different-surface',
      type: 'failure',
      errorCode: -102,
      errorDescription: 'ERR_CONNECTION_REFUSED',
      validatedURL: 'https://example.com',
      isMainFrame: true,
    });

    expect(screen.queryByText('网页视图加载失败')).toBeNull();
    expect(screen.getByTestId('surface-host')).toBeInTheDocument();
  });
});
