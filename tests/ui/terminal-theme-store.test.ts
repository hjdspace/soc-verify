// @vitest-environment jsdom
/**
 * 终端主题 store（Issue #3）——useTerminalThemeStore 单元测试。
 *
 * 覆盖验收点：
 * 1. 8 款内置主题定义齐备（完整 xterm.js ITheme，20 个颜色键均为合法 hex）
 * 2. resolveTerminalITheme 双模式取色：follow-ui → CSS 变量；independent → 主题定义
 * 3. setter 行为 + 未知主题 ID 拒绝
 * 4. initTerminalTheme 从主进程恢复持久化设置
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockGetMode, mockSetMode, mockGetThemeId, mockSetThemeId } = vi.hoisted(() => ({
  mockGetMode: vi.fn<() => Promise<string>>(),
  mockSetMode: vi.fn<() => Promise<unknown>>(),
  mockGetThemeId: vi.fn<() => Promise<string | null>>(),
  mockSetThemeId: vi.fn<() => Promise<unknown>>(),
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    settings: {
      getTerminalThemeMode: { query: mockGetMode },
      setTerminalThemeMode: { mutate: mockSetMode },
      getTerminalThemeId: { query: mockGetThemeId },
      setTerminalThemeId: { mutate: mockSetThemeId },
    },
  },
}));

import {
  BUILTIN_TERMINAL_THEMES,
  getBuiltinTerminalTheme,
  resolveTerminalITheme,
  useTerminalThemeStore,
} from '@renderer/stores/terminal-theme';
import { TERMINAL_CSS_VARS } from '@renderer/components/terminal/terminal-theme';

/** ITheme 的 20 个颜色键 */
const I_THEME_KEYS = TERMINAL_CSS_VARS.map((spec) => spec.themeKey);

const EXPECTED_THEME_IDS = [
  'dracula',
  'nord',
  'tokyo-night',
  'catppuccin-mocha',
  'gruvbox-dark',
  'solarized-dark',
  'one-dark',
  'snazzy',
] as const;

function resetStore(): void {
  useTerminalThemeStore.setState({ themeMode: 'follow-ui', themeId: 'dracula' });
}

describe('terminal-theme store - 内置主题定义', () => {
  it('恰好 8 款内置主题，ID 与 issue #3 列表一致', () => {
    expect(BUILTIN_TERMINAL_THEMES).toHaveLength(8);
    expect(BUILTIN_TERMINAL_THEMES.map((t) => t.id)).toEqual([...EXPECTED_THEME_IDS]);
  });

  it.each(EXPECTED_THEME_IDS)('[%s] 每款主题有 name / description / swatch / 完整 ITheme', (id) => {
    const theme = getBuiltinTerminalTheme(id);
    expect(theme).toBeTruthy();
    expect(theme!.name.length).toBeGreaterThan(0);
    expect(theme!.description.length).toBeGreaterThan(0);
    expect(theme!.swatch).toMatch(/^#[0-9a-fA-F]{6}$/);
    for (const key of I_THEME_KEYS) {
      const value = theme!.theme[key] as string | undefined;
      expect(value, `${id}.${key} 不应为空`).toBeTruthy();
      expect(value, `${id}.${key} = ${value} 应为 hex 格式`).toMatch(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);
    }
  });

  it('每款主题 swatch 各不相同（用于卡片色板预览辨识）', () => {
    // 注：Dracula 与 Snazzy 官方调色盘背景同为 #282a36，故校验 swatch 而非背景
    const swatches = BUILTIN_TERMINAL_THEMES.map((t) => t.swatch);
    expect(new Set(swatches).size).toBe(BUILTIN_TERMINAL_THEMES.length);
  });
});

describe('terminal-theme store - resolveTerminalITheme', () => {
  beforeEach(resetStore);

  it('follow-ui 模式返回 CSS 变量调色盘（回退中性深色）', () => {
    const theme = resolveTerminalITheme({ themeMode: 'follow-ui', themeId: 'dracula' });
    // jsdom 无 --term-* 变量 → 逐项回退 fallback（与 terminal-theme.test.ts 断言一致）
    expect(theme.background).toBe('#1e1e1e');
  });

  it('independent 模式返回选中内置主题的调色盘', () => {
    const theme = resolveTerminalITheme({ themeMode: 'independent', themeId: 'tokyo-night' });
    expect(theme.background).toBe('#1a1b26');
    expect(theme.red).toBe('#f7768e');
  });

  it('independent 模式 + 未知 themeId 回退 CSS 变量调色盘', () => {
    const theme = resolveTerminalITheme({ themeMode: 'independent', themeId: 'not-exist' });
    expect(theme.background).toBe('#1e1e1e');
  });
});

describe('terminal-theme store - setter', () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    mockSetMode.mockResolvedValue({ ok: true });
    mockSetThemeId.mockResolvedValue({ ok: true });
  });

  it('setThemeMode 更新状态并同步主进程持久化', () => {
    useTerminalThemeStore.getState().setThemeMode('independent');
    expect(useTerminalThemeStore.getState().themeMode).toBe('independent');
    expect(mockSetMode).toHaveBeenCalledWith({ mode: 'independent' });
  });

  it('setTheme 更新 themeId 并同步主进程持久化', () => {
    useTerminalThemeStore.getState().setTheme('gruvbox-dark');
    expect(useTerminalThemeStore.getState().themeId).toBe('gruvbox-dark');
    expect(mockSetThemeId).toHaveBeenCalledWith({ themeId: 'gruvbox-dark' });
  });

  it('setTheme 拒绝未知主题 ID（状态不变、不持久化）', () => {
    useTerminalThemeStore.getState().setTheme('not-a-theme');
    expect(useTerminalThemeStore.getState().themeId).toBe('dracula');
    expect(mockSetThemeId).not.toHaveBeenCalled();
  });
});

describe('terminal-theme store - initTerminalTheme 持久化恢复', () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  it('主进程返回 independent + 有效 themeId 时恢复', async () => {
    mockGetMode.mockResolvedValue('independent');
    mockGetThemeId.mockResolvedValue('nord');
    useTerminalThemeStore.getState().initTerminalTheme();
    await vi.waitFor(() => {
      const s = useTerminalThemeStore.getState();
      expect(s.themeMode).toBe('independent');
      expect(s.themeId).toBe('nord');
    });
  });

  it('主进程返回 independent + 无效 themeId 时保持 follow-ui', async () => {
    mockGetMode.mockResolvedValue('independent');
    mockGetThemeId.mockResolvedValue('deleted-theme');
    useTerminalThemeStore.getState().initTerminalTheme();
    await vi.waitFor(() => {
      expect(useTerminalThemeStore.getState().themeMode).toBe('follow-ui');
    });
  });

  it('主进程返回 follow-ui 时保持跟随 UI', async () => {
    mockGetMode.mockResolvedValue('follow-ui');
    useTerminalThemeStore.getState().initTerminalTheme();
    await vi.waitFor(() => {
      expect(mockGetMode).toHaveBeenCalled();
    });
    expect(useTerminalThemeStore.getState().themeMode).toBe('follow-ui');
  });

  it('tRPC 调用失败时保持默认 follow-ui', async () => {
    mockGetMode.mockRejectedValue(new Error('ipc down'));
    useTerminalThemeStore.getState().initTerminalTheme();
    await vi.waitFor(() => {
      expect(mockGetMode).toHaveBeenCalled();
    });
    expect(useTerminalThemeStore.getState().themeMode).toBe('follow-ui');
  });
});
