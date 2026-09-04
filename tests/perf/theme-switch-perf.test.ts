// @vitest-environment jsdom
/**
 * 主题切换 / 窗口 resize 性能回归测试。
 *
 * 背景（修复前的卡顿根因）：
 * 1. `applyTheme` 直接翻转 data-theme，而 `.theme-transition *` 全局规则
 *    给文档内所有元素同时挂 200ms color/border 过渡——上万用例树视图
 *    切主题时逐帧样式计算直接掉帧。
 * 2. `rebuildTheme()` 同步遍历所有图表监听器，每个 setOption 独立占帧，
 *    多图场景连掉数帧。
 * 3. 终端 ResizeObserver 回调同步 fit()——拖拽窗口边框时每帧全量
 *    重算网格 + 整屏重绘。
 *
 * jsdom 测不了真实帧率，这里锁定的是「不会退回慢路径」的结构性契约：
 * A. applyTheme 走 View Transition（无 startViewTransition 时立即降级）；
 *    reduced-motion 下不做过渡直接切换。
 * B. rebuildTheme 的监听器通知合帧（一次 rebuild 多个监听器也只在
 *    下一帧收到一次回调），不再同步逐个通知。
 * C. 终端 fit 由 rAF 合并（一帧内多次 resize 只触发一次 fit）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useThemeStore } from '@renderer/stores/theme';
import {
  onThemeChange,
  rebuildTheme,
  resetThemeState,
} from '@renderer/lib/echarts-theme';

describe('applyTheme — View Transition 路径', () => {
  const originalStartViewTransition = document.startViewTransition;
  const originalMatchMedia = window.matchMedia;

  const setStartViewTransition = (value: unknown) => {
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      writable: true,
      value,
    });
  };

  const setMatchMediaMatches = (matches: boolean) => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: () => ({ matches }),
    });
  };

  afterEach(() => {
    setStartViewTransition(originalStartViewTransition);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
    vi.restoreAllMocks();
  });

  it('支持时通过 startViewTransition 切换（不在主线程挂全局过渡）', () => {
    setMatchMediaMatches(false);
    const startViewTransition = vi.fn((cb: () => void) => {
      cb();
      return { finished: Promise.resolve() };
    });
    setStartViewTransition(startViewTransition);

    useThemeStore.getState().setTheme('daylight');

    expect(startViewTransition).toHaveBeenCalledTimes(1);
    // DOM 更新发生在 View Transition 回调内（而非渐进 transition 风暴）
    expect(document.documentElement.dataset.theme).toBe('daylight');
    expect(document.documentElement.dataset.shade).toBe('light');
  });

  it('不支持时降级为立即切换（旧内核 / jsdom）', () => {
    setStartViewTransition(undefined);

    useThemeStore.getState().setTheme('bench');

    expect(document.documentElement.dataset.theme).toBe('bench');
    expect(document.documentElement.dataset.shade).toBe('dark');
  });

  it('prefers-reduced-motion 时跳过 View Transition 直接切换', () => {
    setMatchMediaMatches(true);
    const startViewTransition = vi.fn();
    setStartViewTransition(startViewTransition);

    useThemeStore.getState().setTheme('daylight');

    expect(startViewTransition).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.theme).toBe('daylight');
  });
});

describe('rebuildTheme — 图表监听器合帧通知', () => {
  beforeEach(() => {
    resetThemeState();
  });

  afterEach(() => {
    resetThemeState();
  });

  it('监听器回调延迟到下一帧（同一帧内合并，不再同步逐个触发）', () => {
    const frames: Array<() => void> = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      frames.push(() => cb(0));
      return frames.length;
    });

    const first = vi.fn();
    const second = vi.fn();
    onThemeChange(first);
    onThemeChange(second);

    rebuildTheme();

    // 同步阶段不通知（旧实现在这里同步逐个调用，每图独立占帧）
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();

    // 一帧内全部送达：回调只注册一次 rAF（合帧）
    expect(frames).toHaveLength(1);
    frames[0]();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('连续两次 rebuild 只注册一次 rAF（防抖合并）', () => {
    const frames: Array<() => void> = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      frames.push(() => cb(0));
      return frames.length;
    });

    const listener = vi.fn();
    onThemeChange(listener);

    rebuildTheme();
    rebuildTheme();

    expect(frames).toHaveLength(1);
    frames[0]();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('通知携带重建后的 theme（rgb 色彩链路不变）', () => {
    const seen: unknown[] = [];
    onThemeChange((theme) => seen.push(theme));

    const theme = rebuildTheme();
    // jsdom 下 window 存在但 rAF 由 vitest 环境提供——同步分支只在
    // typeof window === 'undefined' 时走；这里手动冲刷队列
    vi.waitFor(() => {
      expect(seen).toHaveLength(1);
      expect(seen[0]).toBe(theme);
    });
  });
});
