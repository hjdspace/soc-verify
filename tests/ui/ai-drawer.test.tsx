// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';

/* RightPanelContent 用轻量 mock 隔离（会话流已有 RightPanel 测试覆盖） */
vi.mock('@renderer/components/layout/RightPanel', () => ({
  RightPanelContent: () => <div data-testid="right-panel-content-mock" />,
}));

import { AiDrawer } from '@renderer/components/layout/AiDrawer';
import { useUiStore } from '@renderer/stores/ui';

beforeEach(() => {
  useUiStore.setState({ leftDrawerOpen: false, rightDrawerOpen: true, aiPanelMode: 'drawer' });
});

describe('AiDrawer 基础渲染', () => {
  it('打开时渲染标题与 RightPanelContent 复用内容', () => {
    render(<AiDrawer />);
    expect(screen.getByRole('dialog', { name: 'AI 验证助手' })).toBeInTheDocument();
    expect(screen.getByTestId('right-panel-content-mock')).toBeInTheDocument();
  });

  it('关闭态 aria-hidden', () => {
    useUiStore.setState({ rightDrawerOpen: false });
    render(<AiDrawer />);
    /* inert 属性使抽屉从 accessibility tree 排除，getByRole 查不到，改用 testid */
    const drawer = screen.getByTestId('drawer-right');
    expect(drawer.getAttribute('aria-hidden')).toBe('true');
  });

  it('Esc 关闭抽屉', () => {
    render(<AiDrawer />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUiStore.getState().rightDrawerOpen).toBe(false);
  });
});

describe('AiDrawer 模式切换', () => {
  it('点击切换按钮 → docked 模式并跳转工作区', () => {
    useUiStore.setState({ activeView: 'dashboard' });
    render(<AiDrawer />);

    fireEvent.click(screen.getByTestId('ai-drawer-dock-switch'));
    expect(useUiStore.getState().aiPanelMode).toBe('docked');
    expect(useUiStore.getState().activeView).toBe('workspace');
    expect(useUiStore.getState().rightDrawerOpen).toBe(false);
  });
});
