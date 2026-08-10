// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ─── Mock tRPC ──────────────────────────────────────────────

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    dashboard: {
      getSubsysList: { query: vi.fn().mockResolvedValue([]) },
      saveLayout: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
      getLayout: { query: vi.fn().mockResolvedValue(null) },
    },
  },
}));

// ─── Mock project store ─────────────────────────────────────

vi.mock('@renderer/stores/project', () => ({
  useProjectStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ currentProjectId: 'test-project-id' }),
  ),
}));

// ─── Import after mocks ─────────────────────────────────────

import { DashboardPanel } from '@renderer/components/dashboard/DashboardPanel';
import { useDashboardStore } from '@renderer/stores/dashboard';

/** Reset dashboard store to initial state between tests */
function resetDashboardStore() {
  useDashboardStore.setState({
    activeTab: 'overview',
    selectedSubsys: null,
    timeRange: 'all',
    subsysList: [],
    subsysListLoading: false,
    tabData: {},
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
    it('shows overview hint on overview tab', async () => {
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
});
