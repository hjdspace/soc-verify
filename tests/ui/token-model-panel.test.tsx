// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';

/* ── ECharts mock ── */
vi.mock('echarts-for-react', () => ({
  default: () =>
    React.createElement('div', {
      'data-testid': 'echarts-mock',
      'data-chart': 'model',
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
const mockModelBreakdownQuery = vi.fn();

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    token: {
      summary: { query: vi.fn() },
      trends: { query: vi.fn() },
      engineBreakdown: { query: vi.fn() },
      modelBreakdown: { query: (...args: unknown[]) => mockModelBreakdownQuery(...args) },
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

import { TokenModelPanel } from '@renderer/components/token/TokenModelPanel';
import { useTokenStore } from '@renderer/stores/token';

const MOCK_BREAKDOWN = [
  {
    model: 'claude-sonnet-4-20250514',
    totalTokens: 1500,
    inputTokens: 1200,
    outputTokens: 300,
    cacheReadTokens: 150,
    cacheWriteTokens: 50,
    costUsd: 0.07,
  },
  {
    model: 'gpt-4o',
    totalTokens: 2000,
    inputTokens: 1500,
    outputTokens: 500,
    cacheReadTokens: 200,
    cacheWriteTokens: 100,
    costUsd: 0.10,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  projectState.currentProjectId = 'proj-1';
  useTokenStore.setState({
    summary: null,
    trends: [],
    engineBreakdown: [],
    modelBreakdown: [],
    loading: false,
    error: null,
    timeRange: 'all',
    trendGroupBy: 'engine',
    loadedForProject: null,
  });
});

describe('TokenModelPanel — 渲染', () => {
  it('无数据显示空状态', () => {
    render(<TokenModelPanel />);
    expect(screen.getByText('暂无模型分解数据')).toBeInTheDocument();
  });

  it('有数据时渲染表格和图表', () => {
    useTokenStore.setState({ modelBreakdown: MOCK_BREAKDOWN });
    render(<TokenModelPanel />);

    expect(screen.getByTestId('token-model-table')).toBeInTheDocument();
    expect(screen.getByTestId('token-model-chart')).toBeInTheDocument();
  });

  it('渲染所有模型行', () => {
    useTokenStore.setState({ modelBreakdown: MOCK_BREAKDOWN });
    render(<TokenModelPanel />);

    expect(screen.getByText('claude-sonnet-4-20250514')).toBeInTheDocument();
    expect(screen.getByText('gpt-4o')).toBeInTheDocument();
  });

  it('渲染表头列', () => {
    useTokenStore.setState({ modelBreakdown: MOCK_BREAKDOWN });
    render(<TokenModelPanel />);

    expect(screen.getByText('模型')).toBeInTheDocument();
    expect(screen.getByText('总 Token')).toBeInTheDocument();
    expect(screen.getByText('Input')).toBeInTheDocument();
    expect(screen.getByText('Output')).toBeInTheDocument();
    expect(screen.getByText('Cache Read')).toBeInTheDocument();
    expect(screen.getByText('Cache Write')).toBeInTheDocument();
    expect(screen.getByText('Cost')).toBeInTheDocument();
    expect(screen.getByText('占比')).toBeInTheDocument();
  });

  it('计算占比百分比正确', () => {
    useTokenStore.setState({ modelBreakdown: MOCK_BREAKDOWN });
    render(<TokenModelPanel />);

    // total = 1500 + 2000 = 3500
    // gpt-4o: 2000 / 3500 = 57.1%
    // claude-sonnet: 1500 / 3500 = 42.9%
    const table = screen.getByTestId('token-model-table');
    expect(table.textContent).toContain('57.1%');
    expect(table.textContent).toContain('42.9%');
  });

  it('默认按 token 降序排列', () => {
    useTokenStore.setState({ modelBreakdown: MOCK_BREAKDOWN });
    render(<TokenModelPanel />);

    const rows = screen.getAllByTestId(/^token-model-row-/);
    expect(rows[0]).toHaveTextContent('gpt-4o'); // 2000 tokens — first
    expect(rows[1]).toHaveTextContent('claude-sonnet-4-20250514'); // 1500 — second
  });
});

describe('TokenModelPanel — 排序交互', () => {
  it('点击列头切换排序方向', () => {
    useTokenStore.setState({ modelBreakdown: MOCK_BREAKDOWN });
    render(<TokenModelPanel />);

    // Default: total tokens descending → gpt-4o first
    let rows = screen.getAllByTestId(/^token-model-row-/);
    expect(rows[0]).toHaveTextContent('gpt-4o');

    // Click "总 Token" header → switch to ascending
    fireEvent.click(screen.getByTestId('token-model-sort-totalTokens'));

    rows = screen.getAllByTestId(/^token-model-row-/);
    expect(rows[0]).toHaveTextContent('claude-sonnet-4-20250514'); // 1500 — now first

    // Click again → back to descending
    fireEvent.click(screen.getByTestId('token-model-sort-totalTokens'));

    rows = screen.getAllByTestId(/^token-model-row-/);
    expect(rows[0]).toHaveTextContent('gpt-4o'); // 2000 — first again
  });

  it('点击 Cost 列头按 cost 排序', () => {
    useTokenStore.setState({ modelBreakdown: MOCK_BREAKDOWN });
    render(<TokenModelPanel />);

    // Click "Cost" header → sort by cost descending (0.10 > 0.07)
    fireEvent.click(screen.getByTestId('token-model-sort-costUsd'));

    let rows = screen.getAllByTestId(/^token-model-row-/);
    expect(rows[0]).toHaveTextContent('gpt-4o'); // cost 0.10 — first

    // Click again → ascending
    fireEvent.click(screen.getByTestId('token-model-sort-costUsd'));

    rows = screen.getAllByTestId(/^token-model-row-/);
    expect(rows[0]).toHaveTextContent('claude-sonnet-4-20250514'); // cost 0.07 — first
  });

  it('点击模型名列头按模型名排序', () => {
    useTokenStore.setState({ modelBreakdown: MOCK_BREAKDOWN });
    render(<TokenModelPanel />);

    // Click "模型" header → sort by model name ascending
    fireEvent.click(screen.getByTestId('token-model-sort-model'));

    let rows = screen.getAllByTestId(/^token-model-row-/);
    expect(rows[0]).toHaveTextContent('claude-sonnet-4-20250514'); // 'c' < 'g'

    // Click again → descending
    fireEvent.click(screen.getByTestId('token-model-sort-model'));

    rows = screen.getAllByTestId(/^token-model-row-/);
    expect(rows[0]).toHaveTextContent('gpt-4o'); // 'g' > 'c'
  });
});

describe('TokenModelPanel — 数据加载', () => {
  it('挂载时加载模型分解数据', async () => {
    mockModelBreakdownQuery.mockResolvedValue(MOCK_BREAKDOWN);

    render(<TokenModelPanel />);

    await waitFor(() => {
      expect(mockModelBreakdownQuery).toHaveBeenCalledWith({
        projectId: 'proj-1',
        timeRange: 'all',
      });
    });
  });

  it('无项目 ID 时不加载', () => {
    projectState.currentProjectId = null;
    render(<TokenModelPanel />);
    expect(mockModelBreakdownQuery).not.toHaveBeenCalled();
  });
});
