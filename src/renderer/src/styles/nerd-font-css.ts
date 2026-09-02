/**
 * Nerd Font @font-face CSS 生成（Issue #1）。
 *
 * 纯函数模块——无 DOM / 网络依赖，便于单元测试。
 * 注入逻辑见 `./nerd-fonts.ts`。
 */

export type NerdFontFaceDescriptor = {
  family: string;
  weight: string;
  style: string;
  /** 字体文件的 local-resource:// URL（由主进程生成） */
  url: string;
};

/** URL 扩展名 → CSS format() 标记 */
function fontFormat(url: string): string {
  const lower = url.toLowerCase();
  if (lower.endsWith('.woff2')) return 'woff2';
  if (lower.endsWith('.woff')) return 'woff';
  if (lower.endsWith('.otf')) return 'opentype';
  return 'truetype';
}

/**
 * 为每个字体 face 生成一条 @font-face 规则。
 *
 * `font-display: swap` 确保字体加载期间先用 fallback 渲染，不阻塞文本显示。
 */
export function buildNerdFontFaceCss(faces: readonly NerdFontFaceDescriptor[]): string {
  return faces
    .map(
      (face) =>
        `@font-face {\n` +
        `  font-family: '${face.family}';\n` +
        `  font-style: ${face.style};\n` +
        `  font-weight: ${face.weight};\n` +
        `  font-display: swap;\n` +
        `  src: url('${face.url}') format('${fontFormat(face.url)}');\n` +
        `}`,
    )
    .join('\n');
}
