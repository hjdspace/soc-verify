/**
 * DrawioViewer — 用官方 viewer-static.min.js 渲染 .drawio XML。
 *
 * 挂载后把 XML 写入容器的 data-mxgraph 属性并调用
 * GraphViewer.createViewerForElement；卸载时销毁 viewer 并清空容器。
 * XML 非法 / viewer 加载失败时回调 onError，由父组件展示错误态。
 */

import { useEffect, useRef } from 'react';
import { loadDrawioViewer, type GraphViewerInstance } from './load-drawio-viewer';

export type DrawioViewerProps = {
  /** .drawio 文件完整 XML 内容 */
  xml: string;
  /** 渲染失败回调（XML 非法、viewer 加载失败） */
  onError: (message: string) => void;
};

export function DrawioViewer({ xml, onError }: DrawioViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<GraphViewerInstance | null>(null);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    // 清理上一次渲染
    viewerRef.current?.destroy?.();
    viewerRef.current = null;
    container.replaceChildren();

    loadDrawioViewer()
      .then((GraphViewer) => {
        if (cancelled || !containerRef.current) return;
        try {
          containerRef.current.dataset.mxgraph = JSON.stringify({
            nav: true,
            resize: true,
            'auto-fit': true,
            toolbar: 'zoom lightbox',
            xml,
          });
          viewerRef.current = GraphViewer.createViewerForElement(containerRef.current);
        } catch (err) {
          onError(err instanceof Error ? err.message : String(err));
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          onError(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      cancelled = true;
      viewerRef.current?.destroy?.();
      viewerRef.current = null;
    };
  }, [xml, onError]);

  return <div ref={containerRef} className="h-full w-full" />;
}
