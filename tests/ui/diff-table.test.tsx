// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  DiffTable,
  DiffBadge,
  type DiffRow,
} from '@renderer/components/ui/DiffTable';

/**
 * 批量编辑采纳表（issues #6，参考 beautiful-ui DiffTable）：
 * 断言外部行为——stage 推进后的 DOM 形态（着色/展开/页脚出现）、
 * 逐行勾选与页脚统计联动、0 项禁用 Apply、Apply 后冻结与确认 pill。
 * CSS 动画本身不做断言（PRD 测试决策 4）。
 */

const ROWS: DiffRow[] = [
  { key: 'r1', kind: 'removal', label: '删除 case_a.timeout', cells: ['case_a.timeout', '10s → 删除'] },
  { key: 'r2', kind: 'removal', label: '删除 case_b.verbosity', cells: ['case_b.verbosity', 'high → 删除'] },
  { key: 'a1', kind: 'addition', label: '新增 case_a.timeout 调整', cells: ['case_a.timeout', '10s → 30s'] },
];

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/** stageDelays=[0,0] 下等待 stage 状态机推进到 settled（两段 setTimeout 链） */
async function settle() {
  await waitFor(() => {
    expect(screen.getByTestId('diff-footer')).toBeInTheDocument();
  });
}

function getRow(key: string): HTMLElement {
  return screen.getByTestId(`diff-row-${key}`);
}

describe('DiffTable', () => {
  it('stage 0：删除行未着色、无页脚、新增行收起（0fr）', () => {
    render(<DiffTable title="提议修改" columns={['参数', '变更']} rows={ROWS} />);
    expect(screen.getByTestId('diff-table')).toBeInTheDocument();
    expect(screen.getByText('参数')).toBeInTheDocument();
    expect(getRow('r1')).not.toHaveClass('ap-diff-row-out');
    expect(screen.queryByTestId('diff-footer')).not.toBeInTheDocument();
    expect(screen.getByTestId('diff-additions').style.gridTemplateRows).toBe('0fr');
  });

  it('stage 推进（默认延迟）：删除行先着色，settled 后新增行展开 + 页脚 fade-up + 提示出现', async () => {
    render(<DiffTable title="提议修改" columns={['参数', '变更']} rows={ROWS} />);
    // stage 1（~180ms）：删除行着色，页脚尚未出现
    await waitFor(() => expect(getRow('r1')).toHaveClass('ap-diff-row-out'));
    expect(screen.queryByTestId('diff-footer')).not.toBeInTheDocument();
    // stage 2（~440ms）：settled
    await waitFor(() => expect(screen.getByTestId('diff-footer')).toBeInTheDocument());
    expect(screen.getByTestId('diff-additions').style.gridTemplateRows).toBe('1fr');
    expect(screen.getByText('点击变更行以切换采纳')).toBeInTheDocument();
    expect(screen.getByTestId('diff-stats')).toHaveTextContent('2 项删除 · 1 项新增');
  });

  it('stageDelays=[0,0] 注入后同步推进到 settled', async () => {
    render(
      <DiffTable title="提议修改" columns={['参数', '变更']} rows={ROWS} stageDelays={[0, 0]} />,
    );
    await settle();
    expect(screen.getByTestId('diff-footer')).toBeInTheDocument();
  });

  it('逐行取消勾选即时反映：行褪色 + 页脚统计减少；重新勾选恢复', async () => {
    render(
      <DiffTable title="提议修改" columns={['参数', '变更']} rows={ROWS} stageDelays={[0, 0]} />,
    );
    await settle();

    fireEvent.click(getRow('r1'));
    expect(getRow('r1')).toHaveAttribute('aria-checked', 'false');
    expect(getRow('r1')).not.toHaveClass('ap-diff-row-out');
    expect(screen.getByTestId('diff-stats')).toHaveTextContent('1 项删除 · 1 项新增');

    fireEvent.click(getRow('a1'));
    expect(getRow('a1')).toHaveAttribute('aria-checked', 'false');
    expect(getRow('a1')).not.toHaveClass('ap-diff-row-add-in');
    expect(screen.getByTestId('diff-stats')).toHaveTextContent('1 项删除 · 0 项新增');

    // 重新勾选恢复
    fireEvent.click(getRow('r1'));
    expect(screen.getByTestId('diff-stats')).toHaveTextContent('2 项删除 · 0 项新增');
  });

  it('键盘 Enter/Space 切换勾选', async () => {
    render(
      <DiffTable title="提议修改" columns={['参数', '变更']} rows={ROWS} stageDelays={[0, 0]} />,
    );
    await settle();
    expect(getRow('r1')).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(getRow('r1'), { key: 'Enter' });
    expect(getRow('r1')).toHaveAttribute('aria-checked', 'false');
    fireEvent.keyDown(getRow('r1'), { key: ' ' });
    expect(getRow('r1')).toHaveAttribute('aria-checked', 'true');
  });

  it('全部取消时统计为 0 且 Apply 禁用（点击不回调）', async () => {
    const onApply = vi.fn();
    render(
      <DiffTable
        title="提议修改"
        columns={['参数', '变更']}
        rows={ROWS}
        stageDelays={[0, 0]}
        onApply={onApply}
      />,
    );
    await settle();
    fireEvent.click(getRow('r1'));
    fireEvent.click(getRow('r2'));
    fireEvent.click(getRow('a1'));
    expect(screen.getByTestId('diff-stats')).toHaveTextContent('0 项删除 · 0 项新增');
    const apply = screen.getByRole('button', { name: '应用 0 项变更' });
    expect(apply).toBeDisabled();
    fireEvent.click(apply);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('Apply 成功后冻结：确认 pill 出现、行交互关闭、CTA 消失', async () => {
    const onApply = vi.fn().mockResolvedValue(undefined);
    render(
      <DiffTable
        title="提议修改"
        columns={['参数', '变更']}
        rows={ROWS}
        stageDelays={[0, 0]}
        onApply={onApply}
      />,
    );
    await settle();

    // 取消一行再应用：pill 统计只含采纳项
    fireEvent.click(getRow('r2'));
    fireEvent.click(screen.getByRole('button', { name: '应用 2 项变更' }));
    expect(onApply).toHaveBeenCalledWith({ removals: ['r1'], additions: ['a1'] });

    const pill = await screen.findByTestId('diff-applied');
    expect(pill).toHaveTextContent('2 项变更已应用');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('diff-stats')).not.toBeInTheDocument();
    expect(screen.queryByText('点击变更行以切换采纳')).not.toBeInTheDocument();

    // 冻结后点击行不再改变勾选态
    fireEvent.click(getRow('r1'));
    expect(getRow('r1')).toHaveAttribute('aria-checked', 'true');
  });

  it('onApply pending 期间 busy：按钮禁用、行交互冻结；reject 后不进入 accepted', async () => {
    let rejectApply: () => void = () => {};
    const onApply = vi.fn(
      () => new Promise<void>((_, reject) => { rejectApply = reject; }),
    );
    render(
      <DiffTable
        title="提议修改"
        columns={['参数', '变更']}
        rows={ROWS}
        stageDelays={[0, 0]}
        onApply={onApply}
      />,
    );
    await settle();

    fireEvent.click(screen.getByRole('button', { name: '应用 3 项变更' }));
    // busy 中：按钮禁用、行不可交互
    expect(screen.getByRole('button', { name: /应用 3 项变更/ })).toBeDisabled();
    fireEvent.click(getRow('r1'));
    expect(getRow('r1')).toHaveAttribute('aria-checked', 'true');

    // 失败：回退可交互，未进入 accepted（可重试）
    await act(async () => { rejectApply(); });
    const apply = screen.getByRole('button', { name: '应用 3 项变更' });
    expect(apply).not.toBeDisabled();
    fireEvent.click(getRow('r1'));
    expect(getRow('r1')).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByTestId('diff-applied')).not.toBeInTheDocument();
  });

  it('rows 为空时渲染 null；DiffBadge 渲染圆点 pill', () => {
    const { container } = render(
      <DiffTable title="提议修改" columns={['参数']} rows={[]} />,
    );
    expect(container).toBeEmptyDOMElement();

    render(<DiffBadge dot="var(--primary)">Classic</DiffBadge>);
    const badge = screen.getByText('Classic').closest('.ap-diff-badge') as HTMLElement;
    expect(badge).toBeInTheDocument();
    expect(badge.querySelector('i')?.style.background).toBe('var(--primary)');
  });
});
