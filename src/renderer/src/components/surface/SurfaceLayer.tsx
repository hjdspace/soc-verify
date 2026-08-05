import { useEffect, useMemo, useState } from 'react';
import type { SurfaceEvent } from '@shared/surface-types';
import { SurfaceHost } from './SurfaceHost';

/** Chromium net error code for ERR_ABORTED — emitted during redirects and navigation cancellations. */
const ERR_ABORTED = -3;

interface SurfaceLayerProps {
  surfaceId: string;
  kind: 'browser' | 'document';
  source: { type: 'url'; url: string } | { type: 'local-file'; path: string } | { type: 'local-server'; url: string };
  visible: boolean;
  /** CSS to inject into the page after dom-ready (Document Surfaces only). */
  injectCSS?: string;
}

/**
 * Determine whether a surface failure event should trigger the fatal error page.
 *
 * Only main-frame failures that are not ERR_ABORTED (redirects / cancellations)
 * should cause the "网页视图加载失败" placeholder. Sub-frame failures (iframes,
 * ads, tracking pixels) and redirect-induced aborts are normal browsing noise.
 */
function isFatalFailure(event: Extract<SurfaceEvent, { type: 'failure' }>): boolean {
  return event.isMainFrame && event.errorCode !== ERR_ABORTED;
}

function sourceKey(source: SurfaceLayerProps['source']): string {
  return source.type === 'local-file'
    ? `file:${source.path}`
    : `${source.type}:${source.url}`;
}

export function SurfaceLayer({ surfaceId, kind, source, visible, injectCSS }: SurfaceLayerProps) {
  const [failed, setFailed] = useState(false);
  const currentSourceKey = sourceKey(source);
  const declaration = useMemo(() => ({
    id: surfaceId,
    kind,
    source,
    visible: visible && !failed,
    injectCSS,
  }), [surfaceId, kind, source, visible, failed, injectCSS]);

  useEffect(() => {
    const unlisten = window.eventBridge?.onSurfaceEvent((event) => {
      const surfaceEvent = event as SurfaceEvent;
      if (surfaceEvent.id !== surfaceId) return;
      if (surfaceEvent.type === 'crash') { setFailed(true); return; }
      if (surfaceEvent.type === 'failure' && isFatalFailure(surfaceEvent)) setFailed(true);
    });
    return unlisten;
  }, [surfaceId]);

  // A failed navigation must not poison the next URL in the same browser tab.
  useEffect(() => {
    setFailed(false);
  }, [surfaceId, currentSourceKey]);

  if (failed) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
        <span>网页视图加载失败</span>
        <button className="rounded border border-border px-2 py-1 hover:bg-accent" onClick={() => setFailed(false)}>
          重新加载
        </button>
      </div>
    );
  }

  return <SurfaceHost declaration={declaration} />;
}
