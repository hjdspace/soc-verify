// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import {
  TagList,
  fitVisibleCount,
  type TagItem,
} from '@renderer/components/ui/TagList';
import {
  ColumnResizeHandle,
  useColumnResize,
} from '@renderer/components/ui/ColumnResize';

/**
 * TagList 溢出折叠（issues #10，摘取 beautiful-ui RecordsTable TagList）：
 * 断言外部行为——贪心 fitVisibleCount（间隙计入 + 「+N」徽标宽度预留）、
 * 窄列折叠为 +N（title/aria-label 保留全部标签）、ResizeObserver 随容器
 * 宽度实时重算（jsdom 无布局，宽高以 prototype getter mock 注入；RO 为
 * 透传 stub，手动触发回调模拟列宽变化——拖拽→RO→重算即真实浏览器链路）。
 * 末组为组合用例：useColumnResize 拖拽改 colgroup 宽 + TagList RO 重算。
 */

/** 测试布局：prototype getter 按元素特征查表（jsdom 量不出尺寸） */
const layout = {
  containerWidth: 400,
  tagWidths: {} as Record<string, number>,
  moreWidth: 34,
  colWidths: { a: 200, b: 160 } as Record<string, number>,
};

/** 透传 ResizeObserver stub：按被观察元素记录回调，手动触发 */
const roCallbacks = new Map<Element, (entries: unknown[]) => void>();
class ROStub {
  private cb: (entries: unknown[]) => void;
  constructor(cb: (entries: unknown[]) => void) {
    this.cb = cb;
  }
  observe(el: Element): void {
    roCallbacks.set(el, this.cb);
  }
  unobserve(el: Element): void {
    roCallbacks.delete(el);
  }
  disconnect(): void {
    for (const [el, cb] of roCallbacks) if (cb === this.cb) roCallbacks.delete(el);
  }
}
/** Flush pending rAF microtasks so TagList's measure callback runs before assertions. */
const flushRaf = async (): Promise<void> => {
  await act(async () => { await Promise.resolve(); });
};

const fireResize = async (el: Element | null): Promise<void> => {
  act(() => {
    roCallbacks.get(el ?? document.body)?.([]);
  });
  await flushRaf();
};

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ROStub);
  // TagList 的 rAF 合并：`frame = rAF(cb)` → cb 内 `frame = null`。
  // 同步 mock 下返回值会覆盖 cb 设置的 null（0 ≠ null），导致后续
  // update() 被 `if (frame !== null) return` 拦截。用微任务延迟 cb
  // 执行：先返回非 null ID，cb 在微任务中将 frame 重置为 null。
  let rafId = 1;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    const id = rafId++;
    queueMicrotask(() => cb(0));
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (_handle: number): void => {});
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.tagMeasure !== undefined) return layout.tagWidths[this.textContent ?? ''] ?? 0;
    if (this.dataset.moreMeasure !== undefined) return layout.moreWidth;
    return 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('ap-tags')) return layout.containerWidth;
    return 0;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const key = this.dataset.thKey;
    return {
      width: key ? (layout.colWidths[key] ?? 0) : 0,
      height: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  roCallbacks.clear();
  document.body.innerHTML = '';
  layout.containerWidth = 400;
  layout.moreWidth = 34;
});

const TAGS: ReadonlyArray<TagItem> = [
  { key: 'a', label: 'Alpha', color: 'var(--status-fail)' },
  { key: 'b', label: 'Beta' },
  { key: 'c', label: 'Gamma', color: 'var(--status-pass)' },
];

const tagsRoot = (): HTMLElement => document.querySelector('.ap-tags') as HTMLElement;
const visibleTags = (): Array<string | null> =>
  [...tagsRoot().children].filter((el) => el.classList.contains('ap-tag')).map((el) => el.textContent);
const moreBadge = (): string | null =>
  [...tagsRoot().children].find((el) => el.classList.contains('ap-tags-more'))?.textContent ?? null;

// ─── fitVisibleCount 纯函数 ─────────────────────────────────────

describe('fitVisibleCount（贪心装箱）', () => {
  it('全部放下时返回标签总数（尾后无隐藏则不预留徽标宽度）', () => {
    expect(fitVisibleCount([50, 60, 70], 400, 30)).toBe(3);
    // 50 + 4 + 60 + 4 + 70 = 188 恰好放下
    expect(fitVisibleCount([50, 60, 70], 188, 30)).toBe(3);
  });

  it('窄容器贪心截断：间隙计入累计宽度', () => {
    // idx0：50 + (4+30) = 84 ≤ 100 ✓；idx1：50+4+60 = 114 > 100 → 只放 1 个
    expect(fitVisibleCount([50, 60, 70], 100, 30)).toBe(1);
    // 间隙不够时同样截断：50 + (4+30) = 84 放不下 80
    expect(fitVisibleCount([50, 60, 70], 83, 30)).toBe(0);
  });

  it('有剩余标签时为「+N」徽标预留宽度（首个标签也不例外）', () => {
    // idx0 需 50 + 4 + 30 = 84 ≤ 100；idx1 需 50+4+60+（0 隐藏不预留）= 114 > 100
    expect(fitVisibleCount([50, 60], 100, 30)).toBe(1);
    // idx1 隐藏数为 0，不预留徽标：50+4+58 = 112 恰好放下
    expect(fitVisibleCount([50, 58], 112, 30)).toBe(2);
  });

  it('空数组返回 0；自定义 gap 生效', () => {
    expect(fitVisibleCount([], 400, 30)).toBe(0);
    expect(fitVisibleCount([50, 50], 200, 30, 10)).toBe(2);
  });
});

// ─── TagList 组件 ───────────────────────────────────────────────

describe('TagList 组件', () => {
  it('宽敞容器全部可见，无 +N 徽标', () => {
    for (const t of TAGS) layout.tagWidths[t.label] = 50;
    render(<TagList items={TAGS} />);
    expect(visibleTags()).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(moreBadge()).toBeNull();
  });

  it('窄容器折叠为 +N：只保留放得下的前缀，徽标计数正确', async () => {
    for (const t of TAGS) layout.tagWidths[t.label] = 60;
    layout.containerWidth = 100;
    // idx0：60 + (4+34) = 98 ≤ 100 ✓；idx1：60+4+60 = 124 > 100 → 1 个 + 2
    render(<TagList items={TAGS} />);
    await flushRaf();
    expect(visibleTags()).toEqual(['Alpha']);
    expect(moreBadge()).toBe('+2');
  });

  it('title / aria-label 保留全部标签（隐藏项可达）', async () => {
    for (const t of TAGS) layout.tagWidths[t.label] = 60;
    layout.containerWidth = 100;
    render(<TagList items={TAGS} />);
    await flushRaf();
    const root = tagsRoot();
    expect(root).toHaveAttribute('title', 'Alpha、Beta、Gamma');
    expect(root).toHaveAttribute('aria-label', 'Alpha、Beta、Gamma');
  });

  it('ResizeObserver 随容器变宽实时重算（列宽拖拽重算缝）', async () => {
    for (const t of TAGS) layout.tagWidths[t.label] = 60;
    layout.containerWidth = 100;
    const { container } = render(<TagList items={TAGS} />);
    await flushRaf();
    expect(moreBadge()).toBe('+2');

    layout.containerWidth = 400;
    await fireResize(container.querySelector('.ap-tags'));
    expect(visibleTags()).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(moreBadge()).toBeNull();

    layout.containerWidth = 60;
    await fireResize(container.querySelector('.ap-tags'));
    // 60 + 34 = 94 > 60 → 一个都放不下
    expect(visibleTags()).toEqual([]);
    expect(moreBadge()).toBe('+3');
  });

  it('items 引用变化即重算（宿主数据刷新折叠态跟随）', async () => {
    for (const t of TAGS) layout.tagWidths[t.label] = 60;
    layout.containerWidth = 100;
    const next: ReadonlyArray<TagItem> = [
      { key: 'x', label: 'Xs', color: 'var(--status-running)' },
      { key: 'y', label: 'Ys' },
    ];
    layout.tagWidths.Xs = 60;
    layout.tagWidths.Ys = 60;
    function HostWithTag() {
      const [items, setItems] = useState(TAGS);
      return (
        <>
          <TagList items={items} />
          <button type="button" onClick={() => setItems(next)} data-testid="swap">
            swap
          </button>
        </>
      );
    }
    render(<HostWithTag />);
    await flushRaf();
    expect(moreBadge()).toBe('+2');
    fireEvent.click(screen.getByTestId('swap'));
    await flushRaf();
    // Xs：60 + (4+34) = 98 ≤ 100 ✓；Ys：60+4+60+34 = 162 > 100 → 1 个 + 1
    expect(visibleTags()).toEqual(['Xs']);
    expect(moreBadge()).toBe('+1');
  });

  it('color 注入 --tag-base 内联变量，缺省无 style', () => {
    for (const t of TAGS) layout.tagWidths[t.label] = 50;
    render(<TagList items={TAGS} />);
    const roots = [...tagsRoot().children].filter((el) => el.classList.contains('ap-tag')) as HTMLElement[];
    expect(roots[0].style.getPropertyValue('--tag-base')).toBe('var(--status-fail)');
    expect(roots[1].style.getPropertyValue('--tag-base')).toBe('');
    expect(roots[2].style.getPropertyValue('--tag-base')).toBe('var(--status-pass)');
  });

  it('空列表渲染空容器，无标签无徽标', () => {
    render(<TagList items={[]} />);
    expect(tagsRoot()).toBeInTheDocument();
    expect(visibleTags()).toEqual([]);
    expect(moreBadge()).toBeNull();
  });
});

// ─── 组合：列宽拖拽 → TagList 重算 ──────────────────────────────

function ResizeHost() {
  const resize = useColumnResize({ defaults: { a: 200, b: 160 } });
  return (
    <table ref={resize.tableRef}>
      <colgroup>
        <col data-testid="col-a" style={{ width: resize.widths.a }} />
        <col data-testid="col-b" style={{ width: resize.widths.b }} />
      </colgroup>
      <thead>
        <tr>
          <th data-th-key="a" className="relative">
            列A
            <ColumnResizeHandle
              label="列A"
              resizing={resize.resizingKey === 'a'}
              onStart={resize.startResize('a', 120)}
            />
          </th>
          <th data-th-key="b" className="relative">
            列B
            <ColumnResizeHandle label="列B" resizing={resize.resizingKey === 'b'} onStart={resize.startResize('b')} />
          </th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            <TagList items={TAGS} />
          </td>
          <td>rest</td>
        </tr>
      </tbody>
    </table>
  );
}

describe('组合：useColumnResize 拖拽 + TagList RO 重算', () => {
  it('拖拽改列宽（minWidth 夹紧）→ TagList 经 ResizeObserver 重新折叠', async () => {
    for (const t of TAGS) layout.tagWidths[t.label] = 60;
    render(<ResizeHost />);
    await flushRaf();

    // 首帧测量锁定：colgroup 取 th 实测宽度
    expect(screen.getByTestId('col-a')).toHaveStyle({ width: '200px' });
    expect(screen.getByTestId('col-b')).toHaveStyle({ width: '160px' });

    // 拖拽列 A：−60px → 140px；列宽变化同步反映到 TagList 容器宽（真实浏览器经 RO 触发）
    const handle = screen.getByLabelText('调整「列A」列宽');
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 500 });
    expect(document.body.style.cursor).toBe('col-resize');
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 440 });
    expect(screen.getByTestId('col-a')).toHaveStyle({ width: '140px' });

    layout.containerWidth = 140;
    await fireResize(tagsRoot());
    // Alpha：60 + (4+34) = 98 ≤ 140 ✓；Beta：60+4+60+(4+34) = 162 > 140 → 1 个 + 2
    expect(moreBadge()).toBe('+2');

    // 拖到 0：minWidth 120 夹紧
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 0 });
    expect(screen.getByTestId('col-a')).toHaveStyle({ width: '120px' });

    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });
});
