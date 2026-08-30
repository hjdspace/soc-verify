// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { GlideMenu } from '@renderer/components/ui/GlideMenu';

/**
 * GlideMenu 滑动高亮：自驱动（hover/focus 测量行位置）与受控
 * （activeIndex 键盘索引）两种驱动方式。jsdom 无布局，用 mock 的
 * getBoundingClientRect / offsetTop 模拟行几何。
 */

const zeroRect = (): DOMRect =>
  ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 } as DOMRect);
const rect = (top: number, height: number): DOMRect =>
  ({ ...zeroRect(), top, bottom: top + height, height } as DOMRect);

/** 行文本 → 内容系 top（36px 行高） */
const ROW_TOP: Record<string, number> = { A: 0, B: 36, C: 72 };

function installLayoutMocks() {
  const gbrSpy = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('glide-root')) return rect(0, 108);
      if (this.dataset.menuRow !== undefined) return rect(ROW_TOP[this.textContent ?? ''] ?? 0, 36);
      return zeroRect();
    });
  // 受控路径读 offsetTop/offsetHeight（内容系坐标）；jsdom 恒为 0，按行 mock
  Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get(this: HTMLElement) {
      return ROW_TOP[this.textContent ?? ''] ?? 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return 36;
    },
  });
  return () => {
    gbrSpy.mockRestore();
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetTop;
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
  };
}

function renderRows(ui: React.ReactElement) {
  const { container, rerender } = render(ui);
  const highlight = container.querySelector<HTMLElement>('.ap-menu-highlight');
  expect(highlight).not.toBeNull();
  return { container, rerender, highlight: highlight! };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('GlideMenu 自驱动（hover/focus 测量）', () => {
  it('hover 行时高亮层移动到该行位置并可见', () => {
    const restore = installLayoutMocks();
    try {
      const { container, highlight } = renderRows(
        <GlideMenu className="glide-root">
          <button type="button" data-menu-row>
            A
          </button>
          <button type="button" data-menu-row>
            B
          </button>
        </GlideMenu>,
      );
      const rowB = container.querySelectorAll<HTMLElement>('[data-menu-row]')[1];
      fireEvent.mouseOver(rowB);
      expect(highlight.style.top).toBe('36px');
      expect(highlight.style.height).toBe('36px');
      expect(highlight.style.opacity).toBe('1');
    } finally {
      restore();
    }
  });

  it('行间移动时 top 跟随目标行，离开容器后隐藏', () => {
    const restore = installLayoutMocks();
    try {
      const { container, highlight } = renderRows(
        <GlideMenu className="glide-root">
          <button type="button" data-menu-row>
            A
          </button>
          <button type="button" data-menu-row>
            B
          </button>
        </GlideMenu>,
      );
      const rows = container.querySelectorAll<HTMLElement>('[data-menu-row]');
      fireEvent.mouseOver(rows[0]);
      expect(highlight.style.top).toBe('0px');
      fireEvent.mouseOver(rows[1]);
      expect(highlight.style.top).toBe('36px');
      fireEvent.mouseLeave(container.querySelector('.glide-root')!);
      expect(highlight.style.opacity).toBe('0');
    } finally {
      restore();
    }
  });

  it('onMouseLeave 回调透传（ComposerMenu 的 engaged 状态依赖）', () => {
    const restore = installLayoutMocks();
    try {
      const onLeave = vi.fn();
      const { container } = render(
        <GlideMenu className="glide-root" onMouseLeave={onLeave}>
          <button type="button" data-menu-row>
            A
          </button>
        </GlideMenu>,
      );
      fireEvent.mouseLeave(container.querySelector('.glide-root')!);
      expect(onLeave).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });
});

describe('GlideMenu 受控（activeIndex 键盘索引）', () => {
  it('activeIndex 定位到对应行，null 隐藏高亮', () => {
    const restore = installLayoutMocks();
    try {
      const { highlight, rerender } = renderRows(
        <GlideMenu className="glide-root" activeIndex={1}>
          <button type="button" data-menu-row>
            A
          </button>
          <button type="button" data-menu-row>
            B
          </button>
        </GlideMenu>,
      );
      expect(highlight.style.top).toBe('36px');
      expect(highlight.style.opacity).toBe('1');
      rerender(
        <GlideMenu className="glide-root" activeIndex={null}>
          <button type="button" data-menu-row>
            A
          </button>
          <button type="button" data-menu-row>
            B
          </button>
        </GlideMenu>,
      );
      expect(highlight.style.opacity).toBe('0');
    } finally {
      restore();
    }
  });

  it('scrollActiveIntoView 时键盘定位行滚动进可视区', () => {
    const restore = installLayoutMocks();
    const scrollSpy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollSpy;
    try {
      const { highlight } = renderRows(
        <GlideMenu className="glide-root" activeIndex={2} scrollActiveIntoView>
          <button type="button" data-menu-row>
            A
          </button>
          <button type="button" data-menu-row>
            B
          </button>
          <button type="button" data-menu-row>
            C
          </button>
        </GlideMenu>,
      );
      expect(highlight.style.top).toBe('72px');
      expect(scrollSpy).toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = original;
      restore();
    }
  });
});

