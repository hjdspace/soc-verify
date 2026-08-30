// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { useStaggeredRows, CalcCell } from '@renderer/components/ui/StaggeredCalc';

/**
 * AI 列逐行计算（issues #10，摘取 beautiful-ui RecordsTable calc effect +
 * CalcCell）：断言外部行为——start 后每 110ms 推进一行（resolved 递增）、
 * 全部完成后 done 落定且无悬挂定时器、rowCount 缩减立即落定、start 重置
 * 重跑；CalcCell 渲染「计算中…」+ 脉动点；宿主组合（占位 → 逐行解析 →
 * 完成页脚统计）镜像 RecordsTable AI 列用法。计时用 fake timers。
 */

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useStaggeredRows', () => {
  it('start 后每 110ms 推进一行，resolved 递增到 rowCount 后 done 落定', () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useStaggeredRows(3));
      expect(result.current).toMatchObject({ resolved: 0, running: false, done: false });

      act(() => result.current.start());
      expect(result.current).toMatchObject({ resolved: 0, running: true, done: false });

      act(() => vi.advanceTimersByTime(110));
      expect(result.current.resolved).toBe(1);
      act(() => vi.advanceTimersByTime(110));
      expect(result.current.resolved).toBe(2);
      act(() => vi.advanceTimersByTime(110));
      expect(result.current).toMatchObject({ resolved: 3, running: false, done: true });

      // 落定后无悬挂定时器：继续推进不再变化
      act(() => vi.advanceTimersByTime(1000));
      expect(result.current.resolved).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stepMs 自定义生效', () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useStaggeredRows(2, 50));
      act(() => result.current.start());
      act(() => vi.advanceTimersByTime(49));
      expect(result.current.resolved).toBe(0);
      act(() => vi.advanceTimersByTime(1));
      expect(result.current.resolved).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rowCount 为 0 时 start 立即落定 done（不悬挂定时器）', () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useStaggeredRows(0));
      act(() => result.current.start());
      expect(result.current).toMatchObject({ resolved: 0, running: false, done: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('推进中 rowCount 缩减至 resolved 以下：立即落定 done', () => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(({ count }: { count: number }) => useStaggeredRows(count), {
        initialProps: { count: 3 },
      });
      act(() => result.current.start());
      act(() => vi.advanceTimersByTime(110));
      act(() => vi.advanceTimersByTime(110));
      expect(result.current.resolved).toBe(2);

      rerender({ count: 1 });
      expect(result.current).toMatchObject({ resolved: 2, running: false, done: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('done 后 start 重置重跑（resolved 归零、done 清除）', () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useStaggeredRows(2));
      act(() => result.current.start());
      act(() => vi.advanceTimersByTime(110));
      act(() => vi.advanceTimersByTime(110));
      expect(result.current.done).toBe(true);

      act(() => result.current.start());
      expect(result.current).toMatchObject({ resolved: 0, running: true, done: false });
      act(() => vi.advanceTimersByTime(110));
      expect(result.current.resolved).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CalcCell', () => {
  it('渲染「计算中…」标签 + 脉动圆点', () => {
    render(<CalcCell />);
    expect(screen.getByText('计算中…')).toBeInTheDocument();
    expect(document.querySelector('.ap-calc-pulse')).toBeInTheDocument();
  });

  it('label 可覆盖，className 透传', () => {
    render(<CalcCell label="AI 根因分析中…" className="extra" />);
    expect(screen.getByText('AI 根因分析中…')).toBeInTheDocument();
    expect(document.querySelector('.ap-calc')?.className).toContain('extra');
  });
});

// ─── 宿主组合（镜像 RecordsTable AI 列用法：占位 → 逐行解析 → 页脚统计） ──

const VALUES = ['根因 A：时钟偏斜', '根因 B：建立时间违例', '根因 C：保持时间违例'];

function CalcHost() {
  const run = useStaggeredRows(VALUES.length);
  return (
    <div>
      <button type="button" data-testid="go" onClick={run.start}>
        开始计算
      </button>
      <table>
        <tbody>
          {VALUES.map((value, index) => (
            <tr key={value}>
              <td data-testid={`cell-${index}`}>
                {index < run.resolved ? value : run.running ? <CalcCell /> : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {run.done && <div data-testid="footer">{`${run.resolved} 项已解析`}</div>}
    </div>
  );
}

describe('宿主组合：AI 列逐行计算', () => {
  it('未开始显示占位；推进中未解析行 CalcCell、已解析行出值；完成出页脚统计', () => {
    vi.useFakeTimers();
    try {
      render(<CalcHost />);
      expect(screen.getByTestId('cell-0')).toHaveTextContent('—');
      expect(screen.queryByTestId('footer')).toBeNull();

      fireEvent.click(screen.getByTestId('go'));
      expect(screen.getByTestId('cell-0')).toHaveTextContent('计算中…');

      act(() => vi.advanceTimersByTime(110));
      expect(screen.getByTestId('cell-0')).toHaveTextContent('根因 A：时钟偏斜');
      // 推进中所有未解析行均为 CalcCell（参考实现 isCalc = index >= resolved）
      expect(screen.getByTestId('cell-1')).toHaveTextContent('计算中…');
      expect(screen.getByTestId('cell-2')).toHaveTextContent('计算中…');
      expect(screen.queryByTestId('footer')).toBeNull();

      act(() => vi.advanceTimersByTime(110));
      act(() => vi.advanceTimersByTime(110));
      expect(screen.getByTestId('cell-2')).toHaveTextContent('根因 C：保持时间违例');
      expect(screen.getByTestId('footer')).toHaveTextContent('3 项已解析');
      expect(document.querySelectorAll('.ap-calc-pulse')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
