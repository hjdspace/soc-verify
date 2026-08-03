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
      clearAllData: { mutate: vi.fn().mockResolvedValue({ deleted: 0 }) },
    },
    confirmation: {
      autoConfirmByResetTime: { mutate: vi.fn().mockResolvedValue({ confirmedCount: 0 }) },
      autoConfirmByInterval: { mutate: vi.fn().mockResolvedValue({ confirmedCount: 0 }) },
      updateConfirmation: { mutate: vi.fn().mockResolvedValue({ success: true }) },
      batchUpdateConfirmations: { mutate: vi.fn().mockResolvedValue({ updatedCount: 0 }) },
      suggestConfirmation: { query: vi.fn() },
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
import { TVConfirmationDialog } from '@renderer/components/timing-violation/TVConfirmationDialog';
import type { ViolationStatistics, ViolationMetadata, ViolationWithConfirmation } from '@renderer/stores/timing-violation';

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

// ─── TVConfirmationDialog 测试 ──────────────────────────────────

describe('TVConfirmationDialog', () => {
  const mockViolation: ViolationWithConfirmation = {
    id: 1,
    caseName: 'test_case',
    corner: 'npg_f1_ssg',
    seed: '1',
    subsys: 'dsp_sys',
    num: 1,
    hier: 'tb_top.dut.reg',
    timeFs: 1523423,
    timeDisplay: '1523423 FS',
    checkInfo: 'setup( posedge clk )',
    filePath: '/path/to/vio_summary.log',
    createdAt: '2024-01-01 10:00:00',
    status: 'pending',
    confirmer: null,
    result: null,
    reason: null,
    isAutoConfirmed: false,
    confirmedAt: null,
  };

  it('renders nothing when open is false', () => {
    const { container } = render(
      <TVConfirmationDialog
        open={false}
        violation={null}
        batchIds={[]}
        confirming={false}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders dialog with violation info when open', () => {
    render(
      <TVConfirmationDialog
        open={true}
        violation={mockViolation}
        batchIds={[]}
        confirming={false}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('确认违例 #1')).toBeTruthy();
    expect(screen.getByPlaceholderText('输入确认人姓名')).toBeTruthy();
    expect(screen.getByText('Pass')).toBeTruthy();
    expect(screen.getByText('Issue')).toBeTruthy();
  });

  it('renders batch title when batchIds provided', () => {
    render(
      <TVConfirmationDialog
        open={true}
        violation={null}
        batchIds={[1, 2, 3]}
        confirming={false}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('批量确认 3 条违例')).toBeTruthy();
  });

  it('disables confirm button when confirmer is empty', () => {
    render(
      <TVConfirmationDialog
        open={true}
        violation={mockViolation}
        batchIds={[]}
        confirming={false}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const confirmBtn = screen.getByText('确认');
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables confirm button when confirmer is filled', () => {
    render(
      <TVConfirmationDialog
        open={true}
        violation={mockViolation}
        batchIds={[]}
        confirming={false}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByPlaceholderText('输入确认人姓名');
    fireEvent.change(input, { target: { value: 'Alice' } });
    const confirmBtn = screen.getByText('确认');
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it('calls onSubmit with confirmed status when confirm button clicked', () => {
    const onSubmit = vi.fn();
    render(
      <TVConfirmationDialog
        open={true}
        violation={mockViolation}
        batchIds={[]}
        confirming={false}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByPlaceholderText('输入确认人姓名');
    fireEvent.change(input, { target: { value: 'Alice' } });
    fireEvent.click(screen.getByText('确认'));
    expect(onSubmit).toHaveBeenCalledWith('confirmed', 'Alice', 'pass', '');
  });

  it('calls onSubmit with ignored status when ignore button clicked', () => {
    const onSubmit = vi.fn();
    render(
      <TVConfirmationDialog
        open={true}
        violation={mockViolation}
        batchIds={[]}
        confirming={false}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('标记忽略'));
    expect(onSubmit).toHaveBeenCalledWith('ignored', '', 'pass', '');
  });

  it('calls onClose when cancel button clicked', () => {
    const onClose = vi.fn();
    render(
      <TVConfirmationDialog
        open={true}
        violation={mockViolation}
        batchIds={[]}
        confirming={false}
        onSubmit={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByText('取消'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('prefills existing confirmation data', () => {
    const confirmedViolation: ViolationWithConfirmation = {
      ...mockViolation,
      status: 'confirmed',
      confirmer: 'Bob',
      result: 'issue',
      reason: 'Has issue',
    };
    render(
      <TVConfirmationDialog
        open={true}
        violation={confirmedViolation}
        batchIds={[]}
        confirming={false}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByPlaceholderText('输入确认人姓名') as HTMLInputElement;
    expect(input.value).toBe('Bob');
  });
});
