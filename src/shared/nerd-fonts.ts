/**
 * Nerd Font 内置字体 face 元数据（Issue #1 — 终端增强 Phase 1 基础设施）。
 *
 * 主进程（`src/main/fonts/nerd-font-paths.ts` 扫描字体目录）与渲染进程
 * （`src/renderer/src/styles/nerd-font-css.ts` 生成 @font-face）共享。
 *
 * 文件名清单须与 `scripts/download-nerd-fonts.mjs` 的下载清单保持一致。
 */

export type NerdFontFace = {
  /** CSS font-family 名 */
  family: string;
  /** CSS font-weight（字符串，直接写入 @font-face） */
  weight: string;
  /** CSS font-style */
  style: 'normal' | 'italic';
  /** resources/fonts/ 下的字体文件名 */
  fileName: string;
};

export const JETBRAINS_NF_FAMILY = 'JetBrainsMono Nerd Font';
export const MESLOLGS_NF_FAMILY = 'MesloLGS NF';

/** 全部内置 Nerd Font face（Regular/Bold/Italic/BoldItalic × 2 个 family） */
export const NERD_FONT_FACES: readonly NerdFontFace[] = [
  { family: JETBRAINS_NF_FAMILY, weight: '400', style: 'normal', fileName: 'JetBrainsMonoNerdFont-Regular.ttf' },
  { family: JETBRAINS_NF_FAMILY, weight: '700', style: 'normal', fileName: 'JetBrainsMonoNerdFont-Bold.ttf' },
  { family: JETBRAINS_NF_FAMILY, weight: '400', style: 'italic', fileName: 'JetBrainsMonoNerdFont-Italic.ttf' },
  { family: JETBRAINS_NF_FAMILY, weight: '700', style: 'italic', fileName: 'JetBrainsMonoNerdFont-BoldItalic.ttf' },
  { family: MESLOLGS_NF_FAMILY, weight: '400', style: 'normal', fileName: 'MesloLGS NF Regular.ttf' },
  { family: MESLOLGS_NF_FAMILY, weight: '700', style: 'normal', fileName: 'MesloLGS NF Bold.ttf' },
  { family: MESLOLGS_NF_FAMILY, weight: '400', style: 'italic', fileName: 'MesloLGS NF Italic.ttf' },
  { family: MESLOLGS_NF_FAMILY, weight: '700', style: 'italic', fileName: 'MesloLGS NF Bold Italic.ttf' },
];
