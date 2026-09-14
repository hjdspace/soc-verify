/**
 * PDF 图像提取与矢量页渲染 —— 行为测试（issue 11，spec §3 / A03）。
 *
 * 测试缝：直接调用主进程模块 `extractPdfAssets`（真实 pdfjs + 真实 canvas 编码），
 * 输入是 `tests/fixtures/pdf-fixture.ts` 手工构造的合法混合 PDF——
 * 文字页 + 位图对象 + 矢量时序图 + 无文字层页，页码与原 PDF 一一对应。
 *
 * 覆盖：
 *  - 位图对象提取（页码/尺寸/CTM 坐标/内容寻址 hash）
 *  - 同图多次出现：复用字节但保留各自位置
 *  - 矢量时序图页判定 + 整页渲染兜底（auto / 指定页 / all）
 *  - 单张最长边上限与缩放标记
 *  - 分批渲染（每批上限）与续跑（donePages → skipped + 原因）
 *  - 取消（signal）不产出半成品记录，已处理页保留
 *  - 统计可见：总页/已处理/失败/跳过 + 逐页原因
 *  - 无文字层区分（文本页计数）与损坏输入的结构化失败
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  extractPdfAssets,
  planRenderBatch,
  DEFAULT_MAX_EDGE,
  DEFAULT_RENDER_BATCH_SIZE,
  type PdfAssetExtraction,
  type PdfAssetOptions,
} from '@main/kb/pdf-assets';
import {
  corruptPdfFixture,
  mixedPdfFixture,
  vectorOnlyPdfFixture,
} from './fixtures/pdf-fixture';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

async function extract(bytes: Uint8Array, options: PdfAssetOptions = {}): Promise<PdfAssetExtraction> {
  const result = await extractPdfAssets(bytes, options);
  if (!result.ok) throw new Error(`提取失败: ${result.error.code} ${result.error.message}`);
  return result.extraction;
}

/** PNG 头部宽高（IHDR），用于核对渲染尺寸 */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const buf = Buffer.from(bytes);
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('pdf-assets 位图对象提取', () => {
  it('提取嵌入位图：页码、像素尺寸、内容寻址 hash 与文件名一致', async () => {
    const extraction = await extract(mixedPdfFixture(), { render: 'none' });

    const objects = extraction.records.filter((r) => r.method === 'object');
    expect(objects.length).toBeGreaterThan(0);

    const first = objects.find((r) => r.page === 1)!;
    expect(first).toBeDefined();
    expect(first.width).toBe(2);
    expect(first.height).toBe(2);
    expect(first.ext).toBe('png');
    expect(first.file).toBe(`${first.assetId}.png`);

    const blob = extraction.blobs.find((b) => b.assetId === first.assetId)!;
    expect(blob).toBeDefined();
    expect(sha256(blob.data)).toBe(first.assetId);
    expect(pngSize(blob.data)).toEqual({ width: 2, height: 2 });
  });

  it('记录页内可靠坐标（CTM 推导，PDF 用户空间）', async () => {
    const extraction = await extract(mixedPdfFixture(), { render: 'none' });
    const first = extraction.records.find((r) => r.method === 'object' && r.page === 1)!;
    expect(first.rect).toEqual({ x: 120, y: 110, width: 40, height: 40 });
  });

  it('同图多次出现：复用同一字节但各自保留位置记录', async () => {
    const extraction = await extract(mixedPdfFixture(), { render: 'none' });
    const page1 = extraction.records.filter((r) => r.method === 'object' && r.page === 1);
    expect(page1).toHaveLength(2);

    expect(page1[0]!.assetId).toBe(page1[1]!.assetId);
    expect(page1[0]!.rect).not.toEqual(page1[1]!.rect);
    // 字节只存一份（同 assetId 不重复出现在 blobs）
    const sameId = extraction.blobs.filter((b) => b.assetId === page1[0]!.assetId);
    expect(sameId).toHaveLength(1);
  });

  it('assets 命名按内容 hash，且 file 与 assetId 一一对应', async () => {
    const extraction = await extract(mixedPdfFixture(), { render: 'none' });
    for (const record of extraction.records) {
      expect(record.file).toBe(`${record.assetId}.${record.ext}`);
      expect(record.assetId).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('pdf-assets 页判定与矢量页渲染', () => {
  it('逐页判定：位图页 / 矢量页 / 无文字层页 可区分', async () => {
    const extraction = await extract(mixedPdfFixture(), { render: 'none' });
    const [p1, p2, p3] = extraction.pages;
    expect(extraction.pages).toHaveLength(3);

    expect(p1!.kind).toBe('bitmap');
    expect(p1!.bitmapCount).toBe(2);
    expect(p1!.vectorOps).toBeGreaterThan(0);
    expect(p1!.textChars).toBeGreaterThan(0);

    expect(p2!.kind).toBe('vector');
    expect(p2!.bitmapCount).toBe(0);
    expect(p2!.vectorOps).toBeGreaterThan(0);

    expect(p3!.kind).toBe('bitmap');
    expect(p3!.textChars).toBe(0);
  });

  it('无位图证据的页进入 renderCandidates，标为不可靠判定', async () => {
    const extraction = await extract(mixedPdfFixture(), { render: 'none' });
    expect(extraction.stats.renderCandidates).toContain(2);
    expect(extraction.pages.find((p) => p.page === 2)!.uncertain).toBe(true);
    expect(extraction.pages.find((p) => p.page === 1)!.uncertain).toBe(false);
  });

  it('auto：对无位图证据的页整页渲染作为读图证据，页码与原 PDF 一致', async () => {
    const extraction = await extract(mixedPdfFixture(), { render: 'auto' });
    const renders = extraction.records.filter((r) => r.method === 'page-render');
    expect(renders.map((r) => r.page)).toEqual([2]);

    const rec = renders[0]!;
    expect(rec.render).toEqual({ scale: 2, maxEdge: DEFAULT_MAX_EDGE, scaled: false });
    const blob = extraction.blobs.find((b) => b.assetId === rec.assetId)!;
    expect(pngSize(blob.data)).toEqual({ width: rec.width, height: rec.height });
    // 矢量时序图确实被画出来（非空白）
    expect(rec.width).toBe(400);
    expect(rec.height).toBe(400);
  });

  it('指定页渲染与 all 渲染均可用', async () => {
    const pages = await extract(mixedPdfFixture(), { render: [1, 3] });
    expect(pages.records.filter((r) => r.method === 'page-render').map((r) => r.page)).toEqual([1, 3]);

    const all = await extract(mixedPdfFixture(), { render: 'all' });
    expect(all.records.filter((r) => r.method === 'page-render').map((r) => r.page)).toEqual([1, 2, 3]);
  });

  it('渲染尺寸受单张最长边上限约束并标记 scaled', async () => {
    const extraction = await extract(vectorOnlyPdfFixture(1), { render: 'all', maxEdge: 100, scale: 4 });
    const rec = extraction.records.find((r) => r.method === 'page-render')!;
    expect(Math.max(rec.width, rec.height)).toBeLessThanOrEqual(100);
    expect(rec.render?.scaled).toBe(true);
    expect(rec.render?.maxEdge).toBe(100);
  });
});

describe('pdf-assets 分批渲染与续跑', () => {
  it('planRenderBatch 每批不超过上限并给出剩余页', () => {
    const pages = Array.from({ length: 120 }, (_, i) => i + 1);
    const { batch, remaining } = planRenderBatch(pages, 50);
    expect(batch).toHaveLength(50);
    expect(batch[0]).toBe(1);
    expect(remaining).toHaveLength(70);
    expect(remaining[0]).toBe(51);
  });

  it('超过单批上限时只渲染一批，其余进入 renderRemaining 供继续下一批', async () => {
    const bytes = vectorOnlyPdfFixture(5);
    const extraction = await extract(bytes, { render: 'auto', batchSize: 2 });

    expect(extraction.records.filter((r) => r.method === 'page-render').map((r) => r.page)).toEqual([1, 2]);
    expect(extraction.stats.renderRendered).toEqual([1, 2]);
    expect(extraction.stats.renderRemaining).toEqual([3, 4, 5]);
    expect(extraction.stats.batchLimitReached).toBe(true);

    // 用户选页继续下一批
    const next = await extract(bytes, { render: extraction.stats.renderRemaining, batchSize: 2 });
    expect(next.records.filter((r) => r.method === 'page-render').map((r) => r.page)).toEqual([3, 4]);
  });

  it('续跑：donePages 记入跳过并带原因，不重复产出记录', async () => {
    const extraction = await extract(vectorOnlyPdfFixture(3), {
      render: 'auto',
      donePages: [1],
    });
    expect(extraction.stats.skipped).toEqual([{ page: 1, reason: 'done' }]);
    expect(extraction.stats.skippedPages).toBe(1);
    expect(extraction.records.every((r) => r.page !== 1)).toBe(true);
    expect(extraction.stats.renderCandidates).toEqual([2, 3]);
  });
});

describe('pdf-assets 取消与统计', () => {
  it('取消后不产出未处理页的记录，已处理页保留且不抛异常', async () => {
    const controller = new AbortController();
    const extraction = await extract(vectorOnlyPdfFixture(4), {
      render: 'all',
      onPageStart: (page) => {
        if (page === 3) controller.abort();
      },
      signal: controller.signal,
    });

    expect(extraction.cancelled).toBe(true);
    expect(extraction.records.map((r) => r.page)).toEqual([1, 2]);
    expect(extraction.stats.processedPages).toBe(2);
    expect(extraction.stats.totalPages).toBe(4);
  });

  it('统计：总页/已处理/失败/跳过 + 文本页计数可见', async () => {
    const extraction = await extract(mixedPdfFixture(), { render: 'auto' });
    expect(extraction.stats.totalPages).toBe(3);
    expect(extraction.stats.processedPages).toBe(3);
    expect(extraction.stats.failedPages).toBe(0);
    expect(extraction.stats.skippedPages).toBe(0);
    expect(extraction.stats.failures).toEqual([]);
    expect(extraction.stats.textPages).toBe(1);
    expect(extraction.pages.filter((p) => p.textChars > 0).map((p) => p.page)).toEqual([1]);
  });

  it('损坏输入返回结构化失败而不抛出', async () => {
    const result = await extractPdfAssets(corruptPdfFixture());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('malformed');
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });
});

describe('pdf-assets 默认参数', () => {
  it('默认不改变约定值（spec §3：单批 50 页、最长边 2048px）', () => {
    expect(DEFAULT_RENDER_BATCH_SIZE).toBe(50);
    expect(DEFAULT_MAX_EDGE).toBe(2048);
  });

  it('默认 render=auto 且默认提取位图', async () => {
    const extraction = await extract(mixedPdfFixture());
    expect(extraction.records.some((r) => r.method === 'object')).toBe(true);
    expect(extraction.records.some((r) => r.method === 'page-render')).toBe(true);
  });
});
