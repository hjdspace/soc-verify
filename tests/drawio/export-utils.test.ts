import { describe, expect, it } from 'vitest';
import {
  MAX_EXPORT_DIMENSION_PX,
  MAX_PDF_PAGE_INCH,
  MIN_PDF_PAGE_INCH,
  captureTargetSize,
  effectiveExportScale,
  pdfPageSizeInches,
  roundBounds,
} from '../../src/main/drawio/export-utils';

describe('drawio/export-utils - roundBounds', () => {
  it('取整并外扩 pad，保证内容完整覆盖', () => {
    expect(roundBounds({ x: 10.4, y: -3.2, width: 100.6, height: 50.1 }, 2)).toEqual({
      x: 8,
      y: -6,
      width: 105,
      height: 55,
    });
  });

  it('pad=0 时不外扩', () => {
    expect(roundBounds({ x: 5, y: 5, width: 40, height: 40 }, 0)).toEqual({
      x: 5,
      y: 5,
      width: 40,
      height: 40,
    });
  });
});

describe('drawio/export-utils - effectiveExportScale', () => {
  it('常规尺寸下透传请求倍率', () => {
    expect(effectiveExportScale({ x: 0, y: 0, width: 1000, height: 800 }, 2)).toBe(2);
  });

  it('非法倍率（0/负数）回落到 1', () => {
    expect(effectiveExportScale({ x: 0, y: 0, width: 1000, height: 800 }, 0)).toBe(1);
    expect(effectiveExportScale({ x: 0, y: 0, width: 1000, height: 800 }, -3)).toBe(1);
  });

  it('超大图收敛渲染倍率，保证最长边不超过上限', () => {
    const bounds = { x: 0, y: 0, width: 10_000, height: 8_000 };
    const s = effectiveExportScale(bounds, 2);
    expect(s).toBeCloseTo(MAX_EXPORT_DIMENSION_PX / 10_000, 6);
    expect(10_000 * s).toBeLessThanOrEqual(MAX_EXPORT_DIMENSION_PX);
  });

  it('即使 scale=1，超限图也允许 <1 倍率', () => {
    const s = effectiveExportScale({ x: 0, y: 0, width: 20_000, height: 10_000 }, 1);
    expect(s).toBeCloseTo(MAX_EXPORT_DIMENSION_PX / 20_000, 6);
    expect(s).toBeLessThan(1);
  });
});

describe('drawio/export-utils - captureTargetSize', () => {
  it('取整为正整数像素', () => {
    expect(captureTargetSize({ x: 0, y: 0, width: 120.4, height: 89.6 })).toEqual({
      width: 120,
      height: 90,
    });
  });

  it('最小保护为 1px', () => {
    expect(captureTargetSize({ x: 0, y: 0, width: 0.2, height: 0.1 })).toEqual({
      width: 1,
      height: 1,
    });
  });
});

describe('drawio/export-utils - pdfPageSizeInches', () => {
  it('px 按 96dpi 换算为 inch', () => {
    expect(pdfPageSizeInches({ x: 0, y: 0, width: 960, height: 480 }, 0)).toEqual({
      width: 10,
      height: 5,
    });
  });

  it('pad 参与换算（等效 --crop 加留白）', () => {
    expect(pdfPageSizeInches({ x: 0, y: 0, width: 960, height: 480 }, 48)).toEqual({
      width: 11,
      height: 6,
    });
  });

  it('过小图形不低于下限页尺寸', () => {
    const page = pdfPageSizeInches({ x: 0, y: 0, width: 10, height: 10 }, 0);
    expect(page.width).toBe(MIN_PDF_PAGE_INCH);
    expect(page.height).toBe(MIN_PDF_PAGE_INCH);
  });

  it('过大图形不超过上限页尺寸', () => {
    const page = pdfPageSizeInches({ x: 0, y: 0, width: 1e7, height: 1e7 }, 0);
    expect(page.width).toBe(MAX_PDF_PAGE_INCH);
    expect(page.height).toBe(MAX_PDF_PAGE_INCH);
  });
});
