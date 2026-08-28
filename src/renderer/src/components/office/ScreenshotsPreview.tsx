/**
 * ScreenshotsPreview — 用 <img> 展示 officecli 渲染的 PNG 截图。
 *
 * 流程：
 *   1. 调用 trpc.document.viewScreenshot.mutate({ filePath, outputDir }) 获取 PNG 路径数组
 *   2. 对每个 PNG 调用 trpc.document.readImageAsDataURL.query 转 base64 data URL
 *      （绕过渲染进程 file:// 的 CORS 限制）
 *   3. 用 <img> 展示，支持点击放大（模态遮罩）
 *
 * 放大模态遮罩支持：
 *   - 鼠标滚轮缩放（以光标位置为中心）
 *   - 鼠标拖拽平移（grab/grabbing 光标）
 *   - 工具栏按钮缩放、重置、关闭
 *   - Esc 关闭、+/- 缩放、0 重置
 *
 * 多张截图时分页展示，当前页号显示在底部状态栏。
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import { trpc } from '@renderer/lib/trpc';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, X, Expand } from 'lucide-react';

export type ScreenshotsPreviewProps = {
  filePath: string;
};

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; images: string[] }
  | { status: 'error'; message: string };

// ── 缩放参数 ──────────────────────────────────────────────────
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 10;
const ZOOM_STEP = 0.25;
const WHEEL_ZOOM_STEP = 0.12;

export function ScreenshotsPreview({ filePath }: ScreenshotsPreviewProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [pageIndex, setPageIndex] = useState(0);
  const [zoomed, setZoomed] = useState(false);

  // 渲染截图并转为 data URL
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    setPageIndex(0);

    // 输出目录使用临时路径（每次 filePath 不同，避免缓存冲突）
    const outputDir = filePath.replace(/\.[^.]+$/, '-screenshots');

    trpc.document.viewScreenshot
      .mutate({ filePath, outputDir })
      .then(async (result) => {
        if (cancelled) return;
        // 逐张转 base64 data URL（绕过渲染进程 file:// CORS 限制）
        const dataUrls = await Promise.all(
          result.paths.map((p) =>
            trpc.document.readImageAsDataURL.query({ filePath: p }).then((r) => r.dataUrl),
          ),
        );
        if (cancelled) return;
        if (dataUrls.length === 0) {
          setState({ status: 'error', message: '截图为空' });
          return;
        }
        setState({ status: 'ready', images: dataUrls });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ status: 'error', message });
      });

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const goPrev = useCallback(() => {
    setPageIndex((i) => Math.max(0, i - 1));
  }, []);

  const goNext = useCallback(() => {
    setPageIndex((i) => i + 1);
  }, []);

  if (state.status === 'loading') {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        截图渲染中...
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 text-xs text-status-fail-foreground">
        <span>截图渲染失败</span>
        <span className="max-w-md text-center text-[11px] text-muted-foreground">
          {state.message}
        </span>
      </div>
    );
  }

  const images = state.images;
  const current = images[Math.min(pageIndex, images.length - 1)];

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* 工具栏 */}
      <div className="flex items-center justify-between border-b bg-secondary/30 px-3 py-1.5 text-[11px] text-muted-foreground">
        <span>共 {images.length} 页</span>
        <div className="flex items-center gap-1">
          <button
            onClick={goPrev}
            disabled={pageIndex === 0}
            className="rounded p-0.5 hover:bg-accent disabled:opacity-30"
            title="上一页"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span className="min-w-12 text-center text-foreground">
            {pageIndex + 1} / {images.length}
          </span>
          <button
            onClick={goNext}
            disabled={pageIndex >= images.length - 1}
            className="rounded p-0.5 hover:bg-accent disabled:opacity-30"
            title="下一页"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setZoomed(true)}
            className="ml-1 flex items-center gap-1 rounded p-0.5 hover:bg-accent"
            title="点击放大"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* 截图展示区 */}
      <div className="flex flex-1 items-center justify-center overflow-auto bg-muted/20 p-3">
        <img
          src={current}
          alt={`第 ${pageIndex + 1} 页`}
          className="max-h-full max-w-full cursor-zoom-in rounded border border-border shadow-sm"
          onClick={() => setZoomed(true)}
        />
      </div>

      {/* 放大模态遮罩 */}
      {zoomed && (
        <ZoomModal
          src={current}
          alt={`第 ${pageIndex + 1} 页（放大）`}
          onClose={() => setZoomed(false)}
        />
      )}
    </div>
  );
}

// ── 放大模态遮罩（支持滚轮缩放 + 拖拽平移） ──────────────────────

interface ZoomModalProps {
  src: string;
  alt: string;
  onClose: () => void;
}

function ZoomModal({ src, alt, onClose }: ZoomModalProps) {
  const [zoom, setZoom] = useState(1);
  const [isDragging, setIsDragging] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 拖拽状态：记录起始鼠标位置和起始滚动位置
  const dragState = useRef({ startX: 0, startY: 0, scrollLeft: 0, scrollTop: 0 });

  // ── 缩放操作 ──────────────────────────────────────────────
  const zoomIn = useCallback(() => {
    setZoom((z) => Math.min(z + ZOOM_STEP, MAX_ZOOM));
  }, []);

  const zoomOut = useCallback(() => {
    setZoom((z) => Math.max(z - ZOOM_STEP, MIN_ZOOM));
  }, []);

  const zoomReset = useCallback(() => {
    setZoom(1);
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ left: 0, top: 0, behavior: 'smooth' });
    }
  }, []);

  // ── 鼠标滚轮缩放（以光标位置为中心） ──────────────────────
  // 计算公式：缩放前后保持光标在图片上的相对位置不变。
  // scrollNew = (cursorInContent / oldZoom) * newZoom - cursorInViewport
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -WHEEL_ZOOM_STEP : WHEEL_ZOOM_STEP;
    const container = scrollRef.current;
    if (!container) return;

    const oldZoom = zoom;
    const newZoom = Math.max(MIN_ZOOM, Math.min(oldZoom + delta, MAX_ZOOM));
    if (newZoom === oldZoom) return;

    const rect = container.getBoundingClientRect();
    // 光标在容器中的位置
    const cursorX = e.clientX - rect.left;
    const cursorY = e.clientY - rect.top;
    // 光标在内容坐标系中的位置（缩放前的内容像素）
    const contentX = (container.scrollLeft + cursorX) / oldZoom;
    const contentY = (container.scrollTop + cursorY) / oldZoom;
    // 缩放后让光标在内容上的同一位置保持不动
    const newScrollLeft = contentX * newZoom - cursorX;
    const newScrollTop = contentY * newZoom - cursorY;

    setZoom(newZoom);
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollLeft = newScrollLeft;
        scrollRef.current.scrollTop = newScrollTop;
      }
    });
  }, [zoom]);

  // ── 鼠标拖拽平移 ──────────────────────────────────────────
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // 仅左键拖拽
    if (e.button !== 0) return;
    const container = scrollRef.current;
    if (!container) return;
    e.preventDefault();
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop,
    };
    setIsDragging(true);
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return;
    const container = scrollRef.current;
    if (!container) return;
    e.preventDefault();
    const dx = e.clientX - dragState.current.startX;
    const dy = e.clientY - dragState.current.startY;
    container.scrollLeft = dragState.current.scrollLeft - dx;
    container.scrollTop = dragState.current.scrollTop - dy;
  }, [isDragging]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // ── 键盘快捷键 ────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === '=' || e.key === '+') zoomIn();
      if (e.key === '-') zoomOut();
      if (e.key === '0') zoomReset();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, zoomIn, zoomOut, zoomReset]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* 工具栏 */}
      <div
        className="relative z-30 flex items-center justify-between border-b border-border bg-secondary/30 px-4 py-2"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-1.5">
          <button
            onClick={zoomOut}
            disabled={zoom <= MIN_ZOOM}
            className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
            title="缩小 (-)"
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <span className="min-w-[3rem] text-center text-[11px] text-muted-foreground tabular-nums">
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={zoomIn}
            disabled={zoom >= MAX_ZOOM}
            className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
            title="放大 (+)"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={zoomReset}
            className="flex h-7 items-center gap-1 rounded px-2 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="重置缩放 (0)"
          >
            <Expand className="h-3 w-3" />
            适应
          </button>
        </div>
        <button
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="关闭 (Esc)"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* 提示栏 */}
      <div className="relative z-20 flex items-center gap-4 border-b border-border/50 bg-secondary/10 px-4 py-1 text-[10px] text-muted-foreground">
        <span>滚轮缩放</span>
        <span>拖拽平移</span>
        <span>+/- 缩放</span>
        <span>0 适应</span>
        <span>Esc 关闭</span>
      </div>

      {/* 图片内容区 — 可滚动 + 可拖拽 */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        {/*
         * 内部容器：width 设为 zoom * 100% 撑开滚动区域。
         * 不用 CSS transform（transform 不改变布局尺寸，overflow-auto
         * 不会产生滚动条，导致放大后上方图片被遮挡且无法滚动到）。
         * zoom=1 时 width=100% 适应容器，zoom>1 时撑开产生滚动条。
         */}
        <div
          className="flex items-center justify-center p-4"
          style={{ width: `${zoom * 100}%`, minHeight: '100%', margin: 'auto' }}
        >
          <img
            src={src}
            alt={alt}
            draggable={false}
            className="h-auto w-full max-w-full select-none object-contain"
            style={{
              transition: isDragging ? 'none' : 'width 0.08s ease-out',
            }}
          />
        </div>
      </div>
    </div>
  );
}
