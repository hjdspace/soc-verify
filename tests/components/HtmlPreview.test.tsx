/**
 * HtmlPreview 组件测试。
 *
 * 验证组件调用 document.viewHtml 获取 HTML 路径后，
 * 使用 SurfaceLayer (kind='document', source='local-file') 加载 HTML 文件，
 * 并通过 injectCSS 注入视口填充 CSS。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { JSX } from 'react';

// vi.mock 工厂会被提升到文件顶部，需用 vi.hoisted 让 mock 引用先于工厂执行时定义
const { viewHtmlMock, surfaceLayerMock } = vi.hoisted(() => ({
  viewHtmlMock: vi.fn(),
  surfaceLayerMock: vi.fn((props: Record<string, unknown>): JSX.Element => {
    const source = props.source as { type: string; path?: string; url?: string };
    return (
      <div
        data-testid="surface-layer"
        data-surface-id={props.surfaceId as string}
        data-kind={props.kind as string}
        data-source-type={source.type}
        data-source-path={source.path ?? ''}
        data-source-url={source.url ?? ''}
        data-inject-css={(props.injectCSS as string) ?? ''}
      />
    );
  }),
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    document: {
      viewHtml: { mutate: viewHtmlMock },
    },
  },
}));

vi.mock('@renderer/components/surface/SurfaceLayer', () => ({
  SurfaceLayer: surfaceLayerMock,
}));

import { HtmlPreview } from '@renderer/components/office/HtmlPreview';

describe('HtmlPreview Document Surface 渲染', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('加载中显示等待状态', () => {
    // viewHtml 不 resolve，保持 pending
    viewHtmlMock.mockReturnValue(new Promise(() => {}));

    const { container } = render(<HtmlPreview filePath="/tmp/report.docx" />);

    expect(screen.getByText(/渲染中/)).toBeInTheDocument();
    expect(container.querySelector('[data-testid="surface-layer"]')).toBeNull();
  });

  it('获取 htmlPath 后用 Document Surface 加载 local-file', async () => {
    viewHtmlMock.mockResolvedValue({ htmlPath: '/tmp/officecli-123.html' });

    const { container } = render(<HtmlPreview filePath="/tmp/report.docx" />);

    await waitFor(() => {
      const surface = container.querySelector('[data-testid="surface-layer"]');
      expect(surface).not.toBeNull();
      expect(surface?.getAttribute('data-kind')).toBe('document');
      expect(surface?.getAttribute('data-source-type')).toBe('local-file');
      expect(surface?.getAttribute('data-source-path')).toContain('officecli-123.html');
    });
  });

  it('Document Surface 注入视口填充 CSS', async () => {
    viewHtmlMock.mockResolvedValue({ htmlPath: '/tmp/officecli-456.html' });

    const { container } = render(<HtmlPreview filePath="/tmp/report.docx" />);

    await waitFor(() => {
      const surface = container.querySelector('[data-testid="surface-layer"]');
      expect(surface).not.toBeNull();
      const css = surface?.getAttribute('data-inject-css') ?? '';
      // CSS 应包含 html, body 选择器和 margin/padding 重置
      expect(css).toContain('html');
      expect(css).toContain('margin');
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
