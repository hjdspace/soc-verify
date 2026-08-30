// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  ContextCard,
  ContextCardList,
  type ContextChunk,
} from '@renderer/components/ui/ContextCard';

const CHUNKS: ContextChunk[] = [
  {
    key: 'c1',
    icon: <span data-testid="ic1">A</span>,
    title: 'Vendor onboarding rule',
    meta: '290 字符',
    body: 'Cold-chain certification must be verified before reorder.',
    source: 'SOP.pdf',
    badge: 'PDF',
    tone: 'red',
  },
  {
    key: 'c2',
    title: 'Seasonal demand row',
    meta: '1,250 字符',
    body: 'Q4 velocity table.',
    source: 'export.csv',
    badge: 'CSV',
    tone: 'green',
  },
];

describe('ContextCard / ContextCardList', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('展开后渲染每条 chunk 卡与来源 chip，chip 数量 = chunk 数', () => {
    act(() => {
      render(<ContextCardList chunks={CHUNKS} active />);
    });
    expect(screen.getAllByTestId('context-card')).toHaveLength(2);
    expect(screen.getAllByTestId('context-chip')).toHaveLength(2);
    // 标题栏图标位渲染
    expect(screen.getByTestId('ic1')).toBeInTheDocument();
    // 标题 / 正文 / 来源均在
    expect(screen.getByText('Vendor onboarding rule')).toBeInTheDocument();
    expect(screen.getByText('Cold-chain certification must be verified before reorder.')).toBeInTheDocument();
    expect(screen.getByText('SOP.pdf')).toBeInTheDocument();
  });

  it('chip 在展开 700ms 后逐枚淡入，第二枚延迟 80ms（i*80ms 错峰）', () => {
    act(() => {
      render(<ContextCardList chunks={CHUNKS} active />);
    });
    const chips = screen.getAllByTestId('context-chip');
    // 展开即刻：chip 已在 DOM 但 opacity 0（700ms 定时尚未触发）
    expect(chips[0].style.opacity).toBe('0');
    // 第二枚错峰延迟 = 1 * 80ms（background-color 那一段保持 0ms）
    expect(chips[1].style.transitionDelay).toContain('80ms');
    expect(chips[0].style.transitionDelay).not.toContain('80ms');

    // 700ms 后逐枚淡入
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(screen.getAllByTestId('context-chip')[0].style.opacity).toBe('1');
  });

  it('收起（active=false）时不触发淡入，chip 保持隐藏', () => {
    act(() => {
      render(<ContextCardList chunks={CHUNKS} active={false} />);
    });
    expect(screen.getAllByTestId('context-chip')[0].style.opacity).toBe('0');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getAllByTestId('context-chip')[0].style.opacity).toBe('0');
  });

  it('无 chunk 不渲染列表', () => {
    const { container } = render(<ContextCardList chunks={[]} active />);
    expect(container.firstChild).toBeNull();
  });

  it('可点击 chip 渲染为 button 并触发 onClick', () => {
    const onClick = vi.fn();
    const chunk: ContextChunk = {
      key: 'click',
      title: 'Openable',
      body: 'detail',
      source: 'src/main/foo.sv',
      badge: 'SV',
      tone: 'accent',
      onClick,
    };
    render(<ContextCard chunk={chunk} />);
    const chip = screen.getByTestId('context-chip');
    expect(chip.tagName).toBe('BUTTON');
    fireEvent.click(chip);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('无可点击行为的 chip 渲染为 span（无外链图标）', () => {
    const chunk: ContextChunk = {
      key: 'plain',
      title: 'Plain',
      body: 'detail',
      source: 'case://',
    };
    render(<ContextCard chunk={chunk} />);
    const chip = screen.getByTestId('context-chip');
    expect(chip.tagName).toBe('SPAN');
  });

  it('badge tone 映射为项目语义色变量（red→--status-fail）', () => {
    const { container } = render(<ContextCard chunk={CHUNKS[0]} />);
    const badge = container.querySelector('.ap-ctx-badge') as HTMLElement;
    expect(badge.style.background).toBe('var(--status-fail)');
  });
});
