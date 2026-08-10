// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ─── Mock ECharts theme ─────────────────────────────────────

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
  const mockSubsysHeatmapData = [
    { subsys: 'cpu', pass: 5, fail: 2, error: 1, total: 8, passRate: 62.5 },
    { subsys: 'gpu', pass: 3, fail: 1, error: 0, total: 4, passRate: 75.0 },
    { subsys: 'axi', pass: 0, fail: 2, error: 1, total: 3, passRate: 0 },
  ];
  const mockRecentFailuresData = [
    { caseName: 'test_case_1', subsys: 'cpu', startTime: '2024-01-10T10:00:00.000Z', durationMs: 5000 },
    { caseName: 'test_case_2', subsys: 'gpu', startTime: '2024-01-09T14:30:00.000Z', durationMs: 3000 },
    { caseName: 'test_case_3', subsys: 'cpu', startTime: '2024-01-08T09:15:00.000Z', durationMs: null },
  ];
  const mockRegressionProgressData = {
    totalCases: 10,
    runCases: 7,
    passedCases: 5,
    failedCases: 2,
    notRunCases: 3,
    passRate: 71.4,
  };
  const mockDurationHistogramData = [
    { bucket: '0-1min', count: 5 },
    { bucket: '1-5min', count: 3 },
    { bucket: '5-15min', count: 2 },
    { bucket: '15-30min', count: 1 },
    { bucket: '30min+', count: 1 },
  ];
  const mockUnstableCasesData = [
    { caseName: 'flaky_case_1', subsys: 'cpu', passCount: 2, failCount: 3, totalCount: 5, failRate: 60.0, lastStatus: 'fail' },
    { caseName: 'flaky_case_2', subsys: 'gpu', passCount: 3, failCount: 1, totalCount: 4, failRate: 25.0, lastStatus: 'pass' },
  ];
  return {
    trpc: {
      dashboard: {
        getSubsysList: { query: vi.fn().mockResolvedValue([]) },
        getSummary: { query: vi.fn().mockResolvedValue(mockSummaryData) },
        getSubsysStatus: { query: vi.fn().mockResolvedValue(mockSubsysStatusData) },
        getTrend: { query: vi.fn().mockResolvedValue(mockTrendData) },
        getSubsysHeatmap: { query: vi.fn().mockResolvedValue(mockSubsysHeatmapData) },
        getRecentFailures: { query: vi.fn().mockResolvedValue(mockRecentFailuresData) },
        getRegressionProgress: { query: vi.fn().mockResolvedValue(mockRegressionProgressData) },
        getDurationHistogram: { query: vi.fn().mockResolvedValue(mockDurationHistogramData) },
        getUnstableCases: { query: vi.fn().mockResolvedValue(mockUnstableCasesData) },
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
    subsysHeatmap: null,
    recentFailures: null,
    regressionProgress: null,
    durationHistogram: null,
    unstableCases: null,
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
      vi.mocked(trpc.dashboard.getRecentFailures.query).mockResolvedValue([]);
      vi.mocked(trpc.dashboard.getRegressionProgress.query).mockResolvedValue({
        totalCases: 0, runCases: 0, passedCases: 0, failedCases: 0, notRunCases: 0, passRate: 0,
      });

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
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.dashboard.getRegressionProgress.query).mockResolvedValue({
        totalCases: 0, runCases: 0, passedCases: 0, failedCases: 0, notRunCases: 0, passRate: 0,
      });

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

  // ─── 子系统标签页内容 ─────────────────────────────────────

  describe('subsys tab content', () => {
    function setupSubsysTab() {
      useDashboardStore.setState({
        activeTab: 'subsys',
        subsysHeatmap: [
          { subsys: 'cpu', pass: 5, fail: 2, error: 1, total: 8, passRate: 62.5 },
          { subsys: 'gpu', pass: 3, fail: 1, error: 0, total: 4, passRate: 75.0 },
          { subsys: 'axi', pass: 0, fail: 2, error: 1, total: 3, passRate: 0 },
        ],
        tabLoaded: { subsys: true },
        loadingTab: null,
      });
    }

    it('renders ECharts heatmap when subsys data is loaded', async () => {
      setupSubsysTab();

      render(<DashboardPanel />);

      await waitFor(() => {
        expect(screen.getByTestId('echarts-mock')).toBeTruthy();
      });
    });

    it('renders subsystem detail data table with all columns', async () => {
      setupSubsysTab();

      render(<DashboardPanel />);

      // Table headers should be present — use getAllByText since "子系统" also appears as a tab label
      await waitFor(() => {
        const subsysHeaders = screen.getAllByText('子系统');
        expect(subsysHeaders.length).toBeGreaterThanOrEqual(1);
      });
      // Should have total, pass, fail, error, passRate columns
      // Use getAllByText since some headers (e.g. 失败) also appear as tab labels
      expect(screen.getAllByText('总数').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('通过').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('失败').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('错误').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('通过率').length).toBeGreaterThanOrEqual(1);
    });

    it('renders subsystem names in the data table', async () => {
      setupSubsysTab();

      render(<DashboardPanel />);

      await waitFor(() => {
        // cpu, gpu, axi should all appear in the table
        const cpuElements = screen.getAllByText('cpu');
        expect(cpuElements.length).toBeGreaterThanOrEqual(1);
      });
      expect(screen.getAllByText('gpu').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('axi').length).toBeGreaterThanOrEqual(1);
    });

    it('shows pass rate values in the data table', async () => {
      setupSubsysTab();

      render(<DashboardPanel />);

      await waitFor(() => {
        // 62.5% should be rendered for cpu
        expect(screen.getByText('62.5%')).toBeTruthy();
      });
      // 75% for gpu
      expect(screen.getByText('75%')).toBeTruthy();
      // 0% for axi
      expect(screen.getByText('0%')).toBeTruthy();
    });

    it('shows empty state hint when subsys data is empty', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.dashboard.getSubsysHeatmap.query).mockResolvedValue([]);

      useDashboardStore.setState({
        activeTab: 'subsys',
        subsysHeatmap: null,
        tabLoaded: {},
        loadingTab: null,
      });

      render(<DashboardPanel />);

      await waitFor(() => {
        expect(screen.getByText(/各子系统.*分布热力图/)).toBeTruthy();
      });
    });
  });

  // ─── 失败标签页内容 ─────────────────────────────────────

  describe('failures tab content', () => {
    function setupFailuresTab() {
      useDashboardStore.setState({
        activeTab: 'failures',
        recentFailures: [
          { caseName: 'test_case_1', subsys: 'cpu', startTime: '2024-01-10T10:00:00.000Z', durationMs: 5000 },
          { caseName: 'test_case_2', subsys: 'gpu', startTime: '2024-01-09T14:30:00.000Z', durationMs: 3000 },
          { caseName: 'test_case_3', subsys: 'cpu', startTime: '2024-01-08T09:15:00.000Z', durationMs: null },
        ],
        tabLoaded: { failures: true },
        loadingTab: null,
      });
    }

    it('renders failures table with correct columns when data is loaded', async () => {
      setupFailuresTab();

      render(<DashboardPanel />);

      // Table headers should be present
      await waitFor(() => {
        expect(screen.getByText('用例名')).toBeTruthy();
      });
      expect(screen.getByText('失败时间')).toBeTruthy();
      // '耗时' appears both as a tab label and as a table header
      expect(screen.getAllByText('耗时').length).toBeGreaterThanOrEqual(1);
    });

    it('does not render Corner column in failures table', async () => {
      setupFailuresTab();

      render(<DashboardPanel />);

      // Should not have a Corner header
      expect(screen.queryByText('Corner')).toBeNull();
      expect(screen.queryByText('corner')).toBeNull();
    });

    it('renders case names in the failures table', async () => {
      setupFailuresTab();

      render(<DashboardPanel />);

      await waitFor(() => {
        expect(screen.getByText('test_case_1')).toBeTruthy();
      });
      expect(screen.getByText('test_case_2')).toBeTruthy();
      expect(screen.getByText('test_case_3')).toBeTruthy();
    });

    it('shows failure count in section title', async () => {
      setupFailuresTab();

      render(<DashboardPanel />);

      await waitFor(() => {
        // Title should show count (3 failures)
        expect(screen.getByText(/共 3 条/)).toBeTruthy();
      });
    });

    it('shows empty state hint when failures data is empty', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.dashboard.getRecentFailures.query).mockResolvedValue([]);

      useDashboardStore.setState({
        activeTab: 'failures',
        recentFailures: null,
        tabLoaded: {},
        loadingTab: null,
      });

      render(<DashboardPanel />);

      await waitFor(() => {
        expect(screen.getByText(/最近失败用例列表/)).toBeTruthy();
      });
    });
  });

  // ─── 回归标签页内容 ─────────────────────────────────────

  describe('regression tab content', () => {
    function setupRegressionTab() {
      useDashboardStore.setState({
        activeTab: 'regression',
        regressionProgress: {
          totalCases: 10,
          runCases: 7,
          passedCases: 5,
          failedCases: 2,
          notRunCases: 3,
          passRate: 71.4,
        },
        tabLoaded: { regression: true },
        loadingTab: null,
      });
    }

    it('renders ECharts pie chart when regression data is loaded', async () => {
      setupRegressionTab();

      render(<DashboardPanel />);

      await waitFor(() => {
        expect(screen.getByTestId('echarts-mock')).toBeTruthy();
      });
    });

    it('renders stat cards with regression numbers', async () => {
      setupRegressionTab();

      render(<DashboardPanel />);

      await waitFor(() => {
        // totalCases=10 should be rendered
        expect(screen.getByText('总用例')).toBeTruthy();
        expect(screen.getByText('10')).toBeTruthy();
      });
      expect(screen.getByText('已跑')).toBeTruthy();
      // '通过' appears both as a tab label and as a stat card label
      expect(screen.getAllByText('通过').length).toBeGreaterThanOrEqual(1);
      // '失败' appears both as a tab label and as a stat card label
      expect(screen.getAllByText('失败').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('未跑')).toBeTruthy();
      expect(screen.getByText('通过率')).toBeTruthy();
      // passRate = 71.4%
      expect(screen.getByText('71.4%')).toBeTruthy();
    });

    it('shows empty state hint when regression data is empty', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.dashboard.getRegressionProgress.query).mockResolvedValue({
        totalCases: 0, runCases: 0, passedCases: 0, failedCases: 0, notRunCases: 0, passRate: 0,
      });

      useDashboardStore.setState({
        activeTab: 'regression',
        regressionProgress: null,
        tabLoaded: {},
        loadingTab: null,
      });

      render(<DashboardPanel />);

      await waitFor(() => {
        expect(screen.getByText(/回归进度环形图/)).toBeTruthy();
      });
    });
  });

  // ─── 耗时标签页内容 ─────────────────────────────────────

  describe('duration tab content', () => {
    function setupDurationTab() {
      useDashboardStore.setState({
        activeTab: 'duration',
        durationHistogram: [
          { bucket: '0-1min', count: 5 },
          { bucket: '1-5min', count: 3 },
          { bucket: '5-15min', count: 2 },
          { bucket: '15-30min', count: 1 },
          { bucket: '30min+', count: 1 },
        ],
        tabLoaded: { duration: true },
        loadingTab: null,
      });
    }

    it('renders ECharts bar chart when duration data is loaded', async () => {
      setupDurationTab();

      render(<DashboardPanel />);

      await waitFor(() => {
        expect(screen.getByTestId('echarts-mock')).toBeTruthy();
      });
    });

    it('renders section title with total run count', async () => {
      setupDurationTab();

      render(<DashboardPanel />);

      // Total count = 5+3+2+1+1 = 12
      await waitFor(() => {
        expect(screen.getByText(/共 12 次运行/)).toBeTruthy();
      });
    });

    it('shows empty state hint when duration data is empty', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.dashboard.getDurationHistogram.query).mockResolvedValue([]);

      useDashboardStore.setState({
        activeTab: 'duration',
        durationHistogram: null,
        tabLoaded: {},
        loadingTab: null,
      });

      render(<DashboardPanel />);

      await waitFor(() => {
        expect(screen.getByText(/仿真耗时分布直方图/)).toBeTruthy();
      });
    });
  });

  // ─── 不稳定标签页内容 ─────────────────────────────────────

  describe('unstable tab content', () => {
    function setupUnstableTab() {
      useDashboardStore.setState({
        activeTab: 'unstable',
        unstableCases: [
          { caseName: 'flaky_case_1', subsys: 'cpu', passCount: 2, failCount: 3, totalCount: 5, failRate: 60.0, lastStatus: 'fail' },
          { caseName: 'flaky_case_2', subsys: 'gpu', passCount: 3, failCount: 1, totalCount: 4, failRate: 25.0, lastStatus: 'pass' },
        ],
        tabLoaded: { unstable: true },
        loadingTab: null,
      });
    }

    it('renders unstable cases table with correct columns when data is loaded', async () => {
      setupUnstableTab();

      render(<DashboardPanel />);

      // Table headers should be present
      await waitFor(() => {
        expect(screen.getByText('用例名')).toBeTruthy();
      });
      expect(screen.getByText('Pass次数')).toBeTruthy();
      expect(screen.getByText('Fail次数')).toBeTruthy();
      expect(screen.getByText('总运行')).toBeTruthy();
      expect(screen.getByText('失败率')).toBeTruthy();
      expect(screen.getByText('最近状态')).toBeTruthy();
    });

    it('renders case names in the unstable cases table', async () => {
      setupUnstableTab();

      render(<DashboardPanel />);

      await waitFor(() => {
        expect(screen.getByText('flaky_case_1')).toBeTruthy();
      });
      expect(screen.getByText('flaky_case_2')).toBeTruthy();
    });

    it('shows fail rate values in the table', async () => {
      setupUnstableTab();

      render(<DashboardPanel />);

      await waitFor(() => {
        expect(screen.getByText('60%')).toBeTruthy();
      });
      expect(screen.getByText('25%')).toBeTruthy();
    });

    it('shows count in section title', async () => {
      setupUnstableTab();

      render(<DashboardPanel />);

      await waitFor(() => {
        expect(screen.getByText(/共 2 个/)).toBeTruthy();
      });
    });

    it('shows empty state hint when unstable cases data is empty', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.dashboard.getUnstableCases.query).mockResolvedValue([]);

      useDashboardStore.setState({
        activeTab: 'unstable',
        unstableCases: null,
        tabLoaded: {},
        loadingTab: null,
      });

      render(<DashboardPanel />);

      await waitFor(() => {
        expect(screen.getByText(/不稳定用例列表/)).toBeTruthy();
      });
    });
  });
});
