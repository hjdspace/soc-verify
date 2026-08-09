import { useEffect, useRef, useState, useCallback, memo } from 'react';
import mermaid from 'mermaid';
import { useThemeStore } from '@renderer/stores/theme';
import { ZoomIn, ZoomOut, X, AlertCircle, Loader2, Maximize2, Download, Expand, RotateCcw } from 'lucide-react';

interface MermaidDiagramProps {
  code: string;
}

// Module-level counter for unique mermaid render IDs
let mermaidIdCounter = 0;

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 10;
const ZOOM_STEP = 0.15;
const WHEEL_ZOOM_STEP = 0.08;

/**
 * Renders a mermaid diagram from source code.
 * - Debounces rendering during streaming to avoid repeated failed renders
 * - Shows a preview that fills the chat panel width (responsive SVG)
 * - Click to open a fullscreen modal with width-based zoom
 * - Supports mouse-wheel zoom and drag-to-pan in the modal
 * - Falls back to raw code display on render error
 * - Adapts to current theme (light/dark)
 */
export const MermaidDiagram = memo(function MermaidDiagram({ code }: MermaidDiagramProps) {
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);

  const currentTheme = useThemeStore((s) => s.currentTheme);
  const themes = useThemeStore((s) => s.themes);
  const themeMode = themes.find((t) => t.id === currentTheme)?.mode ?? 'dark';

  const instanceIdRef = useRef(`mermaid-diagram-${++mermaidIdCounter}`);

  useEffect(() => {
    let cancelled = false;
    const debounceTimer = setTimeout(async () => {
      try {
        mermaid.initialize({
          startOnLoad: false,
          theme: themeMode === 'dark' ? 'dark' : 'default',
          securityLevel: 'loose',
          fontFamily: 'inherit',
        });

        const renderId = `${instanceIdRef.current}-${Date.now()}`;
        const { svg: renderedSvg } = await mermaid.render(renderId, code);

        if (!cancelled) {
          setSvg(renderedSvg);
          setError('');
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setSvg('');
          setLoading(false);
        }
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(debounceTimer);
    };
  }, [code, themeMode]);

  useEffect(() => {
    setLoading(true);
  }, [code]);

  if (loading) {
    return (
      <div className="my-1.5 flex items-center justify-center rounded-md border border-border/40 bg-secondary/30 py-6">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        <span className="ml-1.5 text-[10px] text-muted-foreground">渲染图表中...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="my-1.5 overflow-hidden rounded-md border border-destructive/40 bg-destructive/5">
        <div className="flex items-center gap-1 border-b border-destructive/30 px-2 py-0.5 text-[9px] text-destructive">
          <AlertCircle className="h-3 w-3" />
          <span>Mermaid 渲染失败</span>
        </div>
        <pre className="overflow-x-auto p-2">
          <code className="text-[10px] font-mono">{code}</code>
        </pre>
      </div>
    );
  }

  return (
    <>
      <div
        className="group relative my-1.5 cursor-zoom-in overflow-hidden rounded-md border border-border/40 bg-secondary/30 transition-colors hover:border-border/60"
        onClick={() => setShowModal(true)}
      >
        <div className="overflow-auto p-3" style={{ maxHeight: '520px' }}>
          <div
            className="mermaid-preview-svg"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
        <div className="pointer-events-none absolute right-2 top-2 opacity-0 transition-opacity group-hover:opacity-100">
          <span className="flex items-center gap-1 rounded bg-background/90 px-2 py-1 text-[10px] text-muted-foreground shadow-md">
            <Maximize2 className="h-3 w-3" />
            点击放大查看
          </span>
        </div>
      </div>
      {showModal && (
        <MermaidZoomModal svg={svg} onClose={() => setShowModal(false)} />
      )}
    </>
  );
});

// ── Fullscreen Zoom Modal ──────────────────────────────────────

interface MermaidZoomModalProps {
  svg: string;
  onClose: () => void;
}

function MermaidZoomModal({ svg, onClose }: MermaidZoomModalProps) {
  const [zoom, setZoom] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragState = useRef({ isDragging: false, startX: 0, startY: 0, scrollLeft: 0, scrollTop: 0 });

  const handleZoomIn = useCallback(() => {
    setZoom((z) => Math.min(z + ZOOM_STEP, MAX_ZOOM));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoom((z) => Math.max(z - ZOOM_STEP, MIN_ZOOM));
  }, []);

  const handleFitWidth = useCallback(() => {
    setZoom(1);
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ left: 0, top: 0, behavior: 'smooth' });
    }
  }, []);

  const handleDownload = useCallback(() => {
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mermaid-diagram-${Date.now()}.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [svg]);

  // Mouse wheel zoom — zooms toward cursor position
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -WHEEL_ZOOM_STEP : WHEEL_ZOOM_STEP;
    setZoom((z) => {
      const next = Math.max(MIN_ZOOM, Math.min(z + delta, MAX_ZOOM));
      // Keep zoom centered around cursor if possible
      if (next !== z && scrollRef.current) {
        const container = scrollRef.current;
        const rect = container.getBoundingClientRect();
        const cursorX = e.clientX - rect.left + container.scrollLeft;
        const cursorY = e.clientY - rect.top + container.scrollTop;
        // Scale cursor position to new zoom
        const ratio = next / z;
        requestAnimationFrame(() => {
          if (!scrollRef.current) return;
          const newScrollX = cursorX * ratio - (e.clientX - rect.left);
          const newScrollY = cursorY * ratio - (e.clientY - rect.top);
          scrollRef.current.scrollTo({ left: newScrollX, top: newScrollY });
        });
      }
      return next;
    });
  }, []);

  // Drag-to-pan
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!scrollRef.current) return;
    dragState.current = {
      isDragging: true,
      startX: e.clientX,
      startY: e.clientY,
      scrollLeft: scrollRef.current.scrollLeft,
      scrollTop: scrollRef.current.scrollTop,
    };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragState.current.isDragging || !scrollRef.current) return;
    e.preventDefault();
    const dx = e.clientX - dragState.current.startX;
    const dy = e.clientY - dragState.current.startY;
    scrollRef.current.scrollLeft = dragState.current.scrollLeft - dx;
    scrollRef.current.scrollTop = dragState.current.scrollTop - dy;
  }, []);

  const handleMouseUp = useCallback(() => {
    dragState.current.isDragging = false;
  }, []);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === '=' || e.key === '+') handleZoomIn();
      if (e.key === '-') handleZoomOut();
      if (e.key === '0') handleFitWidth();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, handleZoomIn, handleZoomOut, handleFitWidth]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-black/50 border-b border-white/10">
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleZoomOut}
            disabled={zoom <= MIN_ZOOM}
            className="flex items-center justify-center h-8 w-8 rounded-md bg-white/10 text-white/80 hover:bg-white/20 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="缩小 (-)"
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <span className="text-xs text-white/60 min-w-[3.5rem] text-center tabular-nums">
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={handleZoomIn}
            disabled={zoom >= MAX_ZOOM}
            className="flex items-center justify-center h-8 w-8 rounded-md bg-white/10 text-white/80 hover:bg-white/20 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="放大 (+)"
          >
            <ZoomIn className="h-4 w-4" />
          </button>
          <button
            onClick={handleFitWidth}
            className="flex items-center gap-1 px-2.5 h-8 rounded-md bg-white/10 text-white/80 hover:bg-white/20 text-xs transition-colors"
            title="适应宽度 (0)"
          >
            <Expand className="h-3.5 w-3.5" />
            适应宽度
          </button>
          <div className="mx-1 h-5 w-px bg-white/10" />
          <button
            onClick={handleDownload}
            className="flex items-center gap-1 px-2.5 h-8 rounded-md bg-white/10 text-white/80 hover:bg-white/20 text-xs transition-colors"
            title="下载 SVG"
          >
            <Download className="h-3.5 w-3.5" />
            下载
          </button>
        </div>
        <button
          onClick={onClose}
          className="flex items-center justify-center h-8 w-8 rounded-md bg-white/10 text-white/80 hover:bg-white/20 transition-colors"
          title="关闭 (Esc)"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Hint bar */}
      <div className="px-4 py-1.5 bg-black/30 border-b border-white/5 text-[10px] text-white/40 flex items-center gap-4">
        <span className="flex items-center gap-1">
          <RotateCcw className="h-2.5 w-2.5" />
          滚轮缩放
        </span>
        <span>拖拽平移</span>
        <span>+/- 缩放</span>
        <span>0 适应宽度</span>
        <span>Esc 关闭</span>
      </div>

      {/* SVG content — scrollable + draggable */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{ cursor: dragState.current.isDragging ? 'grabbing' : 'grab' }}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div
          style={{
            width: `${zoom * 100}%`,
            padding: '20px',
            minWidth: 'fit-content',
          }}
        >
          <div
            className="mermaid-modal-svg"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      </div>
    </div>
  );
}
