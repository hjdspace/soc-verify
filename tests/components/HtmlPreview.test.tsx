/**
 * HtmlPreview 组件测试。
 *
 * 验证组件调用 document.viewHtml 获取 HTML 路径后，
 * 用 webview 标签加载 file:// URL，并使用 partition 隔离。
 *
 * jsdom 不支持 webview 标签，但会将其渲染为 HTMLElement，
 * 因此可以通过 querySelector('webview') 断言 src / partition 属性。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// vi.mock 工厂会被提升到文件顶部，需用 vi.hoisted 让 mock 引用先于工厂执行时定义
const { viewHtmlMock } = vi.hoisted(() => ({
  viewHtmlMock: vi.fn(),
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    document: {
      viewHtml: { mutate: viewHtmlMock },
    },
  },
}));

import { HtmlPreview } from '@renderer/components/office/HtmlPreview';

describe('HtmlPreview webview 渲染', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('加载中显示等待状态', () => {
    // viewHtml 不 resolve，保持 pending
    viewHtmlMock.mockReturnValue(new Promise(() => {}));

    const { container } = render(<HtmlPreview filePath="/tmp/report.docx" />);

    expect(screen.getByText(/渲染中/)).toBeInTheDocument();
    expect(container.querySelector('webview')).toBeNull();
  });

  it('获取 htmlPath 后用 webview 加载 file:// URL', async () => {
    viewHtmlMock.mockResolvedValue({ htmlPath: '/tmp/officecli-123.html' });

    const { container } = render(<HtmlPreview filePath="/tmp/report.docx" />);

    await waitFor(() => {
      const webview = container.querySelector('webview');
      expect(webview).not.toBeNull();
      expect(webview?.getAttribute('src')).toContain('file://');
      expect(webview?.getAttribute('src')).toContain('officecli-123.html');
    });
  });

  it('webview 使用 persist:office-preview partition 隔离', async () => {
    viewHtmlMock.mockResolvedValue({ htmlPath: '/tmp/officecli-456.html' });

    const { container } = render(<HtmlPreview filePath="/tmp/report.docx" />);

    await waitFor(() => {
      const webview = container.querySelector('webview');
      expect(webview).not.toBeNull();
      expect(webview?.getAttribute('partition')).toBe('persist:office-preview');
    });
  });

  it('渲染失败时显示错误信息', async () => {
    viewHtmlMock.mockRejectedValue(new Error('OfficeCLI not available'));

    render(<HtmlPreview filePath="/tmp/report.docx" />);

    await waitFor(() => {
      expect(screen.getByText(/渲染失败/)).toBeInTheDocument();
    });
  });

  it('viewHtml 接收正确的 filePath 入参', async () => {
    viewHtmlMock.mockResolvedValue({ htmlPath: '/tmp/out.html' });

    render(<HtmlPreview filePath="/path/to/spec.docx" />);

    await waitFor(() => {
      expect(viewHtmlMock).toHaveBeenCalledWith({
        filePath: '/path/to/spec.docx',
      });
    });
  });
});
