/**
 * NavigationBar 组件测试。
 *
 * 验证导航按钮状态、地址栏显示和交互行为。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NavigationBar } from '@renderer/components/browser/NavigationBar';

// Mock trpc
vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    system: {
      openExternal: { mutate: vi.fn().mockResolvedValue({ success: true }) },
    },
  },
}));

describe('NavigationBar', () => {
  const defaultProps = {
    surfaceId: 'surface-1',
    url: 'https://example.com',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: null,
    onNavigate: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock surfaceBridge
    (window as unknown as { surfaceBridge: unknown }).surfaceBridge = {
      goBack: vi.fn().mockResolvedValue(undefined),
      goForward: vi.fn().mockResolvedValue(undefined),
      reload: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('渲染后退、前进、刷新和系统浏览器打开按钮', () => {
    render(<NavigationBar {...defaultProps} />);

    expect(screen.getByTitle('后退')).toBeInTheDocument();
    expect(screen.getByTitle('前进')).toBeInTheDocument();
    expect(screen.getByTitle('刷新')).toBeInTheDocument();
    expect(screen.getByTitle('在系统浏览器中打开')).toBeInTheDocument();
  });

  it('地址栏显示当前 URL', () => {
    render(<NavigationBar {...defaultProps} url="https://example.com/page" />);
    expect(screen.getByDisplayValue('https://example.com/page')).toBeInTheDocument();
  });

  it('后退按钮在 canGoBack=false 时禁用', () => {
    render(<NavigationBar {...defaultProps} canGoBack={false} />);
    expect(screen.getByTitle('后退')).toBeDisabled();
  });

  it('后退按钮在 canGoBack=true 时可点击', () => {
    render(<NavigationBar {...defaultProps} canGoBack={true} />);
    const backBtn = screen.getByTitle('后退');
    expect(backBtn).not.toBeDisabled();
    fireEvent.click(backBtn);
    expect(window.surfaceBridge?.goBack).toHaveBeenCalledWith('surface-1');
  });

  it('前进按钮在 canGoForward=false 时禁用', () => {
    render(<NavigationBar {...defaultProps} canGoForward={false} />);
    expect(screen.getByTitle('前进')).toBeDisabled();
  });

  it('点击刷新按钮调用 surfaceBridge.reload', () => {
    render(<NavigationBar {...defaultProps} />);
    fireEvent.click(screen.getByTitle('刷新'));
    expect(window.surfaceBridge?.reload).toHaveBeenCalledWith('surface-1');
  });

  it('加载中时刷新按钮显示加载图标', () => {
    render(<NavigationBar {...defaultProps} loading={true} />);
    expect(screen.getByTitle('加载中...')).toBeInTheDocument();
  });

  it('在地址栏输入新 URL 并提交时调用 onNavigate', () => {
    const onNavigate = vi.fn();
    render(<NavigationBar {...defaultProps} url="https://example.com" onNavigate={onNavigate} />);

    const input = screen.getByDisplayValue('https://example.com');
    fireEvent.change(input, { target: { value: 'https://other.com' } });
    fireEvent.submit(input.closest('form')!);

    expect(onNavigate).toHaveBeenCalledWith('https://other.com');
  });

  it('输入无效 URL 时不调用 onNavigate', () => {
    const onNavigate = vi.fn();
    render(<NavigationBar {...defaultProps} url="https://example.com" onNavigate={onNavigate} />);

    const input = screen.getByDisplayValue('https://example.com');
    fireEvent.change(input, { target: { value: 'invalid url' } });
    fireEvent.submit(input.closest('form')!);

    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('输入相同 URL 时不调用 onNavigate', () => {
    const onNavigate = vi.fn();
    render(<NavigationBar {...defaultProps} url="https://example.com" onNavigate={onNavigate} />);

    const input = screen.getByDisplayValue('https://example.com');
    fireEvent.submit(input.closest('form')!);

    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('有错误时显示错误图标', () => {
    render(<NavigationBar {...defaultProps} error="Connection refused" />);
    // The error icon should be visible (AlertCircle instead of Globe)
    const addrBar = screen.getByDisplayValue('https://example.com');
    const container = addrBar.closest('div');
    expect(container?.querySelector('.lucide-circle-alert')).toBeTruthy();
  });
});
