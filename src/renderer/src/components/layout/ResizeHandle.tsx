import { useCallback, useEffect, useRef } from 'react';
import { cn } from '@renderer/lib/utils';

interface ResizeHandleProps {
  /** Whether this handle resizes the panel to its left. */
  side: 'left' | 'right';
  /** Current width of the panel being resized. */
  width: number;
  /** Callback to update the panel width. */
  onResize: (width: number) => void;
}

/**
 * A vertical drag handle for resizing adjacent panels.
 *
 * Renders a thin transparent strip that becomes visible on hover.
 * Pointer Events + setPointerCapture（apple-design §2）：指针移出边界后
 * 拖拽仍继续，触控笔/触摸同样工作。During drag, a global listener
 * captures pointer events to avoid triggering iframe / content reflow issues.
 */
export function ResizeHandle({ side, width, onResize }: ResizeHandleProps) {
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const draggingRef = useRef(false);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      e.preventDefault();
      draggingRef.current = true;
      startXRef.current = e.clientX;
      startWidthRef.current = width;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* jsdom 无该实现 */
      }
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [width],
  );

  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      const delta = e.clientX - startXRef.current;
      const newWidth = side === 'left' ? startWidthRef.current + delta : startWidthRef.current - delta;
      onResize(newWidth);
    };

    const handlePointerUp = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      const target = e.currentTarget as HTMLElement | null;
      if (target?.hasPointerCapture?.(e.pointerId)) {
        target.releasePointerCapture(e.pointerId);
      }
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [side, onResize]);

  return (
    <div
      onPointerDown={handlePointerDown}
      className={cn(
        'group relative z-20 w-1 shrink-0 cursor-col-resize',
        'hover:bg-primary/30 transition-colors',
      )}
    >
      {/* Wider invisible hit area */}
      <div className="absolute inset-y-0 -left-1 -right-1" />
    </div>
  );
}
