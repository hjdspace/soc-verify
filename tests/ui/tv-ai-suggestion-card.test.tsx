// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Mock tRPC / toast — store 模块导入 trpc 需要 electron 环境（先例 tv-dashboard.test.tsx）。
// confirmations store 的动作在用例中直接以 vi.fn 覆写，trpc 不会被真正调用。
vi.mock('@renderer/lib/trpc', () => ({ trpc: {} }));

vi.mock('@renderer/lib/trpc-utils', () => ({
  tRPCError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  getToast: () => ({ error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }),
}));

vi.mock('@renderer/stores/project', () => ({
  useProjectStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ currentProjectId: 'p1' }),
  ),
}));

import { TVAISuggestionCard } from '@renderer/components/chat/TVAISuggestionCard';
import { useTvDataStore, useTvConfirmationsStore } from '@renderer/stores/timing-violation';
import type { ViolationWithConfirmation } from '@renderer/stores/timing-violation';

/**
 * TVAISuggestionCard 重构到通用建议卡（RecommendationCard）后的行为回归：
 * 确认/拒绝/重新分析仍写 tv-confirmations store，TV 字段映射与置信度
 * 信号条正确呈现。
 */

const SUGGESTION_JSON = JSON.stringify({
  confirmer: 'alice',
  result: 'pass',
  reason: '复位释放满足建立时间',
  confidence: 0.85,
  analysis: 'slack 为正，建议确认',
});

function makeViolation(overrides: Partial<ViolationWithConfirmation> = {}): ViolationWithConfirmation {
  return {
    id: 1,
    caseName: 'case_a',
    corner: null,
    seed: null,
    subsys: null,
    num: 7,
    hier: 'u_core',
    timeFs: 1234.5,
    timeDisplay: '1.23us',
    checkInfo: '',
    filePath: '',
    createdAt: '',
    status: 'pending',
    confirmer: null,
    result: null,
    reason: null,
    isAutoConfirmed: false,
    confirmedAt: null,
    ...overrides,
  };
}

describe('TVAISuggestionCard（RecommendationCard TV 场景）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTvDataStore.setState({ violations: [makeViolation()] });
    useTvConfirmationsStore.setState({
      applyAISuggestion: vi.fn().mockResolvedValue(undefined),
      clearAISuggestion: vi.fn(),
      startAISuggestion: vi.fn().mockResolvedValue(null),
    });
  });

  it('渲染为通用建议卡：违例上下文 + 字段行 + 3 格信号条 + 置信度标签', () => {
    render(<TVAISuggestionCard content={SUGGESTION_JSON} violationId={1} />);
    expect(screen.getByTestId('recommendation-card')).toBeInTheDocument();
    expect(screen.getByText('AI 分析建议')).toBeInTheDocument();
    // 违例上下文 preface
    expect(screen.getByText('Vio#7')).toBeInTheDocument();
    // 结构化字段行
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.getByText('✓ Pass')).toBeInTheDocument();
    expect(screen.getByText('复位释放满足建立时间')).toBeInTheDocument();
    // confidence 0.85 → 3 格信号条 + 高置信度 85%
    expect(screen.getByText('高置信度 85%')).toBeInTheDocument();
    const bars = document.querySelectorAll<HTMLElement>('.ap-rec-footer .ap-rec-meter i');
    expect(bars).toHaveLength(3);
    expect(Array.from(bars).every((b) => b.style.background === 'var(--status-pass)')).toBe(true);
  });

  it('确认并应用走 applyAISuggestion 写 confirmation store，成功后 CTA success 态', async () => {
    const applyAISuggestion = useTvConfirmationsStore.getState().applyAISuggestion;
    render(<TVAISuggestionCard content={SUGGESTION_JSON} violationId={1} />);

    fireEvent.click(screen.getByRole('button', { name: /确认并应用/ }));
    await waitFor(() => expect(applyAISuggestion).toHaveBeenCalledTimes(1));
    expect(applyAISuggestion).toHaveBeenCalledWith(
      'p1',
      1,
      expect.objectContaining({ confirmer: 'alice', result: 'pass' }),
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '已应用' })).toBeDisabled();
    });
  });

  it('拒绝清除 AI 建议并禁用全部操作', () => {
    const clearAISuggestion = useTvConfirmationsStore.getState().clearAISuggestion;
    render(<TVAISuggestionCard content={SUGGESTION_JSON} violationId={1} />);

    fireEvent.click(screen.getByRole('button', { name: /拒绝/ }));
    expect(clearAISuggestion).toHaveBeenCalledTimes(1);
    // 拒绝按钮与 CTA 均进入「已拒绝」禁用态（对齐原卡行为）
    for (const b of screen.getAllByRole('button', { name: '已拒绝' })) {
      expect(b).toBeDisabled();
    }
    expect(screen.getByRole('button', { name: /重新分析/ })).toBeDisabled();
  });

  it('重新分析走 startAISuggestion（projectId + violationId 不变）', async () => {
    const startAISuggestion = useTvConfirmationsStore.getState().startAISuggestion;
    render(<TVAISuggestionCard content={SUGGESTION_JSON} violationId={1} />);

    fireEvent.click(screen.getByRole('button', { name: /重新分析/ }));
    await waitFor(() => expect(startAISuggestion).toHaveBeenCalledWith('p1', 1));
  });

  it('违例已确认时 CTA 直接呈现已应用态', () => {
    useTvDataStore.setState({ violations: [makeViolation({ status: 'confirmed' })] });
    render(<TVAISuggestionCard content={SUGGESTION_JSON} violationId={1} />);
    expect(screen.getByRole('button', { name: '已应用' })).toBeDisabled();
  });

  it('confidence 为 0 时不渲染信号条与置信度标签', () => {
    render(
      <TVAISuggestionCard
        content={JSON.stringify({ confirmer: 'bob', result: 'issue', confidence: 0 })}
        violationId={1}
      />,
    );
    expect(document.querySelector('.ap-rec-meter')).toBeNull();
    expect(screen.getByText('✗ Issue')).toBeInTheDocument();
  });

  it('confirmer/result 不全时不渲染确认 CTA（防止不写 store 的假 success 态）', () => {
    render(
      <TVAISuggestionCard
        content={JSON.stringify({ confirmer: 'bob', reason: '仅确认人，缺结果', confidence: 0.5 })}
        violationId={1}
      />,
    );
    expect(screen.getByTestId('recommendation-card')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /确认并应用/ })).not.toBeInTheDocument();
    // 重新分析/拒绝仍可用
    expect(screen.getByRole('button', { name: /重新分析/ })).not.toBeDisabled();
  });

  it('非 TV 建议 JSON 不渲染卡片（由调用方回退 Markdown 渲染）', () => {
    const { container } = render(<TVAISuggestionCard content="普通回复文本" violationId={1} />);
    expect(container).toBeEmptyDOMElement();
  });
});
