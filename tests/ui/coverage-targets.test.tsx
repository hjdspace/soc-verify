// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TargetsSection } from '@renderer/components/coverage/TargetsSection';
import type { CoverageMetric } from '@shared/types';

/**
 * TargetsSection 覆盖率目标编辑（issues #8 真实场景接入）：
 * 8 metric 行由 ScrubField 承载（slider 手柄三路改值），保存链路走
 * coverage-gaps store 的 setTargets（trpc.coverage.setTarget 不变）。
 * 断言外部行为——偏离行业默认高亮、键盘改值进 draft、调回默认移除
 * draft 项（视为未设置）、保存 payload 正确。store mock 为纯对象，
 * trpc 不参与（loadTargets/setTargets 为注入的 store action）。
 */

const mocks = vi.hoisted(() => ({
  targets: {} as Partial<Record<CoverageMetric, number>>,
  loadTargets: vi.fn().mockResolvedValue(undefined),
  setTargets: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@renderer/stores/coverage', () => ({
  useCoverageGapsStore: (selector: (s: unknown) => unknown) =>
    selector({
      targets: mocks.targets,
      loadTargets: mocks.loadTargets,
      setTargets: mocks.setTargets,
    }),
}));

beforeEach(() => {
  mocks.targets = { line: 90, branch: 80 };
  mocks.loadTargets.mockClear();
  mocks.setTargets.mockClear();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function handle(metric: string): HTMLElement {
  return screen.getByTestId(`cov-target-${metric}-handle`);
}

describe('TargetsSection（ScrubField 接入）', () => {
  it('8 个 metric 各渲染一个 slider 行；已存目标回显，assertion 无默认取 0', () => {
    render(<TargetsSection currentProjectId="proj" currentSessionId="sess" />);
    const sliders = screen.getAllByRole('slider');
    expect(sliders).toHaveLength(8);
    expect(handle('line')).toHaveAttribute('aria-valuenow', '90');
    expect(handle('branch')).toHaveAttribute('aria-valuenow', '80');
    // toggle 无已存目标 → 回显行业默认 85；assertion 无默认 → 0
    expect(handle('toggle')).toHaveAttribute('aria-valuenow', '85');
    expect(handle('assertion')).toHaveAttribute('aria-valuenow', '0');
  });

  it('偏离行业默认的目标高亮（line 90≠95），等于默认的不高亮（toggle 85）', () => {
    render(<TargetsSection currentProjectId="proj" currentSessionId="sess" />);
    expect(screen.getByTestId('cov-target-line')).toHaveAttribute('data-edited', 'true');
    expect(screen.getByTestId('cov-target-toggle')).toHaveAttribute('data-edited', 'false');
  });

  it('键盘 ↑ 改值进 draft，保存 payload 含新值与原有未动项', async () => {
    render(<TargetsSection currentProjectId="proj" currentSessionId="sess" />);
    handle('line').focus();
    fireEvent.keyDown(handle('line'), { key: 'ArrowUp' });
    expect(handle('line')).toHaveAttribute('aria-valuenow', '91');

    fireEvent.click(screen.getByTestId('cov-target-save'));
    await waitFor(() => {
      expect(mocks.setTargets).toHaveBeenCalledTimes(1);
    });
    expect(mocks.setTargets).toHaveBeenCalledWith(
      'proj',
      'sess',
      expect.objectContaining({ line: 91, branch: 80 }),
    );
  });

  it('调回行业默认即移除 draft 项（视为未设置），保存 payload 不含该项', async () => {
    render(<TargetsSection currentProjectId="proj" currentSessionId="sess" />);
    // branch 80（默认 90）：Shift+↑ ×10 → 90 → 与默认相同 → draft 移除
    handle('branch').focus();
    fireEvent.keyDown(handle('branch'), { key: 'ArrowUp', shiftKey: true });
    expect(handle('branch')).toHaveAttribute('aria-valuenow', '90');
    expect(screen.getByTestId('cov-target-branch')).toHaveAttribute('data-edited', 'false');

    fireEvent.click(screen.getByTestId('cov-target-save'));
    await waitFor(() => {
      expect(mocks.setTargets).toHaveBeenCalledTimes(1);
    });
    const payload = mocks.setTargets.mock.calls[0]![2] as Record<string, number>;
    expect(payload).not.toHaveProperty('branch');
    expect(payload).toHaveProperty('line', 90);
  });

  it('无 session 时保存按钮禁用，不会写 store', () => {
    render(<TargetsSection currentProjectId="proj" currentSessionId={null} />);
    const save = screen.getByTestId('cov-target-save');
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(mocks.setTargets).not.toHaveBeenCalled();
  });
});
