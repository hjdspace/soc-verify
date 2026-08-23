// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { initializeMock, renderMock } = vi.hoisted(() => ({
  initializeMock: vi.fn((config: { themeVariables?: Record<string, unknown> }) => {
    const unsupported = Object.values(config.themeVariables ?? {})
      .find((value) => typeof value === 'string' && value.startsWith('oklch('));
    if (unsupported) throw new Error(`Unsupported color format: "${unsupported}"`);
  }),
  renderMock: vi.fn().mockResolvedValue({ svg: '<svg></svg>' }),
}));

vi.mock('mermaid', () => ({
  default: {
    initialize: initializeMock,
    render: renderMock,
  },
}));

vi.mock('@renderer/stores/theme', () => ({
  useThemeStore: (selector: (state: {
    currentTheme: string;
    themes: Array<{ id: string; mode: 'light' | 'dark' }>;
  }) => unknown) => selector({
    currentTheme: 'bench',
    themes: [{ id: 'bench', mode: 'dark' }],
  }),
}));

import { MermaidDiagram } from '@renderer/components/chat/MermaidDiagram';

const canvasContext = {
  fillStyle: '#000000',
  clearRect: vi.fn(),
  fillRect: vi.fn(),
  getImageData: vi.fn(() => ({
    data: new Uint8ClampedArray([51, 65, 85, 255]),
  })),
};

describe('MermaidDiagram', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canvasContext.fillStyle = '#000000';
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(canvasContext as unknown as CanvasRenderingContext2D);
    for (const name of [
      '--secondary',
      '--foreground',
      '--border',
      '--muted-foreground',
      '--muted',
      '--card',
    ]) {
      document.documentElement.style.setProperty(name, 'oklch(0.25 0.008 60)');
    }
  });

  it('converts oklch theme variables before initializing Mermaid', async () => {
    const { container } = render(<MermaidDiagram code="flowchart LR\nA --> B" />);

    await waitFor(() => {
      expect(container.querySelector('.mermaid-preview-svg')).not.toBeNull();
    });

    expect(screen.queryByText('Mermaid 渲染失败')).not.toBeInTheDocument();
    expect(initializeMock).toHaveBeenCalledWith(expect.objectContaining({
      suppressErrorRendering: true,
      themeVariables: expect.objectContaining({
        primaryColor: '#334155',
        primaryTextColor: '#334155',
        primaryBorderColor: '#334155',
        lineColor: '#334155',
        secondaryColor: '#334155',
        tertiaryColor: '#334155',
      }),
    }));
    expect(renderMock).toHaveBeenCalledOnce();
  });
});
