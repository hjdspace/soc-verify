/**
 * Terminal 主题读取（Issue #2）——follow-ui 模式的调色盘来源。
 *
 * 从 UI 主题的 CSS 变量（globals.css 中每个 [data-theme] 块的
 * `--term-black` 到 `--term-bright-white` 16 个 ANSI 色 + 4 个语义色）
 * 构建 xterm.js 的 ITheme 对象，让终端配色随 UI 主题自动联动。
 *
 * 颜色格式约定：所有 --term-* 变量直接写 hex（含可选 8 位 alpha）。
 * xterm.js 的 css.toColor 只解析 hex/rgb/rgba，不支持 oklch()——
 * 与 echarts-theme 的教训一致（见 tests/ui/echarts-theme.test.ts）。
 */

import type { ITheme } from '@xterm/xterm';

/** 一条 CSS 变量 → ITheme 键的映射及缺省回退值 */
type TerminalCssVarSpec = {
  /** CSS 变量名 */
  cssVar: string;
  /** xterm.js ITheme 的键名 */
  themeKey: keyof ITheme;
  /** 变量缺失 / 为空时的回退色（中性深色调色盘） */
  fallback: string;
};

/** 16 ANSI 色 + 4 语义色，共 20 条映射 */
export const TERMINAL_CSS_VARS: readonly TerminalCssVarSpec[] = [
  // ── 语义色 ──────────────────────────────────────────────
  { cssVar: '--term-background', themeKey: 'background', fallback: '#1e1e1e' },
  { cssVar: '--term-foreground', themeKey: 'foreground', fallback: '#d4d4d4' },
  { cssVar: '--term-cursor', themeKey: 'cursor', fallback: '#aeafad' },
  { cssVar: '--term-selection', themeKey: 'selectionBackground', fallback: '#4a4a4a' },
  // ── 8 基础色 ────────────────────────────────────────────
  { cssVar: '--term-black', themeKey: 'black', fallback: '#2e2e2e' },
  { cssVar: '--term-red', themeKey: 'red', fallback: '#cd5c5c' },
  { cssVar: '--term-green', themeKey: 'green', fallback: '#7ab87a' },
  { cssVar: '--term-yellow', themeKey: 'yellow', fallback: '#d0a44e' },
  { cssVar: '--term-blue', themeKey: 'blue', fallback: '#6a9ad0' },
  { cssVar: '--term-magenta', themeKey: 'magenta', fallback: '#b58ad0' },
  { cssVar: '--term-cyan', themeKey: 'cyan', fallback: '#5ab8b8' },
  { cssVar: '--term-white', themeKey: 'white', fallback: '#c8c8c8' },
  // ── 8 亮色 ──────────────────────────────────────────────
  { cssVar: '--term-bright-black', themeKey: 'brightBlack', fallback: '#6a6a6a' },
  { cssVar: '--term-bright-red', themeKey: 'brightRed', fallback: '#ef8a7a' },
  { cssVar: '--term-bright-green', themeKey: 'brightGreen', fallback: '#96d496' },
  { cssVar: '--term-bright-yellow', themeKey: 'brightYellow', fallback: '#e8be6e' },
  { cssVar: '--term-bright-blue', themeKey: 'brightBlue', fallback: '#8ab8e8' },
  { cssVar: '--term-bright-magenta', themeKey: 'brightMagenta', fallback: '#cfa8e8' },
  { cssVar: '--term-bright-cyan', themeKey: 'brightCyan', fallback: '#7ad4d4' },
  { cssVar: '--term-bright-white', themeKey: 'brightWhite', fallback: '#eeeeee' },
] as const;

/**
 * 从当前主题的 CSS 变量构建 xterm.js ITheme。
 *
 * 变量缺失或为空（如 CSS 未加载、旧自定义主题）时逐项回退到内置
 * 中性深色调色盘，保证终端始终可用。
 */
export function readTerminalThemeFromCss(): ITheme {
  const read = (spec: TerminalCssVarSpec): string => {
    if (typeof document === 'undefined') return spec.fallback;
    return getComputedStyle(document.documentElement).getPropertyValue(spec.cssVar).trim() || spec.fallback;
  };
  return Object.fromEntries(TERMINAL_CSS_VARS.map((spec) => [spec.themeKey, read(spec)])) as ITheme;
}
