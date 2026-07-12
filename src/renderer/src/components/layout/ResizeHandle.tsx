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
 * During drag, a global overlay captures mouse events to avoid
 * triggering iframe / content reflow issues.
 */
export function ResizeHandle({ side, width, onResize }: ResizeHandleProps) {
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const draggingRef = useRef(false);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      startXRef.current = e.clientX;
      startWidthRef.current = width;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [width],
  );

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const delta = e.clientX - startXRef.current;
      const newWidth = side === 'left' ? startWidthRef.current + delta : startWidthRef.current - delta;
      onResize(newWidth);
    };

    const handleMouseUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [side, onResize]);

  return (
    <div
      onMouseDown={handleMouseDown}
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
