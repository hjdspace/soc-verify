// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';

/* ── ECharts mock ── */
vi.mock('echarts-for-react', () => ({
  default: () =>
    React.createElement('div', {
      'data-testid': 'echarts-mock',
      'data-chart': 'engine',
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
const mockEngineBreakdownQuery = vi.fn();

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    token: {
      summary: { query: vi.fn() },
      trends: { query: vi.fn() },
      engineBreakdown: { query: (...args: unknown[]) => mockEngineBreakdownQuery(...args) },
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

import { TokenEnginePanel } from '@renderer/components/token/TokenEnginePanel';
import { useTokenStore } from '@renderer/stores/token';

const MOCK_BREAKDOWN = [
  {
    engine: 'omp',
    todayTokens: 1000,
    monthTokens: 5000,
    totalTokens: 10000,
    todayCost: 0.05,
    monthCost: 0.25,
    totalCost: 0.50,
    inputTokens: 8000,
    outputTokens: 2000,
    cacheReadTokens: 500,
    cacheWriteTokens: 200,
    reasoningTokens: 0,
  },
  {
    engine: 'claude-code',
    todayTokens: 500,
    monthTokens: 2000,
    totalTokens: 4000,
    todayCost: 0.03,
    monthCost: 0.12,
    totalCost: 0.24,
    inputTokens: 3000,
    outputTokens: 1000,
    cacheReadTokens: 300,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  },
  {
    engine: 'codex',
    todayTokens: 0,
    monthTokens: 500,
    totalTokens: 1000,
    todayCost: 0,
    monthCost: 0.02,
    totalCost: 0.04,
    inputTokens: 800,
    outputTokens: 200,
    cacheReadTokens: 100,
    cacheWriteTokens: 50,
    reasoningTokens: 0,
  },
];

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

describe('TokenEnginePanel — 渲染', () => {
  it('无数据显示空状态', () => {
    render(<TokenEnginePanel />);
    expect(screen.getByText('暂无引擎分解数据')).toBeInTheDocument();
  });

  it('有数据时渲染三列卡片', () => {
    useTokenStore.setState({ engineBreakdown: MOCK_BREAKDOWN });
    render(<TokenEnginePanel />);

    expect(screen.getByTestId('token-engine-card-omp')).toBeInTheDocument();
    expect(screen.getByTestId('token-engine-card-claude-code')).toBeInTheDocument();
    expect(screen.getByTestId('token-engine-card-codex')).toBeInTheDocument();
  });

  it('渲染引擎名称和 token 数据', () => {
    useTokenStore.setState({ engineBreakdown: MOCK_BREAKDOWN });
    render(<TokenEnginePanel />);

    expect(screen.getByText('OMP')).toBeInTheDocument();
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('Codex')).toBeInTheDocument();

    // omp total = 10,000
    const ompCard = screen.getByTestId('token-engine-card-omp');
    expect(ompCard.textContent).toContain('10,000');
  });

  it('渲染占比百分比', () => {
    useTokenStore.setState({ engineBreakdown: MOCK_BREAKDOWN });
    render(<TokenEnginePanel />);

    // omp = 10000 / 15000 = 66.7%
    const ompCard = screen.getByTestId('token-engine-card-omp');
    expect(ompCard.textContent).toContain('66.7%');
  });

  it('挂载时加载引擎分解数据', async () => {
    mockEngineBreakdownQuery.mockResolvedValue(MOCK_BREAKDOWN);

    render(<TokenEnginePanel />);

    await waitFor(() => {
      expect(mockEngineBreakdownQuery).toHaveBeenCalledWith({
        projectId: 'proj-1',
        timeRange: 'all',
      });
    });
  });

  it('无项目 ID 时不加载', () => {
    projectState.currentProjectId = null;
    render(<TokenEnginePanel />);
    expect(mockEngineBreakdownQuery).not.toHaveBeenCalled();
  });
});

describe('TokenEnginePanel — Cache 细节展开', () => {
  it('点击展开按钮显示 cache 细节', () => {
    useTokenStore.setState({ engineBreakdown: MOCK_BREAKDOWN });
    render(<TokenEnginePanel />);

    const expandBtn = screen.getByTestId('token-engine-expand-omp');
    expect(screen.queryByTestId('token-engine-cache-omp')).not.toBeInTheDocument();

    fireEvent.click(expandBtn);

    expect(screen.getByTestId('token-engine-cache-omp')).toBeInTheDocument();
    expect(screen.getByText('Cache 命中率')).toBeInTheDocument();
  });

  it('再次点击收起 cache 细节', () => {
    useTokenStore.setState({ engineBreakdown: MOCK_BREAKDOWN });
    render(<TokenEnginePanel />);

    const expandBtn = screen.getByTestId('token-engine-expand-omp');
    fireEvent.click(expandBtn);
    expect(screen.getByTestId('token-engine-cache-omp')).toBeInTheDocument();

    fireEvent.click(expandBtn);
    expect(screen.queryByTestId('token-engine-cache-omp')).not.toBeInTheDocument();
  });

  it('cache 命中率计算正确', () => {
    useTokenStore.setState({ engineBreakdown: MOCK_BREAKDOWN });
    render(<TokenEnginePanel />);

    // omp: cacheRead=500, input=8000 → hitRate = 500/8500 = 5.9%
    fireEvent.click(screen.getByTestId('token-engine-expand-omp'));
    const cacheDetail = screen.getByTestId('token-engine-cache-omp');
    expect(cacheDetail.textContent).toContain('5.9%');
  });
});
