// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

/* ── trpc mock ── */
const mockSummaryQuery = vi.fn();

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    token: {
      summary: {
        query: (...args: unknown[]) => mockSummaryQuery(...args),
      },
    },
  },
}));

/* ── toast store mock ── */
vi.mock('@renderer/stores/toast', () => ({
  useToastStore: {
    getState: () => ({ error: vi.fn() }),
  },
}));

/* ── project store mock ── */
const projectState = vi.hoisted(() => ({ currentProjectId: 'proj-1' as string | null }));
vi.mock('@renderer/stores/project', () => ({
  useProjectStore: (selector: (s: { currentProjectId: string | null }) => unknown) =>
    selector(projectState),
}));

import { TokenOverviewPanel } from '@renderer/components/token/TokenOverviewPanel';
import { useTokenStore } from '@renderer/stores/token';

beforeEach(() => {
  vi.clearAllMocks();
  useTokenStore.setState({
    summary: null,
    trends: [],
    engineBreakdown: [],
    loading: false,
    error: null,
    timeRange: 'all',
    trendGroupBy: 'engine',
    loadedForProject: null,
  });
  projectState.currentProjectId = 'proj-1';
  mockSummaryQuery.mockResolvedValue({
    todayTokens: 12000,
    monthTokens: 150000,
    totalTokens: 500000,
    todayCostUsd: 0.038,
  });
});

describe('TokenOverviewPanel — 渲染', () => {
  it('渲染标题与时间范围选择器', async () => {
    render(<TokenOverviewPanel />);
    expect(screen.getByText('Token Monitor')).toBeInTheDocument();
    expect(screen.getByTestId('token-time-range-all')).toBeInTheDocument();
    expect(screen.getByTestId('token-time-range-7d')).toBeInTheDocument();
    expect(screen.getByTestId('token-time-range-30d')).toBeInTheDocument();
  });

  it('加载后显示四张 KPI 卡片', async () => {
    render(<TokenOverviewPanel />);
    await waitFor(() => {
      expect(screen.getByTestId('token-kpi-today')).toBeInTheDocument();
    });
    expect(screen.getByTestId('token-kpi-today').textContent).toContain('12,000');
    expect(screen.getByTestId('token-kpi-month').textContent).toContain('150,000');
    expect(screen.getByTestId('token-kpi-total').textContent).toContain('500,000');
    expect(screen.getByTestId('token-kpi-cost').textContent).toContain('$0.038');
  });

  it('加载中显示加载文本', async () => {
    mockSummaryQuery.mockImplementation(
      () => new Promise(() => { /* never resolves */ }),
    );
    render(<TokenOverviewPanel />);
    await waitFor(() => {
      expect(screen.getByText('加载中…')).toBeInTheDocument();
    });
  });

  it('加载失败显示错误信息', async () => {
    mockSummaryQuery.mockRejectedValue(new Error('DB not found'));
    render(<TokenOverviewPanel />);
    await waitFor(() => {
      expect(screen.getByText(/DB not found/)).toBeInTheDocument();
    });
  });

  it('无数据显示空状态', async () => {
    projectState.currentProjectId = null;
    render(<TokenOverviewPanel />);
    expect(screen.getByText('暂无 Token 用量数据')).toBeInTheDocument();
  });
});

describe('TokenOverviewPanel — 时间范围选择', () => {
  it('切换时间范围触发重新加载', async () => {
    render(<TokenOverviewPanel />);
    await waitFor(() => {
      expect(mockSummaryQuery).toHaveBeenCalledTimes(1);
    });
    expect(mockSummaryQuery).toHaveBeenLastCalledWith({
      projectId: 'proj-1',
      timeRange: 'all',
    });

    fireEvent.click(screen.getByTestId('token-time-range-7d'));

    await waitFor(() => {
      expect(mockSummaryQuery).toHaveBeenCalledTimes(2);
    });
    expect(mockSummaryQuery).toHaveBeenLastCalledWith({
      projectId: 'proj-1',
      timeRange: '7d',
    });
  });

  it('选中态视觉反馈：当前选项高亮', async () => {
    render(<TokenOverviewPanel />);
    await waitFor(() => {
      expect(screen.getByTestId('token-kpi-today')).toBeInTheDocument();
    });

    const allBtn = screen.getByTestId('token-time-range-all');
    const sevenBtn = screen.getByTestId('token-time-range-7d');

    expect(allBtn.className).toContain('text-primary');
    expect(sevenBtn.className).not.toContain('text-primary');

    fireEvent.click(sevenBtn);

    expect(sevenBtn.className).toContain('text-primary');
    expect(allBtn.className).not.toContain('text-primary');
  });
});
