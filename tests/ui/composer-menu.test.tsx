// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { RefObject } from 'react';
import { ComposerMenu } from '@renderer/components/layout/ComposerMenu';

/**
 * ComposerMenu 水平夹紧：锚定按钮的弹层（w-72 模型菜单等）在窄面板下
 * 右缘会越过窗口边框——右缘必须夹紧到 composer 边界内。
 * jsdom 无布局，用 mock 的 getBoundingClientRect / offsetParent 模拟几何。
 */

const zeroRect = (): DOMRect =>
  ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 } as DOMRect);
const rect = (left: number, width: number): DOMRect =>
  ({ ...zeroRect(), left, right: left + width, width } as DOMRect);

/** 渲染菜单：wrapper 是 340px composer 内偏移 140px 的按钮包裹层，菜单自身宽 menuWidth */
function renderMenu(opts: { composerWidth: number; menuWidth: number }) {
  const boundary = document.createElement('div');
  const wrapper = document.createElement('div');
  document.body.append(wrapper);

  const gbrSpy = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('ap-menu')) return rect(140, opts.menuWidth);
      if (this === boundary) return rect(0, opts.composerWidth);
      if (this === wrapper) return rect(140, 24);
      return zeroRect();
    });
  const originalOffsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() {
      return wrapper;
    },
  });

  const clampTo = { current: boundary } as unknown as RefObject<HTMLElement | null>;
  const { container } = render(
    <ComposerMenu className="left-0" origin="left" clampTo={clampTo}>
      <button type="button" className="ap-menu-row">
        <span className="ap-menu-row-title">模型</span>
      </button>
    </ComposerMenu>,
    { container: wrapper },
  );
  const menu = container.querySelector<HTMLElement>('.ap-menu');
  expect(menu).not.toBeNull();

  return {
    menu: menu!,
    restore: () => {
      gbrSpy.mockRestore();
      if (originalOffsetParent) Object.defineProperty(HTMLElement.prototype, 'offsetParent', originalOffsetParent);
      wrapper.remove();
    },
  };
}

describe('ComposerMenu 水平夹紧', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('弹层右缘超出 composer 时左移，夹到边界内', () => {
    const { menu, restore } = renderMenu({ composerWidth: 340, menuWidth: 288 });
    // maxLeft = 340 - 140 - 288 = -88 → 整体左移 88px，右缘与 composer 右缘对齐
    expect(menu.style.left).toBe('-88px');
    restore();
  });

  it('弹层在 composer 范围内时不夹紧（保持 left-0）', () => {
    const { menu, restore } = renderMenu({ composerWidth: 600, menuWidth: 288 });
    // maxLeft = 600 - 140 - 288 = 172 > 0 → 不偏移
    expect(menu.style.left).toBe('0px');
    restore();
  });
});
