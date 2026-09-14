/**
 * webgl-support — WebGL 能力探测（spec §9/§11，issue 26）。
 *
 * sigma 依赖 WebGL 渲染画布；WebGL 不可用时必须仍有可用的图视图（邻接列表），
 * 而不能只是空白画布。探测是纯函数（可注入 canvas 工厂），因此「无 WebGL」
 * 分支可以在单测与冒烟测试中被真实触发。
 */

/** 探测结果：webgl2 优先，回退 webgl，都没有则 none。 */
export type WebGLSupport = 'webgl2' | 'webgl' | 'none';

export type WebGLProbe = {
  /** 返回一个可用于探测的 canvas；返回 null 表示环境不支持 canvas */
  createCanvas?: () => HTMLCanvasElement | null;
};

function defaultCreateCanvas(): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  try {
    return document.createElement('canvas');
  } catch {
    return null;
  }
}

/**
 * 探测 WebGL 支持。
 *
 * 创建真实上下文并立即丢弃（`WEBGL_lose_context`），避免探测本身占用一个
 * GPU 上下文槽位——Electron 里上下文数量有上限，探测泄漏会让正式画布创建失败。
 */
export function detectWebGLSupport(probe: WebGLProbe = {}): WebGLSupport {
  const createCanvas = probe.createCanvas ?? defaultCreateCanvas;
  let canvas: HTMLCanvasElement | null = null;
  try {
    canvas = createCanvas();
  } catch {
    return 'none';
  }
  if (!canvas) return 'none';

  const attempt = (contextId: 'webgl2' | 'webgl'): boolean => {
    try {
      const context = canvas?.getContext(contextId);
      if (!context) return false;
      const lose = (context as WebGLRenderingContext).getExtension('WEBGL_lose_context');
      lose?.loseContext();
      return true;
    } catch {
      return false;
    }
  };

  if (attempt('webgl2')) return 'webgl2';
  if (attempt('webgl')) return 'webgl';
  return 'none';
}

/** 是否可以用 sigma 画布（webgl2/webgl 任一可用）。 */
export function canUseGraphCanvas(support: WebGLSupport): boolean {
  return support !== 'none';
}

/**
 * 释放画布上的 WebGL 上下文。
 *
 * sigma.kill() 会移除监听并丢掉 canvas 引用，但 GPU 上下文要等 GC 才回收；
 * 显式 loseContext 才能保证反复切库/切视图不累积上下文（spec §9「卸载释放」）。
 */
export function releaseWebGLContexts(container: HTMLElement | null): number {
  if (!container) return 0;
  let released = 0;
  const canvases = container.querySelectorAll('canvas');
  canvases.forEach((canvas) => {
    for (const contextId of ['webgl2', 'webgl'] as const) {
      let context: RenderingContext | null = null;
      try {
        context = canvas.getContext(contextId);
      } catch {
        context = null;
      }
      if (!context) continue;
      try {
        (context as WebGLRenderingContext).getExtension('WEBGL_lose_context')?.loseContext();
        released += 1;
      } catch {
        // 释放失败不阻断卸载
      }
    }
  });
  return released;
}
