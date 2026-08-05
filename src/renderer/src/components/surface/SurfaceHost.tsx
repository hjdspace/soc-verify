import { useEffect, useRef } from 'react';
import type { SurfaceDeclaration } from '@shared/surface-types';

interface SurfaceHostProps {
  declaration: SurfaceDeclaration;
}

/** DOM anchor for a main-process WebContentsView. The native view never enters React's DOM tree. */
export function SurfaceHost({ declaration }: SurfaceHostProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const declarationRef = useRef(declaration);
  declarationRef.current = declaration;

  useEffect(() => {
    const container = containerRef.current;
    const bridge = window.surfaceBridge;
    if (!container || !bridge) return;

    let framePending = false;
    let destroyed = false;
    const surfaceId = declaration.id;

    const sync = () => {
      framePending = false;
      if (destroyed) return;
      const rect = container.getBoundingClientRect();
      const next = declarationRef.current;
      void bridge.sync({
        ...next,
        bounds: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      }).catch(() => {
        // Surface errors are reported through the event bridge; a transient layout error is best-effort.
      });
    };

    const scheduleSync = () => {
      if (framePending) return;
      framePending = true;
      window.requestAnimationFrame(sync);
    };

    const observer = new ResizeObserver(scheduleSync);
    observer.observe(container);
    window.addEventListener('resize', scheduleSync);
    scheduleSync();

    return () => {
      destroyed = true;
      observer.disconnect();
      window.removeEventListener('resize', scheduleSync);
      void bridge.destroy(surfaceId);
    };
  }, [declaration.id]);

  useEffect(() => {
    if (!window.surfaceBridge) return;
    if (declaration.visible) void window.surfaceBridge.show(declaration.id);
    else void window.surfaceBridge.hide(declaration.id);
  }, [declaration.id, declaration.visible]);

  return <div ref={containerRef} className="relative h-full w-full overflow-hidden" aria-label={`Surface ${declaration.id}`} />;
}
