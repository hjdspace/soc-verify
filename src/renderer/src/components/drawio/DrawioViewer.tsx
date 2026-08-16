/**
 * DrawioViewer — 用官方 viewer-static.min.js 渲染 .drawio XML。
 *
 * 挂载后把 XML 写入容器的 data-mxgraph 属性并调用
 * GraphViewer.createViewerForElement；卸载时销毁 viewer 并清空容器。
 * XML 非法 / viewer 加载失败时回调 onError，由父组件展示错误态。
 *
 * 配置说明：
 *   - lightbox: false 禁用左键点击触发 lightbox 弹出。
 *     viewer-static.min.js 中 lightboxClickEnabled = 0 != graphConfig.lightbox，
 *     未显式设置时 undefined 被视为 truthy，左键点击会弹出 lightbox。
 *     设为 false 后左键可用于拖拽平移。
 *   - toolbar 只含 'zoom'（不含 'lightbox'），避免工具栏出现 lightbox 按钮。
 *   - move: true 启用单元格拖拽（panning），允许左键拖拽调整图表位置。
 *     viewer 初始化后还需手动调用 graph.setPanning(true)，
 *     因为 viewer-static.min.js 中 setPanning(false) 被硬编码调用。
 *   - 右键上下文菜单提供"打开放大图"入口，调用 showLocalLightbox()。
 *   - 容器 CSS 隔离（.drawio-viewer-root）阻止 Tailwind preflight 的
 *     `img { display: block }` 渗透到 viewer 内部。
 *     lightbox 元素被添加到 document.body（不在容器内），
 *     需额外全局 CSS 规则恢复其 img 为 inline（见 globals.css）。
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
            move: true,
            lightbox: false,
            toolbar: 'zoom',
            xml,
          });
          const viewer = GraphViewer.createViewerForElement(containerRef.current);
          viewerRef.current = viewer;

          // viewer-static.min.js 中 setPanning(false) 被硬编码调用，
          // 需要手动启用 panning 以支持左键拖拽平移。
          // panningHandler 在 init 中已配置好 useLeftButtonForPanning 等。
          viewer.graph?.setPanning?.(true);
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

  // ── 右键上下文菜单：打开放大图 ──────────────────────────
  // lightbox: false 禁用了左键点击触发 lightbox，
  // 通过右键菜单提供"打开放大图"入口。
  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const viewer = viewerRef.current;
    if (!viewer) return;

    // 创建临时菜单
    const menu = document.createElement('div');
    menu.style.cssText = [
      'position: fixed',
      'z-index: 10000',
      'background: var(--popover, #2a2a2a)',
      'border: 1px solid var(--border, #555)',
      'border-radius: 6px',
      'box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5)',
      'min-width: 160px',
      'padding: 4px 0',
      'font-family: var(--app-font-family-ui, system-ui, sans-serif)',
    ].join(';');

    const btn = document.createElement('button');
    btn.textContent = '打开放大图';
    btn.style.cssText = [
      'display: flex',
      'align-items: center',
      'gap: 8px',
      'width: 100%',
      'padding: 8px 16px',
      'background: none',
      'border: none',
      'color: var(--foreground, #e0e0e0)',
      'font-size: 13px',
      'cursor: pointer',
      'text-align: left',
    ].join(';');

    btn.addEventListener('mouseenter', () => {
      btn.style.background = 'var(--accent, #3a3a3a)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = 'none';
    });
    btn.addEventListener('click', () => {
      try {
        viewer.showLocalLightbox?.();
      } catch {
        // showLocalLightbox 可能因各种原因失败，静默处理
      }
      menu.remove();
    });

    menu.appendChild(btn);
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    document.body.appendChild(menu);

    // 点击外部关闭菜单
    const closeHandler = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) {
        menu.remove();
        document.removeEventListener('click', closeHandler);
        document.removeEventListener('contextmenu', closeHandler);
      }
    };
    setTimeout(() => {
      document.addEventListener('click', closeHandler);
      document.addEventListener('contextmenu', closeHandler);
    }, 0);
  };

  return (
    <div
      ref={containerRef}
      className="drawio-viewer-root h-full w-full"
      onContextMenu={handleContextMenu}
    />
  );
}
