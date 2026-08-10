// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ─── Mock ECharts theme ─────────────────────────────────────

const mockTheme = {
  backgroundColor: 'transparent',
  textColor: '#333',
  borderColor: '#ccc',
  mutedColor: '#999',
  colors: ['#5470c6', '#91cc75', '#fac858', '#ee6666'],
  statusPass: '#91cc75',
  statusFail: '#ee6666',
  statusError: '#ee6666',
  statusRunning: '#73c0de',
  toDefaults: () => ({
    backgroundColor: 'transparent',
    textStyle: { color: '#333' },
    color: ['#5470c6', '#91cc75', '#fac858', '#ee6666'],
  }),
};

vi.mock('@renderer/lib/echarts-theme', () => ({
  getEChartsTheme: () => mockTheme,
  onThemeChange: () => () => {},
  startThemeObserver: () => {},
  stopThemeObserver: () => {},
  rebuildTheme: () => mockTheme,
  resetThemeState: () => {},
}));

// ─── Mock ECharts component ─────────────────────────────────

vi.mock('echarts-for-react', () => ({
  default: () => React.createElement('div', { 'data-testid': 'echarts-mock' }),
}));

// ─── Mock tRPC ──────────────────────────────────────────────

vi.mock('@renderer/lib/trpc', () => {
  const mockSummaryData = {
    subsysCount: 2,
    caseCount: 5,
    passRate: 60.0,
    failCount: 2,
    trend7d: [
      { date: '2024-01-01', pass: 1, fail: 0, error: 0 },
      { date: '2024-01-02', pass: 0, fail: 1, error: 0 },
      { date: '2024-01-03', pass: 2, fail: 0, error: 0 },
      { date: '2024-01-04', pass: 0, fail: 0, error: 0 },
      { date: '2024-01-05', pass: 1, fail: 1, error: 0 },
      { date: '2024-01-06', pass: 0, fail: 0, error: 0 },
      { date: '2024-01-07', pass: 1, fail: 0, error: 0 },
    ],
  };
  const mockSubsysStatusData = [
    { name: 'cpu', caseCount: 3, pass: 2, fail: 1, passRate: 66.7 },
    { name: 'gpu', caseCount: 2, pass: 1, fail: 1, passRate: 50.0 },
  ];
  const mockTrendData = [
    { date: '2024-01-01', pass: 1, fail: 0, error: 0 },
    { date: '2024-01-02', pass: 0, fail: 1, error: 0 },
    { date: '2024-01-03', pass: 2, fail: 1, error: 0 },
  ];
  return {
    trpc: {
      dashboard: {
        getSubsysList: { query: vi.fn().mockResolvedValue([]) },
        getSummary: { query: vi.fn().mockResolvedValue(mockSummaryData) },
        getSubsysStatus: { query: vi.fn().mockResolvedValue(mockSubsysStatusData) },
        getTrend: { query: vi.fn().mockResolvedValue(mockTrendData) },
        saveLayout: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
        getLayout: { query: vi.fn().mockResolvedValue(null) },
      },
    },
  };
});

// ─── Mock project store ─────────────────────────────────────

vi.mock('@renderer/stores/project', () => ({
  useProjectStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ currentProjectId: 'test-project-id' }),
  ),
}));

// ─── Import after mocks ─────────────────────────────────────

import { DashboardPanel } from '@renderer/components/dashboard/DashboardPanel';
import { useDashboardStore } from '@renderer/stores/dashboard';
import React from 'react';

/** Reset dashboard store to initial state between tests */
function resetDashboardStore() {
  useDashboardStore.setState({
    activeTab: 'overview',
    selectedSubsys: null,
    timeRange: 'all',
    subsysList: [],
    subsysListLoading: false,
    summary: null,
    subsysStatus: null,
    trend: null,
    trendGranularity: 'daily',
    tabLoaded: {},
    tabError: {},
    loadingTab: null,
    layoutLoaded: false,
  });
}

// ─── Tests ──────────────────────────────────────────────────

describe('DashboardPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDashboardStore();
  });

  // ─── 标签页渲染 ───────────────────────────────────────────

  describe('tab rendering', () => {
    it('renders all 9 tabs with correct labels', () => {
      render(<DashboardPanel />);

      expect(screen.getByText('概览')).toBeTruthy();
      expect(screen.getByText('趋势')).toBeTruthy();
      expect(screen.getByText('子系统')).toBeTruthy();
      expect(screen.getByText('失败')).toBeTruthy();
      expect(screen.getByText('回归')).toBeTruthy();
      expect(screen.getByText('耗时')).toBeTruthy();
      expect(screen.getByText('不稳定')).toBeTruthy();
      expect(screen.getByText('阶段')).toBeTruthy();
      expect(screen.getByText('调试难度')).toBeTruthy();
    });

    it('shows overview tab as active by default', () => {
      render(<DashboardPanel />);

      const overviewTab = screen.getByText('概览');
      expect(overviewTab.closest('[data-active="true"]')).toBeTruthy();
    });
  });

  // ─── 标签页切换 ───────────────────────────────────────────

  describe('tab switching', () => {
    it('switches active tab when clicked', () => {
      render(<DashboardPanel />);

      fireEvent.click(screen.getByText('趋势'));

      const trendTab = screen.getByText('趋势');
      expect(trendTab.closest('[data-active="true"]')).toBeTruthy();
    });

    it('shows different empty state hint when switching tabs', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.dashboard.getSummary.query).mockResolvedValue({
        subsysCount: 0, caseCount: 0, passRate: 0, failCount: 0, trend7d: [],
      });
      vi.mocked(trpc.dashboard.getTrend.query).mockResolvedValue([]);

      render(<DashboardPanel />);

      // Wait for overview tab to settle
      await waitFor(() => {
        expect(screen.getByText(/汇总指标卡片和子系统状态表/)).toBeTruthy();
      });

      // Switch to trend tab
      fireEvent.click(screen.getByText('趋势'));
      await waitFor(() => {
        expect(screen.getByText(/每日\/每周 pass\/fail 趋势折线图/)).toBeTruthy();
      });

      // Switch to failures tab
      fireEvent.click(screen.getByText('失败'));
      await waitFor(() => {
        expect(screen.getByText(/最近失败用例列表/)).toBeTruthy();
      });
    });
  });

  // ─── 工具栏 ───────────────────────────────────────────────

  describe('toolbar', () => {
    it('renders subsystem dropdown with "全部子系统" default', () => {
      render(<DashboardPanel />);

      const subsysSelect = screen.getByDisplayValue('全部子系统');
      expect(subsysSelect).toBeTruthy();
    });

    it('renders time range selector with all options', () => {
      render(<DashboardPanel />);

      const timeRangeSelect = screen.getByDisplayValue('全部');
      expect(timeRangeSelect).toBeTruthy();

      const options = timeRangeSelect.querySelectorAll('option');
      const optionTexts = Array.from(options).map((o) => o.textContent);
      expect(optionTexts).toContain('全部');
      expect(optionTexts).toContain('最近7天');
      expect(optionTexts).toContain('最近30天');
    });

    it('renders refresh button', () => {
      render(<DashboardPanel />);

      const refreshButton = screen.getByTitle('刷新');
      expect(refreshButton).toBeTruthy();
    });

    it('changes time range when selecting different option', () => {
      render(<DashboardPanel />);

      const timeRangeSelect = screen.getByDisplayValue('全部');
      fireEvent.change(timeRangeSelect, { target: { value: '7d' } });

      expect(screen.getByDisplayValue('最近7天')).toBeTruthy();
    });

    it('populates subsystem dropdown from getSubsysList', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.dashboard.getSubsysList.query).mockResolvedValue(['cpu', 'gpu', 'axi']);

      render(<DashboardPanel />);

      await waitFor(() => {
        const select = screen.getByDisplayValue('全部子系统');
        const options = select.querySelectorAll('option');
        const optionTexts = Array.from(options).map((o) => o.textContent);
        expect(optionTexts).toContain('cpu');
        expect(optionTexts).toContain('gpu');
        expect(optionTexts).toContain('axi');
      });
    });
  });

  // ─── 空状态 ───────────────────────────────────────────────

  describe('empty state', () => {
    it('shows overview hint on overview tab when no data', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.dashboard.getSummary.query).mockResolvedValue({
        subsysCount: 0, caseCount: 0, passRate: 0, failCount: 0, trend7d: [],
      });

      render(<DashboardPanel />);
      await waitFor(() => {
        expect(screen.getByText(/汇总指标卡片和子系统状态表/)).toBeTruthy();
      });
    });

    it('shows regression hint on regression tab', async () => {
      render(<DashboardPanel />);

      fireEvent.click(screen.getByText('回归'));
      await waitFor(() => {
        expect(screen.getByText(/回归进度环形图/)).toBeTruthy();
      });
    });

    it('shows debug difficulty hint on debug tab', async () => {
      render(<DashboardPanel />);

      fireEvent.click(screen.getByText('调试难度'));
      await waitFor(() => {
        expect(screen.getByText(/调试难度散点图/)).toBeTruthy();
      });
    });
  });

  // ─── 概览标签页内容 ─────────────────────────────────────

  describe('overview tab content', () => {
    function setupOverviewTab() {
      useDashboardStore.setState({
        activeTab: 'overview',
        summary: {
          subsysCount: 2,
          caseCount: 5,
          passRate: 60.0,
          failCount: 2,
          trend7d: [],
        },
        subsysStatus: [
          { name: 'cpu', caseCount: 3, pass: 2, fail: 1, passRate: 66.7 },
          { name: 'gpu', caseCount: 2, pass: 1, fail: 1, passRate: 50.0 },
        ],
        tabLoaded: { overview: true },
        loadingTab: null,
      });
    }

    it('renders metric cards with summary data', async () => {
      setupOverviewTab();

      render(<DashboardPanel />);

      // Should show the subsysCount from mock data in a metric card
      await waitFor(() => {
        // subsysCount=2 and caseCount=5 should both be rendered as metric card values
        const twos = screen.getAllByText('2');
        expect(twos.length).toBeGreaterThanOrEqual(1);
      });
    });

    it('renders subsystem status table with per-subsystem data', async () => {
      setupOverviewTab();

      render(<DashboardPanel />);

      // Both cpu and gpu should appear in the subsystem status table
      await waitFor(() => {
        expect(screen.getAllByText('cpu').length).toBeGreaterThanOrEqual(1);
      });
      expect(screen.getAllByText('gpu').length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── 趋势标签页内容 ─────────────────────────────────────

  describe('trend tab content', () => {
    // Pre-set store state to bypass async loading timing issues
    function setupTrendTab() {
      useDashboardStore.setState({
        activeTab: 'trend',
        trend: [
          { date: '2024-01-01', pass: 1, fail: 0, error: 0 },
          { date: '2024-01-02', pass: 0, fail: 1, error: 0 },
          { date: '2024-01-03', pass: 2, fail: 1, error: 0 },
        ],
        tabLoaded: { overview: true, trend: true },
        summary: {
          subsysCount: 2,
          caseCount: 5,
          passRate: 60.0,
          failCount: 2,
          trend7d: [],
        },
        subsysStatus: [],
        loadingTab: null,
      });
    }

    it('renders ECharts chart when trend data is loaded', async () => {
      setupTrendTab();

      render(<DashboardPanel />);

      await waitFor(() => {
        expect(screen.getByTestId('echarts-mock')).toBeTruthy();
      });
    });

    it('renders daily/weekly granularity toggle', async () => {
      setupTrendTab();

      render(<DashboardPanel />);

      await waitFor(() => {
        expect(screen.getByText('每日')).toBeTruthy();
      });
      expect(screen.getByText('每周')).toBeTruthy();
    });

    it('switches to weekly granularity when clicked', async () => {
      setupTrendTab();

      render(<DashboardPanel />);

      await waitFor(() => {
        expect(screen.getByText('每日')).toBeTruthy();
      });

      fireEvent.click(screen.getByText('每周'));

      // The store should have updated granularity
      expect(useDashboardStore.getState().trendGranularity).toBe('weekly');
    });
  });
});
