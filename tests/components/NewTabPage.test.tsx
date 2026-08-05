/**
 * NewTabPage 组件测试。
 *
 * 验证地址输入、URL 提交、无效输入提示和快捷链接。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NewTabPage } from '@renderer/components/browser/NewTabPage';

describe('NewTabPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('渲染地址输入框', () => {
    render(<NewTabPage onNavigate={vi.fn()} />);
    expect(screen.getByPlaceholderText(/输入网址/)).toBeInTheDocument();
  });

  it('渲染常用书签占位', () => {
    render(<NewTabPage onNavigate={vi.fn()} />);
    expect(screen.getByText('常用书签')).toBeInTheDocument();
  });

  it('渲染书签分组占位', () => {
    render(<NewTabPage onNavigate={vi.fn()} />);
    expect(screen.getByText('书签分组')).toBeInTheDocument();
  });

  it('提交有效 URL 时调用 onNavigate', () => {
    const onNavigate = vi.fn();
    render(<NewTabPage onNavigate={onNavigate} />);

    const input = screen.getByPlaceholderText(/输入网址/);
    fireEvent.change(input, { target: { value: 'example.com' } });
    fireEvent.submit(input.closest('form')!);

    expect(onNavigate).toHaveBeenCalledWith('https://example.com');
  });

  it('提交无效 URL 时显示错误提示', () => {
    const onNavigate = vi.fn();
    render(<NewTabPage onNavigate={onNavigate} />);

    const input = screen.getByPlaceholderText(/输入网址/);
    fireEvent.change(input, { target: { value: 'not a url' } });
    fireEvent.submit(input.closest('form')!);

    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.getByText(/请输入有效的网址/)).toBeInTheDocument();
  });

  it('点击快捷链接时调用 onNavigate', () => {
    const onNavigate = vi.fn();
    render(<NewTabPage onNavigate={onNavigate} />);

    const link = screen.getByText('回归平台');
    fireEvent.click(link);

    expect(onNavigate).toHaveBeenCalledWith('https://regression.example.com');
  });

  it('输入有效 URL 后错误提示消失', () => {
    const onNavigate = vi.fn();
    render(<NewTabPage onNavigate={onNavigate} />);

    const input = screen.getByPlaceholderText(/输入网址/);
    // First submit invalid — spaces make it an invalid URL
    fireEvent.change(input, { target: { value: 'not a url' } });
    fireEvent.submit(input.closest('form')!);
    expect(screen.getByText(/请输入有效的网址/)).toBeInTheDocument();

    // Then type a valid URL
    fireEvent.change(input, { target: { value: 'https://example.com' } });
    expect(screen.queryByText(/请输入有效的网址/)).not.toBeInTheDocument();
  });
});
