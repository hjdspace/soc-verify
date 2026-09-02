// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';

/* ── ECharts mock ── */
vi.mock('echarts-for-react', () => ({
  default: () =>
    React.createElement('div', {
      'data-testid': 'echarts-mock',
      'data-chart': 'trends',
    }),
}));

/* ── ECharts theme mock ── */
const mockTheme = {
  backgroundColor: 'transparent',
  textColor: '#333',
  borderColor: '#ccc',
  mutedColor: '#999',
  cardColor: '#fff',
  cardForegroundColor: '#333',
  colors: ['#5470c6', '#91cc75', '#fac858', '#ee6666'],
  statusPass: '#91cc75',
  statusFail: '#ee6666',
  statusError: '#ee6666',
  statusRunning: '#73c0de',
  chartOmp: '#fac858',
  chartClaude: '#ee6666',
  chartCodex: '#91cc75',
  toDefaults: () => ({
    backgroundColor: 'transparent',
    textStyle: { color: '#333' },
    color: ['#5470c6', '#91cc75', '#fac858', '#ee6666'],
  }),
};

vi.mock('@renderer/lib/echarts-theme', () => ({
  getEChartsTheme: () => mockTheme,
  onThemeChange: () => () => {},
}));

/* ── trpc mock ── */
const mockTrendsQuery = vi.fn();

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    token: {
      summary: { query: vi.fn() },
      trends: { query: (...args: unknown[]) => mockTrendsQuery(...args) },
      engineBreakdown: { query: vi.fn() },
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

import { TokenTrendsPanel } from '@renderer/components/token/TokenTrendsPanel';
import { useTokenStore } from '@renderer/stores/token';

beforeEach(() => {
  vi.clearAllMocks();
  projectState.currentProjectId = 'proj-1';
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
});

describe('TokenTrendsPanel — 渲染', () => {
  it('无数据显示空状态', () => {
    render(<TokenTrendsPanel />);
    expect(screen.getByText('暂无趋势数据')).toBeInTheDocument();
  });

  it('有数据时渲染图表和切换按钮', async () => {
    useTokenStore.setState({
      trends: [
        { date: '2026-09-01', groups: [{ group: 'omp', totalTokens: 1000 }] },
        { date: '2026-09-02', groups: [{ group: 'omp', totalTokens: 2000 }] },
      ],
    });

    render(<TokenTrendsPanel />);

    expect(screen.getByTestId('token-trends-chart')).toBeInTheDocument();
    expect(screen.getByText('按引擎')).toBeInTheDocument();
    expect(screen.getByText('按模型')).toBeInTheDocument();
  });

  it('切换分色维度触发重新加载', async () => {
    useTokenStore.setState({
      trends: [{ date: '2026-09-01', groups: [{ group: 'omp', totalTokens: 1000 }] }],
    });

    render(<TokenTrendsPanel />);

    // 默认按引擎高亮
    const engineBtn = screen.getByText('按引擎');
    const modelBtn = screen.getByText('按模型');
    expect(engineBtn.className).toContain('bg-primary');
    expect(modelBtn.className).not.toContain('bg-primary');

    // 切换到按模型
    fireEvent.click(modelBtn);

    expect(useTokenStore.getState().trendGroupBy).toBe('model');
  });

  it('挂载时加载趋势数据', async () => {
    mockTrendsQuery.mockResolvedValue([
      { date: '2026-09-01', groups: [{ group: 'omp', totalTokens: 500 }] },
    ]);

    render(<TokenTrendsPanel />);

    await waitFor(() => {
      expect(mockTrendsQuery).toHaveBeenCalledWith({
        projectId: 'proj-1',
        timeRange: 'all',
        groupBy: 'engine',
      });
    });
  });

  it('无项目 ID 时不加载', () => {
    projectState.currentProjectId = null;
    render(<TokenTrendsPanel />);
    expect(mockTrendsQuery).not.toHaveBeenCalled();
  });
});
