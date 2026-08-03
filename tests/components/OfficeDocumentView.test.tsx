/**
 * OfficeDocumentView 容器组件测试。
 *
 * 验证容器根据 destination 的 mode / previewMode / 文件扩展名分发到对应子组件，
 * 以及 officecli 不可用时的降级提示和预览模式切换栏的可见性。
 *
 * 子组件（HtmlPreview / ScreenshotsPreview / WatchPreview）通过 vi.mock 替换为
 * 仅暴露 data-testid 的占位组件，避免触碰真实的 webview / tRPC 调用。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ── mock 子组件：用 data-testid 标识被渲染的子组件 ─────────────────────
vi.mock('@renderer/components/office/HtmlPreview', () => ({
  HtmlPreview: ({ filePath }: { filePath: string }) => (
    <div data-testid="html-preview" data-file={filePath}>HtmlPreview</div>
  ),
}));

vi.mock('@renderer/components/office/ScreenshotsPreview', () => ({
  ScreenshotsPreview: ({ filePath }: { filePath: string }) => (
    <div data-testid="screenshots-preview" data-file={filePath}>ScreenshotsPreview</div>
  ),
}));

vi.mock('@renderer/components/office/WatchPreview', () => ({
  WatchPreview: ({ filePath }: { filePath: string }) => (
    <div data-testid="watch-preview" data-file={filePath}>WatchPreview</div>
  ),
}));

vi.mock('@renderer/components/office/PdfPreview', () => ({
  PdfPreview: ({ filePath }: { filePath: string }) => (
    <div data-testid="pdf-preview" data-file={filePath}>PdfPreview</div>
  ),
}));

vi.mock('@renderer/components/office/XlsxEditor', () => ({
  XlsxEditor: ({ filePath }: { filePath: string }) => (
    <div data-testid="xlsx-editor" data-file={filePath}>XlsxEditor</div>
  ),
}));

// ── mock tRPC：仅 mock document.checkInstalled，其余 procedure 由子组件测试覆盖 ──
// vi.mock 工厂会被提升到文件顶部，需用 vi.hoisted 让 mock 引用先于工厂执行时定义
const { checkInstalledMock } = vi.hoisted(() => ({
  checkInstalledMock: vi.fn(),
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    document: {
      checkInstalled: { query: checkInstalledMock },
    },
  },
}));

import { OfficeDocumentView } from '@renderer/components/office/OfficeDocumentView';

describe('OfficeDocumentView 容器分发', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 默认 officecli 可用
    checkInstalledMock.mockResolvedValue({ installed: true });
  });

  it('在 preview 模式下默认 html 预览时渲染 HtmlPreview', async () => {
    render(
      <OfficeDocumentView
        filePath="/tmp/report.docx"
        mode="preview"
        previewMode="html"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('html-preview')).toBeInTheDocument();
    });
    expect(screen.getByTestId('html-preview')).toHaveAttribute('data-file', '/tmp/report.docx');
  });

  it('previewMode=screenshots 时渲染 ScreenshotsPreview', async () => {
    render(
      <OfficeDocumentView
        filePath="/tmp/report.docx"
        mode="preview"
        previewMode="screenshots"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('screenshots-preview')).toBeInTheDocument();
    });
  });

  it('previewMode=watch 时渲染 WatchPreview', async () => {
    render(
      <OfficeDocumentView
        filePath="/tmp/report.docx"
        mode="preview"
        previewMode="watch"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('watch-preview')).toBeInTheDocument();
    });
  });

  it('edit 模式下渲染 XlsxEditor（.xlsx）', async () => {
    render(
      <OfficeDocumentView
        filePath="/tmp/sheet.xlsx"
        mode="edit"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('xlsx-editor')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('html-preview')).not.toBeInTheDocument();
  });

  it('PDF 文件渲染 PdfPreview', async () => {
    render(
      <OfficeDocumentView
        filePath="/tmp/doc.pdf"
        mode="preview"
        previewMode="html"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('pdf-preview')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('html-preview')).not.toBeInTheDocument();
  });

  it('.docx 文件显示预览模式切换栏（HTML/Screenshots/Watch）', async () => {
    render(
      <OfficeDocumentView
        filePath="/tmp/report.docx"
        mode="preview"
        previewMode="html"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('html-preview')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'HTML' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Screenshots' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Watch' })).toBeInTheDocument();
  });

  it('PDF 文件不显示预览模式切换栏', async () => {
    render(
      <OfficeDocumentView
        filePath="/tmp/doc.pdf"
        mode="preview"
        previewMode="html"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('pdf-preview')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'HTML' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Watch' })).not.toBeInTheDocument();
  });

  it('officecli 不可用时 PDF 仍直接渲染 PdfPreview', async () => {
    checkInstalledMock.mockResolvedValue({ installed: false });

    render(
      <OfficeDocumentView
        filePath="/tmp/doc.pdf"
        mode="preview"
        previewMode="html"
      />,
    );

    expect(screen.getByTestId('pdf-preview')).toBeInTheDocument();
    expect(checkInstalledMock).not.toHaveBeenCalled();
  });

  it('officecli 不可用时 XLSX 编辑器仍直接渲染', async () => {
    checkInstalledMock.mockResolvedValue({ installed: false });

    render(
      <OfficeDocumentView
        filePath="/tmp/sheet.xlsx"
        mode="edit"
      />,
    );

    expect(screen.getByTestId('xlsx-editor')).toBeInTheDocument();
    expect(checkInstalledMock).not.toHaveBeenCalled();
  });

  it('点击切换栏按钮切换预览模式', async () => {
    render(
      <OfficeDocumentView
        filePath="/tmp/report.docx"
        mode="preview"
        previewMode="html"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('html-preview')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Watch' }));

    await waitFor(() => {
      expect(screen.getByTestId('watch-preview')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('html-preview')).not.toBeInTheDocument();
  });

  it('officecli 不可用时显示未安装提示', async () => {
    checkInstalledMock.mockResolvedValue({ installed: false });

    render(
      <OfficeDocumentView
        filePath="/tmp/report.docx"
        mode="preview"
        previewMode="html"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/officecli 未安装/)).toBeInTheDocument();
    });
    expect(screen.queryByTestId('html-preview')).not.toBeInTheDocument();
  });
});
