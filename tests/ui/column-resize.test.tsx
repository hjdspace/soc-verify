// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  ColumnResizeHandle,
  useColumnResize,
} from '@renderer/components/ui/ColumnResize';

/**
 * 列宽拖拽（issues #10，摘取 beautiful-ui RecordsTable startColumnResize +
 * 首帧测量锁定）：断言外部行为——首帧 useLayoutEffect 测量 thead th 锁定
 * 显式列宽、拖拽经 window 级 pointermove 改宽且 minWidth 夹紧、拖拽期 body
 * 光标/文本选择切换与恢复、is-resizing 态、卸载兜底清理。jsdom 无布局，
 * th 宽度以 getBoundingClientRect prototype mock 注入（data-th-key 查表）。
 */

const colWidths: Record<string, number> = { a: 200, b: 160 };

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const key = this.dataset.thKey;
    return {
      width: key ? (colWidths[key] ?? 0) : 0,
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
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

type ColKey = 'a' | 'b';

function Host() {
  const resize = useColumnResize<ColKey>({ defaults: { a: 200, b: 160 } });
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
          <td>va</td>
          <td>vb</td>
        </tr>
      </tbody>
    </table>
  );
}

describe('useColumnResize', () => {
  it('首帧 useLayoutEffect 测量 thead th 并锁定显式列宽（colgroup 取实测值）', () => {
    render(<Host />);
    // 实测 a=200 / b=160（prototype mock），锁定后 colgroup 为显式 px
    expect(screen.getByTestId('col-a')).toHaveStyle({ width: '200px' });
    expect(screen.getByTestId('col-b')).toHaveStyle({ width: '160px' });
  });

  it('拖拽经 window 级 pointermove 改宽（Δx 累加），pointerup/cancel 结束', () => {
    render(<Host />);
    const handle = screen.getByLabelText('调整「列A」列宽');
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 500 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 560 });
    expect(screen.getByTestId('col-a')).toHaveStyle({ width: '260px' });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 530 });
    expect(screen.getByTestId('col-a')).toHaveStyle({ width: '230px' });
    fireEvent.pointerUp(window, { pointerId: 1 });
    // 结束后 move 不再生效
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 900 });
    expect(screen.getByTestId('col-a')).toHaveStyle({ width: '230px' });
  });

  it('minWidth 夹紧（列 A 显式 120，列 B 缺省 120）', () => {
    render(<Host />);
    const handleA = screen.getByLabelText('调整「列A」列宽');
    fireEvent.pointerDown(handleA, { pointerId: 1, clientX: 500 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 0 });
    expect(screen.getByTestId('col-a')).toHaveStyle({ width: '120px' });
    fireEvent.pointerUp(window, { pointerId: 1 });

    const handleB = screen.getByLabelText('调整「列B」列宽');
    fireEvent.pointerDown(handleB, { pointerId: 1, clientX: 300 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: -1000 });
    expect(screen.getByTestId('col-b')).toHaveStyle({ width: '120px' });
    fireEvent.pointerUp(window, { pointerId: 1 });
  });

  it('拖拽期 body 换 col-resize 光标并禁文本选择，结束恢复原值', () => {
    document.body.style.cursor = 'default';
    document.body.style.userSelect = 'text';
    render(<Host />);
    const handle = screen.getByLabelText('调整「列A」列宽');
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 });
    expect(document.body.style.cursor).toBe('col-resize');
    expect(document.body.style.userSelect).toBe('none');
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(document.body.style.cursor).toBe('default');
    expect(document.body.style.userSelect).toBe('text');
  });

  it('is-resizing 态：拖拽列手柄带 is-resizing 类，结束移除', () => {
    render(<Host />);
    const handleA = screen.getByLabelText('调整「列A」列宽');
    expect(handleA.className).not.toContain('is-resizing');
    fireEvent.pointerDown(handleA, { pointerId: 1, clientX: 100 });
    expect(handleA.className).toContain('is-resizing');
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(handleA.className).not.toContain('is-resizing');
  });

  it('手柄可访问性：role=separator + vertical + 「调整 X 列宽」aria-label', () => {
    render(<Host />);
    const handleA = screen.getByLabelText('调整「列A」列宽');
    expect(handleA).toHaveAttribute('role', 'separator');
    expect(handleA).toHaveAttribute('aria-orientation', 'vertical');
    expect(screen.getByLabelText('调整「列B」列宽')).toBeInTheDocument();
  });

  it('拖拽中途卸载：兜底清理恢复 body 样式，window 监听不再生效', () => {
    document.body.style.cursor = 'default';
    const { unmount } = render(<Host />);
    const handle = screen.getByLabelText('调整「列A」列宽');
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 });
    act(() => {
      unmount();
    });
    expect(document.body.style.cursor).toBe('default');
    expect(() => fireEvent.pointerMove(window, { pointerId: 1, clientX: 300 })).not.toThrow();
  });
});
