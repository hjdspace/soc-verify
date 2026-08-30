// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { PillButton } from '@renderer/components/ui/PillButton';
import { EntityChip, Monogram, MONOGRAM_DEFAULT_COLOR } from '@renderer/components/ui/EntityChip';
import { ValuePill } from '@renderer/components/ui/ValuePill';
import { Shimmer } from '@renderer/components/ui/Shimmer';

/**
 * beautiful-ui 四 atom 适配（PillButton / EntityChip / ValuePill / Shimmer）：
 * 断言渲染结构与映射层 token 接线（语义变量、color-mix 派生、canonical
 * keyframes），样式值本身由映射层 CSS 保证。
 */

afterEach(cleanup);

describe('PillButton', () => {
  it('点击触发 onClick，disabled 透传', () => {
    const onClick = vi.fn();
    const { getByText, rerender } = render(<PillButton onClick={onClick}>确认</PillButton>);
    fireEvent.click(getByText('确认'));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(<PillButton disabled onClick={onClick}>确认</PillButton>);
    fireEvent.click(getByText('确认'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('变体映射到项目语义色类（accent→primary）', () => {
    const { getByText } = render(<PillButton variant="accent">Go</PillButton>);
    expect(getByText('Go').closest('button')?.className).toContain('bg-primary');
  });

  it('secondary 变体阴影取映射层 --shadow-btn', () => {
    const { getByText } = render(<PillButton>Go</PillButton>);
    expect(getByText('Go').closest('button')?.style.boxShadow).toBe('var(--shadow-btn)');
  });
});

describe('EntityChip', () => {
  it('默认以名称首字符作 monogram', () => {
    const { container } = render(<EntityChip name="OpenLane" />);
    expect(container.textContent).toBe('OOpenLane');
  });

  it('自定义 monogram 节点覆盖首字符', () => {
    const { container } = render(<EntityChip name="Xyz" monogram={<b>M</b>} />);
    expect(container.textContent).toBe('MXyz');
  });

  it('Monogram 默认装饰色板', () => {
    const { container } = render(<Monogram>A</Monogram>);
    // jsdom 会把 rgb() 序列化为逗号分隔形式，剥掉分隔符后比较
    const norm = (s: string) => s.replace(/[\s,]+/g, '');
    const bg = (container.firstElementChild as HTMLElement | null)?.style.background ?? '';
    expect(norm(bg)).toBe(norm(MONOGRAM_DEFAULT_COLOR));
  });
});

describe('ValuePill', () => {
  it('neutral 默认：muted 底 + hairline 描边', () => {
    const { container } = render(<ValuePill>1,024</ValuePill>);
    const pill = container.firstElementChild as HTMLElement;
    expect(pill.style.backgroundColor).toBe('var(--muted)');
    expect(pill.style.boxShadow).toBe('var(--shadow-hairline)');
  });

  it('green tone：status-pass 派生 tint 底与 28% 描边', () => {
    const { container } = render(<ValuePill tone="green">PASS</ValuePill>);
    const pill = container.firstElementChild as HTMLElement;
    expect(pill.style.backgroundColor).toContain('--status-pass');
    expect(pill.style.backgroundColor).toContain('14%');
    expect(pill.style.boxShadow).toContain('--status-pass');
    expect(pill.style.boxShadow).toContain('28%');
  });

  it('red tone 映射到 --status-fail，orange 映射到 --status-aborted', () => {
    const { container, rerender } = render(<ValuePill tone="red">F</ValuePill>);
    expect((container.firstElementChild as HTMLElement).style.backgroundColor).toContain('--status-fail');
    rerender(<ValuePill tone="orange">O</ValuePill>);
    expect((container.firstElementChild as HTMLElement).style.backgroundColor).toContain('--status-aborted');
  });
});

describe('Shimmer', () => {
  it('使用 canonical shimmer-text keyframes 与 ink 色阶渐变', () => {
    const { container } = render(<Shimmer>思考中</Shimmer>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.animation).toBe('shimmer-text 1.8s linear infinite');
    expect(el.style.backgroundImage).toContain('--fg-faint');
    expect(el.style.backgroundImage).toContain('--foreground');
  });
});
