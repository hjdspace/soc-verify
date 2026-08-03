// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Mock tRPC — TVDashboard / store imports trpc which requires electron environment.
vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    violation: {
      pickFile: { mutate: vi.fn() },
      parseLog: { mutate: vi.fn() },
      queryViolations: { query: vi.fn().mockResolvedValue({ total: 0, items: [] }) },
      getStatistics: { query: vi.fn().mockResolvedValue({ total: 0, confirmed: 0, pending: 0, ignored: 0, bySubsys: {}, byCorner: {}, byCase: {} }) },
      getMetadata: { query: vi.fn().mockResolvedValue({ corners: [], cases: [], subsys: [] }) },
      getDatabaseStats: { query: vi.fn() },
      clearCaseData: { mutate: vi.fn() },
    },
  },
}));

vi.mock('@renderer/lib/trpc-utils', () => ({
  tRPCError: (err: unknown) => err instanceof Error ? err.message : String(err),
  getToast: () => ({
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  }),
}));

// Mock project store
vi.mock('@renderer/stores/project', () => ({
  useProjectStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ currentProjectId: 'test-project-id' }),
  ),
}));

import { TVStatsCards } from '@renderer/components/timing-violation/TVStatsCards';
import { TVFilterBar } from '@renderer/components/timing-violation/TVFilterBar';
import type { ViolationStatistics, ViolationMetadata } from '@renderer/stores/timing-violation';

// ─── TVStatsCards 测试 ──────────────────────────────────────────

describe('TVStatsCards', () => {
  it('renders four stat cards with correct labels', () => {
    const stats: ViolationStatistics = {
      total: 100,
      confirmed: 30,
      pending: 60,
      ignored: 10,
      bySubsys: {},
      byCorner: {},
      byCase: {},
    };
    render(<TVStatsCards statistics={stats} loading={false} />);
    expect(screen.getByText('总数')).toBeTruthy();
    expect(screen.getByText('已确认')).toBeTruthy();
    expect(screen.getByText('待确认')).toBeTruthy();
    expect(screen.getByText('已忽略')).toBeTruthy();
    expect(screen.getByText('100')).toBeTruthy();
    expect(screen.getByText('30')).toBeTruthy();
    expect(screen.getByText('60')).toBeTruthy();
    expect(screen.getByText('10')).toBeTruthy();
  });

  it('shows dash when loading', () => {
    render(<TVStatsCards statistics={null} loading={true} />);
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBe(4);
  });

  it('shows zeros when statistics is null but not loading', () => {
    render(<TVStatsCards statistics={null} loading={false} />);
    // All 4 cards show 0 when statistics is null
    const zeros = screen.getAllByText('0');
    expect(zeros.length).toBe(4);
  });
});

// ─── TVFilterBar 测试 ───────────────────────────────────────────

describe('TVFilterBar', () => {
  const mockMetadata: ViolationMetadata = {
    corners: ['npg_f1_ssg', 'npg_f2_tt'],
    cases: ['test_case_1', 'test_case_2'],
    subsys: ['dsp_sys', 'top'],
  };

  const defaultProps = {
    metadata: mockMetadata,
    filterCaseName: null,
    filterCorner: null,
    filterStatus: null,
    filterSubsys: null,
    searchText: '',
    onCaseNameChange: vi.fn(),
    onCornerChange: vi.fn(),
    onStatusChange: vi.fn(),
    onSubsysChange: vi.fn(),
    onSearchTextChange: vi.fn(),
    onReset: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders all filter dropdowns with metadata options', () => {
    render(<TVFilterBar {...defaultProps} />);

    // 用例下拉
    const caseSelect = screen.getByTitle('按用例筛选');
    expect(caseSelect).toBeTruthy();
    expect(caseSelect.querySelector('option[value="test_case_1"]')).toBeTruthy();
    expect(caseSelect.querySelector('option[value="test_case_2"]')).toBeTruthy();

    // Corner 下拉
    const cornerSelect = screen.getByTitle('按 Corner 筛选');
    expect(cornerSelect).toBeTruthy();
    expect(cornerSelect.querySelector('option[value="npg_f1_ssg"]')).toBeTruthy();

    // 子系统下拉
    const subsysSelect = screen.getByTitle('按子系统筛选');
    expect(subsysSelect.querySelector('option[value="dsp_sys"]')).toBeTruthy();
  });

  it('renders status dropdown with pending/confirmed/ignored', () => {
    render(<TVFilterBar {...defaultProps} />);
    const statusSelect = screen.getByTitle('按状态筛选');
    expect(statusSelect.querySelector('option[value="pending"]')).toBeTruthy();
    expect(statusSelect.querySelector('option[value="confirmed"]')).toBeTruthy();
    expect(statusSelect.querySelector('option[value="ignored"]')).toBeTruthy();
  });

  it('renders search input with placeholder', () => {
    render(<TVFilterBar {...defaultProps} />);
    expect(screen.getByPlaceholderText('搜索 Hier / Check...')).toBeTruthy();
  });

  it('does not show reset button when no filters active', () => {
    render(<TVFilterBar {...defaultProps} />);
    expect(screen.queryByText('重置')).toBeNull();
  });

  it('shows reset button when filters are active', () => {
    render(
      <TVFilterBar
        {...defaultProps}
        searchText="abc"
      />,
    );
    expect(screen.getByText('重置')).toBeTruthy();
  });

  it('calls onReset when reset button is clicked', () => {
    const onReset = vi.fn();
    render(
      <TVFilterBar
        {...defaultProps}
        searchText="abc"
        onReset={onReset}
      />,
    );
    fireEvent.click(screen.getByText('重置'));
    expect(onReset).toHaveBeenCalledOnce();
  });

  it('calls onSearchTextChange when typing in search box', () => {
    const onSearchTextChange = vi.fn();
    render(
      <TVFilterBar
        {...defaultProps}
        onSearchTextChange={onSearchTextChange}
      />,
    );
    const input = screen.getByPlaceholderText('搜索 Hier / Check...');
    fireEvent.change(input, { target: { value: 'tb_top' } });
    expect(onSearchTextChange).toHaveBeenCalledWith('tb_top');
  });

  it('calls onCaseNameChange when selecting a case', () => {
    const onCaseNameChange = vi.fn();
    render(
      <TVFilterBar
        {...defaultProps}
        onCaseNameChange={onCaseNameChange}
      />,
    );
    const select = screen.getByTitle('按用例筛选') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'test_case_1' } });
    expect(onCaseNameChange).toHaveBeenCalledWith('test_case_1');
  });
});
