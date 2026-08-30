// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  RecommendationCard,
  SignalMeter,
  type RecommendationOption,
} from '@renderer/components/ui/RecommendationCard';

/**
 * 通用建议卡（issues #4，参考 beautiful-ui RecommendationCard）：
 * 断言外部行为——信号条格数与着色、备选抽屉展开/收起、切换备选重置
 * accepted、CTA busy/accepted 态。动画本身不做断言（PRD 测试决策 4）。
 */

const OPTIONS: RecommendationOption[] = [
  {
    key: 'a',
    body: '方案 A：直接重排序',
    short: '方案 A',
    signal: 3,
    tone: 'var(--status-pass)',
    label: '高置信度',
    cta: '接受 A',
    ctaVariant: 'accent',
  },
  {
    key: 'b',
    body: '方案 B：切换供应商',
    short: '方案 B',
    signal: 2,
    tone: 'var(--status-aborted)',
    label: '需复核',
    cta: '配置 B',
    ctaVariant: 'primary',
  },
  {
    key: 'c',
    body: '方案 C：全量补货',
    short: '方案 C',
    signal: 0,
    tone: 'var(--muted-foreground)',
    label: '无信号',
    cta: '接受 C',
    ctaVariant: 'primary',
  },
];

afterEach(() => {
  document.body.innerHTML = '';
});

describe('SignalMeter 信号条', () => {
  it('3 根竖条，前 signal 根取 tone 色，其余取 --input（映射 --line-strong）', () => {
    const { container } = render(<SignalMeter signal={2} tone="var(--status-pass)" />);
    const bars = container.querySelectorAll('i');
    expect(bars).toHaveLength(3);
    expect(bars[0].style.background).toBe('var(--status-pass)');
    expect(bars[1].style.background).toBe('var(--status-pass)');
    expect(bars[2].style.background).toBe('var(--input)');
  });

  it('signal=0 时全部竖条为 --input', () => {
    const { container } = render(<SignalMeter signal={0} tone="var(--status-fail)" />);
    const bars = Array.from(container.querySelectorAll('i'));
    expect(bars).toHaveLength(3);
    expect(bars.every((b) => b.style.background === 'var(--input)')).toBe(true);
  });
});

describe('RecommendationCard', () => {
  it('渲染当前建议正文与页脚（信号条 + 标签 + CTA）', () => {
    render(<RecommendationCard options={OPTIONS} />);
    expect(screen.getByTestId('recommendation-card')).toBeInTheDocument();
    expect(screen.getByText('方案 A：直接重排序')).toBeInTheDocument();
    expect(screen.getByText('高置信度')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '接受 A' })).toBeInTheDocument();
  });

  it('页脚信号条格数跟随当前建议（signal=3 → 3 格 tone 色）', () => {
    render(<RecommendationCard options={OPTIONS} />);
    const cta = screen.getByRole('button', { name: '接受 A' });
    const footer = cta.closest('.ap-rec-footer');
    const bars = footer?.querySelectorAll<HTMLElement>('.ap-rec-meter i') ?? [];
    expect(bars).toHaveLength(3);
    expect(Array.from(bars).every((b) => b.style.background === 'var(--status-pass)')).toBe(true);
  });

  it('备选抽屉默认收起（grid-rows 0fr），点击开关展开（1fr）且列出其余选项', () => {
    render(<RecommendationCard options={OPTIONS} />);
    const toggle = screen.getByRole('button', { name: '备选方案' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const drawer = document.querySelector('.ap-rec-drawer') as HTMLElement;
    expect(drawer.style.gridTemplateRows).toBe('0fr');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(drawer.style.gridTemplateRows).toBe('1fr');
    // 其余 2 项进抽屉（当前项不在列）
    expect(screen.getAllByTestId('recommendation-alternative')).toHaveLength(2);
    expect(screen.getByText('方案 B')).toBeInTheDocument();
    expect(screen.getByText('方案 C')).toBeInTheDocument();
  });

  it('切换备选项提升为当前建议并重置 accepted，信号条与 CTA 随之更新', async () => {
    const onAccept = vi.fn().mockResolvedValue(undefined);
    render(<RecommendationCard options={OPTIONS} onAccept={onAccept} />);

    // 先接受当前建议 A → success 态
    fireEvent.click(screen.getByRole('button', { name: '接受 A' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '已接受' })).toBeDisabled();
    });

    // 展开抽屉并点选备选 B
    fireEvent.click(screen.getByRole('button', { name: '备选方案' }));
    fireEvent.click(screen.getByText('方案 B'));

    // B 提升为当前建议：正文/标签/CTA 更新
    expect(screen.getByText('方案 B：切换供应商')).toBeInTheDocument();
    expect(screen.getByText('需复核')).toBeInTheDocument();
    const cta = screen.getByRole('button', { name: '配置 B' });
    // accepted 已重置：CTA 回到未接受态
    expect(cta).not.toBeDisabled();
    expect(cta.className).not.toContain('bg-status-pass');

    // 页脚信号条 = B 的 2 格 tone + 1 格 input
    const bars = cta.closest('.ap-rec-footer')?.querySelectorAll<HTMLElement>('.ap-rec-meter i') ?? [];
    expect(bars).toHaveLength(3);
    expect(bars[0].style.background).toBe('var(--status-aborted)');
    expect(bars[1].style.background).toBe('var(--status-aborted)');
    expect(bars[2].style.background).toBe('var(--input)');

    // 对新建议确认：onAccept 收到备选 B 的完整契约
    fireEvent.click(cta);
    await waitFor(() => expect(onAccept).toHaveBeenCalledTimes(2));
    expect(onAccept).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'b' }));
  });

  it('CTA 确认进入 busy（禁用），resolve 后 success 态且不重复回调', async () => {
    let resolveAccept: () => void = () => {};
    const onAccept = vi.fn(
      () => new Promise<void>((resolve) => { resolveAccept = resolve; }),
    );
    render(<RecommendationCard options={[OPTIONS[0]]} onAccept={onAccept} />);

    fireEvent.click(screen.getByRole('button', { name: /接受 A/ }));
    expect(onAccept).toHaveBeenCalledTimes(1);
    // busy 中：CTA 禁用
    expect(screen.getByRole('button', { name: /接受 A/ })).toBeDisabled();

    await act(async () => { resolveAccept(); });
    const acceptedCta = screen.getByRole('button', { name: '已接受' });
    expect(acceptedCta.className).toContain('bg-status-pass');
    expect(acceptedCta).toBeDisabled();
    fireEvent.click(acceptedCta);
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('外部受控 accepted 直接呈现 success（如违例已确认）', () => {
    render(<RecommendationCard options={[OPTIONS[0]]} accepted acceptedLabel="已应用" />);
    const cta = screen.getByRole('button', { name: '已应用' });
    expect(cta.className).toContain('bg-status-pass');
    expect(cta).toBeDisabled();
  });

  it('单选项时不渲染备选抽屉开关', () => {
    render(<RecommendationCard options={[OPTIONS[0]]} />);
    expect(screen.queryByRole('button', { name: '备选方案' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('recommendation-alternatives')).not.toBeInTheDocument();
  });

  it('选项缺省 signal/tone/label 时不渲染信号条与标签（追问等无置信度场景）', () => {
    render(
      <RecommendationCard
        options={[{ key: 'q', body: '如何修改复位释放时序？', short: '追问一', cta: '发送追问', ctaVariant: 'primary' }]}
      />,
    );
    expect(document.querySelector('.ap-rec-meter')).toBeNull();
    expect(screen.queryByText('高置信度')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送追问' })).toBeInTheDocument();
  });

  it('disabled 禁用 CTA 与备选交互', () => {
    const onAccept = vi.fn();
    render(<RecommendationCard options={OPTIONS} disabled onAccept={onAccept} />);
    expect(screen.getByRole('button', { name: /接受 A/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: '备选方案' })).toBeDisabled();
    for (const row of screen.getAllByTestId('recommendation-alternative')) {
      expect(row).toBeDisabled();
    }
    fireEvent.click(screen.getAllByTestId('recommendation-alternative')[0]);
    // 备选点击无效：正文保持当前建议
    expect(screen.getByText('方案 A：直接重排序')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /接受 A/ }));
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('options 为空时渲染 null', () => {
    const { container } = render(<RecommendationCard options={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
