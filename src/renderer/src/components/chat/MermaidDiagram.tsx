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

// ── SVG Style Isolation ──────────────────────────────────────────
// Mermaid SVGs embed <style> tags whose CSS rules can leak beyond the
// SVG scope and affect the entire document (e.g., disabling pointer
// events on toolbar buttons).  These functions scope every selector
// inside <style> tags to a container class so styles stay contained.

function scopeCssRules(css: string, scope: string): string {
  // Strip CSS comments
  let result = css.replace(/\/\*[\s\S]*?\*\//g, '');

  // Handle @-rules (@media, @supports, …) — recurse into their body
  const atRuleRegex = /(@[\w-]+[^{]*)\{([\s\S]*?)\}/g;
  result = result.replace(atRuleRegex, (_m, atRule: string, body: string) => {
    return `${atRule.trim()}{${scopeCssRules(body, scope)}}`;
  });

  // Scope regular CSS rules  selector { props }
  result = result.replace(/([^{}]+)\{([^{}]*)\}/g, (_m, selectors: string, body: string) => {
    const scoped = selectors
      .split(',')
      .map((s) => {
        const trimmed = s.trim();
        if (!trimmed) return '';
        if (trimmed.startsWith('@')) return trimmed; // shouldn't happen, but safe
        if (trimmed.startsWith(scope)) return trimmed; // already scoped
        return `${scope} ${trimmed}`;
      })
      .filter(Boolean)
      .join(', ');
    return `${scoped}{${body}}`;
  });

  return result;
}

/** Scopes all <style> tags inside the SVG HTML to `.` + `scopeClass`. */
function scopeSvgStyles(svgHtml: string, scopeClass: string): string {
  const scope = `.${scopeClass}`;
  return svgHtml.replace(
    /<style([^>]*)>([\s\S]*?)<\/style>/gi,
    (_m, attrs: string, css: string) => `<style${attrs}>${scopeCssRules(css, scope)}</style>`,
  );
}

// ── Theme Color Resolution ───────────────────────────────────────
// Reads CSS custom properties from the active theme and converts them
// to #hex / rgba() strings that mermaid can safely use in themeVariables.
//
// IMPORTANT: Chromium preserves oklch() when serialising Canvas fillStyle,
// but mermaid cannot parse it. Drawing the colour and reading the pixel data
// converts every browser-supported CSS colour to sRGB bytes.

type ThemeColors = {
  primaryColor: string;
  primaryTextColor: string;
  primaryBorderColor: string;
  lineColor: string;
  secondaryColor: string;
  tertiaryColor: string;
};

const FALLBACK_DARK: ThemeColors = {
  primaryColor: '#334155',
  primaryTextColor: '#e2e8f0',
  primaryBorderColor: '#475569',
  lineColor: '#64748b',
  secondaryColor: '#1e293b',
  tertiaryColor: '#0f172a',
};

const FALLBACK_LIGHT: ThemeColors = {
  primaryColor: '#f1f5f9',
  primaryTextColor: '#1e293b',
  primaryBorderColor: '#cbd5e1',
  lineColor: '#94a3b8',
  secondaryColor: '#e2e8f0',
  tertiaryColor: '#f8fafc',
};

function resolveThemeColors(dark: boolean): ThemeColors {
  const fallback = dark ? FALLBACK_DARK : FALLBACK_LIGHT;
  if (typeof window === 'undefined') return fallback;

  try {
    const root = document.documentElement;
    const cs = getComputedStyle(root);

    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return fallback;

    const resolve = (varName: string): string => {
      const raw = cs.getPropertyValue(varName).trim();
      if (!raw) return '';
      ctx.fillStyle = '#000001';
      ctx.fillStyle = raw;
      if (ctx.fillStyle === '#000001' && raw.toLowerCase() !== '#000001') return '';

      ctx.clearRect(0, 0, 1, 1);
      ctx.fillRect(0, 0, 1, 1);
      const [red, green, blue, alpha] = ctx.getImageData(0, 0, 1, 1).data;
      if (alpha === 255) {
        const hex = [red, green, blue]
          .map((value) => value.toString(16).padStart(2, '0'))
          .join('');
        return `#${hex}`;
      }
      return `rgba(${red}, ${green}, ${blue}, ${(alpha / 255).toFixed(3)})`;
    };

    return {
      primaryColor: resolve('--secondary') || fallback.primaryColor,
      primaryTextColor: resolve('--foreground') || fallback.primaryTextColor,
      primaryBorderColor: resolve('--border') || fallback.primaryBorderColor,
      lineColor: resolve('--muted-foreground') || fallback.lineColor,
      secondaryColor: resolve('--muted') || fallback.secondaryColor,
      tertiaryColor: resolve('--card') || fallback.tertiaryColor,
    };
  } catch {
    return fallback;
  }
}

// ── MermaidDiagram Component ─────────────────────────────────────

/**
 * Renders a mermaid diagram from source code.
 * - Debounces rendering while a Mermaid block itself is still streaming
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
  // Unique scope class shared by preview and modal containers
  const scopeClassRef = useRef(`mermaid-scope-${instanceIdRef.current}`);

  useEffect(() => {
    let cancelled = false;
    const debounceTimer = setTimeout(async () => {
      const renderId = `${instanceIdRef.current}-${Date.now()}`;
      try {
        const dark = themeMode === 'dark';
        const themeColors = resolveThemeColors(dark);

        mermaid.initialize({
          startOnLoad: false,
          // 解析失败时阻止 mermaid 向 document.body 注入"炸弹"错误 SVG。
          // 该元素游离于 React 树之外，会覆盖整个 GUI 且无法关闭。
          suppressErrorRendering: true,
          theme: dark ? 'dark' : 'default',
          securityLevel: 'loose',
          fontFamily: 'inherit',
          themeVariables: {
            borderRadius: 8,
            fontSize: '14px',
            ...themeColors,
          },
          flowchart: {
            curve: 'basis',
            padding: 20,
            nodeSpacing: 50,
            rankSpacing: 50,
            useMaxWidth: true,
            htmlLabels: true,
          },
          sequence: {
            actorMargin: 50,
            boxMargin: 10,
            boxTextMargin: 5,
            noteMargin: 10,
            messageMargin: 35,
            mirrorActors: true,
          },
          gantt: {
            leftPadding: 75,
            gridLineStartPadding: 35,
            fontSize: 14,
          },
          journey: {
            leftMargin: 20,
          },
        });

        const { svg: renderedSvg } = await mermaid.render(renderId, code);

        if (!cancelled) {
          // Scope SVG <style> rules to prevent CSS leaking to the document
          const scopedSvg = scopeSvgStyles(renderedSvg, scopeClassRef.current);
          setSvg(scopedSvg);
          setError('');
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setSvg('');
          setLoading(false);
        }
      } finally {
        // 只清理本次渲染自己的临时节点（mermaid 正常路径会自删，此处兜底异常路径）。
        // 注意：绝不能按 id 前缀做 body 级全局清理——所有图表实例共享
        // "mermaid-diagram-" 前缀，全局清理会误删其他实例正在渲染中的
        // 临时节点，导致流式输出期间所有图表卡在 loading 直到流结束。
        for (const tempId of [`d${renderId}`, `i${renderId}`, renderId]) {
          document.getElementById(tempId)?.remove();
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
            className={`mermaid-preview-svg ${scopeClassRef.current}`}
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
        <MermaidZoomModal svg={svg} scopeClass={scopeClassRef.current} onClose={() => setShowModal(false)} />
      )}
    </>
  );
});

// ── Fullscreen Zoom Modal ──────────────────────────────────────

interface MermaidZoomModalProps {
  svg: string;
  scopeClass: string;
  onClose: () => void;
}

function MermaidZoomModal({ svg, scopeClass, onClose }: MermaidZoomModalProps) {
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
      {/* Toolbar — z-30 + relative ensures it sits above any SVG content.
          stopPropagation prevents stray clicks from reaching the backdrop. */}
      <div
        className="relative z-30 flex items-center justify-between px-4 py-2.5 bg-black/50 border-b border-white/10"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
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
      <div
        className="relative z-20 px-4 py-1.5 bg-black/30 border-b border-white/5 text-[10px] text-white/40 flex items-center gap-4"
        onClick={(e) => e.stopPropagation()}
      >
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
            className={`mermaid-modal-svg ${scopeClass}`}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      </div>
    </div>
  );
}
