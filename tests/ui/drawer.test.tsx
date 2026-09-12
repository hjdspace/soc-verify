// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Backdrop } from '@renderer/components/layout/Backdrop';
import {
  Drawer,
  projectMomentum,
  shouldCloseOnRelease,
  rubberband,
  resolveDragOffset,
} from '@renderer/components/layout/Drawer';
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

/** 从 inline transform 解析 translateX 位移绝对值（px）；motion 归零位为 none */
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
    // motion 到位后写 transform: none（= translateX(0) 的单位归零态）
    expect(drawer.style.transform === 'none' || drawer.style.transform === 'translateX(0px)').toBe(true);
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

  it('开合动画规格：欠阻尼弹簧（apple-design §4 drawer damping 0.8/response 0.3 的物理等价）', async () => {
    // rAF polyfill：jsdom 默认 rAF 永不触发，motion 弹簧帧完全不动
    const origRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 16)) as unknown as typeof requestAnimationFrame;
    try {
      function Demo() {
        const [open, setOpen] = useState(false);
        return (
          <>
            <button onClick={() => setOpen((v) => !v)}>toggle</button>
            <Drawer side="left" open={open} onClose={() => setOpen(false)} title="文件">
              <div />
            </Drawer>
          </>
        );
      }
      render(<Demo />);
      const drawer = queryDrawer('left');
      // 关闭位由初始 motion value 直出（不依赖动画帧）
      expect(drawer.style.transform).toBe('translateX(-400px)');

      await act(async () => {
        fireEvent.click(screen.getByText('toggle'));
        await new Promise((r) => setTimeout(r, 700));
      });
      // 弹簧 settle 后归零位（motion 清除单位变换）
      expect(drawer.style.transform).toBe('none');

      await act(async () => {
        fireEvent.click(screen.getByText('toggle'));
        await new Promise((r) => setTimeout(r, 700));
      });
      // 再关：弹簧滑回关闭位
      expect(drawer.style.transform).toBe('translateX(-400px)');
      expect(drawer.getBoundingClientRect().right).toBeLessThanOrEqual(0);
    } finally {
      window.requestAnimationFrame = origRaf;
    }
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
  it('backdrop 点击关闭后，抽屉滑回完全离屏', async () => {
    // rAF polyfill：让关闭弹簧在测试内实际播放
    const origRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 16)) as unknown as typeof requestAnimationFrame;
    try {
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
      // 打开弹簧 settle 后到位（none = translateX(0)）
      await act(async () => {
        await new Promise((r) => setTimeout(r, 700));
      });
      expect(drawer.style.transform === 'none' || drawer.style.transform === 'translateX(0px)').toBe(true);

      fireEvent.click(screen.getByTestId('app-backdrop'));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 700));
      });
      expect(drawer.style.transform).toBe('translateX(-400px)');
      expect(drawer.getBoundingClientRect().right).toBeLessThanOrEqual(0);
    } finally {
      window.requestAnimationFrame = origRaf;
    }
  });
});

describe('StatusBar', () => {
  it('渲染静态段：引擎连接状态与引擎版本', () => {
    render(<StatusBar />);
    expect(screen.getByText('引擎已连接')).toBeInTheDocument();
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

/* ══ 手势行为（apple-design §2/§5/§6/§9/§10）══════════════════
 * 指针事件在抽屉面板上直接派发（jsdom 无 setPointerCapture，
 * 组件已 try/catch 兜底）；位移断言读 inline transform。 */

/** 视口宽（resolveDragOffset 橡皮筋的 dimension 参数） */
const VW = 1280;
const CLOSE_DISTANCE = DRAWER_LEFT_OFFSET + 330 + 2;

/** 从 transform 解析当前 x（px）；归零位 none → 0 */
const xOf = (el: HTMLElement): number =>
  Number(/translateX\((-?[\d.]+)px\)/.exec(el.style.transform)?.[1] ?? 0);

/**
 * rAF polyfill：motion 的 motionvalue → DOM 写入由 rAF 驱动，jsdom 默认
 * rAF 永不触发，手势/弹簧帧全部滞留队列。返回恢复函数。
 */
function polyfillRaf(): () => void {
  const origRaf = window.requestAnimationFrame;
  window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 16)) as unknown as typeof requestAnimationFrame;
  return () => {
    window.requestAnimationFrame = origRaf;
  };
}

/** 等待 rAF 队列 flush（motion 渲染帧落地） */
const flushFrames = () => act(async () => {
  await new Promise((r) => setTimeout(r, 50));
});

describe('Drawer 手势（apple-design §2/§9/§10）', () => {
  it('拖拽 1:1 跟手：越阈值后位移直接映射（左抽屉向左为关闭方向）', async () => {
    const restoreRaf = polyfillRaf();
    try {
      render(
        <Drawer side="left" open onClose={() => {}} title="文件">
          <div />
        </Drawer>,
      );
      // 先等打开弹簧 settle（拖拽起手前不能残留入场动画速度）
      await flushFrames();
      await act(async () => {
        await new Promise((r) => setTimeout(r, 700));
      });
      const drawer = queryDrawer('left');
      expect(drawer.style.transform).toBe('none'); // settle 基线

      fireEvent.pointerDown(drawer, { pointerId: 1, clientX: 600, clientY: 100, button: 0 });
      // 越过 10px 阈值那一刻重锚（startPointerX=580），之后 1:1
      fireEvent.pointerMove(drawer, { pointerId: 1, clientX: 580, clientY: 100 });
      fireEvent.pointerMove(drawer, { pointerId: 1, clientX: 550, clientY: 100 });
      await flushFrames();
      expect(xOf(drawer)).toBe(-30);
      fireEvent.pointerMove(drawer, { pointerId: 1, clientX: 450, clientY: 100 });
      await flushFrames();
      expect(xOf(drawer)).toBe(-130);
    } finally {
      restoreRaf();
    }
  });

  it('未过 10px 阈值不进入拖拽（点击子元素不被吞）', async () => {
    const restoreRaf = polyfillRaf();
    try {
      render(
        <Drawer side="left" open onClose={() => {}} title="文件">
          <div />
        </Drawer>,
      );
      await act(async () => {
        await new Promise((r) => setTimeout(r, 700));
      });
      const drawer = queryDrawer('left');
      fireEvent.pointerDown(drawer, { pointerId: 1, clientX: 600, clientY: 100, button: 0 });
      fireEvent.pointerMove(drawer, { pointerId: 1, clientX: 592, clientY: 100 }); // 8px < 10px 阈值
      await flushFrames();
      expect(drawer.style.transform).toBe('none');
      fireEvent.pointerUp(drawer, { pointerId: 1 });
      await flushFrames();
      expect(drawer.style.transform).toBe('none');
    } finally {
      restoreRaf();
    }
  });

  it('越过打开位朝屏幕内推：橡皮筋衰减，非线性跟手（§9）', async () => {
    const restoreRaf = polyfillRaf();
    try {
      render(
        <Drawer side="left" open onClose={() => {}} title="文件">
          <div />
        </Drawer>,
      );
      await act(async () => {
        await new Promise((r) => setTimeout(r, 700));
      });
      const drawer = queryDrawer('left');
      fireEvent.pointerDown(drawer, { pointerId: 1, clientX: 600, clientY: 100, button: 0 });
      // 越过阈值（重锚 610px），指针向右推 90px（朝屏幕内）
      fireEvent.pointerMove(drawer, { pointerId: 1, clientX: 610, clientY: 100 });
      fireEvent.pointerMove(drawer, { pointerId: 1, clientX: 700, clientY: 100 });
      await flushFrames();
      const x1 = xOf(drawer);
      expect(x1).toBeGreaterThan(0);
      expect(x1).toBeLessThan(90);
      // 更大位移衰减更强（单调递增但增量递减）
      fireEvent.pointerMove(drawer, { pointerId: 1, clientX: 900, clientY: 100 });
      await flushFrames();
      const x2 = xOf(drawer);
      expect(x2).toBeGreaterThan(x1);
      expect(x2).toBeLessThan(x1 + 200); // 衰减后远小于线性 200px
    } finally {
      restoreRaf();
    }
  });

  it('朝关闭方向甩动（速度 > 阈值）：释放即关闭回调（§5 用速度符号决策）', async () => {
    const restoreRaf = polyfillRaf();
    try {
      const onClose = vi.fn();
      render(
        <Drawer side="left" open onClose={onClose} title="文件">
          <div />
        </Drawer>,
      );
      await act(async () => {
        await new Promise((r) => setTimeout(r, 700));
      });
      const drawer = queryDrawer('left');
      fireEvent.pointerDown(drawer, { pointerId: 1, clientX: 600, clientY: 100, button: 0 });
      fireEvent.pointerMove(drawer, { pointerId: 1, clientX: 580, clientY: 100 }); // 越阈值重锚
      // 甩动：大位移（history 时间窗内瞬时完成 → 高速）
      fireEvent.pointerMove(drawer, { pointerId: 1, clientX: 320, clientY: 100 });
      fireEvent.pointerUp(drawer, { pointerId: 1 });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      restoreRaf();
    }
  });

  it('小幅慢速释放且投影未过行程 30%：吸附回打开位', async () => {
    const onClose = vi.fn();
    const origRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 16)) as unknown as typeof requestAnimationFrame;
    // 控制时间源：慢速手势 = 大位移/长时间，确保释放速度低
    let now = 0;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      render(
        <Drawer side="left" open onClose={onClose} title="文件">
          <div />
        </Drawer>,
      );
      const drawer = queryDrawer('left');
      now = 0;
      fireEvent.pointerDown(drawer, { pointerId: 1, clientX: 600, clientY: 100, button: 0 });
      // 慢速：700ms 内仅位移 70px（越阈值后重锚 590，有效位移 70 ≈ 17% 行程）
      now = 100;
      fireEvent.pointerMove(drawer, { pointerId: 1, clientX: 590, clientY: 100 });
      now = 700;
      fireEvent.pointerMove(drawer, { pointerId: 1, clientX: 520, clientY: 100 });
      // 末两样本 100px/600ms ≈ 167px/s < 400 甩动阈值；投影 167·0.5≈84 + 位移 70 →
      // 154 ≈ 38% 行程 > 30%？不：offset 70 + 投影 84 = 154 > 120（30% of 400）会关闭。
      // 因此用更小速度：末段 300ms 只动 10px（33px/s，投影 ~16）
      now = 1000;
      fireEvent.pointerMove(drawer, { pointerId: 1, clientX: 510, clientY: 100 });
      fireEvent.pointerUp(drawer, { pointerId: 1 });
      // 末窗（1000-900ms 内样本）速度极低 → 投影 ≈ 位移 80 + 惯性 ~17 < 120（30%）
      expect(onClose).not.toHaveBeenCalled();
      now = 1100;
      await act(async () => {
        await new Promise((r) => setTimeout(r, 700));
      });
      // 回弹弹簧 settle 到打开位
      expect(drawer.style.transform).toBe('none');
    } finally {
      window.requestAnimationFrame = origRaf;
      nowSpy.mockRestore();
    }
  });
});

describe('释放决策与投影（apple-design §5/§6 纯函数）', () => {
  it('projectMomentum：v=500px/s → 约 250px（iOS decelerationRate 0.998）', () => {
    // 0.998/(1-0.998)=499 → 500px/s × 0.499s ≈ 249.5px
    expect(projectMomentum(500)).toBeGreaterThan(240);
    expect(projectMomentum(500)).toBeLessThan(260);
    expect(projectMomentum(0)).toBe(0);
    expect(projectMomentum(-500)).toBeLessThan(0);
  });

  it('shouldCloseOnRelease：甩动速度符号优先于位置（quick-ref 决策表）', () => {
    const base = { side: 'left' as const, closeDistance: CLOSE_DISTANCE };
    // 朝关闭方向甩（v < −400）：哪怕只拖了 1px 也关闭
    expect(shouldCloseOnRelease({ ...base, velocityX: -600, offsetX: -1, closeDistance: CLOSE_DISTANCE })).toBe(true);
    // 朝打开方向甩（v > 400）：哪怕拖过 90% 行程也回弹
    expect(shouldCloseOnRelease({ ...base, velocityX: 600, offsetX: -360, closeDistance: CLOSE_DISTANCE })).toBe(false);
    // 慢速：投影落点（位移 + 惯性滑行）越过 30% 行程才吸附关闭
    expect(
      shouldCloseOnRelease({ side: 'left', velocityX: 0, offsetX: -100, closeDistance: CLOSE_DISTANCE }),
    ).toBe(false); // 100 < 120（30% of 400）
    expect(
      shouldCloseOnRelease({ side: 'left', velocityX: 0, offsetX: -130, closeDistance: CLOSE_DISTANCE }),
    ).toBe(true); // 130 > 120
    // 慢速但带惯性：位移 60 + 投影 250 > 120 → 关闭（flick 的「投掷」感）
    expect(
      shouldCloseOnRelease({ side: 'left', velocityX: -500, offsetX: -60, closeDistance: CLOSE_DISTANCE }),
    ).toBe(true);
    // 右抽屉：方向镜像
    expect(
      shouldCloseOnRelease({ side: 'right', velocityX: 600, offsetX: 1, closeDistance: 360 }),
    ).toBe(true);
  });

  it('rubberband：越界位移渐进衰减、单调、远小于线性（§9）', () => {
    const small = rubberband(50, VW);
    const big = rubberband(500, VW);
    expect(small).toBeGreaterThan(0);
    expect(small).toBeLessThan(50);
    expect(big).toBeGreaterThan(small);
    expect(big).toBeLessThan(500);
    // ratio 递减：越远每 px 跟得越少
    const ratioSmall = small / 50;
    const ratioBig = big / 500;
    expect(ratioBig).toBeLessThan(ratioSmall);
  });

  it('resolveDragOffset：关闭方向 1:1 夹紧行程、打开方向越界衰减', () => {
    expect(resolveDragOffset(-100, CLOSE_DISTANCE, VW)).toBe(-100);
    // 夹紧：不超出关闭行程
    expect(resolveDragOffset(-9999, CLOSE_DISTANCE, VW)).toBe(-CLOSE_DISTANCE);
    // 朝屏幕内推：衰减
    const decayed = resolveDragOffset(300, CLOSE_DISTANCE, VW);
    expect(decayed).toBeGreaterThan(0);
    expect(decayed).toBeLessThan(300);
  });
});
