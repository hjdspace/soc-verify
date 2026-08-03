/**
 * ScreenshotsPreview — 用 <img> 展示 officecli 渲染的 PNG 截图。
 *
 * 流程：
 *   1. 调用 trpc.document.viewScreenshot.mutate({ filePath, outputDir }) 获取 PNG 路径数组
 *   2. 对每个 PNG 调用 trpc.document.readImageAsDataURL.query 转 base64 data URL
 *      （绕过渲染进程 file:// 的 CORS 限制）
 *   3. 用 <img> 展示，支持点击放大（模态遮罩）
 *
 * 多张截图时分页展示，当前页号显示在底部状态栏。
 */
import { useEffect, useState, useCallback } from 'react';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';
import { ChevronLeft, ChevronRight, ZoomIn, X } from 'lucide-react';

export type ScreenshotsPreviewProps = {
  filePath: string;
};

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; images: string[] }
  | { status: 'error'; message: string };

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
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/90"
          onClick={() => setZoomed(false)}
        >
          <button
            className="absolute right-4 top-4 rounded-full bg-secondary/80 p-1.5 text-secondary-foreground hover:bg-secondary"
            onClick={() => setZoomed(false)}
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
          <img
            src={current}
            alt={`第 ${pageIndex + 1} 页（放大）`}
            className={cn(
              'max-h-[90vh] max-w-[90vw] cursor-zoom-out rounded shadow-2xl',
            )}
            onClick={(e) => {
              e.stopPropagation();
              setZoomed(false);
            }}
          />
        </div>
      )}
    </div>
  );
}
