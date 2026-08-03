/**
 * PdfPreview 组件测试。
 *
 * 验证 react-pdf 的 Document / Page 被正确使用，以及
 * 翻页、缩放、加载状态、错误状态等交互行为。
 *
 * jsdom 不支持 canvas，故 react-pdf 的 Document / Page 被 mock 为
 * 简单 div，通过 data-testid 暴露给测试断言。Document 的
 * onLoadSuccess / onLoadError 回调通过 vi.hoisted 暴露给测试手动触发，
 * 避免触碰真实 PDF 解析。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// ── vi.hoisted：mock 状态与回调存储，在 vi.mock 工厂执行前就绪 ──────
const { documentCallbacks } = vi.hoisted(() => ({
  documentCallbacks: {
    onLoadSuccess: null as null | ((pdf: { numPages: number }) => void),
    onLoadError: null as null | ((err: Error) => void),
  },
}));

// ── mock react-pdf：Document 暴露回调，Page 暴露 pageNumber/scale ────
vi.mock('react-pdf', () => ({
  pdfjs: {
    GlobalWorkerOptions: { workerSrc: '' },
    version: '5.4.296',
  },
  Document: function MockDocument(props: Record<string, unknown>) {
    documentCallbacks.onLoadSuccess = props.onLoadSuccess as typeof documentCallbacks.onLoadSuccess;
    documentCallbacks.onLoadError = props.onLoadError as typeof documentCallbacks.onLoadError;
    return (
      <div data-testid="pdf-document" data-file={String(props.file ?? '')}>
        {props.children as React.ReactNode}
      </div>
    );
  },
  Page: function MockPage(props: Record<string, unknown>) {
    return (
      <div
        data-testid="pdf-page"
        data-page-number={String(props.pageNumber ?? '')}
        data-scale={String(props.scale ?? '')}
      />
    );
  },
}));

import { PdfPreview } from '@renderer/components/office/PdfPreview';

describe('PdfPreview react-pdf 渲染', () => {
  beforeEach(() => {
    documentCallbacks.onLoadSuccess = null;
    documentCallbacks.onLoadError = null;
  });

  it('初始渲染显示加载状态', () => {
    render(<PdfPreview filePath="/tmp/test.pdf" />);
    expect(screen.getByText(/加载中/)).toBeInTheDocument();
    expect(screen.getByTestId('pdf-document')).toBeInTheDocument();
  });

  it('将 filePath 转换为 file:// URL 传给 Document', () => {
    render(<PdfPreview filePath="/tmp/test.pdf" />);
    expect(screen.getByTestId('pdf-document')).toHaveAttribute(
      'data-file',
      'file:///tmp/test.pdf',
    );
  });

  it('Windows 路径反斜杠转换为正斜杠生成 file:// URL', () => {
    render(<PdfPreview filePath="C:\\Users\\test\\doc.pdf" />);
    expect(screen.getByTestId('pdf-document')).toHaveAttribute(
      'data-file',
      'file:///C:/Users/test/doc.pdf',
    );
  });

  it('加载成功后显示页码 "1 / N"', () => {
    render(<PdfPreview filePath="/tmp/test.pdf" />);
    act(() => {
      documentCallbacks.onLoadSuccess?.({ numPages: 5 });
    });
    expect(screen.getByText(/1\s*\/\s*5/)).toBeInTheDocument();
  });

  it('加载成功后隐藏加载状态', () => {
    render(<PdfPreview filePath="/tmp/test.pdf" />);
    act(() => {
      documentCallbacks.onLoadSuccess?.({ numPages: 3 });
    });
    expect(screen.queryByText(/加载中/)).not.toBeInTheDocument();
  });

  it('点击下一页按钮翻到第 2 页', () => {
    render(<PdfPreview filePath="/tmp/test.pdf" />);
    act(() => {
      documentCallbacks.onLoadSuccess?.({ numPages: 5 });
    });
    fireEvent.click(screen.getByRole('button', { name: /下一页/ }));
    expect(screen.getByTestId('pdf-page')).toHaveAttribute('data-page-number', '2');
    expect(screen.getByText(/2\s*\/\s*5/)).toBeInTheDocument();
  });

  it('点击上一页按钮回到第 1 页', () => {
    render(<PdfPreview filePath="/tmp/test.pdf" />);
    act(() => {
      documentCallbacks.onLoadSuccess?.({ numPages: 5 });
    });
    fireEvent.click(screen.getByRole('button', { name: /下一页/ }));
    fireEvent.click(screen.getByRole('button', { name: /上一页/ }));
    expect(screen.getByTestId('pdf-page')).toHaveAttribute('data-page-number', '1');
  });

  it('第一页时上一页按钮禁用', () => {
    render(<PdfPreview filePath="/tmp/test.pdf" />);
    act(() => {
      documentCallbacks.onLoadSuccess?.({ numPages: 5 });
    });
    expect(screen.getByRole('button', { name: /上一页/ })).toBeDisabled();
  });

  it('最后一页时下一页按钮禁用', () => {
    render(<PdfPreview filePath="/tmp/test.pdf" />);
    act(() => {
      documentCallbacks.onLoadSuccess?.({ numPages: 3 });
    });
    fireEvent.click(screen.getByRole('button', { name: /下一页/ }));
    fireEvent.click(screen.getByRole('button', { name: /下一页/ }));
    expect(screen.getByRole('button', { name: /下一页/ })).toBeDisabled();
  });

  it('点击放大按钮增加缩放比例', () => {
    render(<PdfPreview filePath="/tmp/test.pdf" />);
    act(() => {
      documentCallbacks.onLoadSuccess?.({ numPages: 5 });
    });
    const initialScale = Number(screen.getByTestId('pdf-page').getAttribute('data-scale'));
    fireEvent.click(screen.getByRole('button', { name: /放大/ }));
    const newScale = Number(screen.getByTestId('pdf-page').getAttribute('data-scale'));
    expect(newScale).toBeGreaterThan(initialScale);
  });

  it('点击缩小按钮降低缩放比例', () => {
    render(<PdfPreview filePath="/tmp/test.pdf" />);
    act(() => {
      documentCallbacks.onLoadSuccess?.({ numPages: 5 });
    });
    const initialScale = Number(screen.getByTestId('pdf-page').getAttribute('data-scale'));
    fireEvent.click(screen.getByRole('button', { name: /缩小/ }));
    const newScale = Number(screen.getByTestId('pdf-page').getAttribute('data-scale'));
    expect(newScale).toBeLessThan(initialScale);
  });

  it('点击适应宽度按钮重置缩放比例为 1', () => {
    render(<PdfPreview filePath="/tmp/test.pdf" />);
    act(() => {
      documentCallbacks.onLoadSuccess?.({ numPages: 5 });
    });
    // 先放大两次
    fireEvent.click(screen.getByRole('button', { name: /放大/ }));
    fireEvent.click(screen.getByRole('button', { name: /放大/ }));
    // 点击适应宽度重置
    fireEvent.click(screen.getByRole('button', { name: /适应宽度/ }));
    expect(Number(screen.getByTestId('pdf-page').getAttribute('data-scale'))).toBe(1);
  });

  it('加载失败时显示错误提示与错误信息', () => {
    render(<PdfPreview filePath="/tmp/test.pdf" />);
    act(() => {
      documentCallbacks.onLoadError?.(new Error('PDF 解析失败'));
    });
    expect(screen.getByText(/加载失败/)).toBeInTheDocument();
    expect(screen.getByText(/PDF 解析失败/)).toBeInTheDocument();
  });

  it('Page 组件接收当前页码与缩放比例', () => {
    render(<PdfPreview filePath="/tmp/test.pdf" />);
    act(() => {
      documentCallbacks.onLoadSuccess?.({ numPages: 5 });
    });
    expect(screen.getByTestId('pdf-page')).toHaveAttribute('data-page-number', '1');
    expect(screen.getByTestId('pdf-page')).toHaveAttribute('data-scale', '1');
  });
});
