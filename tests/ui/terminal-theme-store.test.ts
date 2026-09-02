// @vitest-environment jsdom
/**
 * 终端主题 store（Issue #3/#4）——useTerminalThemeStore 单元测试。
 *
 * 覆盖验收点：
 * 1. 8 款内置主题定义齐备（完整 xterm.js ITheme，20 个颜色键均为合法 hex）
 * 2. resolveTerminalITheme 多模式取色：follow-ui → CSS 变量；independent → 内置/自定义主题
 * 3. setter 行为 + 未知主题 ID 拒绝
 * 4. initTerminalTheme 从主进程恢复持久化设置（含自定义主题）
 * 5. 自定义主题导入/删除（Issue #4）
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const {
  mockGetMode,
  mockSetMode,
  mockGetThemeId,
  mockSetThemeId,
  mockListCustom,
  mockImportTheme,
  mockDeleteCustom,
} = vi.hoisted(() => ({
  mockGetMode: vi.fn<() => Promise<string>>(),
  mockSetMode: vi.fn<() => Promise<unknown>>(),
  mockGetThemeId: vi.fn<() => Promise<string | null>>(),
  mockSetThemeId: vi.fn<() => Promise<unknown>>(),
  mockListCustom: vi.fn<() => Promise<unknown[]>>(),
  mockImportTheme: vi.fn<() => Promise<unknown>>(),
  mockDeleteCustom: vi.fn<() => Promise<unknown>>(),
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    settings: {
      getTerminalThemeMode: { query: mockGetMode },
      setTerminalThemeMode: { mutate: mockSetMode },
      getTerminalThemeId: { query: mockGetThemeId },
      setTerminalThemeId: { mutate: mockSetThemeId },
      listCustomTerminalThemes: { query: mockListCustom },
      importTerminalTheme: { mutate: mockImportTheme },
      deleteCustomTheme: { mutate: mockDeleteCustom },
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
  useTerminalThemeStore.setState({ themeMode: 'follow-ui', themeId: 'dracula', customThemes: [] });
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

  it('independent 模式 + 自定义主题命中时返回自定义调色盘（Issue #4）', () => {
    const customThemes = [
      { id: 'my-theme', name: 'My Theme', theme: { background: '#abcabc', red: '#ff0000' } },
    ];
    const theme = resolveTerminalITheme({
      themeMode: 'independent',
      themeId: 'my-theme',
      customThemes,
    });
    expect(theme.background).toBe('#abcabc');
    expect(theme.red).toBe('#ff0000');
  });

  it('independent 模式 + 自定义主题未命中时回退内置/CSS', () => {
    const customThemes = [
      { id: 'my-theme', name: 'My Theme', theme: { background: '#abcabc' } },
    ];
    expect(
      resolveTerminalITheme({ themeMode: 'independent', themeId: 'nord', customThemes }).background,
    ).toBe('#2e3440');
    expect(
      resolveTerminalITheme({ themeMode: 'independent', themeId: 'nope', customThemes }).background,
    ).toBe('#1e1e1e');
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
    mockListCustom.mockResolvedValue([]);
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

  it('恢复 customThemes 列表（Issue #4）', async () => {
    const custom = [{ id: 'my-theme', name: 'My Theme', theme: { background: '#101010' } }];
    mockListCustom.mockResolvedValue(custom);
    mockGetMode.mockResolvedValue('follow-ui');
    useTerminalThemeStore.getState().initTerminalTheme();
    await vi.waitFor(() => {
      expect(useTerminalThemeStore.getState().customThemes).toEqual(custom);
    });
  });

  it('independent + 持久化 themeId 命中自定义主题时恢复（Issue #4）', async () => {
    mockListCustom.mockResolvedValue([
      { id: 'my-theme', name: 'My Theme', theme: { background: '#101010' } },
    ]);
    mockGetMode.mockResolvedValue('independent');
    mockGetThemeId.mockResolvedValue('my-theme');
    useTerminalThemeStore.getState().initTerminalTheme();
    await vi.waitFor(() => {
      const s = useTerminalThemeStore.getState();
      expect(s.themeMode).toBe('independent');
      expect(s.themeId).toBe('my-theme');
    });
  });

  it('自定义主题列表加载失败时视为空列表，恢复逻辑不受阻（Issue #4）', async () => {
    mockListCustom.mockRejectedValue(new Error('ipc down'));
    mockGetMode.mockResolvedValue('independent');
    mockGetThemeId.mockResolvedValue('nord');
    useTerminalThemeStore.getState().initTerminalTheme();
    await vi.waitFor(() => {
      const s = useTerminalThemeStore.getState();
      expect(s.customThemes).toEqual([]);
      expect(s.themeId).toBe('nord');
    });
  });
});

// ── Issue #4：自定义主题导入 / 删除 ──────────────────────────

const IMPORTED_THEME = {
  id: 'my-theme',
  name: 'My Theme',
  theme: { background: '#101010', red: '#ff0000' },
};

describe('terminal-theme store - importTheme（Issue #4）', () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    mockSetMode.mockResolvedValue({ ok: true });
    mockSetThemeId.mockResolvedValue({ ok: true });
  });

  it('调用主进程导入后更新 customThemes 并切换为 independent 选中', async () => {
    mockImportTheme.mockResolvedValue(IMPORTED_THEME);
    await useTerminalThemeStore.getState().importTheme({ background: '#101010' }, 'my-theme');
    expect(mockImportTheme).toHaveBeenCalledWith({ json: { background: '#101010' }, name: 'my-theme' });
    const s = useTerminalThemeStore.getState();
    expect(s.customThemes).toEqual([IMPORTED_THEME]);
    expect(s.themeMode).toBe('independent');
    expect(s.themeId).toBe('my-theme');
    expect(mockSetMode).toHaveBeenCalledWith({ mode: 'independent' });
    expect(mockSetThemeId).toHaveBeenCalledWith({ themeId: 'my-theme' });
  });

  it('重复导入同 ID 主题时覆盖旧条目', async () => {
    useTerminalThemeStore.setState({
      customThemes: [{ id: 'my-theme', name: 'My Theme', theme: { background: '#000000' } }],
    });
    mockImportTheme.mockResolvedValue(IMPORTED_THEME);
    await useTerminalThemeStore.getState().importTheme(IMPORTED_THEME.theme, 'My Theme');
    const customThemes = useTerminalThemeStore.getState().customThemes;
    expect(customThemes).toHaveLength(1);
    expect(customThemes[0].theme).toEqual(IMPORTED_THEME.theme);
  });

  it('导入失败（格式不合法）时抛错且状态不变', async () => {
    mockImportTheme.mockRejectedValue(new Error('主题 JSON 格式不合法'));
    await expect(
      useTerminalThemeStore.getState().importTheme({ background: 'not-a-color' }),
    ).rejects.toThrow('主题 JSON 格式不合法');
    const s = useTerminalThemeStore.getState();
    expect(s.customThemes).toEqual([]);
    expect(s.themeMode).toBe('follow-ui');
  });

  it('导入后 setTheme 接受自定义主题 ID', async () => {
    useTerminalThemeStore.setState({ customThemes: [IMPORTED_THEME] });
    useTerminalThemeStore.getState().setTheme('my-theme');
    expect(useTerminalThemeStore.getState().themeId).toBe('my-theme');
    expect(mockSetThemeId).toHaveBeenCalledWith({ themeId: 'my-theme' });
  });
});

describe('terminal-theme store - deleteCustomTheme（Issue #4）', () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    mockSetMode.mockResolvedValue({ ok: true });
    mockDeleteCustom.mockResolvedValue({ ok: true });
  });

  it('删除后从列表移除', async () => {
    useTerminalThemeStore.setState({
      themeMode: 'independent',
      themeId: 'nord',
      customThemes: [IMPORTED_THEME],
    });
    await useTerminalThemeStore.getState().deleteCustomTheme('my-theme');
    expect(mockDeleteCustom).toHaveBeenCalledWith({ themeId: 'my-theme' });
    expect(useTerminalThemeStore.getState().customThemes).toEqual([]);
    // 删除的不是当前选中主题 → 模式不变
    expect(useTerminalThemeStore.getState().themeMode).toBe('independent');
  });

  it('删除当前选中主题时回退 follow-ui 并持久化', async () => {
    useTerminalThemeStore.setState({
      themeMode: 'independent',
      themeId: 'my-theme',
      customThemes: [IMPORTED_THEME],
    });
    await useTerminalThemeStore.getState().deleteCustomTheme('my-theme');
    const s = useTerminalThemeStore.getState();
    expect(s.themeMode).toBe('follow-ui');
    expect(mockSetMode).toHaveBeenCalledWith({ mode: 'follow-ui' });
  });
});
