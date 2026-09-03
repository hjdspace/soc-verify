/**
 * drawio viewer（viewer-static.min.js，本地打包于 public/drawio/）加载器。
 *
 * viewer-static.min.js 是 diagrams.net 官方静态查看器（资源全部内联，
 * 离线可用），加载后暴露 window.GraphViewer。CSP script-src 'self' 下
 * 以相对路径从应用自身加载，无外网请求。
 */

/** viewer 实例的 graph 对象（panning / zoom 等操作需要） */
type GraphViewerGraph = {
  container?: HTMLElement;
  setPanning: (enabled: boolean) => void;
  /**
   * mxGraph.prototype.zoom(factor)。
   * factor > 1 放大（如 1.1），factor < 1 缩小（如 1/1.1）。
   * viewer-static.min.js 中 zoomIn/zoomOut 即调用此方法。
   */
  zoom?: (factor: number) => void;
  /**
   * mxGraph.prototype.resizeContainer。
   * true 时 sizeDidChange → doResizeContainer 会把容器 inline width/height
   * 设为内容大小，覆盖 CSS。viewer 配置 resize:true 会开启此行为。
   * 需在初始化后设为 false 以保持容器固定大小、启用滚动平移。
   */
  resizeContainer?: boolean;
};

type GraphViewerLightbox = {
  chromelessToolbar?: HTMLElement;
};

export type GraphViewerInstance = {
  destroy?: () => void;
  showLocalLightbox?: () => GraphViewerLightbox | void;
  graph?: GraphViewerGraph;
};

export type GraphViewerStatic = {
  createViewerForElement: (
    element: HTMLElement,
    callback?: (viewer: GraphViewerInstance) => void,
  ) => void;
};

declare global {
  interface Window {
    GraphViewer?: GraphViewerStatic;
  }
}

/** viewer data-mxgraph 配置（GraphViewer 支持的子集） */
export type GraphViewerConfig = {
  highlight?: string;
  nav?: boolean;
  resize?: boolean;
  toolbar?: string;
  'auto-fit'?: boolean;
  'auto-crop'?: boolean;
  /** lightbox: false 禁用左键点击触发 lightbox，改由右键菜单调用 */
  lightbox?: boolean;
  /** move: true 启用拖拽平移 */
  move?: boolean;
  xml: string;
};

let loaderPromise: Promise<GraphViewerStatic> | null = null;

/** 注入 <script src="drawio/viewer-static.min.js">（仅一次）并等待 GraphViewer 就绪 */
export function loadDrawioViewer(): Promise<GraphViewerStatic> {
  if (window.GraphViewer) return Promise.resolve(window.GraphViewer);
  if (loaderPromise) return loaderPromise;

  loaderPromise = new Promise<GraphViewerStatic>((resolvePromise, rejectPromise) => {
    const script = document.createElement('script');
    script.src = 'drawio/viewer-static.min.js';
    script.async = true;
    script.onload = () => {
      if (window.GraphViewer) {
        resolvePromise(window.GraphViewer);
      } else {
        rejectPromise(new Error('viewer-static.min.js loaded but GraphViewer not found'));
      }
    };
    script.onerror = () => {
      loaderPromise = null;
      rejectPromise(new Error('viewer-static.min.js failed to load'));
    };
    document.head.appendChild(script);
  });
  return loaderPromise;
}
