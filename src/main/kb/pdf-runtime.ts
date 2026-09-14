/**
 * PDF Runtime — pdfjs 的执行进程、模块形态、worker 与本地资源安排。
 *
 * 本模块是 issue 11「首个检查点的实测方案」的落点：下面每条都是在本机
 * 实测（真实混合 PDF fixture）得出的，不是从参考实现推断的。
 *
 * 1. 执行进程：**Electron 主进程**（CJS 输出）。不额外 spawn 子进程。
 *    pdf.mjs 经「运行时计算的 specifier + 原生 dynamic import」加载，
 *    Rollup 无法静态解析该 specifier，因此既不会把 944KB 的 ESM 载荷内联进
 *    CJS bundle，也不会改写 pdfjs 内部的 `import.meta.url`——后者是
 *    `createRequire(import.meta.url)('@napi-rs/canvas')` 的唯一基址。
 *
 * 2. 模块形态：只能用 **legacy ESM build**（`legacy/build/pdf.mjs`）。
 *    非 legacy 的 `build/pdf.mjs` 在 Node 下加载即抛
 *    `ReferenceError: DOMMatrix is not defined`（实测）。
 *
 * 3. worker：Node 下 pdfjs 自身把 `#isWorkerDisabled` 置为 true，并就地
 *    `import("./pdf.worker.mjs")` 当 fake worker（主线程消息处理器）跑。
 *    因此：不需要 worker 线程、不需要设置 `GlobalWorkerOptions.workerSrc`；
 *    代价是 **pdf.mjs 与 pdf.worker.mjs 必须保持相邻**（不可被打包器拆散）。
 *
 * 4. 本地资源：standard fonts / cMaps / wasm 全部走本地目录（不联网、不读 CDN）。
 *    资源目录必须是「正斜杠 + 尾斜杠」形式——Windows 反斜杠路径会被 pdfjs
 *    判为 `Invalid factory url`（实测）。Node 侧用 fs 读取，正斜杠路径可用。
 *
 * 5. 打包：`resources/pdfjs/`（`scripts/prepare-pdfjs-runtime.mjs` 准备）
 *    经 electron-builder `extraResources` 原样复制到 `process.resourcesPath/pdfjs`。
 *    运行时优先读该目录（打包形态）；开发/测试回退到 `node_modules`。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §3、§11
 * @see .scratch/llm-wiki/issues/11-pdf-assets.md
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── pdfjs 最小结构契约 ──────────────────────────────────────────
// 动态 import 的结果无法静态类型化；这里只声明本模块真正消费的成员，
// 保持 strict 且不引入 any。

export type PdfImageObject = {
  width: number;
  height: number;
  /** pdfjs ImageKind：1=GRAYSCALE_1BPP 2=RGB_24BPP 3=RGBA_32BPP */
  kind: number;
  data?: Uint8Array | Uint8ClampedArray;
};

export type PdfViewport = {
  width: number;
  height: number;
  scale: number;
};

export type PdfTextItem = { str?: string };

export type PdfCanvasLike = {
  width: number;
  height: number;
  getContext(type: '2d'): PdfCanvasContextLike;
  encodeSync(format: 'png'): Uint8Array;
};

export type PdfCanvasContextLike = {
  save(): void;
  restore(): void;
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
  putImageData(data: object, x: number, y: number): void;
  fillRect?(x: number, y: number, w: number, h: number): void;
};

/** pdfjs PDFObjects（objs / commonObjs 共用形态）：get 带回调时在数据就绪后调用 */
export type PdfObjects = {
  /** 无回调：未解析时抛错；有回调：数据就绪后调用（此时返回 null） */
  get(objId: string, callback?: (data: PdfImageObject) => void): PdfImageObject | null;
  /** 对象数据是否已解析 */
  has(objId: string): boolean;
};

export type PdfPageProxy = {
  getViewport(params: { scale: number }): PdfViewport;
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
  render(params: {
    canvasContext: PdfCanvasContextLike;
    viewport: PdfViewport;
    canvas: PdfCanvasLike;
  }): { promise: Promise<void> };
  cleanup(): boolean | void;
  /** 页内对象（位图 XObject 的页内副本） */
  readonly objs: PdfObjects;
  /**
   * 跨页共享对象：同一图像 XObject 被多个页面引用时，pdfjs 将其提升为
   * 全局对象（objId 以 `g_` 开头），数据放在 commonObjs 而不是 objs。
   * （实测：混合 PDF 同图跨页复用，`objs.get` 对第 2 页起全部抛
   * "Requesting object that isn't resolved yet"。）
   */
  readonly commonObjs: PdfObjects;
};

export type PdfDocumentProxy = {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageProxy>;
  destroy(): Promise<void>;
};

export type PdfJsModule = {
  version: string;
  OPS: Record<string, number>;
  getDocument(src: Record<string, unknown>): { promise: Promise<PdfDocumentProxy> };
};

export type NodeCanvasModule = {
  createCanvas(width: number, height: number): PdfCanvasLike;
  DOMMatrix?: unknown;
  ImageData?: unknown;
  Path2D?: unknown;
};

// ── 运行时解析 ──────────────────────────────────────────────────

export type PdfRuntimeSource = 'resources' | 'node_modules';

export type PdfRuntimeInfo = {
  /** pdfjs 包根目录（含 legacy/build、standard_fonts、cmaps、wasm） */
  root: string;
  /** legacy ESM 入口（pdf.mjs）绝对路径 */
  entry: string;
  /** fake worker 模块绝对路径；必须与 entry 相邻 */
  worker: string;
  source: PdfRuntimeSource;
};

export type PdfRuntimePaths = {
  standardFontDataUrl: string;
  cMapUrl: string;
  wasmUrl: string;
};

export type PdfRuntime = {
  info: PdfRuntimeInfo;
  pdfjs: PdfJsModule;
  canvas: NodeCanvasModule;
  fontUrls: PdfRuntimePaths;
};

/** pdfjs 运行时不可用（未打包、缺 worker/字体资源、原生 canvas 缺失） */
export class PdfRuntimeUnavailableError extends Error {
  readonly code = 'runtimeUnavailable';

  constructor(message: string) {
    super(message);
    this.name = 'PdfRuntimeUnavailableError';
  }
}

/** pdfjs 资源目录 URL：pdfjs 要求正斜杠 + 尾斜杠 */
export function pdfResourceDirUrl(dir: string): string {
  return dir.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
}

const LEGACY_ENTRY_REL = join('legacy', 'build', 'pdf.mjs');
const WORKER_REL = join('legacy', 'build', 'pdf.worker.mjs');

/** 打包形态：extraResources 把 resources/pdfjs 复制到 <resources>/pdfjs */
function packagedRoots(): string[] {
  const roots: string[] = [];
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (typeof resourcesPath === 'string' && resourcesPath.length > 0) {
    roots.push(join(resourcesPath, 'pdfjs'));
  }
  return roots;
}

/** 开发/测试形态：cwd 下的 resources/pdfjs（已 prepare）或 node_modules */
function devRoots(): Array<{ root: string; source: PdfRuntimeSource }> {
  const cwd = process.cwd();
  const pdfjsRoot = join(cwd, 'resources', 'pdfjs');
  return [
    { root: pdfjsRoot, source: 'resources' },
    { root: join(pdfjsRoot, 'node_modules', 'pdfjs-dist'), source: 'resources' },
    { root: join(cwd, 'node_modules', 'pdfjs-dist'), source: 'node_modules' },
  ];
}

/**
 * 解析 pdfjs 运行时路径。
 *
 * 顺序：显式 root → 打包资源目录 → 开发目录（resources/pdfjs → node_modules）。
 * 返回 null 表示运行时不可用（调用方应给出可操作的降级提示，不得假装成功）。
 */
export function resolvePdfRuntimePaths(options: { root?: string } = {}): PdfRuntimeInfo | null {
  const candidates: Array<{ root: string; source: PdfRuntimeSource }> = [];
  if (options.root) candidates.push({ root: options.root, source: 'resources' });
  for (const root of packagedRoots()) candidates.push({ root, source: 'resources' });
  candidates.push(...devRoots());

  for (const candidate of candidates) {
    const entry = join(candidate.root, LEGACY_ENTRY_REL);
    const worker = join(candidate.root, WORKER_REL);
    if (existsSync(entry) && existsSync(worker)) {
      return { root: candidate.root, entry, worker, source: candidate.source };
    }
  }
  return null;
}

let cached: Promise<PdfRuntime> | null = null;

/**
 * 加载 pdfjs + 本地 canvas。
 *
 * 首次调用执行原生 dynamic import 并缓存（单进程一个 pdfjs 实例；
 * Node 下 pdfjs 用主线程 fake worker，多实例没有隔离收益，只有内存代价）。
 */
export async function loadPdfRuntime(options: { root?: string } = {}): Promise<PdfRuntime> {
  if (cached && !options.root) return cached;
  const load = async (): Promise<PdfRuntime> => {
    const info = resolvePdfRuntimePaths(options);
    if (!info) {
      throw new PdfRuntimeUnavailableError(
        '未找到本地 pdfjs 运行时（legacy/build/pdf.mjs + pdf.worker.mjs）。'
        + '开发环境请在仓库根执行 npm run prepare:pdfjs；打包环境请确认 extraResources 含 resources/pdfjs → pdfjs。',
      );
    }

    // 原生 dynamic import：specifier 为运行时变量，Rollup 保持原样不内联。
    const entryUrl = pathToFileURL(info.entry).href;
    const pdfjs = (await import(/* @vite-ignore */ entryUrl)) as unknown as PdfJsModule;
    if (typeof pdfjs?.getDocument !== 'function') {
      throw new PdfRuntimeUnavailableError(`pdfjs 模块形态异常（缺少 getDocument）: ${info.entry}`);
    }

    // pdfjs 在 Node 下自行 createRequire('@napi-rs/canvas') 做 DOMMatrix/ImageData
    // 垫片；我们同时显式加载一份，缺失时立刻给出可操作错误而不是渲染出空白图。
    let canvas: NodeCanvasModule;
    try {
      canvas = (await import(/* @vite-ignore */ pdfCanvasSpecifier(info))) as unknown as NodeCanvasModule;
    } catch (err) {
      throw new PdfRuntimeUnavailableError(`加载 @napi-rs/canvas 失败（PDF 页面渲染必需）: ${String(err)}`);
    }
    if (typeof canvas?.createCanvas !== 'function') {
      throw new PdfRuntimeUnavailableError('@napi-rs/canvas 形态异常（缺少 createCanvas）');
    }

    return {
      info,
      pdfjs,
      canvas,
      fontUrls: {
        standardFontDataUrl: pdfResourceDirUrl(join(info.root, 'standard_fonts')),
        cMapUrl: pdfResourceDirUrl(join(info.root, 'cmaps')),
        wasmUrl: pdfResourceDirUrl(join(info.root, 'wasm')),
      },
    };
  };

  if (options.root) return load();
  cached = load();
  try {
    return await cached;
  } catch (err) {
    cached = null;
    throw err;
  }
}

/**
 * @napi-rs/canvas 的加载 specifier。
 *
 * 打包形态下 pdfjs 随附一份 `resources/pdfjs/node_modules/@napi-rs/canvas`
 * （pdfjs 自己的 `createRequire(import.meta.url)` 从 pdf.mjs 位置解析，
 * 只有放在 pdfjs 根下才命中）；显式加载走同一份，避免出现
 * 「pdfjs 拿不到 canvas 而渲染出空白图」。开发形态回退到裸 specifier。
 */
function pdfCanvasSpecifier(info: PdfRuntimeInfo): string {
  const bundled = join(info.root, 'node_modules', '@napi-rs', 'canvas', 'index.js');
  return existsSync(bundled) ? pathToFileURL(bundled).href : '@napi-rs/canvas';
}

/** 测试用：清空运行时缓存 */
export function __resetPdfRuntimeCache(): void {
  cached = null;
}
