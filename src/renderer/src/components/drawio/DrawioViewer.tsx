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
 *   - viewer 初始化后禁用 graph.resizeContainer 并清除 inline height，
 *     否则 doResizeContainer 会把容器高度撑开到内容大小，
 *     导致垂直方向 scrollHeight == clientHeight，无法上下拖拽平移。
 *   - 右键上下文菜单提供"打开放大图"入口，调用 showLocalLightbox()。
 *   - 中键拖拽缩放：按下中键后上下移动鼠标即可缩放，
 *     上移放大、下移缩小（参考 3D 软件 / Figma 中键缩放手感）。
 *     每累积 MOUSE_ZOOM_THRESHOLD 像素触发一次 zoom(ZOOM_FACTOR)。
 *   - 容器 CSS 隔离（.drawio-viewer-root）阻止 Tailwind preflight 的
 *     `img { display: block }` 渗透到 viewer 内部。
 *     lightbox 元素被添加到 document.body（不在容器内），
 *     需额外全局 CSS 规则恢复其 img 为 inline（见 globals.css）。
 */

import { useEffect, useRef, useState } from 'react';
import { loadDrawioViewer, type GraphViewerInstance } from './load-drawio-viewer';

export type DrawioViewerProps = {
  /** .drawio 文件完整 XML 内容 */
  xml: string;
  /** 渲染失败回调（XML 非法、viewer 加载失败） */
  onError: (message: string) => void;
};

/**
 * 中键拖拽缩放参数。
 * - 每累积 MOUSE_ZOOM_THRESHOLD 像素的垂直位移触发一次 zoom(ZOOM_FACTOR)。
 * - ZOOM_FACTOR 取 1.1（小于 mxGraph 默认 zoomFactor 1.2），
 *   让中键拖拽的缩放步长更细、手感更平滑。
 */
const MOUSE_ZOOM_THRESHOLD = 8;
const ZOOM_FACTOR = 1.1;

export function DrawioViewer({ xml, onError }: DrawioViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<GraphViewerInstance | null>(null);
  const [dragging, setDragging] = useState(false);
  /** 中键拖拽缩放进行中 */
  const [zoomDragging, setZoomDragging] = useState(false);
  /** 中键拖拽过程中累积的垂直位移（用于按阈值触发 zoom） */
  const zoomAccumY = useRef(0);
  /** 上一帧鼠标 clientY，用于计算增量 */
  const zoomLastY = useRef(0);

  useEffect(() => {
    if (!dragging) return;
    const stopDragging = () => setDragging(false);
    window.addEventListener('mouseup', stopDragging);
    window.addEventListener('blur', stopDragging);
    return () => {
      window.removeEventListener('mouseup', stopDragging);
      window.removeEventListener('blur', stopDragging);
    };
  }, [dragging]);

  useEffect(() => {
    const cursor = dragging ? 'grabbing' : 'grab';
    viewerRef.current?.graph?.container?.style.setProperty('cursor', cursor, 'important');
  }, [dragging]);

  // ── 中键拖拽缩放 ───────────────────────────────────────
  // 监听全局 mousemove / mouseup / blur：
  //   - mousemove：累积垂直位移，达到阈值时触发 graph.zoom(factor)。
  //     上移（deltaY < 0）放大，下移（deltaY > 0）缩小。
  //   - mouseup / blur：结束中键拖拽。
  // 阈值循环处理一次性长距离移动，保证快速拖动也能连续缩放。
  useEffect(() => {
    if (!zoomDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      // 阻止中键拖拽时浏览器自动滚动光标行为
      e.preventDefault();
      const dy = e.clientY - zoomLastY.current;
      zoomLastY.current = e.clientY;
      zoomAccumY.current += dy;

      const graph = viewerRef.current?.graph;
      if (!graph?.zoom) return;

      // 累积位移达阈值后循环触发 zoom，支持一次移动跨多个阈值
      while (zoomAccumY.current >= MOUSE_ZOOM_THRESHOLD) {
        graph.zoom(1 / ZOOM_FACTOR); // 下移 → 缩小
        zoomAccumY.current -= MOUSE_ZOOM_THRESHOLD;
      }
      while (zoomAccumY.current <= -MOUSE_ZOOM_THRESHOLD) {
        graph.zoom(ZOOM_FACTOR); // 上移 → 放大
        zoomAccumY.current += MOUSE_ZOOM_THRESHOLD;
      }
    };

    const stopZoomDrag = () => setZoomDragging(false);

    window.addEventListener('mousemove', handleMouseMove, { passive: false });
    window.addEventListener('mouseup', stopZoomDrag);
    window.addEventListener('blur', stopZoomDrag);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', stopZoomDrag);
      window.removeEventListener('blur', stopZoomDrag);
    };
  }, [zoomDragging]);

  // 中键拖拽时同步 graph 容器 cursor 为 ns-resize，明示垂直缩放方向
  useEffect(() => {
    if (!zoomDragging) return;
    viewerRef.current?.graph?.container?.style.setProperty('cursor', 'ns-resize', 'important');
  }, [zoomDragging]);

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
          // createViewerForElement 不返回值（返回 undefined），
          // viewer 实例通过第二个参数（回调）获取。
          GraphViewer.createViewerForElement(containerRef.current, (v) => {
            if (cancelled) return;
            viewerRef.current = v;
            // viewer-static.min.js 中 setPanning(false) 被硬编码调用，
            // 需要手动启用 panning 以支持左键拖拽平移。
            // panningHandler 在 init 中已配置好 useLeftButtonForPanning 等。
            v.graph?.setPanning?.(true);
            // 禁用 resizeContainer：config resize:true 会让 viewer 开启
            // graph.resizeContainer，在 sizeDidChange 中通过 doResizeContainer
            // 把容器 inline height 设为内容高度（覆盖 CSS height:100%），
            // 导致垂直方向无滚动空间（scrollHeight==clientHeight），
            // 左键拖拽平移只能左右、不能上下。
            // 禁用后容器保持 CSS 高度，内容超出则 overflow:auto 滚动。
            if (v.graph) {
              v.graph.resizeContainer = false;
              // 清除 viewer 初始化时已设置的 inline height
              v.graph.container?.style.removeProperty('height');
              // 确保 overflow 为 auto（panning 通过 scrollLeft/scrollTop 实现）
              v.graph.container?.style.setProperty('overflow', 'auto');
            }
            v.graph?.container?.style.setProperty('cursor', 'grab', 'important');
          });
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
        const lightbox = viewer.showLocalLightbox?.();
        lightbox?.chromelessToolbar?.classList.add('drawio-lightbox-toolbar');
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
      className={`drawio-viewer-root h-full min-w-0 max-w-full overflow-hidden ${
        zoomDragging ? 'cursor-ns-resize' : dragging ? 'cursor-grabbing' : 'cursor-grab'
      }`}
      onContextMenu={handleContextMenu}
      onMouseDown={(e) => {
        if (e.button === 1) {
          // 中键：启动拖拽缩放，阻止浏览器自动滚动行为
          e.preventDefault();
          zoomAccumY.current = 0;
          zoomLastY.current = e.clientY;
          setZoomDragging(true);
        } else if (e.button === 0) {
          setDragging(true);
        }
      }}
      onMouseUp={() => {
        setDragging(false);
        setZoomDragging(false);
      }}
    />
  );
}
