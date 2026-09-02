// @vitest-environment jsdom
/**
 * AppearanceTab 终端主题区块（Issue #3）——渲染层测试。
 *
 * 覆盖验收点：
 * 1. 模式切换开关（跟随 UI / 独立）生效
 * 2. independent 模式展示 8 款内置主题卡片（色板 + 名称 + 描述）
 * 3. 选中主题卡片后 store 状态更新
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getTerminalThemeMode: vi.fn<() => Promise<string>>().mockResolvedValue('follow-ui'),
  setTerminalThemeMode: vi.fn<() => Promise<unknown>>().mockResolvedValue({ ok: true }),
  getTerminalThemeId: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
  setTerminalThemeId: vi.fn<() => Promise<unknown>>().mockResolvedValue({ ok: true }),
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    settings: {
      getTerminalThemeMode: { query: mocks.getTerminalThemeMode },
      setTerminalThemeMode: { mutate: mocks.setTerminalThemeMode },
      getTerminalThemeId: { query: mocks.getTerminalThemeId },
      setTerminalThemeId: { mutate: mocks.setTerminalThemeId },
    },
  },
}));

import { useTerminalThemeStore } from '@renderer/stores/terminal-theme';
import { AppearanceTab } from '@renderer/components/settings/AppearanceTab';

describe('AppearanceTab - 终端主题区块', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTerminalThemeMode.mockResolvedValue('follow-ui');
    mocks.setTerminalThemeMode.mockResolvedValue({ ok: true });
    mocks.getTerminalThemeId.mockResolvedValue(null);
    mocks.setTerminalThemeId.mockResolvedValue({ ok: true });
    useTerminalThemeStore.setState({ themeMode: 'follow-ui', themeId: 'dracula' });
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
