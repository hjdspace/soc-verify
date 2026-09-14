/**
 * PDF 资产仓库 —— 资产记录与字节的库内持久化（issue 11，spec §1/§3）。
 *
 * 落盘布局（沿用 spec §1 的 `raw/assets/<sourceId>/<sourceRevision>/`）：
 *   raw/assets/<sourceId>/<revision>/<sha256>.<ext>   内容寻址图像字节（参数变化产新 hash，不覆写）
 *   raw/assets/<sourceId>/<revision>/pdf-assets.json  资产记录 + 逐页检查 + 统计 + 提取参数历史
 *
 * 关键规则：
 *  - 文件名 = 内容 hash → 同字节只写一份；「参数变化不能覆写已有引用」天然成立。
 *  - 记录合并去重（键含收 page/method/rect/render），但 `extractions` 追加保留每次
 *    参数与统计，便于核对「这批图是哪次用什么参数提的」。
 *  - 读取只从身份出发：assetId 必须是 64 位 hex，revision 必须是 64 位 hex，
 *    拼接后仍须存在，绝不接受调用方任意路径。
 *  - 资产目录按 revision 分目录，历史修订的资产不被新修订覆写。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §1、§3
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { writeFileAtomic } from './atomic-commit';
import { sha256Hex } from './hash';
import {
  readWikiManifest,
  resolveWikiOriginalPath,
  wikiLayout,
  type WikiLayoutPaths,
} from './wiki-layout';
import { extractPdfAssets, type PdfAssetExtraction, type PdfAssetOptions, type PdfAssetRecord } from './pdf-assets';
import type { WikiPdfAssetErrorCode } from '@shared/kb-types';

// ── 类型 ────────────────────────────────────────────────────────

export const PDF_ASSET_EXTENSIONS = ['png'] as const;

/** 一次提取的参数快照（供核对与复现） */
export type PdfAssetExtractOptionsRecord = {
  render: string;
  scale: number;
  maxEdge: number;
  batchSize: number;
  bitmaps: boolean;
};

export type PdfAssetExtractionRecord = {
  options: PdfAssetExtractOptionsRecord;
  at: string;
  stats: PdfAssetExtraction['stats'];
};

export type PdfAssetManifest = {
  manifestVersion: 1;
  sourceId: string;
  revision: string;
  parsedHash: string | null;
  /** 提取器（不含任何本机绝对路径，库可搬移） */
  extractor: { runtime: string; version: string };
  assets: PdfAssetRecord[];
  pages: PdfAssetExtraction['pages'];
  stats: PdfAssetExtraction['stats'];
  /** 每次提取的参数与统计（追加，不覆写） */
  extractions: PdfAssetExtractionRecord[];
  /** 是否存在文本层（false = 纯图像来源，不承诺 OCR 全文） */
  textLayer: boolean;
  createdAt: string;
  updatedAt: string;
};

export type PdfAssetStoreInput = {
  sourceId: string;
  revision: string;
  parsedHash?: string | null;
  extraction: PdfAssetExtraction;
  extractor: { runtime?: string; version: string };
  options: PdfAssetExtractOptionsRecord;
};

export type PdfAssetStoreResult = {
  dir: string;
  /** 本次新写入的字节文件数 */
  written: number;
  /** 本次合并新增的记录数 */
  addedRecords: number;
  manifest: PdfAssetManifest;
};

export type PdfAssetStoreErrorCode = WikiPdfAssetErrorCode;

export type PdfAssetStoreExtractResult =
  | ({ ok: true } & PdfAssetStoreResult)
  | { ok: false; error: { code: PdfAssetStoreErrorCode; message: string } };

const HASH_RE = /^[0-9a-f]{64}$/;

// ── 路径 ────────────────────────────────────────────────────────

/** 资产目录：raw/assets/<sourceId>/<revision>/ */
export function pdfAssetDir(layout: WikiLayoutPaths, sourceId: string, revision: string): string {
  return join(layout.rawAssetsDir, sourceId, revision);
}

async function readManifestFile(dir: string): Promise<PdfAssetManifest | null> {
  try {
    const raw = await readFile(join(dir, 'pdf-assets.json'), 'utf-8');
    const parsed = JSON.parse(raw) as PdfAssetManifest;
    if (parsed?.manifestVersion !== 1 || !Array.isArray(parsed.assets)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 记录去重键：同图多次出现（不同 page/rect）必须各自保留 */
function recordKey(r: PdfAssetRecord): string {
  return [r.assetId, r.page, r.method, JSON.stringify(r.rect ?? null), JSON.stringify(r.render ?? null)].join('|');
}

/**
 * 合并逐页探针与统计（续跑不丢证据，spec §3「用户可选页或继续下一批」）。
 *
 * `extractPdfAssets` 的每次运行只产出本次处理页的 pages/stats；若直接整体
 * 覆盖，「继续渲染剩余页」后 manifest.pages 会丢失已完成页的 kind/坐标/
 * uncertain 证据。合并规则：
 *  - pages：按页号并集（同页以最新一次为准——重跑覆盖旧探针）；
 *  - failures：新失败 + 旧失败中「本次既未成功处理也未再失败」的页；
 *  - renderCandidates/renderRendered：并集（累计覆盖）；
 *  - bitmapAssets/renderAssets/textPages：按合并后的 records/pages 重算；
 *  - renderRemaining/batchLimitReached/skipped/cancelled：取本次（可操作的
 *    「继续下一批」输入与单次运行信息）；totalPages 取最大。
 */
function mergeExtractionState(
  existing: PdfAssetManifest,
  extraction: PdfAssetExtraction,
  mergedRecords: PdfAssetRecord[],
): { pages: PdfAssetExtraction['pages']; stats: PdfAssetExtraction['stats'] } {
  const pages = new Map<number, PdfAssetExtraction['pages'][number]>();
  for (const probe of existing.pages) pages.set(probe.page, probe);
  for (const probe of extraction.pages) pages.set(probe.page, probe);
  const mergedPages = [...pages.values()].sort((a, b) => a.page - b.page);

  const processedThisRun = new Set(extraction.pages.map((p) => p.page));
  const failedThisRun = new Set(extraction.stats.failures.map((f) => f.page));
  const failures = [...extraction.stats.failures];
  for (const prev of existing.stats.failures) {
    if (!processedThisRun.has(prev.page) && !failedThisRun.has(prev.page)) failures.push(prev);
  }

  const bitmapAssets = mergedRecords.filter((r) => r.method === 'object').length;
  const renderAssets = mergedRecords.filter((r) => r.method === 'page-render').length;

  const merged: PdfAssetExtraction['stats'] = {
    totalPages: Math.max(existing.stats.totalPages, extraction.stats.totalPages),
    // 完整处理过的页 = 有探针的页（donePages 跳过页保留前次探针）
    processedPages: mergedPages.length,
    failedPages: new Set(failures.map((f) => f.page)).size,
    skippedPages: extraction.stats.skippedPages,
    failures,
    skipped: extraction.stats.skipped,
    bitmapAssets,
    renderAssets,
    renderCandidates: [...new Set([...existing.stats.renderCandidates, ...extraction.stats.renderCandidates])].sort(
      (a, b) => a - b,
    ),
    renderRendered: [...new Set([...existing.stats.renderRendered, ...extraction.stats.renderRendered])].sort(
      (a, b) => a - b,
    ),
    renderRemaining: extraction.stats.renderRemaining,
    batchLimitReached: extraction.stats.batchLimitReached,
    textPages: mergedPages.filter((p) => p.textChars > 0).length,
    cancelled: extraction.stats.cancelled,
  };
  return { pages: mergedPages, stats: merged };
}

// ── 写入 ────────────────────────────────────────────────────────

/** 内容寻址写字节：已存在则跳过（同字节只写一份） */
async function writeBlobs(dir: string, extraction: PdfAssetExtraction): Promise<number> {
  await mkdir(dir, { recursive: true });
  let written = 0;
  for (const blob of extraction.blobs) {
    const file = join(dir, `${blob.assetId}.${blob.ext}`);
    if (existsSync(file)) continue;
    await writeFileAtomic(file, Buffer.from(blob.data));
    written++;
  }
  return written;
}

/**
 * 持久化一次提取结果（合并进既有清单）。
 *
 * 合并语义：记录与字节是**并集**——旧参数产出的资产引用不会被新参数覆写；
 * `pages` 按页号并集、`stats` 按合并状态重算（续跑不丢已完成页的探针证据，
 * 详见 mergeExtractionState）；`extractions` 逐次追加，保留每次参数与统计。
 */
export async function storePdfAssets(
  kbPath: string,
  input: PdfAssetStoreInput,
): Promise<PdfAssetStoreResult> {
  const layout = wikiLayout(kbPath);
  const dir = pdfAssetDir(layout, input.sourceId, input.revision);
  const existing = await readManifestFile(dir);
  const now = new Date().toISOString();

  const written = await writeBlobs(dir, input.extraction);

  const merged = new Map<string, PdfAssetRecord>();
  for (const record of existing?.assets ?? []) merged.set(recordKey(record), record);
  const before = merged.size;
  for (const record of input.extraction.records) merged.set(recordKey(record), record);
  const mergedRecords = [...merged.values()].sort(
    (a, b) => a.page - b.page || a.method.localeCompare(b.method) || a.file.localeCompare(b.file),
  );

  // 续跑不丢证据：pages 按页号并集、统计按合并状态重算（extractions 保留单次历史）
  const { pages, stats } = existing
    ? mergeExtractionState(existing, input.extraction, mergedRecords)
    : { pages: input.extraction.pages, stats: input.extraction.stats };

  const manifest: PdfAssetManifest = {
    manifestVersion: 1,
    sourceId: input.sourceId,
    revision: input.revision,
    parsedHash: input.parsedHash ?? existing?.parsedHash ?? null,
    extractor: { runtime: input.extractor.runtime ?? 'unknown', version: input.extractor.version },
    assets: mergedRecords,
    pages,
    stats,
    extractions: [
      ...(existing?.extractions ?? []),
      { options: input.options, at: now, stats: input.extraction.stats },
    ],
    textLayer: stats.textPages > 0,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await writeFileAtomic(join(dir, 'pdf-assets.json'), JSON.stringify(manifest, null, 2));
  return { dir, written, addedRecords: merged.size - before, manifest };
}

// ── 读取 ────────────────────────────────────────────────────────

/** 来源记录的当前修订（缺 sourceId 列表时返回 null） */
async function currentRevision(kbPath: string, sourceId: string): Promise<string | null> {
  const read = await readWikiManifest(kbPath);
  if (!read.ok) return null;
  return read.manifest.sources?.[sourceId]?.currentRevision ?? null;
}

/** 读取资产清单（revision 缺省 = 当前修订）；未提取过返回 null */
export async function readPdfAssetManifest(
  kbPath: string,
  sourceId: string,
  revision?: string,
): Promise<PdfAssetManifest | null> {
  if (!HASH_RE.test(sourceId)) return null;
  const rev = revision ?? (await currentRevision(kbPath, sourceId));
  if (!rev || !HASH_RE.test(rev)) return null;
  return readManifestFile(pdfAssetDir(wikiLayout(kbPath), sourceId, rev));
}

/** 资产记录列表（revision 缺省 = 当前修订） */
export async function listPdfAssets(
  kbPath: string,
  sourceId: string,
  revision?: string,
): Promise<PdfAssetRecord[] | null> {
  const manifest = await readPdfAssetManifest(kbPath, sourceId, revision);
  return manifest ? manifest.assets : null;
}

/**
 * 解析资产字节文件绝对路径（预览用）。
 * assetId/revision 必须是内容 hash；拼接后的文件必须真实存在。
 */
export async function resolvePdfAssetFile(
  kbPath: string,
  sourceId: string,
  revision: string,
  assetId: string,
): Promise<string | null> {
  if (!HASH_RE.test(sourceId) || !HASH_RE.test(revision) || !HASH_RE.test(assetId)) return null;
  const manifest = await readManifestFile(pdfAssetDir(wikiLayout(kbPath), sourceId, revision));
  const record = manifest?.assets.find((a) => a.assetId === assetId);
  const ext = record?.ext ?? PDF_ASSET_EXTENSIONS[0];
  if (!(PDF_ASSET_EXTENSIONS as readonly string[]).includes(ext)) return null;
  const file = join(pdfAssetDir(wikiLayout(kbPath), sourceId, revision), `${assetId}.${ext}`);
  try {
    const s = await stat(file);
    return s.isFile() ? file : null;
  } catch {
    return null;
  }
}

// ── 提取 + 持久化（导入/队列入口） ──────────────────────────────

/**
 * 提取 PDF 资产的完整入口：读原件 → 提图/渲染 → 内容寻址落盘。
 *
 * 失败（非 PDF、原件缺失/被外部改动、运行时不可用、加密/损坏）一律返回
 * 结构化错误，不抛异常：调用方（导入管线/队列/UI）必须能显示真实原因。
 */
export async function extractAndStorePdfAssets(
  kbPath: string,
  sourceId: string,
  options: PdfAssetOptions & { revision?: string; parsedHash?: string | null } = {},
): Promise<PdfAssetStoreExtractResult> {
  const read = await readWikiManifest(kbPath);
  if (!read.ok) {
    return { ok: false, error: { code: 'io', message: `库 manifest 不可读（${read.reason}）` } };
  }
  const rec = read.manifest.sources?.[sourceId];
  if (!rec) {
    return { ok: false, error: { code: 'sourceNotFound', message: `来源不存在: ${sourceId}` } };
  }
  if (rec.ext.toLowerCase() !== '.pdf') {
    return {
      ok: false,
      error: { code: 'notPdf', message: `仅 PDF 支持提图/页面渲染，当前来源为 ${rec.ext || '（无扩展名）'}` },
    };
  }

  const revision = options.revision ?? rec.currentRevision;
  // 原件解析复用 wiki-layout 的单一实现（当前修订 → raw/sources，历史 → revisions 区）
  const original = await resolveWikiOriginalPath(kbPath, { sourceId, revision });
  if (!original) {
    return {
      ok: false,
      error: { code: 'sourceNotFound', message: `原件不可读（${rec.sourcePath} @ ${revision.slice(0, 8)}）` },
    };
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(original);
  } catch (err) {
    return { ok: false, error: { code: 'io', message: `读取原件失败: ${String(err)}` } };
  }
  if (sha256Hex(bytes) !== revision) {
    return {
      ok: false,
      error: {
        code: 'originalHashMismatch',
        message: `原件字节与修订不符（盘上文件被外部改动）: ${basename(rec.sourcePath)}`,
      },
    };
  }

  const extracted = await extractPdfAssets(bytes, options);
  if (!extracted.ok) {
    return { ok: false, error: extracted.error };
  }
  // 被取消的提取不落任何资产（半批渲染不得成为「已完成」的证据）
  if (extracted.extraction.cancelled) {
    return { ok: false, error: { code: 'aborted', message: 'PDF 资产提取已取消' } };
  }

  const stored = await storePdfAssets(kbPath, {
    sourceId,
    revision,
    parsedHash: options.parsedHash ?? rec.parsedHash ?? null,
    extraction: extracted.extraction,
    extractor: { runtime: extracted.extraction.runtime.source, version: extracted.extraction.runtime.version },
    options: {
      render: renderLabel(options.render ?? 'auto'),
      scale: options.scale ?? 2,
      maxEdge: options.maxEdge ?? 2048,
      batchSize: options.batchSize ?? 50,
      bitmaps: options.bitmaps !== false,
    },
  });
  return { ok: true, ...stored };
}

function renderLabel(spec: PdfAssetOptions['render']): string {
  if (typeof spec === 'string') return spec;
  if (Array.isArray(spec)) return `pages:${(spec as readonly number[]).join(',')}`;
  return 'none';
}
