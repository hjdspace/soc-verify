/**
 * HtmlPreview — 用 webview 加载 officecli 渲染出的 HTML 文件。
 *
 * 流程：
 *   1. 调用 trpc.document.viewHtml.mutate({ filePath }) 获取 HTML 文件路径
 *   2. 用 <webview> 加载 file:// URL，partition="persist:office-preview" 隔离
 *   3. webview dom-ready 后注入 CSS，让文档内容铺满视口
 *
 * webview 是 Electron 独立进程，不受渲染进程 CSP（default-src 'self'）限制。
 * 不修改 index.html 的 CSP。
 */
import { useEffect, useRef, useState } from 'react';
import { trpc } from '@renderer/lib/trpc';

export type HtmlPreviewProps = {
  filePath: string;
};

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; htmlPath: string }
  | { status: 'error'; message: string };

/** 将本地路径转换为 file:// URL（兼容 Windows 反斜杠路径） */
function toFileUrl(path: string): string {
  // Windows 路径反斜杠转正斜杠；连续斜杠折叠以避免 file:///C:/ 与 file://C:/ 的歧义
  const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/');
  // file:// + 绝对路径：Unix 以 / 开头 → file:///，Windows 以 C:/ 开头 → file:///
  if (normalized.startsWith('/')) {
    return `file://${normalized}`;
  }
  return `file:///${normalized}`;
}

/** 注入到 webview 的 CSS：让文档内容铺满视口，移除 officecli 默认的页边距 */
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

/** webview DOM 元素上 insertCSS 方法的最小类型签名 */
type WebviewElement = HTMLElement & {
  insertCSS?: (css: string) => Promise<unknown>;
};

export function HtmlPreview({ filePath }: HtmlPreviewProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const webviewRef = useRef<WebviewElement | null>(null);

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

  // webview dom-ready 后注入 CSS（webview 事件需用 addEventListener）
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const handleDomReady = () => {
      const insertCss = webview.insertCSS;
      if (typeof insertCss === 'function') {
        // 注入失败不影响主流程，best-effort
        insertCss.call(webview, VIEWPORT_FILL_CSS).catch(() => {
          // CSS 注入失败：文档仍可显示，仅样式不完美
        });
      }
    };

    webview.addEventListener('dom-ready', handleDomReady);
    return () => {
      webview.removeEventListener('dom-ready', handleDomReady);
    };
  }, [state]);

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

  return (
    <webview
      ref={webviewRef as unknown as React.Ref<WebviewElement>}
      src={toFileUrl(state.htmlPath)}
      partition="persist:office-preview"
      className="h-full w-full flex-1 border-0"
    />
  );
}
