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
      graph: { container: graphContainer, setPanning: vi.fn(), zoom: vi.fn() },
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
