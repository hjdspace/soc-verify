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

// ── 自定义终端主题（Issue #4，ADR-0030）──────────────────────
//
// 用户通过 JSON 文件导入自定义主题，格式与 xterm.js ITheme 兼容。
// 前端不能直接读取 appData 文件（CSP: default-src 'self'），
// 所有读写经 tRPC procedure 在主进程完成，前端只接收数据对象。

/** xterm.js ITheme 中接受颜色值的键（16 ANSI 色 + 语义色） */
export const TERMINAL_THEME_COLOR_KEYS = [
  'background',
  'foreground',
  'cursor',
  'cursorAccent',
  'selectionBackground',
  'selectionForeground',
  'selectionInactiveBackground',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;

export type TerminalThemeColorKey = (typeof TERMINAL_THEME_COLOR_KEYS)[number];

/** 部分填充的 ITheme 兼容调色盘（结构上可赋值给 xterm.js ITheme） */
export type TerminalThemeColors = Partial<Record<TerminalThemeColorKey, string>>;

/** 一条自定义终端主题（持久化文档与 tRPC 返回结构） */
export type CustomTerminalTheme = {
  /** 主题 ID（由名称 slug 化生成，即持久化文件名去 .json） */
  id: string;
  name: string;
  theme: TerminalThemeColors;
};

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** 是否为 xterm.js 接受的 hex 颜色（#RGB / #RGBA / #RRGGBB / #RRGGBBAA） */
export function isValidHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR_RE.test(value);
}

/**
 * 从任意 JSON 值中提取合法的 ITheme 颜色键值对：
 * - 仅保留 TERMINAL_THEME_COLOR_KEYS 中的键，值必须为合法 hex
 * - 已知键但值非法 → 视为格式不合法，返回 null
 * - 未知键 / 非字符串值 → 忽略
 */
export function sanitizeTerminalThemeColors(raw: unknown): TerminalThemeColors | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const colors: TerminalThemeColors = {};
  let validCount = 0;
  for (const key of TERMINAL_THEME_COLOR_KEYS) {
    const value = record[key];
    if (value === undefined) continue;
    if (!isValidHexColor(value)) return null;
    colors[key] = value.toLowerCase();
    validCount += 1;
  }
  // 至少一个合法颜色才认为是 ITheme 兼容对象
  return validCount > 0 ? colors : null;
}

/**
 * 解析用户导入的主题 JSON：
 * - 顶层为对象，含可选 `name` 字符串字段 + ITheme 颜色键值对
 * - 颜色部分经 sanitizeTerminalThemeColors 校验，不合法返回 null
 */
export function parseTerminalThemeJson(
  json: unknown,
): { name?: string; colors: TerminalThemeColors } | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const record = json as Record<string, unknown>;
  const colors = sanitizeTerminalThemeColors(record);
  if (!colors) return null;
  const name =
    typeof record.name === 'string' && record.name.trim().length > 0
      ? record.name.trim().slice(0, 50)
      : undefined;
  return { name, colors };
}
