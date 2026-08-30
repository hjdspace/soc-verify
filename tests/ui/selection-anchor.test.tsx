// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createRef, type ReactNode } from 'react';
import {
  readDomSelection,
  useSelectionAnchor,
  type SelectionSnapshot,
} from '@renderer/hooks/use-selection-anchor';

/**
 * 划选锚定 hook（issues #5 测试缝）：通过注入假 readSelection 脱离
 * 真实 DOM Selection 驱动，断言锚点换算（包围盒水平中心 + 最后一行
 * bottom + gap）与监听（selectionchange/resize/enabled 开关）行为。
 */

const BASE_SNAPSHOT: SelectionSnapshot = {
  text: '选中的引用片段',
  // 包围盒中心 x = (100 + 300) / 2 = 200
  bounds: { left: 100, top: 50, right: 300, bottom: 70 },
  // 最后一行 bottom = 70
  lastLine: { left: 100, top: 60, right: 300, bottom: 70 },
};

type AnchorOptions = Omit<Parameters<typeof useSelectionAnchor>[0], 'hostRef'>;

function renderAnchor(initial: AnchorOptions) {
  const hostRef = createRef<HTMLDivElement>();
  return renderHook((props: AnchorOptions) => useSelectionAnchor({ hostRef, ...props }), {
    initialProps: initial,
    wrapper: ({ children }: { children: ReactNode }) => (
      <div ref={hostRef} data-testid="host">
        {children}
      </div>
    ),
  });
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useSelectionAnchor', () => {
  it('place() 按注入快照换算锚点：x=包围盒中心，y=最后一行 bottom + gap', async () => {
    const { result } = renderAnchor({ readSelection: () => BASE_SNAPSHOT });
    expect(result.current.anchor).toBeNull();

    act(() => {
      result.current.place();
    });
    await waitFor(() => {
      expect(result.current.anchor).not.toBeNull();
    });
    // jsdom 中 host getBoundingClientRect 全零 → 锚点即视口坐标取整
    expect(result.current.anchor).toEqual({ x: 200, y: 78 });
    expect(result.current.selection?.text).toBe('选中的引用片段');
  });

  it('gap 自定义间距生效', async () => {
    const { result } = renderAnchor({ readSelection: () => BASE_SNAPSHOT, gap: 20 });
    act(() => {
      result.current.place();
    });
    await waitFor(() => {
      expect(result.current.anchor).toEqual({ x: 200, y: 90 });
    });
  });

  it('选区消失（reader 返回 null）后锚点清空', async () => {
    let snapshot: SelectionSnapshot | null = BASE_SNAPSHOT;
    const { result } = renderAnchor({ readSelection: () => snapshot });
    act(() => {
      result.current.place();
    });
    await waitFor(() => {
      expect(result.current.anchor).not.toBeNull();
    });

    snapshot = null;
    act(() => {
      result.current.place();
    });
    await waitFor(() => {
      expect(result.current.anchor).toBeNull();
    });
    expect(result.current.selection).toBeNull();
  });

  it('document selectionchange 事件触发重算', async () => {
    const { result } = renderAnchor({ readSelection: () => BASE_SNAPSHOT });
    await act(async () => {
      document.dispatchEvent(new Event('selectionchange'));
    });
    await waitFor(() => {
      expect(result.current.anchor).toEqual({ x: 200, y: 78 });
    });
  });

  it('window resize 事件触发重算：几何变化后锚点随之更新', async () => {
    // 几何可变快照：resize 前后选区位置不同，验证重算真的换了锚点
    let shifted = false;
    const movingSnapshot = (): SelectionSnapshot =>
      shifted
        ? { ...BASE_SNAPSHOT, bounds: { ...BASE_SNAPSHOT.bounds, left: 200, right: 400 }, lastLine: { ...BASE_SNAPSHOT.lastLine, bottom: 120 } }
        : BASE_SNAPSHOT;
    const { result } = renderAnchor({ readSelection: movingSnapshot });
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
    });
    await waitFor(() => {
      expect(result.current.anchor).toEqual({ x: 200, y: 78 });
    });

    shifted = true;
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
    });
    await waitFor(() => {
      expect(result.current.anchor).toEqual({ x: 300, y: 128 });
    });
  });

  it('快照未变化时锚点引用保持稳定（同帧 rAF 批处理去重）', async () => {
    const { result } = renderAnchor({ readSelection: () => BASE_SNAPSHOT });
    act(() => {
      result.current.place();
    });
    await waitFor(() => {
      expect(result.current.anchor).not.toBeNull();
    });
    const first = result.current.anchor;
    act(() => {
      result.current.place();
    });
    // 再次 place 后仍是同一引用（无变化不触发多余渲染）
    expect(result.current.anchor).toBe(first);
  });

  it('子树滚动容器 scroll 事件触发重算（捕获监听，CodeMirror 内滚场景）', async () => {
    // 几何可变快照：滚动前后选区位置不同，验证重算真的换了锚点
    let shifted = false;
    const movingSnapshot = (): SelectionSnapshot =>
      shifted
        ? { ...BASE_SNAPSHOT, bounds: { ...BASE_SNAPSHOT.bounds, left: 200, right: 400 }, lastLine: { ...BASE_SNAPSHOT.lastLine, bottom: 120 } }
        : BASE_SNAPSHOT;
    const { result } = renderAnchor({ readSelection: movingSnapshot });
    await act(async () => {
      result.current.place();
    });
    await waitFor(() => {
      expect(result.current.anchor).toEqual({ x: 200, y: 78 });
    });

    // scroll 不冒泡：事件派发在 host 后代的滚动元素上，document 捕获监听仍应收到
    shifted = true;
    const scroller = document.createElement('div');
    document.querySelector('[data-testid="host"]')!.appendChild(scroller);
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll'));
    });
    await waitFor(() => {
      expect(result.current.anchor).toEqual({ x: 300, y: 128 });
    });
  });

  it('enabled=false 不监听 selectionchange（已得锚点保留）', async () => {
    const { result, rerender } = renderAnchor({ readSelection: () => BASE_SNAPSHOT });
    act(() => {
      result.current.place();
    });
    await waitFor(() => {
      expect(result.current.anchor).not.toBeNull();
    });

    rerender({ readSelection: () => BASE_SNAPSHOT, enabled: false });
    await act(async () => {
      document.dispatchEvent(new Event('selectionchange'));
    });
    // 监听已移除：锚点保持原值（回合进行中浮条不消失、不跳位）
    expect(result.current.anchor).toEqual({ x: 200, y: 78 });
  });
});

describe('readDomSelection（默认 reader 的契约）', () => {
  it('无真实选区（jsdom 默认折叠态）返回 null', () => {
    expect(readDomSelection(document.body)).toBeNull();
  });

  it('host 为 null 时不做容器过滤，仍要求非折叠选区', () => {
    expect(readDomSelection(null)).toBeNull();
  });
});
