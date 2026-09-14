// @vitest-environment jsdom
/**
 * WebGL 能力探测与上下文释放（spec §9/§11，issue 26）。
 *
 * 这两条是「WebGL 不可用时仍可用邻接列表」与「卸载释放渲染资源」的
 * 判定基础：探测决定了走画布还是走列表，释放决定了反复切库不累积 GPU 上下文。
 */

import { describe, it, expect, vi } from 'vitest';
import {
  canUseGraphCanvas,
  detectWebGLSupport,
  releaseWebGLContexts,
} from '@renderer/lib/webgl-support';

type FakeContext = {
  getExtension: (name: string) => { loseContext: () => void } | null;
};

function fakeCanvas(contexts: Record<string, FakeContext | null>): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.getContext = ((type: string) => contexts[type] ?? null) as HTMLCanvasElement['getContext'];
  return canvas;
}

function countingContext(): { context: FakeContext; lost: () => number } {
  let lost = 0;
  return {
    context: {
      getExtension: (name) => (name === 'WEBGL_lose_context' ? { loseContext: () => { lost += 1; } } : null),
    },
    lost: () => lost,
  };
}

describe('detectWebGLSupport', () => {
  it('优先 WebGL2，其次 WebGL1', () => {
    expect(detectWebGLSupport({ createCanvas: () => fakeCanvas({ webgl2: countingContext().context }) })).toBe('webgl2');
    expect(detectWebGLSupport({ createCanvas: () => fakeCanvas({ webgl: countingContext().context }) })).toBe('webgl');
  });

  it('两者都拿不到时返回 none（走邻接列表）', () => {
    expect(detectWebGLSupport({ createCanvas: () => fakeCanvas({}) })).toBe('none');
  });

  it('环境没有 canvas 时返回 none 而不是抛错', () => {
    expect(detectWebGLSupport({ createCanvas: () => null })).toBe('none');
  });

  it('getContext 抛错时降级为 none', () => {
    const canvas = document.createElement('canvas');
    canvas.getContext = (() => {
      throw new Error('GPU 进程不可用');
    }) as HTMLCanvasElement['getContext'];
    expect(detectWebGLSupport({ createCanvas: () => canvas })).toBe('none');
  });

  it('探测本身会立即丢弃上下文（不占 GPU 上下文槽位）', () => {
    const { context, lost } = countingContext();
    detectWebGLSupport({ createCanvas: () => fakeCanvas({ webgl2: context }) });
    expect(lost()).toBe(1);
  });

  it('canUseGraphCanvas 只把 none 判为不可用', () => {
    expect(canUseGraphCanvas('webgl2')).toBe(true);
    expect(canUseGraphCanvas('webgl')).toBe(true);
    expect(canUseGraphCanvas('none')).toBe(false);
  });
});

describe('releaseWebGLContexts', () => {
  it('对容器内每个 WebGL 上下文调用 loseContext', () => {
    const first = countingContext();
    const second = countingContext();
    const container = document.createElement('div');
    const a = document.createElement('canvas');
    a.getContext = ((type: string) => (type === 'webgl2' ? first.context : null)) as HTMLCanvasElement['getContext'];
    const b = document.createElement('canvas');
    b.getContext = ((type: string) => (type === 'webgl' ? second.context : null)) as HTMLCanvasElement['getContext'];
    container.append(a, b);

    expect(releaseWebGLContexts(container)).toBe(2);
    expect(first.lost()).toBe(1);
    expect(second.lost()).toBe(1);
  });

  it('容器为 null 或没有画布时安全返回 0', () => {
    expect(releaseWebGLContexts(null)).toBe(0);
    expect(releaseWebGLContexts(document.createElement('div'))).toBe(0);
  });

  it('释放失败不影响其他上下文的释放', () => {
    const container = document.createElement('div');
    const broken = document.createElement('canvas');
    broken.getContext = (() => {
      throw new Error('上下文已失效');
    }) as HTMLCanvasElement['getContext'];
    const healthy = countingContext();
    const good = document.createElement('canvas');
    good.getContext = ((type: string) => (type === 'webgl2' ? healthy.context : null)) as HTMLCanvasElement['getContext'];
    container.append(broken, good);

    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(releaseWebGLContexts(container)).toBe(1);
    expect(healthy.lost()).toBe(1);
    spy.mockRestore();
  });
});
