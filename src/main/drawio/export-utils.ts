/**
 * drawio 导出纯计算工具 —— 无 Electron 依赖，便于单元测试。
 */

/** 图形边界（css px，容器坐标系） */
export type DiagramBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** 栅格导出单边像素上限（防止超大图位图失控，Windows GDI+/BMP 限制参考值内） */
export const MAX_EXPORT_DIMENSION_PX = 16_384;

/** PDF 页面尺寸下限（inch），避免 0 尺寸页导致 printToPDF 报错 */
export const MIN_PDF_PAGE_INCH = 1;

/** PDF 页面尺寸上限（inch） */
export const MAX_PDF_PAGE_INCH = 200;

/** px → inch（Electron/Chromium 默认 96 css px = 1 inch） */
const PX_PER_INCH = 96;

/** 对 bounds 取整并外扩 pad，得到内容完整覆盖的最小矩形。 */
export function roundBounds(b: DiagramBounds, pad: number): DiagramBounds {
  return {
    x: Math.floor(b.x) - pad,
    y: Math.floor(b.y) - pad,
    width: Math.ceil(b.width) + pad * 2,
    height: Math.ceil(b.height) + pad * 2,
  };
}

/**
 * 计算栅格导出实际使用的渲染倍率：渲染最长边（bounds × 倍率）超过
 * MAX_EXPORT_DIMENSION_PX 时收敛到上限内（超大图允许 <1 倍率换可控位图）。
 */
export function effectiveExportScale(bounds: DiagramBounds, scale: number): number {
  const s = scale > 0 ? scale : 1;
  const maxEdge = Math.max(bounds.width, bounds.height);
  if (maxEdge <= 0) return 1;
  return Math.min(s, MAX_EXPORT_DIMENSION_PX / maxEdge);
}

/**
 * 计算自定义 PDF 页面尺寸（inch）。图形铺满整页（等效 CLI --crop），
 * 加 padInch 留白；尺寸限制在 [MIN_PDF_PAGE_INCH, MAX_PDF_PAGE_INCH] 内。
 */
export function pdfPageSizeInches(
  bounds: DiagramBounds,
  padPx: number,
): { width: number; height: number } {
  const width = (bounds.width + padPx * 2) / PX_PER_INCH;
  const height = (bounds.height + padPx * 2) / PX_PER_INCH;
  return {
    width: Math.min(MAX_PDF_PAGE_INCH, Math.max(MIN_PDF_PAGE_INCH, width)),
    height: Math.min(MAX_PDF_PAGE_INCH, Math.max(MIN_PDF_PAGE_INCH, height)),
  };
}

/** PNG/JPG 输出像素尺寸 = 捕获区域取整（scale 已通过页面渲染体现） */
export function captureTargetSize(rect: DiagramBounds): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
}

/**
 * JPEG 压缩质量（预留调节入口）。
 */
export const JPEG_QUALITY = 90;
