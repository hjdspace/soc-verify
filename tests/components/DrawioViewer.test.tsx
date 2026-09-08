// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadDrawioViewerMock, createViewerForElementMock, viewerMock, toolbar, graphContainer } = vi.hoisted(() => {
  const toolbar = document.createElement('div');
  const graphContainer = document.createElement('div');
  return {
    loadDrawioViewerMock: vi.fn(),
    createViewerForElementMock: vi.fn(),
    viewerMock: {
      graph: {
        container: graphContainer,
        setPanning: vi.fn(),
        zoom: vi.fn(),
        resizeContainer: true,
        centerZoom: false,
      },
      destroy: vi.fn(),
      showLocalLightbox: vi.fn(() => ({ chromelessToolbar: toolbar })),
    },
    toolbar,
    graphContainer,
  };
});

const graphZoom = viewerMock.graph.zoom;

vi.mock('@renderer/components/drawio/load-drawio-viewer', () => ({
  loadDrawioViewer: loadDrawioViewerMock,
}));

import { DrawioViewer } from '@renderer/components/drawio/DrawioViewer';

describe('DrawioViewer interaction layout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toolbar.className = '';
    // reset mutable graph flags between tests
    viewerMock.graph.resizeContainer = true;
    viewerMock.graph.centerZoom = false;
    graphContainer.style.overflow = '';
    loadDrawioViewerMock.mockResolvedValue({
      createViewerForElement: createViewerForElementMock,
    });
    createViewerForElementMock.mockImplementation((_: HTMLElement, callback?: (viewer: typeof viewerMock) => void) => {
      callback?.(viewerMock);
    });
  });

  it('keeps the embedded viewer inside its host and shows grab feedback while dragging', async () => {
    const { container } = render(<DrawioViewer xml="<mxfile />" onError={vi.fn()} />);
    const root = container.firstElementChild as HTMLElement;

    await waitFor(() => expect(createViewerForElementMock).toHaveBeenCalled());

    expect(root).toHaveClass('overflow-hidden', 'cursor-grab');
    expect(graphContainer.style.cursor).toBe('grab');
    fireEvent.mouseDown(root);
    await waitFor(() => {
      expect(root).toHaveClass('cursor-grabbing');
      expect(graphContainer.style.cursor).toBe('grabbing');
    });
    fireEvent.mouseUp(root);
    await waitFor(() => {
      expect(root).toHaveClass('cursor-grab');
      expect(graphContainer.style.cursor).toBe('grab');
    });
  });

  it('marks the lightbox toolbar for horizontal layout', async () => {
    const { container } = render(<DrawioViewer xml="<mxfile />" onError={vi.fn()} />);
    const root = container.firstElementChild as HTMLElement;
    await waitFor(() => expect(createViewerForElementMock).toHaveBeenCalled());

    fireEvent.contextMenu(root, { clientX: 24, clientY: 32 });
    fireEvent.click(screen.getByRole('button', { name: '打开放大图' }));

    expect(toolbar).toHaveClass('drawio-lightbox-toolbar');
    expect(viewerMock.showLocalLightbox).toHaveBeenCalledOnce();
  });

  describe('panning scroll setup', () => {
    it('disables resizeContainer and clears inline height for vertical panning', async () => {
      // viewer 初始化时可能已设置了 inline height（doResizeContainer）
      graphContainer.style.height = '800px';
      render(<DrawioViewer xml="<mxfile />" onError={vi.fn()} />);

      await waitFor(() => expect(createViewerForElementMock).toHaveBeenCalled());

      // resizeContainer 被禁用，防止后续 sizeDidChange 撑开容器
      expect(viewerMock.graph.resizeContainer).toBe(false);
      // inline height 被清除，让 CSS height:100% 生效
      expect(graphContainer.style.height).toBe('');
      // overflow 设为 auto，使 panning 通过 scrollLeft/scrollTop 实现
      expect(graphContainer.style.overflow).toBe('auto');
    });

    it('anchors zoom at the viewport center (centerZoom)', async () => {
      render(<DrawioViewer xml="<mxfile />" onError={vi.fn()} />);
      await waitFor(() => expect(createViewerForElementMock).toHaveBeenCalled());

      // viewer-static.min.js 初始化时硬编码 centerZoom=false，需改回 true
      // 否则缩放锚定画布原点，缩放往返后中心漂移
      expect(viewerMock.graph.centerZoom).toBe(true);
    });

    it('restores overflow=auto when the viewer size handler resets it to hidden', async () => {
      const { unmount } = render(<DrawioViewer xml="<mxfile />" onError={vi.fn()} />);
      await waitFor(() => expect(createViewerForElementMock).toHaveBeenCalled());

      // 模拟 viewer size handler：内容尺寸变化时把 overflow 重置为 hidden
      //（MutationObserver 守卫应将其钳回 auto）
      graphContainer.style.overflow = 'hidden';
      await waitFor(() => expect(graphContainer.style.overflow).toBe('auto'));

      // 普通的 overflow 写入不会被钳（守卫只在偏离 auto 时纠正）
      graphContainer.style.overflow = 'auto';
      await expect(waitFor(() => expect(graphContainer.style.overflow).toBe('auto'))).resolves.toBeDefined();

      unmount();
      // 卸载后守卫应停止工作：size handler 再次写入 hidden 不再被纠正
      graphContainer.style.overflow = 'hidden';
      expect(graphContainer.style.overflow).toBe('hidden');
    });
  });

  describe('middle-button drag zoom', () => {
    it('zooms in when the middle button is dragged upward', async () => {
      const { container } = render(<DrawioViewer xml="<mxfile />" onError={vi.fn()} />);
      const root = container.firstElementChild as HTMLElement;
      await waitFor(() => expect(createViewerForElementMock).toHaveBeenCalled());

      // 中键按下于 clientY=100
      fireEvent.mouseDown(root, { button: 1, clientY: 100 });
      await waitFor(() => {
        expect(root).toHaveClass('cursor-ns-resize');
        expect(graphContainer.style.cursor).toBe('ns-resize');
      });

      // 上移 16px（>阈值 8 两次）应触发两次放大
      fireEvent.mouseMove(window, { clientY: 84 });

      expect(graphZoom).toHaveBeenCalledTimes(2);
      // 放大传入 factor > 1
      for (const call of graphZoom.mock.calls) {
        expect(call[0]).toBeGreaterThan(1);
      }
    });

    it('zooms out when the middle button is dragged downward', async () => {
      const { container } = render(<DrawioViewer xml="<mxfile />" onError={vi.fn()} />);
      const root = container.firstElementChild as HTMLElement;
      await waitFor(() => expect(createViewerForElementMock).toHaveBeenCalled());

      fireEvent.mouseDown(root, { button: 1, clientY: 50 });
      await waitFor(() => expect(root).toHaveClass('cursor-ns-resize'));
      // 下移 10px（>阈值 8 一次）应触发一次缩小
      fireEvent.mouseMove(window, { clientY: 60 });

      expect(graphZoom).toHaveBeenCalledTimes(1);
      // 缩小传入 factor < 1
      expect(graphZoom.mock.calls[0]?.[0]).toBeLessThan(1);
    });

    it('does not zoom when movement is below threshold', async () => {
      const { container } = render(<DrawioViewer xml="<mxfile />" onError={vi.fn()} />);
      const root = container.firstElementChild as HTMLElement;
      await waitFor(() => expect(createViewerForElementMock).toHaveBeenCalled());

      fireEvent.mouseDown(root, { button: 1, clientY: 100 });
      await waitFor(() => expect(root).toHaveClass('cursor-ns-resize'));
      // 仅移动 5px（<阈值 8）不应触发 zoom
      fireEvent.mouseMove(window, { clientY: 95 });

      expect(graphZoom).not.toHaveBeenCalled();
    });

    it('stops zooming on mouseup and restores grab cursor', async () => {
      const { container } = render(<DrawioViewer xml="<mxfile />" onError={vi.fn()} />);
      const root = container.firstElementChild as HTMLElement;
      await waitFor(() => expect(createViewerForElementMock).toHaveBeenCalled());

      fireEvent.mouseDown(root, { button: 1, clientY: 100 });
      await waitFor(() => expect(root).toHaveClass('cursor-ns-resize'));

      fireEvent.mouseUp(window);
      await waitFor(() => {
        expect(root).toHaveClass('cursor-grab');
      });

      graphZoom.mockClear();
      // 抬起后再移动不应再触发 zoom
      fireEvent.mouseMove(window, { clientY: 50 });
      expect(graphZoom).not.toHaveBeenCalled();
    });

    it('does not start zoom-drag on left button', async () => {
      const { container } = render(<DrawioViewer xml="<mxfile />" onError={vi.fn()} />);
      const root = container.firstElementChild as HTMLElement;
      await waitFor(() => expect(createViewerForElementMock).toHaveBeenCalled());

      // 左键按下不应触发中键缩放状态
      fireEvent.mouseDown(root, { button: 0, clientY: 100 });
      await waitFor(() => expect(root).toHaveClass('cursor-grabbing'));
      expect(root).not.toHaveClass('cursor-ns-resize');

      fireEvent.mouseMove(window, { clientY: 80 });
      expect(graphZoom).not.toHaveBeenCalled();
    });
  });
});
