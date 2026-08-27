// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Backdrop } from '@renderer/components/layout/Backdrop';
import { Drawer } from '@renderer/components/layout/Drawer';
import { StatusBar } from '@renderer/components/layout/StatusBar';
import {
  DRAWER_LEFT_OFFSET,
  NAV_RAIL_WIDTH,
  STATUS_BAR_HEIGHT,
  TITLE_BAR_HEIGHT,
} from '@renderer/components/layout/layout-constants';
import type { TerminalTab } from '@renderer/stores/terminal';

/* ── StatusBar 数据面 mock（Issue #8：终端开关迁入后依赖
 * project / terminal store，二者模块级引入真实 trpc client，
 * jsdom 无 electronTRPC 全局）────────────────────────────── */
const stores = vi.hoisted(() => ({
  proj: { currentProjectId: null as string | null },
  term: {
    tabs: [] as TerminalTab[],
    createTerminal: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@renderer/stores/project', () => ({
  useProjectStore: (selector: (s: typeof stores.proj) => unknown) => selector(stores.proj),
}));

vi.mock('@renderer/stores/terminal', () => ({
  useTerminalStore: (selector: (s: typeof stores.term) => unknown) => selector(stores.term),
}));

/* ── 几何断言基建 ──────────────────────────────────────────────
 * jsdom 不做真实布局（getBoundingClientRect 恒为 0）。
 * 此处依据组件 inline style（left/top/right/bottom/width/transform）
 * 在 1280×800 视口下推算矩形，使「离屏 / 遮挡」类几何断言可测。 */
const VIEWPORT_W = 1280;
const VIEWPORT_H = 800;

function rectFromInlineStyle(el: HTMLElement): DOMRect {
  const s = el.style;
  const num = (v: string): number | null => (v ? parseFloat(v) : null);
  const w = num(s.width);
  const h = num(s.height);
  let left = num(s.left);
  const right = num(s.right);
  let top = num(s.top);
  const bottom = num(s.bottom);
  if (left === null && right !== null) left = VIEWPORT_W - right - (w ?? 0);
  if (top === null && bottom !== null) top = VIEWPORT_H - bottom - (h ?? 0);
  const width = w ?? (left !== null && right !== null ? VIEWPORT_W - left - right : 0);
  const height = h ?? (top !== null && bottom !== null ? VIEWPORT_H - top - bottom : 0);
  const m = /translateX\((-?[\d.]+)px\)/.exec(s.transform);
  const dx = m ? Number(m[1]) : 0;
  const x = (left ?? 0) + dx;
  const y = top ?? 0;
  return {
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  } as DOMRect;
}

let rectSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
  rectSpy = vi
    .spyOn(Element.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: Element) {
      return rectFromInlineStyle(this as HTMLElement);
    });
});

afterEach(() => {
  rectSpy?.mockRestore();
  vi.useRealTimers();
});

/**
 * 抽屉常驻挂载（保证动画），关闭态为 inert（可访问性树排除），
 * getByRole 查不到，几何断言统一走 data-testid。
 */
const queryDrawer = (side: 'left' | 'right') => screen.getByTestId(`drawer-${side}`);

/** 从 inline transform 解析 translateX 位移绝对值（px） */
const translateXOf = (el: HTMLElement) =>
  Math.abs(Number(/translateX\((-?[\d.]+)px\)/.exec(el.style.transform)?.[1] ?? 0));

describe('Drawer', () => {
  it('打开时 transform 归零，面板位于导航栏右侧、状态栏之上', () => {
    render(
      <Drawer side="left" open onClose={() => {}} title="文件">
        <div>文件树内容</div>
      </Drawer>,
    );
    const drawer = screen.getByRole('dialog', { name: '文件' });
    expect(drawer.style.transform).toBe('translateX(0)');
    expect(screen.getByText('文件树内容')).toBeInTheDocument();

    const rect = drawer.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(NAV_RAIL_WIDTH);
    expect(rect.top).toBe(TITLE_BAR_HEIGHT);
    expect(rect.bottom).toBeLessThanOrEqual(VIEWPORT_H - STATUS_BAR_HEIGHT);
  });

  it('关闭态完全离屏：位移 ≥ left + width，矩形不进入导航栏区域（原型 §2.1-1 回归防线）', () => {
    render(
      <Drawer side="left" open={false} onClose={() => {}} title="文件">
        <div>文件树内容</div>
      </Drawer>,
    );
    const drawer = queryDrawer('left');
    // 原型踩坑值：left(68) + 宽(330) = 398，位移取 400（含余量）才完全离屏
    expect(drawer.style.transform).toBe('translateX(-400px)');
    expect(translateXOf(drawer)).toBeGreaterThanOrEqual(DRAWER_LEFT_OFFSET + 330);
    const rect = drawer.getBoundingClientRect();
    // 导航栏区域 x ∈ [0, 61]，关闭态抽屉右缘必须 ≤ 0（完全离屏、不拦截导航栏点击）
    expect(rect.right).toBeLessThanOrEqual(0);
  });

  it('自定义宽度时关闭位移随之放大，同样完全离屏', () => {
    render(
      <Drawer side="left" open={false} onClose={() => {}} title="文件" width={420}>
        <div />
      </Drawer>,
    );
    const drawer = queryDrawer('left');
    // 位移不变式：≥ left + width（68 + 420 = 488）
    expect(translateXOf(drawer)).toBeGreaterThanOrEqual(DRAWER_LEFT_OFFSET + 420);
    expect(drawer.getBoundingClientRect().right).toBeLessThanOrEqual(0);
  });

  it('右侧抽屉关闭态完全离屏（左缘 ≥ 视口右缘）', () => {
    render(
      <Drawer side="right" open={false} onClose={() => {}} title="AI 助手" width={360}>
        <div />
      </Drawer>,
    );
    const drawer = queryDrawer('right');
    expect(translateXOf(drawer)).toBeGreaterThanOrEqual(360);
    expect(drawer.getBoundingClientRect().left).toBeGreaterThanOrEqual(VIEWPORT_W);
  });

  it('Esc 关闭：仅打开时响应', () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Drawer side="left" open onClose={onClose} title="文件">
        <div />
      </Drawer>,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <Drawer side="left" open={false} onClose={onClose} title="文件">
        <div />
      </Drawer>,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('头部关闭按钮触发 onClose', () => {
    const onClose = vi.fn();
    render(
      <Drawer side="left" open onClose={onClose} title="文件">
        <div />
      </Drawer>,
    );
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('开合动画规格：引用动效 token（--duration-drawer / --ease-out，AUDIT.md Category 2）', () => {
    render(
      <Drawer side="left" open onClose={() => {}} title="文件">
        <div />
      </Drawer>,
    );
    const drawer = queryDrawer('left');
    expect(drawer.className).toContain('duration-[var(--duration-drawer)]');
    expect(drawer.className).toContain('ease-[var(--ease-out)]');
    expect(drawer.className).toContain('transition-transform');
  });
});

describe('Backdrop', () => {
  it('只遮内容区：矩形避开 TitleBar / 导航栏 / 状态栏（原型 §2.1-2）', () => {
    render(<Backdrop open onClose={() => {}} />);
    const rect = screen.getByTestId('app-backdrop').getBoundingClientRect();
    expect(rect.left).toBe(NAV_RAIL_WIDTH);
    expect(rect.top).toBe(TITLE_BAR_HEIGHT);
    expect(rect.right).toBeLessThanOrEqual(VIEWPORT_W);
    expect(rect.bottom).toBeLessThanOrEqual(VIEWPORT_H - STATUS_BAR_HEIGHT);
  });

  it('打开时点击触发 onClose；关闭态不拦截指针（pointer-events-none）', () => {
    const onClose = vi.fn();
    const { rerender } = render(<Backdrop open onClose={onClose} />);
    const backdrop = screen.getByTestId('app-backdrop');
    expect(backdrop.className).toContain('pointer-events-auto');
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(<Backdrop open={false} onClose={onClose} />);
    expect(backdrop.className).toContain('pointer-events-none');
    expect(backdrop.className).toContain('opacity-0');
  });

  it('z-index 刻度：backdrop 40 / drawer 50', () => {
    render(
      <>
        <Backdrop open onClose={() => {}} />
        <Drawer side="left" open onClose={() => {}} title="文件">
          <div />
        </Drawer>
      </>,
    );
    expect(screen.getByTestId('app-backdrop').className).toContain('z-40');
    expect(queryDrawer('left').className).toContain('z-50');
  });
});

describe('Drawer + Backdrop 组合', () => {
  it('backdrop 点击关闭后，抽屉滑回完全离屏', () => {
    function Demo() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>打开抽屉</button>
          <Backdrop open={open} onClose={() => setOpen(false)} />
          <Drawer side="left" open={open} onClose={() => setOpen(false)} title="文件">
            <div>内容</div>
          </Drawer>
        </>
      );
    }
    render(<Demo />);
    fireEvent.click(screen.getByText('打开抽屉'));
    const drawer = queryDrawer('left');
    expect(drawer.style.transform).toBe('translateX(0)');

    fireEvent.click(screen.getByTestId('app-backdrop'));
    expect(drawer.style.transform).toBe('translateX(-400px)');
    expect(drawer.getBoundingClientRect().right).toBeLessThanOrEqual(0);
  });
});

describe('StatusBar', () => {
  it('渲染静态段：omp 连接状态与引擎版本', () => {
    render(<StatusBar />);
    expect(screen.getByText('omp 已连接')).toBeInTheDocument();
    expect(screen.getByText('引擎 v4.1.2')).toBeInTheDocument();
  });

  it('时钟每秒刷新，卸载时清理定时器', () => {
    vi.useFakeTimers();
    const { unmount } = render(<StatusBar />);
    const clock = screen.getByTestId('statusbar-clock');
    expect(vi.getTimerCount()).toBe(1);

    const initial = clock.textContent;
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(clock.textContent).not.toBe(initial);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
