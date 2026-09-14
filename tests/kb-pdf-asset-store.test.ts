/**
 * PDF 资产持久化 —— 行为测试（issue 11，spec §1/§3）。
 *
 * 测试缝：真实临时库目录 + 真文件 fixture；anydoc 被 mock（本票不测转换器），
 * 但原件字节、资产目录、manifest 全部走真实文件系统。
 *
 * 覆盖：
 *  - 内容寻址落盘：`raw/assets/<sourceId>/<revision>/<hash>.png` + pdf-assets.json
 *  - 资产记录字段：sourceId/revision/页码/尺寸/提取方式/可靠坐标
 *  - 同字节只写一份；重复提取不膨胀记录（去重）但参数历史追加
 *  - 参数变化不覆写已有引用（不同渲染参数 → 新文件，旧文件与旧记录保留）
 *  - revision 分目录：同一来源两个修订的资产互不覆盖
 *  - 路径围栏：非法资产 id / 缺文件 / 未知修订 → 拒绝
 *  - 无文字层标记（纯图像来源的转换限制可解释）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const globalDataDir = join(tmpdir(), `sv-kb-pdfstore-app-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => globalDataDir) },
}));

vi.mock('@firecrawl/anydoc', () => ({
  toDocument: vi.fn(async () => {
    const err = new Error('pdf 无 document model') as Error & { code?: string };
    err.code = 'unsupported';
    throw err;
  }),
  // 模拟无文字层的扫描件：内容流没有文本算子 → 转换失败（本节第 2 组用例）
  toMarkdownBytes: vi.fn(async (bytes: Uint8Array) => {
    const latin = Buffer.from(bytes).toString('latin1');
    if (!latin.includes('BT ')) {
      const err = new Error('扫描版 PDF 无文字层') as Error & { code?: string };
      err.code = 'unsupported';
      throw err;
    }
    return '# 手册\n\nAXI outstanding limit 8\n';
  }),
  formatFromPath: vi.fn((p: string) => (p.toLowerCase().endsWith('.pdf') ? 'pdf' : undefined)),
}));

import {
  extractAndStorePdfAssets,
  storePdfAssets,
  readPdfAssetManifest,
  listPdfAssets,
  resolvePdfAssetFile,
} from '../src/main/kb/pdf-asset-store';
import { extractPdfAssets } from '../src/main/kb/pdf-assets';
import { importWikiSources } from '../src/main/kb/source-import';
import { initWikiLayout, readWikiManifest, wikiLayout } from '../src/main/kb/wiki-layout';
import { sourceIdFor } from '../src/main/kb/source-identity';
import { mixedPdfFixture, buildPdf, IMAGE_B } from './fixtures/pdf-fixture';

// ─── Fixture 搭建 ───────────────────────────────────────────────

let kbPath: string;
let incomingDir: string;

beforeEach(async () => {
  const base = join(tmpdir(), `sv-kb-pdfstore-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  kbPath = join(base, 'kb');
  incomingDir = join(base, 'incoming');
  mkdirSync(kbPath, { recursive: true });
  mkdirSync(incomingDir, { recursive: true });
  await initWikiLayout(kbPath, { kbId: 'kb-pdf-1', name: 'PDF 资产库' });
});

afterEach(() => {
  try {
    rmSync(join(kbPath, '..'), { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
});

/**
 * 导入一个真实 PDF fixture，返回 sourceId 与当前修订。
 * 转换失败（扫描版）不算错误：来源仍会保存并已完成提图。
 */
async function importPdf(name: string, bytes: Buffer) {
  const abs = join(incomingDir, name);
  writeFileSync(abs, bytes);
  const outcomes = await importWikiSources(kbPath, [{ absolutePath: abs, relPath: name }]);
  const outcome = outcomes[0]!;
  const sourceId = outcome.ok ? outcome.source.sourceId : sourceIdFor(name);
  const read = await readWikiManifest(kbPath);
  if (!read.ok) throw new Error('manifest 不可读');
  const rec = read.manifest.sources?.[sourceId];
  if (!rec) throw new Error(`来源未保存: ${outcome.ok ? '' : outcome.error.message}`);
  return { sourceId, revision: rec.currentRevision };
}

// ─── 用例 ───────────────────────────────────────────────────────

describe('pdf-asset-store 内容寻址落盘', () => {
  it('写入 raw/assets/<sourceId>/<revision>/<hash>.png 与 pdf-assets.json', async () => {
    const { sourceId, revision } = await importPdf('manual.pdf', mixedPdfFixture());

    const result = await extractAndStorePdfAssets(kbPath, sourceId, { render: 'none' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const layout = wikiLayout(kbPath);
    const dir = join(layout.rawAssetsDir, sourceId, revision);
    expect(result.dir).toBe(dir);

    const files = readdirSync(dir);
    expect(files).toContain('pdf-assets.json');
    for (const record of result.manifest.assets) {
      expect(files).toContain(record.file);
      expect(record.file).toBe(`${record.assetId}.png`);
    }
  });

  it('资产记录带 sourceId/revision/页码/尺寸/提取方式/可靠坐标', async () => {
    const { sourceId, revision } = await importPdf('manual.pdf', mixedPdfFixture());
    const result = await extractAndStorePdfAssets(kbPath, sourceId, { render: 'none' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const manifest = result.manifest;
    expect(manifest.sourceId).toBe(sourceId);
    expect(manifest.revision).toBe(revision);
    expect(manifest.assets.length).toBeGreaterThan(0);

    const obj = manifest.assets.find((a) => a.method === 'object')!;
    expect(obj.page).toBe(1);
    expect(obj.width).toBe(2);
    expect(obj.height).toBe(2);
    expect(obj.rect).toEqual({ x: 120, y: 110, width: 40, height: 40 });

    // 逐页检查与统计同样持久化（覆盖情况可解释）
    expect(manifest.pages.length).toBe(3);
    expect(manifest.stats.totalPages).toBe(3);
  });

  it('同字节只写一份文件；重复提取不膨胀记录但追加参数历史', async () => {
    const { sourceId } = await importPdf('manual.pdf', mixedPdfFixture());

    // 导入管线已自动提取一次（auto），此处以该状态为基线
    const base = await readPdfAssetManifest(kbPath, sourceId);
    expect(base).not.toBeNull();
    const extractionCount = base!.extractions.length;

    const first = await extractAndStorePdfAssets(kbPath, sourceId, { render: 'none' });
    const second = await extractAndStorePdfAssets(kbPath, sourceId, { render: 'none' });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.manifest.assets).toHaveLength(first.manifest.assets.length);
    expect(second.manifest.assets).toHaveLength(base!.assets.length);
    expect(second.addedRecords).toBe(0);
    expect(second.manifest.extractions).toHaveLength(extractionCount + 2);
    expect(second.written).toBe(0);
  });

  it('参数变化不覆写已有引用：新参数产出新文件，旧文件与旧记录保留', async () => {
    const { sourceId } = await importPdf('manual.pdf', mixedPdfFixture());

    const bitmapsOnly = await extractAndStorePdfAssets(kbPath, sourceId, { render: 'none' });
    const withRender = await extractAndStorePdfAssets(kbPath, sourceId, { render: 'all' });
    expect(bitmapsOnly.ok && withRender.ok).toBe(true);
    if (!bitmapsOnly.ok || !withRender.ok) return;

    const layout = wikiLayout(kbPath);
    const dir = join(layout.rawAssetsDir, sourceId, bitmapsOnly.manifest.revision);

    // 新参数：新增页面渲染记录 + 新字节（页面 1/3 是位图页，auto 不会渲染它们）
    const before = new Set(bitmapsOnly.manifest.assets.map((a) => a.file));
    const after = new Set(withRender.manifest.assets.map((a) => a.file));
    expect(after.size).toBeGreaterThan(before.size);
    expect(withRender.manifest.assets.filter((a) => a.method === 'page-render').map((a) => a.page)).toEqual([1, 2, 3]);

    // 旧引用仍可解析（文件仍在盘上）
    for (const file of before) {
      expect(existsSync(join(dir, file))).toBe(true);
    }
    expect(bitmapsOnly.manifest.extractions.length).toBeLessThan(withRender.manifest.extractions.length);
  });

  it('同一来源两个修订的资产互不覆盖', async () => {
    const v1 = await importPdf('manual.pdf', mixedPdfFixture());
    const first = await extractAndStorePdfAssets(kbPath, v1.sourceId, { render: 'none' });
    expect(first.ok).toBe(true);

    // 同路径新字节 → 新 revision
    const v2 = await importPdf('manual.pdf', buildPdf([{ images: [IMAGE_B] }]));
    expect(v2.revision).not.toBe(v1.revision);
    const second = await extractAndStorePdfAssets(kbPath, v2.sourceId, { render: 'none' });
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const layout = wikiLayout(kbPath);
    const dir1 = join(layout.rawAssetsDir, v1.sourceId, v1.revision);
    const dir2 = join(layout.rawAssetsDir, v1.sourceId, v2.revision);
    expect(existsSync(dir1)).toBe(true);
    expect(existsSync(dir2)).toBe(true);

    // 指定修订读取只看到该修订的资产
    const rev1 = await listPdfAssets(kbPath, v1.sourceId, v1.revision);
    expect(rev1?.length).toBe(first.manifest.assets.length);
    const rev2 = await listPdfAssets(kbPath, v1.sourceId, v2.revision);
    expect(rev2?.length).toBe(second.manifest.assets.length);

    // 缺省读取 = 当前修订
    const current = await readPdfAssetManifest(kbPath, v1.sourceId);
    expect(current?.revision).toBe(v2.revision);
  });
});

describe('pdf-asset-store 读取与围栏', () => {
  it('resolvePdfAssetFile 只接受内容 hash 命名且必须存在', async () => {
    const { sourceId, revision } = await importPdf('manual.pdf', mixedPdfFixture());
    const stored = await extractAndStorePdfAssets(kbPath, sourceId, { render: 'none' });
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;

    const record = stored.manifest.assets[0]!;
    const resolved = await resolvePdfAssetFile(kbPath, sourceId, revision, record.assetId);
    expect(resolved).toBe(join(stored.dir, record.file));

    expect(await resolvePdfAssetFile(kbPath, sourceId, revision, '../../sources/manual.pdf')).toBeNull();
    expect(await resolvePdfAssetFile(kbPath, sourceId, revision, 'not-a-hash')).toBeNull();
    expect(await resolvePdfAssetFile(kbPath, sourceId, revision, 'a'.repeat(64))).toBeNull();
    expect(await resolvePdfAssetFile(kbPath, sourceId, '../..', record.assetId)).toBeNull();
  });

  it('未知来源/非 PDF/缺失来源返回结构化失败', async () => {
    await importPdf('manual.pdf', mixedPdfFixture());

    const missing = await extractAndStorePdfAssets(kbPath, 'f'.repeat(64), { render: 'none' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('sourceNotFound');

    const txt = join(incomingDir, 'notes.txt');
    writeFileSync(txt, 'hello');
    const t = await importWikiSources(kbPath, [{ absolutePath: txt, relPath: 'notes.txt' }]);
    expect(t[0]!.ok).toBe(true);
    const notPdf = await extractAndStorePdfAssets(kbPath, sourceIdFor('notes.txt'), { render: 'none' });
    expect(notPdf.ok).toBe(false);
    if (!notPdf.ok) expect(notPdf.error.code).toBe('notPdf');
  });

  it('未提取过的来源读取返回 null 而不报错', async () => {
    const txt = join(incomingDir, 'notes.txt');
    writeFileSync(txt, 'hello');
    const t = await importWikiSources(kbPath, [{ absolutePath: txt, relPath: 'notes.txt' }]);
    expect(t[0]!.ok).toBe(true);

    const sourceId = sourceIdFor('notes.txt');
    expect(await readPdfAssetManifest(kbPath, sourceId)).toBeNull();
    expect(await listPdfAssets(kbPath, sourceId)).toBeNull();
  });
});

describe('pdf-asset-store 无文字层标记', () => {
  it('纯图像来源标记 textLayer=false（不假装有机械全文）', async () => {
    const { sourceId } = await importPdf('scan.pdf', buildPdf([{ images: [IMAGE_B] }]));
    const result = await extractAndStorePdfAssets(kbPath, sourceId, { render: 'none' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.manifest.textLayer).toBe(false);
    expect(result.manifest.stats.textPages).toBe(0);
    expect(result.manifest.assets.some((a) => a.method === 'object')).toBe(true);
  });

  it('有文字页的来源标记 textLayer=true', async () => {
    const { sourceId } = await importPdf('manual.pdf', mixedPdfFixture());
    const result = await extractAndStorePdfAssets(kbPath, sourceId, { render: 'none' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.textLayer).toBe(true);
    expect(result.manifest.stats.textPages).toBe(1);
  });
});

describe('导入管线自动提取（与转换解耦）', () => {
  it('导入文字 PDF：来源记录带 pdfAssets 状态，资产已落盘', async () => {
    const { sourceId, revision } = await importPdf('manual.pdf', mixedPdfFixture());

    const read = await readWikiManifest(kbPath);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const rec = read.manifest.sources?.[sourceId];
    expect(rec?.status).toBe('ready');
    expect(rec?.pdfAssets?.status).toBe('ready');
    expect(rec?.pdfAssets?.assetCount).toBeGreaterThan(0);

    const manifest = await readPdfAssetManifest(kbPath, sourceId, revision);
    expect(manifest?.textLayer).toBe(true);
    expect(manifest?.assets.some((a) => a.method === 'object')).toBe(true);
    // 矢量时序图页在导入时已整页渲染（auto 模式，无位图证据的页）
    expect(manifest?.assets.some((a) => a.method === 'page-render' && a.page === 2)).toBe(true);
  });

  it('扫描版 PDF（机械转换失败）仍提取图像，且明确区分「有图」与「有全文」', async () => {
    const { sourceId } = await importPdf('scan.pdf', buildPdf([{ images: [IMAGE_B] }]));

    const read = await readWikiManifest(kbPath);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const rec = read.manifest.sources?.[sourceId];

    // 全文转换失败（提示不含 OCR），旧全文不标成新版
    expect(rec?.status).toBe('failed');
    expect(rec?.parsedRevision).toBeNull();
    // 但原图证据可用 —— 两者状态互不掩盖
    expect(rec?.pdfAssets?.status).toBe('ready');
    expect(rec?.pdfAssets?.assetCount).toBeGreaterThan(0);

    const manifest = await readPdfAssetManifest(kbPath, sourceId);
    expect(manifest?.textLayer).toBe(false);
    expect(manifest?.stats.textPages).toBe(0);
  });
});

describe('pdf-asset-store 直接写入', () => {
  it('storePdfAssets 接受已完成的提取结果（供队列/重试复用）', async () => {
    const { sourceId, revision } = await importPdf('manual.pdf', mixedPdfFixture());
    const extracted = await extractPdfAssets(mixedPdfFixture(), { render: 'all' });
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;

    const result = await storePdfAssets(kbPath, {
      sourceId,
      revision,
      parsedHash: null,
      extraction: extracted.extraction,
      extractor: { version: 'test' },
      options: { render: 'all', scale: 2, maxEdge: 2048, batchSize: 50, bitmaps: true },
    });

    // 位图页（1/3）的整页渲染是本次新参数带来的新字节
    expect(result.written).toBeGreaterThan(0);
    const manifest = await readPdfAssetManifest(kbPath, sourceId, revision);
    expect(manifest?.extractor.version).toBe('test');
    expect(manifest?.assets).toHaveLength(extracted.extraction.records.length);
    // 落盘文件可被 stat（内容真实存在）
    const file = join(result.dir, manifest!.assets[0]!.file);
    expect(statSync(file).size).toBeGreaterThan(0);
  });
});
