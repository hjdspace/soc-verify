import { useEffect, useMemo, useState } from 'react';
import type { SurfaceEvent } from '@shared/surface-types';
import { SurfaceHost } from './SurfaceHost';

interface SurfaceLayerProps {
  surfaceId: string;
  kind: 'browser' | 'document';
  source: { type: 'url'; url: string } | { type: 'local-file'; path: string } | { type: 'local-server'; url: string };
  visible: boolean;
}

export function SurfaceLayer({ surfaceId, kind, source, visible }: SurfaceLayerProps) {
  const [failed, setFailed] = useState(false);
  const declaration = useMemo(() => ({
    id: surfaceId,
    kind,
    source,
    visible: visible && !failed,
  }), [surfaceId, kind, source, visible, failed]);

  useEffect(() => {
    const unlisten = window.eventBridge?.onSurfaceEvent((event) => {
      const surfaceEvent = event as SurfaceEvent;
      if (surfaceEvent.id !== surfaceId) return;
      if (surfaceEvent.type === 'failure' || surfaceEvent.type === 'crash') setFailed(true);
    });
    return unlisten;
  }, [surfaceId]);

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
