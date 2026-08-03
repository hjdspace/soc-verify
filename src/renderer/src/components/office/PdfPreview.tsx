/**
 * PdfPreview — 用 react-pdf 渲染 PDF 文件。
 *
 * 流程：
 *   1. 将 filePath 转换为 file:// URL，传给 <Document file={...} />
 *   2. <Document> 加载 PDF 后回调 onLoadSuccess 设置 numPages
 *   3. <Page> 渲染当前页，支持翻页（上一页/下一页）与缩放（in/out/适应宽度）
 *   4. 加载中显示 spinner，加载失败显示错误提示
 *
 * Document 始终挂载（不随 loadState 切换而卸载），避免状态变化时重新加载 PDF。
 * Document 的内置 loading/error 文案用空串抑制，改由本组件渲染统一 UI。
 *
 * worker 本地加载（不走 CDN，符合内网约束），通过 pdfjs.GlobalWorkerOptions.workerSrc
 * 指向 pdfjs-dist/build/pdf.worker.min.mjs（Vite 的 new URL(..., import.meta.url)
 * 模式自动将 worker 复制到输出目录）。
 *
 * react-pdf 10.x 已正式支持 React 19（peerDependencies 声明 ^19.0.0）。
 */
import { useState, useCallback, useEffect } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Maximize } from 'lucide-react';

// 配置 PDF.js worker——必须在模块顶层执行（react-pdf 官方推荐）。
// Vite 会自动将 pdf.worker.min.mjs 复制到输出目录并替换为正确的 URL。
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

export type PdfPreviewProps = {
  filePath: string;
};

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; numPages: number }
  | { status: 'error'; message: string };

/** 缩放限制 */
const MIN_SCALE = 0.5;
const MAX_SCALE = 3.0;
const SCALE_STEP = 0.25;
const DEFAULT_SCALE = 1.0;

/** 将本地路径转换为 file:// URL（兼容 Windows 反斜杠路径） */
function toFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (normalized.startsWith('/')) {
    return `file://${normalized}`;
  }
  return `file:///${normalized}`;
}

export function PdfPreview({ filePath }: PdfPreviewProps) {
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' });
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState(DEFAULT_SCALE);

  const fileUrl = toFileUrl(filePath);

  // filePath 变化时重置状态
  useEffect(() => {
    setLoadState({ status: 'loading' });
    setCurrentPage(1);
    setScale(DEFAULT_SCALE);
  }, [filePath]);

  const handleLoadSuccess = useCallback((pdf: PDFDocumentProxy) => {
    setLoadState({ status: 'ready', numPages: pdf.numPages });
    setCurrentPage(1);
  }, []);

  const handleLoadError = useCallback((error: Error) => {
    setLoadState({ status: 'error', message: error.message });
  }, []);

  const goPrevPage = useCallback(() => {
    setCurrentPage((p) => Math.max(1, p - 1));
  }, []);

  const goNextPage = useCallback(() => {
    setCurrentPage((p) => p + 1);
  }, []);

  const zoomIn = useCallback(() => {
    setScale((s) => Math.min(MAX_SCALE, +(s + SCALE_STEP).toFixed(2)));
  }, []);

  const zoomOut = useCallback(() => {
    setScale((s) => Math.max(MIN_SCALE, +(s - SCALE_STEP).toFixed(2)));
  }, []);

  const fitWidth = useCallback(() => {
    setScale(DEFAULT_SCALE);
  }, []);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* 工具栏：仅在 PDF 加载成功后显示 */}
      {loadState.status === 'ready' && (
        <div className="flex shrink-0 items-center justify-between border-b bg-secondary/30 px-3 py-1.5 text-[11px] text-muted-foreground">
          {/* 翻页 */}
          <div className="flex items-center gap-1">
            <button
              onClick={goPrevPage}
              disabled={currentPage <= 1}
              className="rounded p-0.5 hover:bg-accent disabled:opacity-30"
              title="上一页"
              aria-label="上一页"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="min-w-14 text-center text-foreground">
              {currentPage} / {loadState.numPages}
            </span>
            <button
              onClick={goNextPage}
              disabled={currentPage >= loadState.numPages}
              className="rounded p-0.5 hover:bg-accent disabled:opacity-30"
              title="下一页"
              aria-label="下一页"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* 缩放 */}
          <div className="flex items-center gap-1">
            <button
              onClick={zoomOut}
              disabled={scale <= MIN_SCALE}
              className="rounded p-0.5 hover:bg-accent disabled:opacity-30"
              title="缩小"
              aria-label="缩小"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </button>
            <span className="min-w-10 text-center text-foreground">
              {Math.round(scale * 100)}%
            </span>
            <button
              onClick={zoomIn}
              disabled={scale >= MAX_SCALE}
              className="rounded p-0.5 hover:bg-accent disabled:opacity-30"
              title="放大"
              aria-label="放大"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={fitWidth}
              className="ml-1 rounded p-0.5 hover:bg-accent"
              title="适应宽度"
              aria-label="适应宽度"
            >
              <Maximize className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* PDF 渲染区 */}
      <div className="flex flex-1 justify-center overflow-auto bg-muted/20 p-3">
        {/* 加载状态：spinner */}
        {loadState.status === 'loading' && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-xs text-muted-foreground">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
            <span>加载中...</span>
          </div>
        )}

        {/* 错误状态：错误提示 */}
        {loadState.status === 'error' && (
          <div className="flex flex-1 flex-col items-center justify-center gap-1 text-xs text-status-fail-foreground">
            <span>PDF 加载失败</span>
            <span className="max-w-md text-center text-[11px] text-muted-foreground">
              {loadState.message}
            </span>
          </div>
        )}

        {/* Document 始终挂载，loading/error 文案用空串抑制 */}
        <Document
          file={fileUrl}
          loading=""
          error=""
          onLoadSuccess={handleLoadSuccess}
          onLoadError={handleLoadError}
        >
          {loadState.status === 'ready' && (
            <Page
              pageNumber={Math.min(currentPage, loadState.numPages)}
              scale={scale}
            />
          )}
        </Document>
      </div>
    </div>
  );
}
