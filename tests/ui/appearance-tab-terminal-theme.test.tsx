// @vitest-environment jsdom
/**
 * AppearanceTab 终端主题区块（Issue #3/#4）——渲染层测试。
 *
 * 覆盖验收点：
 * 1. 模式切换开关（跟随 UI / 独立）生效
 * 2. independent 模式展示 8 款内置主题卡片（色板 + 名称 + 描述）
 * 3. 选中主题卡片后 store 状态更新
 * 4. 自定义主题导入/删除/展示（Issue #4）
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getTerminalThemeMode: vi.fn<() => Promise<string>>().mockResolvedValue('follow-ui'),
  setTerminalThemeMode: vi.fn<() => Promise<unknown>>().mockResolvedValue({ ok: true }),
  getTerminalThemeId: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
  setTerminalThemeId: vi.fn<() => Promise<unknown>>().mockResolvedValue({ ok: true }),
  listCustomTerminalThemes: vi.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
  importTerminalTheme: vi.fn<() => Promise<unknown>>().mockResolvedValue({}),
  deleteCustomTheme: vi.fn<() => Promise<unknown>>().mockResolvedValue({ ok: true }),
}));

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    settings: {
      getTerminalThemeMode: { query: mocks.getTerminalThemeMode },
      setTerminalThemeMode: { mutate: mocks.setTerminalThemeMode },
      getTerminalThemeId: { query: mocks.getTerminalThemeId },
      setTerminalThemeId: { mutate: mocks.setTerminalThemeId },
      listCustomTerminalThemes: { query: mocks.listCustomTerminalThemes },
      importTerminalTheme: { mutate: mocks.importTerminalTheme },
      deleteCustomTheme: { mutate: mocks.deleteCustomTheme },
    },
  },
}));

vi.mock('@renderer/stores/toast', () => ({
  useToastStore: Object.assign(
    vi.fn((selector: (state: Record<string, unknown>) => unknown) =>
      selector({ success: toastMocks.success, error: toastMocks.error }),
    ),
    { getState: () => ({ success: toastMocks.success, error: toastMocks.error }) },
  ),
}));

import { useTerminalThemeStore } from '@renderer/stores/terminal-theme';
import { AppearanceTab } from '@renderer/components/settings/AppearanceTab';

const IMPORTED_THEME = {
  id: 'my-custom-theme',
  name: 'My Custom Theme',
  theme: { background: '#1a1b26', red: '#f7768e' },
};

describe('AppearanceTab - 终端主题区块', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTerminalThemeMode.mockResolvedValue('follow-ui');
    mocks.setTerminalThemeMode.mockResolvedValue({ ok: true });
    mocks.getTerminalThemeId.mockResolvedValue(null);
    mocks.setTerminalThemeId.mockResolvedValue({ ok: true });
    mocks.listCustomTerminalThemes.mockResolvedValue([]);
    mocks.importTerminalTheme.mockResolvedValue(IMPORTED_THEME);
    mocks.deleteCustomTheme.mockResolvedValue({ ok: true });
    useTerminalThemeStore.setState({
      themeMode: 'follow-ui',
      themeId: 'dracula',
      customThemes: [],
    });
  });

  it('默认 follow-ui 模式：不展示内置主题卡片', () => {
    render(<AppearanceTab />);
    expect(screen.getByText('终端主题')).toBeInTheDocument();
    expect(screen.getByText('跟随 UI')).toBeInTheDocument();
    expect(screen.getByText('独立主题')).toBeInTheDocument();
    // follow-ui 模式下不渲染主题卡片
    expect(screen.queryByText('Dracula')).not.toBeInTheDocument();
  });

  it('切换为 independent 模式后展示 8 款内置主题卡片', () => {
    render(<AppearanceTab />);
    fireEvent.click(screen.getByRole('button', { name: /独立主题/ }));

    expect(useTerminalThemeStore.getState().themeMode).toBe('independent');
    for (const name of [
      'Dracula',
      'Nord',
      'Tokyo Night',
      'Catppuccin Mocha',
      'Gruvbox Dark',
      'Solarized Dark',
      'One Dark',
      'Snazzy',
    ]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
  });

  it('点击主题卡片后选中态更新并持久化到主进程', () => {
    useTerminalThemeStore.setState({ themeMode: 'independent', themeId: 'dracula' });
    render(<AppearanceTab />);

    fireEvent.click(screen.getByRole('button', { name: /Solarized Dark/ }));
    expect(useTerminalThemeStore.getState().themeId).toBe('solarized-dark');
    expect(mocks.setTerminalThemeId).toHaveBeenCalledWith({ themeId: 'solarized-dark' });
  });

  it('模式切换同步主进程持久化', () => {
    render(<AppearanceTab />);
    fireEvent.click(screen.getByRole('button', { name: /独立主题/ }));
    expect(mocks.setTerminalThemeMode).toHaveBeenCalledWith({ mode: 'independent' });

    fireEvent.click(screen.getByRole('button', { name: /跟随 UI/ }));
    expect(mocks.setTerminalThemeMode).toHaveBeenCalledWith({ mode: 'follow-ui' });
    expect(useTerminalThemeStore.getState().themeMode).toBe('follow-ui');
  });
});

// ── Issue #4：自定义主题导入 / 删除 / 展示 ─────────────────────

describe('AppearanceTab - 自定义主题（Issue #4）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTerminalThemeMode.mockResolvedValue('follow-ui');
    mocks.setTerminalThemeMode.mockResolvedValue({ ok: true });
    mocks.getTerminalThemeId.mockResolvedValue(null);
    mocks.setTerminalThemeId.mockResolvedValue({ ok: true });
    mocks.listCustomTerminalThemes.mockResolvedValue([]);
    mocks.importTerminalTheme.mockResolvedValue(IMPORTED_THEME);
    mocks.deleteCustomTheme.mockResolvedValue({ ok: true });
    useTerminalThemeStore.setState({
      themeMode: 'follow-ui',
      themeId: 'dracula',
      customThemes: [],
    });
  });

  it('展示「导入主题」按钮', () => {
    render(<AppearanceTab />);
    expect(screen.getByText(/导入主题/)).toBeInTheDocument();
  });

  it('independent 模式 + 有自定义主题时并列展示自定义主题卡片', () => {
    useTerminalThemeStore.setState({
      themeMode: 'independent',
      themeId: 'dracula',
      customThemes: [IMPORTED_THEME],
    });
    render(<AppearanceTab />);
    // 自定义主题名称出现在页面上（在 8 款内置主题之后）
    expect(screen.getByText('My Custom Theme')).toBeInTheDocument();
  });

  it('自定义主题卡片有删除按钮', () => {
    useTerminalThemeStore.setState({
      themeMode: 'independent',
      themeId: 'my-custom-theme',
      customThemes: [IMPORTED_THEME],
    });
    render(<AppearanceTab />);
    const deleteBtn = screen.getByLabelText('删除主题 My Custom Theme');
    expect(deleteBtn).toBeInTheDocument();
  });

  it('点击删除按钮后调用 store.deleteCustomTheme', async () => {
    useTerminalThemeStore.setState({
      themeMode: 'independent',
      themeId: 'my-custom-theme',
      customThemes: [IMPORTED_THEME],
    });
    render(<AppearanceTab />);
    fireEvent.click(screen.getByLabelText('删除主题 My Custom Theme'));
    await waitFor(() => {
      expect(mocks.deleteCustomTheme).toHaveBeenCalledWith({ themeId: 'my-custom-theme' });
    });
  });

  it('删除成功后显示 toast 提示', async () => {
    useTerminalThemeStore.setState({
      themeMode: 'independent',
      themeId: 'my-custom-theme',
      customThemes: [IMPORTED_THEME],
    });
    render(<AppearanceTab />);
    fireEvent.click(screen.getByLabelText('删除主题 My Custom Theme'));
    await waitFor(() => {
      expect(toastMocks.success).toHaveBeenCalledWith('主题已删除', 'My Custom Theme');
    });
  });

  it('点击导入按钮后触发文件选择', async () => {
    render(<AppearanceTab />);
    const importBtn = screen.getByText(/导入主题/);
    // 验证按钮可点击且关联的 hidden input 存在
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeInTheDocument();
    expect(fileInput.accept).toBe('.json,application/json');
    // 点击导入按钮应触发 click on input
    const clickSpy = vi.spyOn(fileInput, 'click');
    fireEvent.click(importBtn);
    expect(clickSpy).toHaveBeenCalled();
  });

  it('选择 JSON 文件后调用 store.importTheme 并显示成功 toast', async () => {
    render(<AppearanceTab />);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;

    const jsonContent = JSON.stringify({ background: '#1a1b26', red: '#f7768e' });
    const file = new File([jsonContent], 'my-theme.json', { type: 'application/json' });

    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(mocks.importTerminalTheme).toHaveBeenCalledWith({
        json: { background: '#1a1b26', red: '#f7768e' },
        name: 'my-theme',
      });
    });
    await waitFor(() => {
      expect(toastMocks.success).toHaveBeenCalledWith('主题导入成功', 'my-theme.json');
    });
  });

  it('导入成功后自定义主题出现在列表中', async () => {
    render(<AppearanceTab />);
    // 切换到 independent 以显示主题列表
    fireEvent.click(screen.getByRole('button', { name: /独立主题/ }));

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const jsonContent = JSON.stringify({ background: '#1a1b26', red: '#f7768e' });
    const file = new File([jsonContent], 'my-theme.json', { type: 'application/json' });

    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(useTerminalThemeStore.getState().customThemes).toContainEqual(IMPORTED_THEME);
    });
    // 导入后自动切到 independent 并选中
    expect(useTerminalThemeStore.getState().themeMode).toBe('independent');
    expect(useTerminalThemeStore.getState().themeId).toBe('my-custom-theme');
  });

  it('导入失败（格式不合法）时显示错误 toast', async () => {
    mocks.importTerminalTheme.mockRejectedValue(new Error('主题 JSON 格式不合法'));
    render(<AppearanceTab />);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;

    // 传入合法 JSON 但主进程校验失败
    const file = new File(['{ "bad": true }'], 'bad.json', { type: 'application/json' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(toastMocks.error).toHaveBeenCalledWith(
        '主题导入失败',
        '主题 JSON 格式不合法',
      );
    });
  });

  it('删除当前选中的自定义主题时回退 follow-ui', async () => {
    useTerminalThemeStore.setState({
      themeMode: 'independent',
      themeId: 'my-custom-theme',
      customThemes: [IMPORTED_THEME],
    });
    render(<AppearanceTab />);
    fireEvent.click(screen.getByLabelText('删除主题 My Custom Theme'));
    await waitFor(() => {
      expect(useTerminalThemeStore.getState().themeMode).toBe('follow-ui');
    });
  });

  it('删除非当前选中的自定义主题时模式不变', async () => {
    useTerminalThemeStore.setState({
      themeMode: 'independent',
      themeId: 'dracula',
      customThemes: [IMPORTED_THEME],
    });
    render(<AppearanceTab />);
    fireEvent.click(screen.getByLabelText('删除主题 My Custom Theme'));
    await waitFor(() => {
      expect(mocks.deleteCustomTheme).toHaveBeenCalled();
    });
    // 删除的不是当前选中主题 → 模式不变
    expect(useTerminalThemeStore.getState().themeMode).toBe('independent');
  });
});
