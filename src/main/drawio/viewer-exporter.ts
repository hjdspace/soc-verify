/**
 * viewer 内置导出器 —— 隐藏 BrowserWindow + viewer-static.min.js 离线渲染导出。
 *
 * 不依赖 draw.io Desktop CLI（预览与导出复用同一 mxGraph 渲染内核，包内自带）：
 *   - SVG  ：序列化渲染后的 DOM SVG 节点（标签以内嵌 foreignObject 保留，矢量）
 *   - PNG  ：webContents.capturePage(rect) → NativeImage.resize 到目标像素
 *   - JPG  ：同 PNG，NativeImage.toJPEG
 *   - PDF  ：webContents.printToPDF（自定义页宽高 = 图形 bounds，等效 --crop，矢量）
 *
 * 流程（两遍渲染）：
 *   1. 布局渲染（scale=1）→ 取 graph.getGraphBounds()
 *   2. svg/pdf 直接产出；png/jpg 若 scale≠1 则按 effectiveScale 二次渲染后
 *      capturePage（rect 裁剪 + resize 得到确定性像素尺寸，与显示器 DPI 无关）
 *
 * draw.io 渲染不可并发（同一渲染页状态），沿用串行队列保证同一时刻
 * 只有一条导出任务。
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow } from 'electron';
import {
  DrawioExportError,
  formatExtension,
  type DrawioExportFormat,
  type DrawioExportOptions,
  type DrawioExportResult,
} from './export-types';
import {
  JPEG_QUALITY,
  captureTargetSize,
  effectiveExportScale,
  pdfPageSizeInches,
  type DiagramBounds,
} from './export-utils';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 默认整体超时（含两遍渲染 + 捕获 + 写盘） */
const DEFAULT_TIMEOUT_MS = 60_000;
/** 捕获前等待重绘（隐藏窗口无 vsync 回调可等，用短延时兜底） */
const PAINT_WAIT_MS = 150;

type ExportPagePayload = {
  xml: string;
  format: DrawioExportFormat;
  scale?: number;
  transparent?: boolean;
};

type ExportPageSvgResult = { svg: string; bounds: DiagramBounds };
type ExportPageRectResult = DiagramBounds;
type ExportPageResult = ExportPageSvgResult | ExportPageRectResult;

function isSvgResult(r: ExportPageResult): r is ExportPageSvgResult {
  return typeof (r as Partial<ExportPageSvgResult>).svg === 'string';
}

/** 校验页面返回的捕获区域（防串改/异常数据） */
function asRect(r: ExportPageResult): DiagramBounds {
  const { x, y, width, height } = r as Record<string, unknown>;
  const ok =
    typeof x === 'number' && Number.isFinite(x) &&
    typeof y === 'number' && Number.isFinite(y) &&
    typeof width === 'number' && Number.isFinite(width) && width > 0 &&
    typeof height === 'number' && Number.isFinite(height) && height > 0;
  if (!ok) throw new DrawioExportError('invalid bounds returned from export page');
  return { x, y, width, height };
}

/**
 * 解析导出页路径（export.html 与 viewer-static.min.js 同目录）。
 * 候选：打包 asar 内 out/renderer → dev out/main 相对源码 → src 直跑（tests）。
 */
export function resolveExportPagePath(): string | null {
  const candidates = [
    join(__dirname, '../renderer/drawio/export.html'),
    resolve(__dirname, '../../src/renderer/public/drawio/export.html'),
    resolve(__dirname, '../../renderer/public/drawio/export.html'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** 在隐藏窗口中执行一次渲染调用 */
function callPage(win: BrowserWindow, payload: ExportPagePayload): Promise<ExportPageResult> {
  const script = `window.__drawioExport(${JSON.stringify(payload)})`;
  return win.webContents.executeJavaScript(script, false) as Promise<ExportPageResult>;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 单次导出执行（窗口生命周期管理 + 各格式产出） */
async function runExport(options: DrawioExportOptions): Promise<DrawioExportResult> {
  const pagePath = resolveExportPagePath();
  if (!pagePath) {
    throw new DrawioExportError('drawio export page not found (public/drawio/export.html)');
  }

  let xml: string;
  try {
    xml = await readFile(options.inputPath, 'utf-8');
  } catch (err) {
    throw new DrawioExportError(
      `read input failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  const win = new BrowserWindow({
    show: false,
    width: 1240,
    height: 800,
    useContentSize: true,
    webPreferences: {
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    win.destroy();
  }, timeoutMs);

  try {
    await win.loadFile(pagePath);
    const base: Omit<ExportPagePayload, 'scale'> = {
      xml,
      format: options.format,
      transparent: options.transparent === true,
    };

    // Pass 1：布局渲染（scale=1）
    const first = await callPage(win, { ...base, scale: 1 });

    let bytes: Buffer;
    if (isSvgResult(first)) {
      bytes = Buffer.from(first.svg, 'utf-8');
    } else {
      const rect = asRect(first);

      if (options.format === 'pdf') {
        // PDF：矢量打印，页尺寸 = 图形 bounds（等效 CLI --crop）
        const page = pdfPageSizeInches(rect, 0);
        const pdf = await win.webContents.printToPDF({
          pageSize: { width: page.width, height: page.height },
          printBackground: true,
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
          preferCSSPageSize: false,
        });
        bytes = Buffer.from(pdf);
      } else {
        // PNG / JPG：按需二次渲染（应用 scale），再裁剪捕获
        let captureRect = rect;
        const effective = effectiveExportScale(rect, options.scale ?? 1);
        if (effective !== 1) {
          const second = await callPage(win, { ...base, scale: effective });
          captureRect = asRect(second);
        }

        // 扩大窗口内容区，确保捕获区域完全落在视口内
        const needW = Math.ceil(captureRect.x + captureRect.width) + 4;
        const needH = Math.ceil(captureRect.y + captureRect.height) + 4;
        const [cw, ch] = win.getContentSize();
        if (needW > cw || needH > ch) {
          win.setContentSize(Math.max(cw, needW), Math.max(ch, needH));
        }
        await delay(PAINT_WAIT_MS);

        const img = await win.webContents.capturePage(
          { x: captureRect.x, y: captureRect.y, width: captureRect.width, height: captureRect.height },
          { stayHidden: true, stayAwake: true },
        );
        if (img.isEmpty()) {
          throw new DrawioExportError('capturePage returned empty image');
        }
        // 物理像素 = css × display scaleFactor；resize 到目标像素得到确定性尺寸
        const size = captureTargetSize(captureRect);
        const sized = img.resize({ width: size.width, height: size.height });
        bytes = options.format === 'jpg' ? sized.toJPEG(JPEG_QUALITY) : sized.toPNG();
      }
    }

    await writeFile(options.outputPath, bytes);
    return { success: true, outputPath: options.outputPath, sizeBytes: bytes.length };
  } catch (err) {
    if (timedOut) {
      throw new DrawioExportError(`export timeout after ${timeoutMs}ms`);
    }
    if (err instanceof DrawioExportError) throw err;
    throw new DrawioExportError(
      `${options.format} export failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  } finally {
    clearTimeout(timer);
    if (!win.isDestroyed()) win.destroy();
  }
}

// ── 串行队列：同一时刻只跑一条导出任务 ─────────────────────

let queueTail: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queueTail.then(task, task);
  // 队列尾部吞掉错误，避免影响后续任务
  queueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 导出 .drawio 文件（串行队列包装）。 */
export function exportDiagram(options: DrawioExportOptions): Promise<DrawioExportResult> {
  return enqueue(() => runExport(options));
}

/** 保留 re-export：router/调用方常用 */
export { formatExtension };
export type { DrawioExportFormat, DrawioExportOptions, DrawioExportResult };
