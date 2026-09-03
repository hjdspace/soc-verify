/**
 * 自定义协议 `local-resource://` —— 让渲染进程加载本地文件（图片、SVG、字体等）。
 *
 * 渲染进程中 `<img src="local-resource://<encoded-path>">` 会触发此 handler，
 * 主进程读取对应本地文件并返回 Response。路径用 encodeURIComponent 编码，
 * 避免反斜杠/空格/中文等字符破坏 URL 解析。
 *
 * 允许加载任意本地文件（与 VSCode 行为一致），用户可打开项目目录外的文件。
 */

import { protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

/** 协议 scheme，需与 CSP img-src 中的条目一致 */
export const LOCAL_RESOURCE_SCHEME = 'local-resource';

/** CSP 中 img-src 需要包含的来源字符串 */
export const LOCAL_RESOURCE_CSP_SOURCE = 'local-resource:';

/** 图片扩展名 → MIME 映射 */
const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  // 字体（Issue #1：Nerd Font 通过本协议加载）
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

/**
 * 从请求 URL 解析出本地文件路径。
 *
 * URL 由 toLocalResourceUrl() 生成，格式为：
 *   local-resource://app/<encodeURIComponent-encoded-path>
 *
 * 例如 Windows 路径 D:\docs\test.png 编码为
 *   local-resource://app/D%3A%5Cdocs%5Ctest.png
 *
 * 使用固定 host 'app' 是因为标准 scheme 要求 URL 有合法的 host 部分，
 * 将编码后的文件路径放在 pathname 中可避免 Chromium URL 规范化导致的问题。
 * 同时兼容旧格式 local-resource://<encoded>（无 host，路径被当作 host）。
 */
function parseFilePathFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);

    // 主要格式：local-resource://app/<encoded-path>
    // host 为 'app'，pathname 以 '/' 开头后跟编码路径
    if (parsed.pathname && parsed.pathname !== '/') {
      let pathPart = parsed.pathname;
      // 去掉前导 '/'
      if (pathPart.startsWith('/')) {
        pathPart = pathPart.slice(1);
      }
      const decoded = decodeURIComponent(pathPart);
      if (decoded) return decoded;
    }

    // 兼容旧格式：local-resource://<encoded>（无 host，路径被当作 hostname）
    if (parsed.hostname && parsed.hostname !== 'app') {
      const decoded = decodeURIComponent(parsed.hostname);
      if (decoded) return decoded;
    }

    return null;
  } catch {
    // URL 解析失败时，尝试手动从 scheme 后面提取
    try {
      const prefix = `${LOCAL_RESOURCE_SCHEME}://`;
      let afterScheme = url.startsWith(prefix) ? url.slice(prefix.length) : url;
      // 去掉 query 和 hash
      const hashIdx = afterScheme.indexOf('#');
      const queryIdx = afterScheme.indexOf('?');
      if (hashIdx >= 0) afterScheme = afterScheme.slice(0, hashIdx);
      if (queryIdx >= 0) afterScheme = afterScheme.slice(0, queryIdx);
      // 去掉可能的 host 前缀（'app/' 或 'localhost/'）
      if (afterScheme.startsWith('app/')) {
        afterScheme = afterScheme.slice('app/'.length);
      } else if (afterScheme.startsWith('localhost/')) {
        afterScheme = afterScheme.slice('localhost/'.length);
      }
      // 去掉前导 '/' (可能有一个或多个，来自 local-resource:/// 形式)
      afterScheme = afterScheme.replace(/^\/+/, '');
      const decoded = decodeURIComponent(afterScheme);
      return decoded || null;
    } catch {
      return null;
    }
  }
}

/**
 * 根据文件扩展名推断 MIME 类型。
 */
function getMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return MIME_MAP[ext] ?? 'application/octet-stream';
}

/**
 * 注册自定义协议 `local-resource://` 的 handler。
 * 必须在 `app.whenReady()` 之后调用。
 */
export function registerLocalResourceProtocol(): void {
  protocol.handle(LOCAL_RESOURCE_SCHEME, async (request) => {
    const filePath = parseFilePathFromUrl(request.url);
    if (!filePath) {
      console.error('[local-resource] Bad request: invalid path from URL:', request.url);
      return new Response('Bad request: invalid path', { status: 400 });
    }

    // 允许加载任意本地文件（图片、字体等），与 VSCode 行为一致。
    // 用户可打开项目目录外的文件（如仿真日志目录下的图片、外部技能路径下的资源等）。
    // local-resource 协议仅用于渲染进程加载本地资源（图片/SVG/字体），
    // 不涉及写入操作，放开路径限制不会带来安全风险。

    if (!existsSync(filePath)) {
      console.error('[local-resource] Not found:', filePath);
      return new Response('Not found', { status: 404 });
    }

    try {
      const buffer = await readFile(filePath);
      const mimeType = getMimeType(filePath);
      return new Response(new Uint8Array(buffer), {
        status: 200,
        headers: { 'Content-Type': mimeType },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[local-resource] Internal error:', msg);
      return new Response(`Internal error: ${msg}`, { status: 500 });
    }
  });
}

/**
 * 将本地文件路径转换为 `local-resource://` URL，供渲染进程使用。
 *
 * URL 格式: local-resource://app/<encodeURIComponent-encoded-path>
 * 例如 D:\docs\test.png → local-resource://app/D%3A%2Fdocs%2Ftest.png
 *
 * 路径中的反斜杠统一转为正斜杠后再编码，避免 Chromium URL 规范化
 * 将 %5C (反斜杠) 解码后转为正斜杠导致路径变化。
 * Windows 的 fs API 兼容正斜杠路径。
 */
export function toLocalResourceUrl(filePath: string): string {
  // 统一路径分隔符为正斜杠，避免 URL 规范化问题
  const normalized = filePath.replace(/\\/g, '/');
  const encoded = encodeURIComponent(normalized);
  return `${LOCAL_RESOURCE_SCHEME}://app/${encoded}`;
}
