/**
 * pdfjs 运行时与打包 smoke（issue 11，spec §3/§11、A22）。
 *
 * 覆盖：
 *  - 运行时解析：legacy ESM 入口 + fake worker 相邻；字体/cmap/wasm 资源
 *    全部指向本地目录（无 http/CDN）——开发形态回退 node_modules。
 *  - 打包形态 smoke（需先 `npm run prepare:pdfjs` 产出 resources/pdfjs）：
 *    解析优先命中 resources/pdfjs（source='resources'），资源目录齐备，
 *    并仅用该运行时对真实混合 PDF 完成提图 + 矢量页整页渲染。
 *  - 实测：逐页内存采样（信息性记录，数值随环境浮动，不作硬断言）、
 *    大文档处理到一半取消（已处理页保留、统计可见）。
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolvePdfRuntimePaths,
  pdfResourceDirUrl,
  type PdfRuntimeInfo,
} from '@main/kb/pdf-runtime';
import { extractPdfAssets } from '@main/kb/pdf-assets';
import { buildPdf, mixedPdfFixture, IMAGE_A } from './fixtures/pdf-fixture';

// ─── 运行时解析（开发形态即可运行） ─────────────────────────────

describe('pdfjs 运行时解析与本地资源', () => {
  it('解析出 legacy 入口且 fake worker 与其相邻', () => {
    const info: PdfRuntimeInfo | null = resolvePdfRuntimePaths();
    expect(info).not.toBeNull();
    if (!info) return;
    expect(info.entry).toMatch(/pdf\.mjs$/);
    expect(info.worker).toMatch(/pdf\.worker\.mjs$/);
    expect(info.worker).toBe(join(info.root, 'legacy', 'build', 'pdf.worker.mjs'));
  });

  it('字体/cmap/wasm 资源全部指向本地目录，无 http/CDN', () => {
    const info = resolvePdfRuntimePaths();
    expect(info).not.toBeNull();
    if (!info) return;
    for (const url of Object.values(
      // 与 pdf-assets.getDocument 使用同一资源基址形态
      {
        standardFontDataUrl: pdfResourceDirUrl(join(info.root, 'standard_fonts')),
        cMapUrl: pdfResourceDirUrl(join(info.root, 'cmaps')),
        wasmUrl: pdfResourceDirUrl(join(info.root, 'wasm')),
      },
    )) {
      expect(url.startsWith('http')).toBe(false);
      expect(url.endsWith('/')).toBe(true);
      expect(existsSync(url)).toBe(true);
    }
  });
});

// ─── 打包形态 smoke（prepare:pdfjs 产物） ───────────────────────

const PREPARED_ROOT = join(process.cwd(), 'resources', 'pdfjs');
const preparedReady = (): boolean =>
  existsSync(join(PREPARED_ROOT, 'legacy', 'build', 'pdf.mjs')) &&
  existsSync(join(PREPARED_ROOT, 'standard_fonts')) &&
  existsSync(join(PREPARED_ROOT, 'wasm'));

describe('打包形态（npm run prepare:pdfjs 之后）', () => {
  // 未 prepare 时跳过并给出可操作原因（fresh clone 直接跑全量测试不阻塞）
  const d = it.skipIf(!preparedReady());

  d('解析优先命中 resources/pdfjs，source=resources', () => {
    const info = resolvePdfRuntimePaths();
    expect(info).not.toBeNull();
    if (!info) return;
    expect(info.source).toBe('resources');
    expect(info.root).toBe(PREPARED_ROOT);
  }, 10_000);

  d('字体/cmap/wasm 资源目录随打包产物齐备', () => {
    for (const dir of ['legacy/build', 'standard_fonts', 'cmaps', 'wasm']) {
      expect(existsSync(join(PREPARED_ROOT, dir)), dir).toBe(true);
    }
    // pdfjs 在打包形态下解析 @napi-rs/canvas 的基座必须存在
    // （pdf.mjs 的 createRequire(import.meta.url) 从自身位置向上找）
    expect(existsSync(join(PREPARED_ROOT, 'node_modules', '@napi-rs', 'canvas', 'index.js'))).toBe(true);
  });

  d('真实 PDF smoke：仅用打包运行时完成位图提取 + 矢量页整页渲染', async () => {
    const result = await extractPdfAssets(mixedPdfFixture(), {
      runtimeRoot: PREPARED_ROOT,
      render: 'auto',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.extraction.runtime.source).toBe('resources');
    expect(result.extraction.records.some((r) => r.method === 'object' && r.page === 1)).toBe(true);
    expect(result.extraction.records.some((r) => r.method === 'page-render' && r.page === 2)).toBe(true);
    expect(result.extraction.stats.failedPages).toBe(0);
  }, 60_000);
});

// ─── 逐页内存采样与大文档取消（实测证据） ────────────────────────

/** 40 页、每页位图 + 矢量的大文档（位图页不触发整页渲染，采样聚焦提取路径） */
function largePdfFixture(pageCount: number): Buffer {
  return buildPdf(
    Array.from({ length: pageCount }, (_, i) => ({
      text: [`page ${i + 1} status register`],
      vector: true,
      images: [{ ...IMAGE_A, x: 10 + (i % 5) * 8, y: 10 + (i % 3) * 8 }],
    })),
  );
}

describe('逐页释放内存与取消（issue 11 实测）', () => {
  it('40 页提取逐页采样：内存增长有界（数值记录为证据，不作硬断言）', async () => {
    const samples: Array<{ page: number; rssMb: number; heapMb: number }> = [];
    const extraction = await (async () => {
      const result = await extractPdfAssets(largePdfFixture(40), {
        render: 'none',
        onPageStart: (page) => {
          const m = process.memoryUsage();
          samples.push({ page, rssMb: Math.round(m.rss / 1048576), heapMb: Math.round(m.heapUsed / 1048576) });
        },
      });
      if (!result.ok) throw new Error(result.error.message);
      return result.extraction;
    })();

    expect(extraction.stats.processedPages).toBe(40);
    expect(extraction.stats.failedPages).toBe(0);

    // 信息性记录（交接证据）：首个/末个样本与峰值，逐页 cleanup 后不应线性膨胀
    const first = samples[0]!;
    const last = samples[samples.length - 1]!;
    const peakRss = Math.max(...samples.map((s) => s.rssMb));
    console.info(
      `[issue-11] 内存采样 rss: 首 ${first.rssMb}MB → 末 ${last.rssMb}MB，峰值 ${peakRss}MB；` +
        `heap: 首 ${first.heapMb}MB → 末 ${last.heapMb}MB（40 页，逐页 cleanup）`,
    );
    // 保守护栏：40 页小位图文档的 RSS 增长不应超过 512MB（真泄漏会是 GB 级）
    expect(peakRss - first.rssMb).toBeLessThan(512);
  }, 120_000);

  it('大文档处理到一半取消：已处理页保留、未处理页不产出且统计可见', async () => {
    const controller = new AbortController();
    const result = await extractPdfAssets(largePdfFixture(40), {
      render: 'none',
      onPageStart: (page) => {
        if (page === 25) controller.abort();
      },
      signal: controller.signal,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.extraction.cancelled).toBe(true);
    expect(result.extraction.stats.processedPages).toBe(24);
    expect(result.extraction.stats.totalPages).toBe(40);
    expect(result.extraction.records.every((r) => r.page <= 24)).toBe(true);
  }, 120_000);
});
