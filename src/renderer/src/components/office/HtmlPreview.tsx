/**
 * HtmlPreview — 用 Document Surface (WebContentsView) 加载 officecli 渲染出的 HTML 文件。
 *
 * 流程：
 *   1. 调用 trpc.document.viewHtml.mutate({ filePath }) 获取 HTML 文件路径
 *   2. 用 SurfaceLayer (kind='document', source='local-file') 加载 file:// URL
 *   3. View Manager 在 dom-ready 后注入视口填充 CSS（通过 injectCSS 声明）
 */
import { useEffect, useState } from 'react';
import { trpc } from '@renderer/lib/trpc';
import { SurfaceLayer } from '@renderer/components/surface/SurfaceLayer';

export type HtmlPreviewProps = {
  filePath: string;
};

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; htmlPath: string }
  | { status: 'error'; message: string };

/** 注入到 Document Surface 的 CSS：让文档内容铺满视口，移除 officecli 默认的页边距 */
const VIEWPORT_FILL_CSS = `
  html, body {
    margin: 0 !important;
    padding: 8px !important;
    width: 100% !important;
    height: 100% !important;
    box-sizing: border-box !important;
  }
  html { overflow: auto; }
`;

export function HtmlPreview({ filePath }: HtmlPreviewProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  // 渲染 HTML 文件
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });

    trpc.document.viewHtml
      .mutate({ filePath })
      .then((result) => {
        if (cancelled) return;
        setState({ status: 'ready', htmlPath: result.htmlPath });
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

  if (state.status === 'loading') {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        渲染中...
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 text-xs text-status-fail-foreground">
        <span>渲染失败</span>
        <span className="max-w-md text-center text-[11px] text-muted-foreground">
          {state.message}
        </span>
      </div>
    );
  }

  // Document Surface 加载 local-file HTML
  // surfaceId 包含文件路径以确保唯一性；SurfaceHost unmount 时自动销毁 Surface
  return (
    <SurfaceLayer
      surfaceId={`doc-html:${state.htmlPath}`}
      kind="document"
      source={{ type: 'local-file', path: state.htmlPath }}
      visible
      injectCSS={VIEWPORT_FILL_CSS}
    />
  );
}
