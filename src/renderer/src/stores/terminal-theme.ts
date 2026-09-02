import { create } from 'zustand';
import type { ITheme } from '@xterm/xterm';
import { trpc } from '@renderer/lib/trpc';
import { readTerminalThemeFromCss } from '@renderer/components/terminal/terminal-theme';
import type { TerminalThemeMode } from '@shared/terminal-theme-types';

// ── 内置终端主题（Issue #3）────────────────────────────────────
// 每款主题是完整的 xterm.js ITheme（16 ANSI 色 + 4 语义色），
// 配色取自各主题官方调色盘。与 useThemeStore（UI 主题）完全解耦。

export type BuiltinTerminalTheme = {
  id: string;
  name: string;
  description: string;
  /** 色板预览主色（AppearanceTab 卡片 swatch） */
  swatch: string;
  /** 完整的 xterm.js ITheme 调色盘 */
  theme: ITheme;
}

function makeTheme(palette: ITheme): ITheme {
  return Object.freeze({ ...palette });
}

export const BUILTIN_TERMINAL_THEMES: readonly BuiltinTerminalTheme[] = [
  {
    id: 'dracula',
    name: 'Dracula',
    description: '深紫夜底 + 高饱和粉紫绿，经典暗色主题，对比强烈。',
    swatch: '#bd93f9',
    theme: makeTheme({
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      selectionBackground: '#44475a',
      black: '#21222c',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#f8f8f2',
      brightBlack: '#6272a4',
      brightRed: '#ff6e6e',
      brightGreen: '#69ff94',
      brightYellow: '#ffffa5',
      brightBlue: '#d6acff',
      brightMagenta: '#ff92df',
      brightCyan: '#a4ffff',
      brightWhite: '#ffffff',
    }),
  },
  {
    id: 'nord',
    name: 'Nord',
    description: '冷蓝灰底 + 霜蓝强调，北欧极简风格，低刺激配色。',
    swatch: '#88c0d0',
    theme: makeTheme({
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#d8dee9',
      selectionBackground: '#434c5e',
      black: '#3b4252',
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
      blue: '#81a1c1',
      magenta: '#b48ead',
      cyan: '#88c0d0',
      white: '#e5e9f0',
      brightBlack: '#4c566a',
      brightRed: '#bf616a',
      brightGreen: '#a3be8c',
      brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1',
      brightMagenta: '#b48ead',
      brightCyan: '#8fbcbb',
      brightWhite: '#eceff4',
    }),
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    description: '深靛夜空底 + 霓虹蓝紫，配色灵感来自东京夜景。',
    swatch: '#7aa2f7',
    theme: makeTheme({
      background: '#1a1b26',
      foreground: '#c0caf5',
      cursor: '#c0caf5',
      selectionBackground: '#33467c',
      black: '#15161e',
      red: '#f7768e',
      green: '#9ece6a',
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#bb9af7',
      cyan: '#7dcfff',
      white: '#a9b1d6',
      brightBlack: '#414868',
      brightRed: '#f7768e',
      brightGreen: '#9ece6a',
      brightYellow: '#e0af68',
      brightBlue: '#7aa2f7',
      brightMagenta: '#bb9af7',
      brightCyan: '#7dcfff',
      brightWhite: '#c0caf5',
    }),
  },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    description: '柔和深色底 + 马卡龙色，低对比度长时间盯屏不累眼。',
    swatch: '#f5c2e7',
    theme: makeTheme({
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      selectionBackground: '#585b70',
      black: '#45475a',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#f5c2e7',
      cyan: '#94e2d5',
      white: '#bac2de',
      brightBlack: '#585b70',
      brightRed: '#f38ba8',
      brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af',
      brightBlue: '#89b4fa',
      brightMagenta: '#f5c2e7',
      brightCyan: '#94e2d5',
      brightWhite: '#a6adc8',
    }),
  },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    description: '暖褐底 + 复古橙黄绿，retro groove 高对比暖色调。',
    swatch: '#fabd2f',
    theme: makeTheme({
      background: '#282828',
      foreground: '#ebdbb2',
      cursor: '#ebdbb2',
      selectionBackground: '#504945',
      black: '#282828',
      red: '#cc241d',
      green: '#98971a',
      yellow: '#d79921',
      blue: '#458588',
      magenta: '#b16286',
      cyan: '#689d6a',
      white: '#a89984',
      brightBlack: '#928374',
      brightRed: '#fb4934',
      brightGreen: '#b8bb26',
      brightYellow: '#fabd2f',
      brightBlue: '#83a598',
      brightMagenta: '#d3869b',
      brightCyan: '#8ec07c',
      brightWhite: '#ebdbb2',
    }),
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    description: '深青蓝底 + 精确调校的 Solarized 色板，久经考验。',
    swatch: '#268bd2',
    theme: makeTheme({
      background: '#002b36',
      foreground: '#839496',
      cursor: '#839496',
      selectionBackground: '#073642',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#002b36',
      brightRed: '#cb4b16',
      brightGreen: '#586e75',
      brightYellow: '#657b83',
      brightBlue: '#839496',
      brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1',
      brightWhite: '#fdf6e3',
    }),
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    description: 'Atom 经典深色主题，均衡的中性蓝灰调。',
    swatch: '#61afef',
    theme: makeTheme({
      background: '#282c34',
      foreground: '#abb2bf',
      cursor: '#528bff',
      selectionBackground: '#3e4451',
      black: '#282c34',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#e5c07b',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#abb2bf',
      brightBlack: '#5c6370',
      brightRed: '#e06c75',
      brightGreen: '#98c379',
      brightYellow: '#e5c07b',
      brightBlue: '#61afef',
      brightMagenta: '#c678dd',
      brightCyan: '#56b6c2',
      brightWhite: '#ffffff',
    }),
  },
  {
    id: 'snazzy',
    name: 'Snazzy',
    description: 'hyper Snazzy，明亮活泼的荧光色，深底高辨识。',
    swatch: '#ff6ac1',
    theme: makeTheme({
      background: '#282a36',
      foreground: '#eff0eb',
      cursor: '#97954b',
      selectionBackground: '#686689',
      black: '#282a36',
      red: '#ff5c57',
      green: '#5af78e',
      yellow: '#f3f99d',
      blue: '#57c7ff',
      magenta: '#ff6ac1',
      cyan: '#9aedfe',
      white: '#f1f1f0',
      brightBlack: '#686689',
      brightRed: '#ff5c57',
      brightGreen: '#5af78e',
      brightYellow: '#f3f99d',
      brightBlue: '#57c7ff',
      brightMagenta: '#ff6ac1',
      brightCyan: '#9aedfe',
      brightWhite: '#eff0eb',
    }),
  },
];

/** 按 ID 查找内置终端主题 */
export function getBuiltinTerminalTheme(id: string): BuiltinTerminalTheme | undefined {
  return BUILTIN_TERMINAL_THEMES.find((t) => t.id === id);
}

/**
 * 解析当前应生效的终端 ITheme：
 * - independent 模式且 themeId 命中内置主题 → 内置主题调色盘
 * - 其他情况（follow-ui / themeId 未知）→ 回退 follow-ui 的 CSS 变量调色盘
 *
 * 接受 store 状态切片而非整个 store，TerminalView 可用
 * useTerminalThemeStore.getState() 在 effect 中读取最新值。
 */
export function resolveTerminalITheme(state: {
  themeMode: TerminalThemeMode;
  themeId: string;
}): ITheme {
  if (state.themeMode === 'independent') {
    const builtin = getBuiltinTerminalTheme(state.themeId);
    if (builtin) return builtin.theme;
  }
  return readTerminalThemeFromCss();
}

// ── 终端主题 Store ─────────────────────────────────────────────

type TerminalThemeState = {
  /** 终端配色模式：跟随 UI 主题（默认）或独立主题 */
  themeMode: TerminalThemeMode;
  /** independent 模式下选中的主题 ID（内置或将来自定义主题） */
  themeId: string;
  /** 内置主题列表（只读引用） */
  builtinThemes: readonly BuiltinTerminalTheme[];
  setThemeMode: (mode: TerminalThemeMode) => void;
  setTheme: (themeId: string) => void;
  /** 应用启动时从主进程恢复上次的模式和主题（Issue #3 持久化） */
  initTerminalTheme: () => void;
}

const DEFAULT_TERMINAL_THEME_ID = 'dracula';

export const useTerminalThemeStore = create<TerminalThemeState>((set) => ({
  themeMode: 'follow-ui',
  themeId: DEFAULT_TERMINAL_THEME_ID,
  builtinThemes: BUILTIN_TERMINAL_THEMES,

  setThemeMode: (mode: TerminalThemeMode) => {
    set({ themeMode: mode });
    // 同步到主进程文件级持久化（确保重启后恢复），best-effort
    void trpc.settings.setTerminalThemeMode.mutate({ mode }).catch(() => {});
  },

  setTheme: (themeId: string) => {
    // 仅接受已知内置主题（将来 Issue #4 扩展自定义主题时在此放宽）
    if (!getBuiltinTerminalTheme(themeId)) return;
    set({ themeId });
    void trpc.settings.setTerminalThemeId.mutate({ themeId }).catch(() => {});
  },

  initTerminalTheme: () => {
    void trpc.settings.getTerminalThemeMode
      .query()
      .then(async (mode) => {
        if (mode === 'independent') {
          const themeId = await trpc.settings.getTerminalThemeId.query();
          // 持久化的 themeId 已不存在（如内置主题变更）时保持 follow-ui 语义
          if (themeId && getBuiltinTerminalTheme(themeId)) {
            set({ themeMode: 'independent', themeId });
          }
        } else if (mode === 'follow-ui') {
          set({ themeMode: 'follow-ui' });
        }
      })
      .catch(() => {
        // tRPC 不可用时保持默认 follow-ui
      });
  },
}));
