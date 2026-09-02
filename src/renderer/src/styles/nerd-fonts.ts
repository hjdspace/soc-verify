/**
 * Nerd Font 注入（Issue #1）。
 *
 * Electron 没有 `app.registerFont()` API。渲染进程通过 tRPC 从主进程获取
 * 已下载字体的 `local-resource://` URL，动态注入 @font-face 规则。
 *
 * 降级策略：字体未下载（faces 为空）或查询失败时跳过注入——CSS font-family
 * 链中的后续 fallback（Consolas / monospace）自然生效，应用不崩溃。
 */

import { trpc } from '@renderer/lib/trpc';
import { buildNerdFontFaceCss, type NerdFontFaceDescriptor } from './nerd-font-css';

/** 注入的 <style> 元素 ID */
const STYLE_ELEMENT_ID = 'nerd-fonts';

/**
 * 启动时注入 Nerd Font @font-face。
 *
 * 查询主进程可用字体列表（按磁盘实际存在过滤），有则生成 CSS 写入
 * <style id="nerd-fonts">；无 / 失败则不注入（fallback 字体兜底）。
 */
export async function injectNerdFonts(): Promise<void> {
  try {
    const result = await trpc.system.nerdFonts.query();
    if (result.faces.length === 0) return;
    injectFontFaceCss(result.faces);
  } catch {
    // 主进程查询失败（如 IPC 桥接未就绪）—— 降级为 fallback 字体，不阻塞启动
  }
}

/** 将 @font-face CSS 注入文档 <head>（幂等：重复调用覆盖同一 <style>） */
export function injectFontFaceCss(faces: readonly NerdFontFaceDescriptor[]): void {
  const css = buildNerdFontFaceCss(faces);
  if (!css) return;

  let style = document.getElementById(STYLE_ELEMENT_ID);
  if (!(style instanceof HTMLStyleElement)) {
    style = document.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    document.head.appendChild(style);
  }
  style.textContent = css;
}
