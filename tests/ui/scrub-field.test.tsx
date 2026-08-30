// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { ScrubField } from '@renderer/components/ui/ScrubField';
import { SegmentedControl } from '@renderer/components/ui/SegmentedControl';
import type { ScrubFieldProps } from '@renderer/components/ui/ScrubField';
import type { SegmentedOption } from '@renderer/components/ui/SegmentedControl';

/**
 * 数值微调控件（issues #8，参考 beautiful-ui FineTuneCard）：
 * 断言外部行为——键盘步进（↑↓/←→ ±step、Shift ×10）、拖拽 (Δx/2)*step、
 * 直接输入、clamp 边界、偏离默认值高亮、slider 全套 aria；
 * SegmentedControl：受控段索引、aria-pressed、thumb 位移、越界夹紧。
 * CSS 过渡本身不做断言。
 */

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// ─── ScrubField ─────────────────────────────────────────────────

/** 受控宿主：value 落 useState（键盘/拖拽连续改值），spy 旁路上报 */
function Harness({
  initial = 50,
  spy,
  ...props
}: Partial<ScrubFieldProps> & { initial?: number; spy?: (v: number) => void }) {
  const [v, setV] = useState(initial);
  return (
    <ScrubField
      label="W"
      min={0}
      max={100}
      suffix="%"
      testId="scrub"
      {...props}
      value={v}
      onChange={(n) => {
        spy?.(n);
        setV(n);
      }}
    />
  );
}

/** 固定值宿主：value 不回写（断言 onChange 纯输出），spy 单点观察 */
function FixedHarness({ spy, ...props }: Partial<ScrubFieldProps> & { spy?: (v: number) => void }) {
  return (
    <ScrubField
      label="W"
      min={0}
      max={100}
      testId="scrub"
      {...props}
      value={50}
      onChange={(n) => spy?.(n)}
    />
  );
}

function handle(): HTMLElement {
  return screen.getByTestId('scrub-handle');
}

function input(): HTMLInputElement {
  return screen.getByTestId('scrub-input') as HTMLInputElement;
}

describe('ScrubField aria 与结构', () => {
  it('手柄即 role="slider"：aria-valuenow/min/max 与 label 全套，输入框独立 aria-label', () => {
    render(<ScrubField label="宽度" value={50} onChange={() => {}} min={0} max={100} testId="scrub" />);
    const h = screen.getByRole('slider');
    expect(h).toBe(screen.getByTestId('scrub-handle'));
    expect(h).toHaveAttribute('aria-label', '宽度');
    expect(h).toHaveAttribute('aria-valuenow', '50');
    expect(h).toHaveAttribute('aria-valuemin', '0');
    expect(h).toHaveAttribute('aria-valuemax', '100');
    expect(input()).toHaveAttribute('aria-label', '宽度 值');
  });
});

describe('ScrubField 键盘步进', () => {
  it('↑/→ +step，↓/← −step（默认 step=1）', () => {
    const spy = vi.fn();
    render(<FixedHarness spy={spy} />);
    fireEvent.keyDown(handle(), { key: 'ArrowUp' });
    fireEvent.keyDown(handle(), { key: 'ArrowDown' });
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    expect(spy.mock.calls).toEqual([[51], [49], [51], [49]]);
  });

  it('Shift 修饰 ×10：Shift+↑ +10、Shift+↓ −10', () => {
    const spy = vi.fn();
    render(<FixedHarness spy={spy} />);
    fireEvent.keyDown(handle(), { key: 'ArrowUp', shiftKey: true });
    fireEvent.keyDown(handle(), { key: 'ArrowDown', shiftKey: true });
    expect(spy).toHaveBeenNthCalledWith(1, 60);
    expect(spy).toHaveBeenNthCalledWith(2, 40);
  });

  it('自定义 step 生效：step=5 时 ↑ ±5', () => {
    const spy = vi.fn();
    render(<FixedHarness step={5} spy={spy} />);
    fireEvent.keyDown(handle(), { key: 'ArrowUp' });
    expect(spy).toHaveBeenCalledWith(55);
  });
});

describe('ScrubField clamp 边界', () => {
  it('到达 max 后 ↑ 夹在 max（不上越）', () => {
    const spy = vi.fn();
    render(<Harness initial={100} spy={spy} />);
    fireEvent.keyDown(handle(), { key: 'ArrowUp' });
    expect(spy).toHaveBeenLastCalledWith(100);
  });

  it('到达 min 后 ↓ 夹在 min（不下越）', () => {
    const spy = vi.fn();
    render(<Harness initial={0} spy={spy} />);
    fireEvent.keyDown(handle(), { key: 'ArrowDown' });
    expect(spy).toHaveBeenCalledWith(0);
  });
});

describe('ScrubField 拖拽', () => {
  it('pointermove 按 (Δx/2)*step 连续调值，pointerup 后停止', () => {
    const spy = vi.fn();
    render(<FixedHarness spy={spy} />);
    fireEvent.pointerDown(handle(), { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 110 }); // +10px → +5
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 90 }); // 相对起点 −10px → −5
    expect(spy).toHaveBeenNthCalledWith(1, 55);
    expect(spy).toHaveBeenNthCalledWith(2, 45);
    fireEvent.pointerUp(handle(), { pointerId: 1 });
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 130 });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('pointercancel 复位拖拽（后续 move 不再上报）', () => {
    const spy = vi.fn();
    render(<FixedHarness spy={spy} />);
    fireEvent.pointerDown(handle(), { pointerId: 1, clientX: 100 });
    fireEvent.pointerCancel(handle(), { pointerId: 1 });
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 120 });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('ScrubField 直接输入', () => {
  it('输入数字上报 onChange，负值/越界值夹到 min', () => {
    const spy = vi.fn();
    render(<FixedHarness spy={spy} />);
    fireEvent.change(input(), { target: { value: '87' } });
    expect(spy).toHaveBeenLastCalledWith(87);
    fireEvent.change(input(), { target: { value: '-999' } });
    expect(spy).toHaveBeenLastCalledWith(0);
  });

  it('非数字输入不上报（NaN 忽略）', () => {
    const spy = vi.fn();
    render(<FixedHarness spy={spy} />);
    fireEvent.change(input(), { target: { value: 'abc' } });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('ScrubField 小数步长', () => {
  it('step=0.5：键盘 ±0.5，输入保留 1 位小数（不被取整吞掉）', () => {
    const spy = vi.fn();
    render(<FixedHarness step={0.5} spy={spy} />);
    fireEvent.keyDown(handle(), { key: 'ArrowUp' });
    expect(spy).toHaveBeenLastCalledWith(50.5);
    fireEvent.change(input(), { target: { value: '49.5' } });
    expect(spy).toHaveBeenLastCalledWith(49.5);
  });
});

describe('ScrubField 偏离默认值高亮', () => {
  it('value 偏离 defaultValue 时高亮，回到默认后高亮消失', () => {
    const { rerender } = render(
      <ScrubField label="W" value={60} onChange={() => {}} min={0} max={100} defaultValue={50} testId="scrub" />,
    );
    expect(screen.getByTestId('scrub')).toHaveAttribute('data-edited', 'true');
    rerender(
      <ScrubField label="W" value={50} onChange={() => {}} min={0} max={100} defaultValue={50} testId="scrub" />,
    );
    expect(screen.getByTestId('scrub')).toHaveAttribute('data-edited', 'false');
  });

  it('active 外部受控优先：显式 false 时不高亮（即便偏离 defaultValue）', () => {
    render(
      <ScrubField
        label="W"
        value={60}
        onChange={() => {}}
        min={0}
        max={100}
        defaultValue={50}
        active={false}
        testId="scrub"
      />,
    );
    expect(screen.getByTestId('scrub')).toHaveAttribute('data-edited', 'false');
  });
});

// ─── SegmentedControl ───────────────────────────────────────────

const OPTIONS: SegmentedOption<'a' | 'b' | 'c'>[] = [
  { key: 'a', label: '甲', testId: 'seg-a' },
  { key: 'b', label: '乙', testId: 'seg-b' },
  { key: 'c', label: '丙', testId: 'seg-c' },
];

describe('SegmentedControl', () => {
  it('aria-pressed 反映受控段 key，点击上报 onChange(key)', () => {
    const onChange = vi.fn();
    render(<SegmentedControl options={OPTIONS} value="b" onChange={onChange} testId="seg" />);
    expect(screen.getByTestId('seg-a')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('seg-b')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('seg-c'));
    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('thumb 按段数均分宽度并 translateX 到选中段', () => {
    const { container } = render(<SegmentedControl options={OPTIONS} value="c" onChange={() => {}} />);
    const thumb = container.querySelector<HTMLElement>('.ap-seg-thumb');
    expect(thumb).not.toBeNull();
    // jsdom 会把 calc((100% - 4px) / 3) 归一化为乘法形式，只断言轨宽扣减式
    expect(thumb!.style.width).toContain('(100% - 4px)');
    expect(thumb!.style.transform).toBe('translateX(200%)');
  });

  it('value 不在 options 中时无选中段且 thumb 隐藏（不猜测首段）', () => {
    const { container } = render(
      <SegmentedControl<'a' | 'b' | 'c' | 'z'> options={OPTIONS} value="z" onChange={() => {}} />,
    );
    expect(screen.getByTestId('seg-a')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('seg-c')).toHaveAttribute('aria-pressed', 'false');
    const thumb = container.querySelector<HTMLElement>('.ap-seg-thumb');
    expect(thumb!.style.opacity).toBe('0');
  });
});
