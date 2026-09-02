// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

/* ── trpc mock ── */
const mockSummaryQuery = vi.fn();
const mockHeatmapQuery = vi.fn();

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    token: {
      summary: {
        query: (...args: unknown[]) => mockSummaryQuery(...args),
      },
      heatmap: {
        query: (...args: unknown[]) => mockHeatmapQuery(...args),
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
    heatmap: [],
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
    currentStreak: 3,
    longestStreak: 5,
  });
  mockHeatmapQuery.mockResolvedValue([]);
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

  it('加载后显示 streak 统计（连续 + 最长）', async () => {
    render(<TokenOverviewPanel />);
    await waitFor(() => {
      expect(screen.getByTestId('token-streak-current')).toBeInTheDocument();
    });
    expect(screen.getByTestId('token-streak-current').textContent).toContain('3');
    expect(screen.getByTestId('token-streak-longest').textContent).toContain('5');
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

describe('TokenOverviewPanel — 热力图', () => {
  it('加载并渲染热力图容器', async () => {
    render(<TokenOverviewPanel />);
    await waitFor(() => {
      expect(screen.getByTestId('token-heatmap')).toBeInTheDocument();
    });
  });

  it('空热力图数据显示空状态文案', async () => {
    render(<TokenOverviewPanel />);
    await waitFor(() => {
      expect(screen.getByTestId('token-heatmap')).toBeInTheDocument();
    });
    expect(screen.getByText('暂无热力图数据')).toBeInTheDocument();
  });

  it('有数据时渲染热力图格子', async () => {
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;

    useTokenStore.setState({
      heatmap: [
        { date: todayStr, totalTokens: 1000, costUsd: 0.05 },
        { date: yesterdayStr, totalTokens: 2000, costUsd: 0.10 },
      ],
      loadedForProject: 'proj-1',
    });

    render(<TokenOverviewPanel />);
    await waitFor(() => {
      expect(screen.getByTestId('token-heatmap')).toBeInTheDocument();
    });
    // Heatmap cells should have data attributes
    const cells = screen.getAllByTestId(/^token-heatmap-cell-/);
    expect(cells.length).toBe(2);
  });
});

describe('TokenOverviewPanel — 7 天趋势 sparkline', () => {
  it('加载后渲染 sparkline 容器', async () => {
    render(<TokenOverviewPanel />);
    await waitFor(() => {
      expect(screen.getByTestId('token-sparkline')).toBeInTheDocument();
    });
  });

  it('有数据时渲染 sparkline SVG', async () => {
    const today = new Date();
    const days: Array<{ date: string; totalTokens: number; costUsd: number }> = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
      days.push({
        date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
        totalTokens: (i + 1) * 100,
        costUsd: 0,
      });
    }
    useTokenStore.setState({ heatmap: days, loadedForProject: 'proj-1' });

    render(<TokenOverviewPanel />);
    await waitFor(() => {
      expect(screen.getByTestId('token-sparkline')).toBeInTheDocument();
    });
    // SVG path should be rendered
    const svg = screen.getByTestId('token-sparkline').querySelector('svg');
    expect(svg).toBeInTheDocument();
  });
});
