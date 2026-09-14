/**
 * PDF 资产提取 —— 嵌入位图对象 + 矢量页整页渲染（issue 11，spec §3）。
 *
 * 输出契约（资产记录）：
 *   - 内容寻址：`assetId = sha256(图像字节)`，文件名 `<assetId>.<ext>`；
 *     同字节只产出一份 blob，但**每次出现都保留独立位置记录**（page/rect）。
 *   - 位图对象：`method='object'`，记录 1-based 页码、像素尺寸、CTM 推导的
 *     页内可靠坐标（PDF 用户空间）。
 *   - 整页渲染：`method='page-render'`，记录渲染参数（scale/maxEdge/scaled），
 *     作为矢量图（时序图、框图）与「含图判定不可靠」页的读图证据。
 *
 * 逐页处理并 `page.cleanup()`，可取消（AbortSignal）；统计始终可见：
 * 总页 / 已处理 / 失败 / 跳过（含原因）/ 文本页 / 渲染候选与剩余批次。
 *
 * 判定策略（可解释，不假装确定）：
 *   - 页有位图对象 → kind='bitmap'
 *   - 无位图但有矢量路径算子 → kind='vector'
 *   - 无位图无矢量但有文本 → kind='text'
 *   - 皆无 → kind='empty'
 *   `uncertain = bitmapCount === 0`：该页「含图」判定只来自启发式，
 *   因此进入 renderCandidates，可分批整页渲染核对（用户可选页或继续下一批）。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §3、§11
 */

import { createHash } from 'node:crypto';
import {
  loadPdfRuntime,
  PdfRuntimeUnavailableError,
  type PdfCanvasContextLike,
  type PdfDocumentProxy,
  type PdfImageObject,
  type PdfJsModule,
  type PdfPageProxy,
  type PdfRuntimeInfo,
  type NodeCanvasModule,
} from './pdf-runtime';

// ── 常量 ────────────────────────────────────────────────────────

/** 每批最多渲染页数（spec §3） */
export const DEFAULT_RENDER_BATCH_SIZE = 50;
/** 单张发送/存储图像最长边初始上限（spec §3；以端点能力适配） */
export const DEFAULT_MAX_EDGE = 2048;
/** 整页渲染像素密度起点 */
export const DEFAULT_RENDER_SCALE = 2;

/** 矢量图判定门槛：低于此算子数的路径（表格线/页眉规则）不作为「矢量图页」信号 */
export const MIN_VECTOR_OPS = 4;

/** pdfjs ImageKind */
const KIND_GRAYSCALE_1BPP = 1;
const KIND_RGB_24BPP = 2;
const KIND_RGBA_32BPP = 3;

export const DEFAULT_RENDER_BATCH = DEFAULT_RENDER_BATCH_SIZE;

// ── 类型 ────────────────────────────────────────────────────────

export type PdfAssetRect = { x: number; y: number; width: number; height: number };

export type PdfAssetMethod = 'object' | 'page-render';

/** 资产记录（可持久化的元数据；字节在 blobs 中按 assetId 唯一） */
export type PdfAssetRecord = {
  /** 图像字节 sha256（hex）—— 即文件名主干 */
  assetId: string;
  /** `<assetId>.<ext>` */
  file: string;
  ext: string;
  method: PdfAssetMethod;
  /** 1-based 页码（PDF 约定；PPTX 用 slide、DOCX 不伪造页码） */
  page: number;
  /** 像素宽 */
  width: number;
  /** 像素高 */
  height: number;
  /** method='object'：位图在页面用户空间的位置（CTM 推导） */
  rect?: PdfAssetRect;
  /** method='page-render'：渲染参数 */
  render?: { scale: number; maxEdge: number; scaled: boolean };
};

/** 内容寻址字节（同 assetId 出现一次） */
export type PdfAssetBlob = { assetId: string; ext: string; data: Uint8Array };

export type PdfPageKind = 'bitmap' | 'vector' | 'text' | 'empty';

/** 逐页检查结果（解释「为什么这页有/没有资产」） */
export type PdfPageProbe = {
  page: number;
  kind: PdfPageKind;
  /** 位图对象放置次数 */
  bitmapCount: number;
  /** 矢量路径/绘制算子数 */
  vectorOps: number;
  /** 文本层字符数（0 = 无文字层） */
  textChars: number;
  /** 含图判定只来自启发式（无位图证据）→ 建议整页渲染核对 */
  uncertain: boolean;
};

export type PdfSkipReason = 'done' | 'renderNotSelected';

export type PdfExtractStats = {
  totalPages: number;
  /** 完整处理（检查 + 提图/渲染）完成的页数 */
  processedPages: number;
  failedPages: number;
  skippedPages: number;
  failures: Array<{ page: number; reason: string }>;
  skipped: Array<{ page: number; reason: PdfSkipReason }>;
  /** 有位图对象证据的页数 */
  bitmapAssets: number;
  renderAssets: number;
  /** 无位图证据的页（含图判定不可靠）→ 整页渲染候选 */
  renderCandidates: number[];
  renderRendered: number[];
  /** 因单批上限未渲染的页（继续下一批的输入） */
  renderRemaining: number[];
  /** 本次是否被单批上限截断 */
  batchLimitReached: boolean;
  /** 有文本层的页数（0 表示纯图像，不含 OCR 全文） */
  textPages: number;
  cancelled: boolean;
};

export type PdfAssetExtraction = {
  records: PdfAssetRecord[];
  blobs: PdfAssetBlob[];
  pages: PdfPageProbe[];
  stats: PdfExtractStats;
  cancelled: boolean;
  /** 本次使用的 pdfjs 运行时（只记来源形态与版本，不记本机绝对路径） */
  runtime: { source: 'resources' | 'node_modules'; version: string };
};

export type PdfAssetErrorCode = 'malformed' | 'password' | 'runtimeUnavailable' | 'io';

export type PdfExtractResult =
  | { ok: true; extraction: PdfAssetExtraction }
  | { ok: false; error: { code: PdfAssetErrorCode; message: string } };

export type PdfRenderSpec = 'none' | 'auto' | 'all' | readonly number[];

export type PdfAssetOptions = {
  /** 取消信号：逐页边界检查；已处理页的记录保留，未处理页不产出 */
  signal?: AbortSignal;
  /** 是否提取嵌入位图对象（默认 true） */
  bitmaps?: boolean;
  /** 整页渲染策略（默认 'auto'） */
  render?: PdfRenderSpec;
  /** 单批最多渲染页数（默认 50） */
  batchSize?: number;
  /** 渲染像素密度（默认 2） */
  scale?: number;
  /** 单张最长边上限（默认 2048，超出等比缩小并标 scaled） */
  maxEdge?: number;
  /** 已完成页（续跑跳过，记入 stats.skipped 原因 'done'） */
  donePages?: readonly number[];
  /** 逐页开始回调（进度上报 / 取消钩子） */
  onPageStart?: (page: number) => void;
  /** 显式 pdfjs 运行时根目录（测试/打包验证用） */
  runtimeRoot?: string;
};

// ── 小工具 ──────────────────────────────────────────────────────

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

/** 2×3 仿射矩阵 [a b c d e f]（PDF 约定） */
type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: readonly number[]): Matrix {
  const [a0, b0, c0, d0, e0, f0] = m;
  const [a1, b1, c1, d1, e1, f1] = n as [number, number, number, number, number, number];
  return [
    a0 * a1 + c0 * b1,
    b0 * a1 + d0 * b1,
    a0 * c1 + c0 * d1,
    b0 * c1 + d0 * d1,
    a0 * e1 + c0 * f1 + e0,
    b0 * e1 + d0 * f1 + f0,
  ];
}

function applyMatrix(m: Matrix, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** 矢量绘制算子（用于区分「矢量时序图页」与纯文字页） */
const VECTOR_OPS = [
  'constructPath',
  'rectangle',
  'stroke',
  'closeStroke',
  'fill',
  'eoFill',
  'fillStroke',
  'eoFillStroke',
  'closeFillStroke',
  'closeEOFillStroke',
];

/** 单批切分：batch 为本次渲染页，remaining 为下一批输入 */
export function planRenderBatch(
  pages: readonly number[],
  batchSize: number,
): { batch: number[]; remaining: number[] } {
  const limit = Math.max(1, Math.floor(batchSize));
  return { batch: pages.slice(0, limit), remaining: pages.slice(limit) };
}

// ── 图像字节编码 ────────────────────────────────────────────────

type ImageDataLike = { data: Uint8ClampedArray; width: number; height: number };

/** pdfjs 解码后的图像对象 → RGBA 像素 */
function toRgba(img: PdfImageObject): Uint8ClampedArray {
  const { width, height, kind } = img;
  const src = img.data;
  if (!src) throw new Error(`图像对象无解码数据（kind=${kind}）`);
  const rgba = new Uint8ClampedArray(width * height * 4);

  if (kind === KIND_RGBA_32BPP) {
    rgba.set(src.subarray(0, Math.min(src.length, rgba.length)));
    return rgba;
  }
  if (kind === KIND_RGB_24BPP) {
    for (let p = 0; p < width * height; p++) {
      rgba[p * 4] = src[p * 3] ?? 0;
      rgba[p * 4 + 1] = src[p * 3 + 1] ?? 0;
      rgba[p * 4 + 2] = src[p * 3 + 2] ?? 0;
      rgba[p * 4 + 3] = 255;
    }
    return rgba;
  }
  if (kind === KIND_GRAYSCALE_1BPP) {
    const stride = (width + 7) >> 3;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (src[y * stride + (x >> 3)]! >> (7 - (x & 7))) & 1;
        const v = bit ? 255 : 0;
        const o = (y * width + x) * 4;
        rgba[o] = v;
        rgba[o + 1] = v;
        rgba[o + 2] = v;
        rgba[o + 3] = 255;
      }
    }
    return rgba;
  }
  throw new Error(`不支持的图像类型 kind=${kind}`);
}

function makeImageData(
  canvasMod: NodeCanvasModule,
  ctx: PdfCanvasContextLike,
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): object {
  const ctor = canvasMod.ImageData as (new (data: Uint8ClampedArray, w: number, h: number) => object) | undefined;
  if (typeof ctor === 'function') return new ctor(rgba, width, height);
  const createImageData = (ctx as { createImageData?: (w: number, h: number) => ImageDataLike }).createImageData;
  if (typeof createImageData === 'function') {
    const img = createImageData.call(ctx, width, height);
    img.data.set(rgba);
    return img;
  }
  throw new Error('canvas 缺少 ImageData 构造能力');
}

/** RGBA 像素 → PNG 字节 */
function encodePng(
  canvasMod: NodeCanvasModule,
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array {
  const canvas = canvasMod.createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.putImageData(makeImageData(canvasMod, ctx, rgba, width, height), 0, 0);
  return new Uint8Array(canvas.encodeSync('png'));
}

// ── 单页检查 ────────────────────────────────────────────────────

type PageInspection = {
  probe: PdfPageProbe;
  /** 待解码的位图对象（含 CTM 推导的页内坐标） */
  images: Array<{ objId: string; rect?: PdfAssetRect; inline?: PdfImageObject }>;
};

async function inspectPage(
  pdfjs: PdfJsModule,
  page: PdfPageProxy,
  pageNumber: number,
): Promise<PageInspection> {
  const ops = await page.getOperatorList();
  const opsMap = pdfjs.OPS;
  const nameToOp = new Map<string, number>();
  for (const name of [...VECTOR_OPS, 'save', 'restore', 'transform']) {
    const op = opsMap[name];
    if (typeof op === 'number') nameToOp.set(name, op);
  }
  const paintImage = opsMap.paintImageXObject;
  const paintJpeg = opsMap.paintJpegXObject;
  const paintInline = opsMap.paintInlineImageXObject;

  const saveOp = nameToOp.get('save');
  const restoreOp = nameToOp.get('restore');
  const transformOp = nameToOp.get('transform');
  const vectorOpSet = new Set(VECTOR_OPS.map((n) => nameToOp.get(n)).filter((v): v is number => v !== undefined));

  let ctm: Matrix = [...IDENTITY] as Matrix;
  const stack: Matrix[] = [];
  const images: PageInspection['images'] = [];
  let vectorOps = 0;

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i]!;
    const args = ops.argsArray[i] ?? [];

    if (fn === saveOp) {
      stack.push([...ctm] as Matrix);
      continue;
    }
    if (fn === restoreOp) {
      ctm = stack.pop() ?? ([...IDENTITY] as Matrix);
      continue;
    }
    if (fn === transformOp) {
      // pdfjs 的 transform 算子参数是展开的 6 个数 [a b c d e f]；
      // 少数路径会包在数组里，两种形态都接受。
      const m = (typeof args[0] === 'number' ? args : args[0]) as number[] | undefined;
      if (Array.isArray(m) && m.length === 6) ctm = multiply(ctm, m);
      continue;
    }
    if (vectorOpSet.has(fn)) {
      vectorOps++;
      continue;
    }
    if (fn === paintImage || fn === paintJpeg) {
      const objId = typeof args[0] === 'string' ? args[0] : undefined;
      if (objId) images.push({ objId, rect: imageRect(ctm) });
      continue;
    }
    if (fn === paintInline) {
      // 内联图像：算子参数即已解码的图像对象（无独立 objId）
      const inline = args[0] as PdfImageObject | undefined;
      if (inline && typeof inline.width === 'number') {
        images.push({ objId: `inline@p${pageNumber}#${images.length}`, rect: imageRect(ctm), inline });
      }
    }
  }

  let textChars = 0;
  try {
    const text = await page.getTextContent();
    for (const item of text.items) textChars += (item.str ?? '').length;
  } catch {
    // 无文字层（扫描版）或字体缺失：文本计数保持 0，不阻断提图
  }

  const bitmapCount = images.length;
  const kind: PdfPageKind = bitmapCount > 0 ? 'bitmap' : vectorOps > 0 ? 'vector' : textChars > 0 ? 'text' : 'empty';
  // 「含图」判定只来自启发式：没有位图对象证据，且（有矢量绘图 或 完全无文字）
  // → 该页可能含图但无法自动确认，自动模式会整页渲染核对。
  // 纯文字页（无位图、矢量算子低于门槛）不算不可靠，但仍在 renderCandidates 里，
  // 用户可显式分批渲染。
  const uncertain = bitmapCount === 0 && (vectorOps >= MIN_VECTOR_OPS || textChars === 0);
  return { images, probe: { page: pageNumber, kind, bitmapCount, vectorOps, textChars, uncertain } };
}

/** CTM 下单位方块的设备空间矩形（PDF 用户空间，y 向上） */
function imageRect(m: Matrix): PdfAssetRect {
  const p0 = applyMatrix(m, 0, 0);
  const p1 = applyMatrix(m, 1, 1);
  return {
    x: Math.min(p0.x, p1.x),
    y: Math.min(p0.y, p1.y),
    width: Math.abs(p1.x - p0.x),
    height: Math.abs(p1.y - p0.y),
  };
}

/**
 * 解析位图对象的解码数据。
 *
 * 页内对象在 `page.objs`，跨页复用的图像被 pdfjs 提升为全局对象放在
 * `page.commonObjs`（objId 以 `g_` 开头）；数据可能晚于 operator list 到达，
 * 已解析的先查，未解析的用 callback 等待（两个 store 同时挂，先到先得），
 * 超时判为不可解析。
 */
async function resolveImageObject(
  page: PdfPageProxy,
  objId: string,
  timeoutMs = 10_000,
): Promise<PdfImageObject | undefined> {
  for (const store of [page.objs, page.commonObjs]) {
    if (store.has(objId)) return store.get(objId) ?? undefined;
  }
  return new Promise((resolve) => {
    let settled = false;
    const once = (data: PdfImageObject | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(() => once(undefined), timeoutMs);
    try {
      page.objs.get(objId, (data) => once(data ?? undefined));
      page.commonObjs.get(objId, (data) => once(data ?? undefined));
    } catch {
      // callback 形态不抛错；保守兜底（store 形态异常时按超时路径结束）
    }
  });
}

// ── 主入口 ──────────────────────────────────────────────────────

function normalizeError(err: unknown): { code: PdfAssetErrorCode; message: string } {
  if (err instanceof PdfRuntimeUnavailableError) {
    return { code: 'runtimeUnavailable', message: err.message };
  }
  const name = (err as { name?: string })?.name ?? '';
  const message = (err as { message?: string })?.message ?? String(err);
  if (name === 'PasswordException') return { code: 'password', message: `PDF 已加密: ${message}` };
  if (name === 'InvalidPDFException' || name === 'MissingPDFException') {
    return { code: 'malformed', message: `PDF 结构损坏或不是 PDF: ${message}` };
  }
  if (name === 'PdfRuntimeUnavailableError') return { code: 'runtimeUnavailable', message };
  if (name === 'UnexpectedResponseException' || name === 'ResponseException') {
    return { code: 'io', message: `PDF 数据读取失败: ${message}` };
  }
  return { code: 'malformed', message };
}

/**
 * 从 PDF 字节提取图像资产（位图对象 + 可选整页渲染）。
 *
 * 不抛异常：运行时缺失/损坏/加密输入都返回结构化错误（UI 必须显示真实原因，
 * 不能把「无法提图」显示成成功）。
 */
export async function extractPdfAssets(
  bytes: Uint8Array,
  options: PdfAssetOptions = {},
): Promise<PdfExtractResult> {
  const runtime = await loadPdfRuntime({ ...(options.runtimeRoot ? { root: options.runtimeRoot } : {}) }).catch(
    (err: unknown) => normalizeError(err),
  );
  if ('code' in (runtime as object)) {
    return { ok: false, error: runtime as { code: PdfAssetErrorCode; message: string } };
  }
  const rt = runtime as Awaited<ReturnType<typeof loadPdfRuntime>>;

  const bitmaps = options.bitmaps !== false;
  const scale = options.scale ?? DEFAULT_RENDER_SCALE;
  const maxEdge = options.maxEdge ?? DEFAULT_MAX_EDGE;
  const batchSize = options.batchSize ?? DEFAULT_RENDER_BATCH_SIZE;
  const renderSpec = options.render ?? 'auto';
  const donePages = new Set(options.donePages ?? []);

  let doc: PdfDocumentProxy;
  try {
    doc = await rt.pdfjs.getDocument({
      data: new Uint8Array(bytes),
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: false,
      verbosity: 0,
      standardFontDataUrl: rt.fontUrls.standardFontDataUrl,
      cMapUrl: rt.fontUrls.cMapUrl,
      cMapPacked: true,
      wasmUrl: rt.fontUrls.wasmUrl,
    }).promise;
  } catch (err) {
    return { ok: false, error: normalizeError(err) };
  }

  const records: PdfAssetRecord[] = [];
  const blobs = new Map<string, PdfAssetBlob>();
  const pages: PdfPageProbe[] = [];
  const failures: Array<{ page: number; reason: string }> = [];
  const skipped: Array<{ page: number; reason: PdfSkipReason }> = [];
  const renderCandidates: number[] = [];
  const renderRequested: number[] = [];
  const renderRendered: number[] = [];
  let processedPages = 0;
  let bitmapAssets = 0;
  let renderAssets = 0;
  let cancelled = false;
  let renderedInBatch = 0;
  let batchLimitReached = false;

  const addBlob = (data: Uint8Array, ext: string): string => {
    const assetId = sha256Hex(data);
    if (!blobs.has(assetId)) blobs.set(assetId, { assetId, ext, data });
    return assetId;
  };

  const wantsRender = (page: number, probe: PdfPageProbe): boolean => {
    if (renderSpec === 'none') return false;
    if (renderSpec === 'all') return true;
    if (Array.isArray(renderSpec)) return (renderSpec as readonly number[]).includes(page);
    // auto：只渲染「无位图证据」的页（矢量图/含图判定不可靠）
    return probe.uncertain;
  };

  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      if (options.signal?.aborted) {
        cancelled = true;
        break;
      }
      if (donePages.has(pageNumber)) {
        skipped.push({ page: pageNumber, reason: 'done' });
        continue;
      }
      options.onPageStart?.(pageNumber);
      // 回调可能触发取消（进度面板/队列暂停）：取消必须在开始处理该页之前生效，
      // 否则会产出「用户已经取消的页」的记录。
      if (options.signal?.aborted) {
        cancelled = true;
        break;
      }

      let page: PdfPageProxy | null = null;
      try {
        page = await doc.getPage(pageNumber);
        const { probe, images } = await inspectPage(rt.pdfjs, page, pageNumber);
        pages.push(probe);
        if (probe.uncertain) renderCandidates.push(pageNumber);

        if (bitmaps) {
          for (const entry of images) {
            const img = entry.inline ?? (await resolveImageObject(page, entry.objId));
            if (!img) {
              failures.push({ page: pageNumber, reason: `位图对象不可解析: ${entry.objId}` });
              continue;
            }
            const png = encodePng(rt.canvas, toRgba(img), img.width, img.height);
            const assetId = addBlob(png, 'png');
            records.push({
              assetId,
              file: `${assetId}.png`,
              ext: 'png',
              method: 'object',
              page: pageNumber,
              width: img.width,
              height: img.height,
              ...(entry.rect ? { rect: entry.rect } : {}),
            });
            bitmapAssets++;
          }
        }

        if (wantsRender(pageNumber, probe)) {
          renderRequested.push(pageNumber);
          if (renderedInBatch >= batchSize) {
            batchLimitReached = true;
          } else {
            const rendered = await renderPage(rt.canvas, page, scale, maxEdge);
            const assetId = addBlob(rendered.png, 'png');
            records.push({
              assetId,
              file: `${assetId}.png`,
              ext: 'png',
              method: 'page-render',
              page: pageNumber,
              width: rendered.width,
              height: rendered.height,
              render: { scale, maxEdge, scaled: rendered.scaled },
            });
            renderRendered.push(pageNumber);
            renderAssets++;
            renderedInBatch++;
          }
        }
        processedPages++;
      } catch (err) {
        failures.push({ page: pageNumber, reason: (err as Error)?.message ?? String(err) });
      } finally {
        // 逐页释放：pdfjs 页面资源随 cleanup 回收（内存峰值随页数不累积）
        try {
          page?.cleanup();
        } catch {
          // 释放失败不改变已完成的处理结果
        }
      }
    }
  } finally {
    try {
      await doc.destroy();
    } catch {
      // 销毁失败不影响已产出的结果
    }
  }

  const renderRemaining = renderRequested.filter((p) => !renderRendered.includes(p));
  const failedPages = new Set(failures.map((f) => f.page)).size;

  return {
    ok: true,
    extraction: {
      records,
      blobs: [...blobs.values()],
      pages,
      cancelled,
      runtime: { source: rt.info.source, version: rt.pdfjs.version },
      stats: {
        totalPages: doc.numPages,
        processedPages,
        failedPages,
        skippedPages: skipped.length,
        failures,
        skipped,
        bitmapAssets,
        renderAssets,
        renderCandidates,
        renderRendered,
        renderRemaining,
        batchLimitReached,
        textPages: pages.filter((p) => p.textChars > 0).length,
        cancelled,
      },
    },
  };
}

/** 整页渲染：按最长边上限等比缩放并编码 PNG */
async function renderPage(
  canvasMod: NodeCanvasModule,
  page: PdfPageProxy,
  scale: number,
  maxEdge: number,
): Promise<{ png: Uint8Array; width: number; height: number; scaled: boolean }> {
  const base = page.getViewport({ scale });
  const longest = Math.max(base.width, base.height);
  const scaled = longest > maxEdge;
  const effective = scaled ? (maxEdge / longest) * scale : scale;
  const viewport = page.getViewport({ scale: effective });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));

  const canvas = canvasMod.createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  // 白底：PDF 默认背景为白，透明底会在阅读器里显示成黑/灰
  if (ctx.fillRect) {
    ctx.save();
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  return { png: new Uint8Array(canvas.encodeSync('png')), width, height, scaled };
}

export type { PdfRuntimeInfo };
