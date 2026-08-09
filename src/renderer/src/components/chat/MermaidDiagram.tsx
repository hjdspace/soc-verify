import { useEffect, useRef, useState, useCallback, memo } from 'react';
import mermaid from 'mermaid';
import { useThemeStore } from '@renderer/stores/theme';
import { ZoomIn, ZoomOut, X, AlertCircle, Loader2, Maximize2, Download } from 'lucide-react';

interface MermaidDiagramProps {
  code: string;
}

// Module-level counter for unique mermaid render IDs
let mermaidIdCounter = 0;

/**
 * Renders a mermaid diagram from source code.
 * - Debounces rendering during streaming to avoid repeated failed renders
 * - Shows a preview thumbnail that can be clicked to open a fullscreen modal
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

  // Stable unique ID for this component instance
  const instanceIdRef = useRef(`mermaid-diagram-${++mermaidIdCounter}`);

  useEffect(() => {
    let cancelled = false;
    const debounceTimer = setTimeout(async () => {
      try {
        // Initialize mermaid with current theme
        mermaid.initialize({
          startOnLoad: false,
          theme: themeMode === 'dark' ? 'dark' : 'default',
          securityLevel: 'loose',
          fontFamily: 'inherit',
        });

        // Use a unique render ID per render attempt to avoid DOM conflicts
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

  // Reset loading state when code changes
  useEffect(() => {
    setLoading(true);
  }, [code]);

  // Loading state
  if (loading) {
    return (
      <div className="my-1.5 flex items-center justify-center rounded-md border border-border/40 bg-secondary/30 py-6">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        <span className="ml-1.5 text-[10px] text-muted-foreground">渲染图表中...</span>
      </div>
    );
  }

  // Error fallback: show raw mermaid code
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

  // Successfully rendered: show preview with zoom hint
  return (
    <>
      <div
        className="group relative my-1.5 cursor-zoom-in overflow-hidden rounded-md border border-border/40 bg-secondary/30 p-2 transition-colors hover:border-border/60"
        onClick={() => setShowModal(true)}
      >
        <div
          dangerouslySetInnerHTML={{ __html: svg }}
          className="flex max-h-64 items-center justify-center overflow-auto"
        />
        <div className="absolute right-1 top-1 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <span className="flex items-center gap-0.5 rounded bg-background/90 px-1.5 py-0.5 text-[9px] text-muted-foreground shadow-sm">
            <Maximize2 className="h-2.5 w-2.5" />
            点击放大
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
  const containerRef = useRef<HTMLDivElement>(null);

  const handleZoomIn = useCallback(() => {
    setZoom((z) => Math.min(z + 0.2, 3));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoom((z) => Math.max(z - 0.2, 0.3));
  }, []);

  const handleReset = useCallback(() => {
    setZoom(1);
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

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/80 backdrop-blur-sm"
      onClick={(e) => {
        // Close when clicking the backdrop (not the content)
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-black/40 border-b border-white/10">
        <div className="flex items-center gap-2">
          <button
            onClick={handleZoomOut}
            disabled={zoom <= 0.3}
            className="flex items-center justify-center h-7 w-7 rounded-md bg-white/10 text-white/80 hover:bg-white/20 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="缩小"
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <span className="text-xs text-white/60 min-w-[3rem] text-center tabular-nums">
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={handleZoomIn}
            disabled={zoom >= 3}
            className="flex items-center justify-center h-7 w-7 rounded-md bg-white/10 text-white/80 hover:bg-white/20 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="放大"
          >
            <ZoomIn className="h-4 w-4" />
          </button>
          <button
            onClick={handleReset}
            className="px-2 h-7 rounded-md bg-white/10 text-white/80 hover:bg-white/20 text-xs transition-colors"
            title="重置"
          >
            重置
          </button>
          <div className="mx-1 h-4 w-px bg-white/10" />
          <button
            onClick={handleDownload}
            className="flex items-center gap-1 px-2 h-7 rounded-md bg-white/10 text-white/80 hover:bg-white/20 text-xs transition-colors"
            title="下载 SVG"
          >
            <Download className="h-3.5 w-3.5" />
            下载
          </button>
        </div>
        <button
          onClick={onClose}
          className="flex items-center justify-center h-7 w-7 rounded-md bg-white/10 text-white/80 hover:bg-white/20 transition-colors"
          title="关闭 (Esc)"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* SVG content */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto p-4 flex items-start justify-center"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div
          dangerouslySetInnerHTML={{ __html: svg }}
          style={{
            transform: `scale(${zoom})`,
            transformOrigin: 'top center',
            transition: 'transform 0.15s ease-out',
          }}
          className="max-w-none"
        />
      </div>
    </div>
  );
}
