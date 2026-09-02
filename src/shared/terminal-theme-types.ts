/**
 * 终端主题共享类型（Issue #3，ADR-0030）。
 *
 * Terminal Theme Mode 取值：
 *   - follow-ui   终端配色跟随 UI 主题（从 globals.css 的 --term-* CSS 变量读取）
 *   - independent 用户选择独立于 UI 主题的终端主题（内置 / 自定义）
 */
export type TerminalThemeMode = 'follow-ui' | 'independent';

export function isValidTerminalThemeMode(value: unknown): value is TerminalThemeMode {
  return value === 'follow-ui' || value === 'independent';
}
