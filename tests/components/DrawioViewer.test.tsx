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
      graph: { container: graphContainer, setPanning: vi.fn() },
      destroy: vi.fn(),
      showLocalLightbox: vi.fn(() => ({ chromelessToolbar: toolbar })),
    },
    toolbar,
    graphContainer,
  };
});

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
});
