/**
 * NewTabPage 组件测试。
 *
 * 验证地址输入、URL 提交、无效输入提示和书签显示。
 * Issue #8: 书签现在来自 useBookmarkStore，测试 mock 该 store。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Mock bookmark store before importing NewTabPage
const mockLoadBookmarks = vi.fn().mockResolvedValue(undefined);
vi.mock('@renderer/stores/bookmarks', () => ({
  useBookmarkStore: (selector: (s: unknown) => unknown) =>
    selector({
      bookmarks: [
        {
          id: 'bm-1',
          url: 'https://regression.example.com',
          title: '回归平台',
          groupId: null,
          frequent: true,
          order: 0,
          createdAt: Date.now(),
        },
        {
          id: 'bm-2',
          url: 'https://docs.example.com',
          title: '文档中心',
          groupId: 'grp-1',
          frequent: false,
          order: 1,
          createdAt: Date.now(),
        },
      ],
      groups: [
        { id: 'grp-1', name: '工具组', order: 0 },
      ],
      loading: false,
      load: mockLoadBookmarks,
      getFrequentBookmarks: () => [
        {
          id: 'bm-1',
          url: 'https://regression.example.com',
          title: '回归平台',
          groupId: null,
          frequent: true,
          order: 0,
          createdAt: Date.now(),
        },
      ],
      getBookmarksByGroup: (groupId: string) =>
        groupId === 'grp-1'
          ? [
              {
                id: 'bm-2',
                url: 'https://docs.example.com',
                title: '文档中心',
                groupId: 'grp-1',
                frequent: false,
                order: 1,
                createdAt: Date.now(),
              },
            ]
          : [],
    }),
}));

import { NewTabPage } from '@renderer/components/browser/NewTabPage';

describe('NewTabPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('渲染地址输入框', () => {
    render(<NewTabPage onNavigate={vi.fn()} />);
    expect(screen.getByPlaceholderText(/输入网址/)).toBeInTheDocument();
  });

  it('渲染常用书签标题', () => {
    render(<NewTabPage onNavigate={vi.fn()} />);
    expect(screen.getByText('常用书签')).toBeInTheDocument();
  });

  it('渲染书签分组标题', () => {
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

  it('点击常用书签时调用 onNavigate', () => {
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

  it('mount 时加载书签', () => {
    render(<NewTabPage onNavigate={vi.fn()} />);
    expect(mockLoadBookmarks).toHaveBeenCalled();
  });

  it('渲染书签分组名称', () => {
    render(<NewTabPage onNavigate={vi.fn()} />);
    expect(screen.getByText('工具组')).toBeInTheDocument();
  });
});
