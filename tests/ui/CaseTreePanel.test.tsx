// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * CaseTreePanel 单元测试：
 *
 * 覆盖子系统发现状态（空状态、插件错误、查询失败、重新扫描）和
 * 用例树渲染（自动展开 / 搜索 / 批量模式 / 状态筛选）。
 *
 * Mock 策略：
 * - project store: currentProjectId / selectedSubsys / caseStatusFilter / plugins
 * - simulation store: startCaseRun / startCaseRuns / selectCase
 * - env store: config（仅读 PROJ_RTL）
 * - trpc: project.getSubsystems / getCases / searchCases / refreshCases /
 *   setCasePostSim / openInSystem
 */

const mocks = vi.hoisted(() => ({
  projectState: {
    currentProjectId: 'test-project' as string | null,
    selectedSubsys: null as string | null,
    caseStatusFilter: 'all',
    plugins: [] as Array<{
      id: string;
      kind: string;
      enabled: boolean;
      error?: string;
    }>,
  },
  setSelectedSubsys: vi.fn(),
  setCaseStatusFilter: vi.fn(),
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    project: {
      getSubsystems: { query: vi.fn().mockResolvedValue([]) },
      getCases: { query: vi.fn().mockResolvedValue([]) },
      searchCases: { query: vi.fn().mockResolvedValue([]) },
      refreshCases: { mutate: vi.fn().mockResolvedValue(undefined) },
      setCasePostSim: { mutate: vi.fn().mockResolvedValue(undefined) },
      openInSystem: { mutate: vi.fn().mockResolvedValue(undefined) },
    },
  },
}));

vi.mock('@renderer/stores/project', () => ({
  useProjectStore: vi.fn((selector: (state: unknown) => unknown) =>
    selector({
      ...mocks.projectState,
      setSelectedSubsys: mocks.setSelectedSubsys,
      setCaseStatusFilter: mocks.setCaseStatusFilter,
    }),
  ),
}));

vi.mock('@renderer/stores/simulation', () => ({
  useSimulationStore: vi.fn((selector: (state: unknown) => unknown) =>
    selector({
      startCaseRun: vi.fn(),
      startCaseRuns: vi.fn(),
      selectCase: vi.fn(),
      simOptions: {},
    }),
  ),
}));

vi.mock('@renderer/stores/env', () => ({
  useEnvStore: vi.fn((selector: (state: unknown) => unknown) =>
    selector({
      config: null,
    }),
  ),
}));

vi.mock('@renderer/stores/toast', () => ({
  useToastStore: {
    getState: () => ({
      error: vi.fn(),
      success: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
    }),
  },
}));

vi.mock('@renderer/stores/overview', () => ({
  useOverviewStore: {
    getState: () => ({ invalidate: vi.fn() }),
  },
}));

vi.mock('@renderer/stores/dashboard', () => ({
  useDashboardStore: {
    getState: () => ({ loadMilestones: vi.fn() }),
  },
}));

import { CaseTreePanel } from '@renderer/components/simulation/CaseTreePanel';
import { trpc } from '@renderer/lib/trpc';

describe('CaseTreePanel discovery states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectState.currentProjectId = 'test-project';
    mocks.projectState.plugins = [
      {
        id: 'unisoc-subsys-discoverer',
        kind: 'subsys-discoverer',
        enabled: true,
      },
    ];
    vi.mocked(trpc.project.getSubsystems.query).mockResolvedValue([]);
  });

  it('offers manual rescan when discovery is empty', async () => {
    render(<CaseTreePanel />);

    // CaseTreePanel shows "未发现子系统" with a hint to check PROJ_RTL
    expect(await screen.findByText('未发现子系统')).toBeInTheDocument();

    // The refresh button at the header triggers a rescan via refreshCases mutate
    fireEvent.click(screen.getByRole('button', { name: '刷新全部用例树' }));

    await waitFor(() => {
      expect(trpc.project.refreshCases.mutate).toHaveBeenCalled();
    });
  });

  it('reports when no subsystem discoverer is loaded', async () => {
    mocks.projectState.plugins = [];

    render(<CaseTreePanel />);

    expect(await screen.findByText('未加载子系统发现插件')).toBeInTheDocument();
  });

  it('shows discovered subsystems even before plugin metadata is restored', async () => {
    mocks.projectState.plugins = [];
    vi.mocked(trpc.project.getSubsystems.query).mockResolvedValue([
      { name: 'cpu_sub_sys', path: 'D:/rtl/cpu_sub_sys' },
    ]);

    render(<CaseTreePanel />);

    expect(await screen.findByText('cpu_sub_sys')).toBeInTheDocument();
    expect(screen.queryByText('未加载子系统发现插件')).not.toBeInTheDocument();
  });

  it('shows the plugin load error instead of reporting an empty scan', async () => {
    mocks.projectState.plugins = [
      {
        id: 'unisoc-subsys-discoverer',
        kind: 'subsys-discoverer',
        enabled: false,
        error: 'Plugin path not found',
      },
    ];

    render(<CaseTreePanel />);

    expect(await screen.findByText('子系统插件加载失败')).toBeInTheDocument();
    expect(screen.getByText('Plugin path not found')).toBeInTheDocument();
  });

  it('reports a subsystem query failure separately', async () => {
    vi.mocked(trpc.project.getSubsystems.query).mockRejectedValue(
      new Error('Discovery crashed'),
    );

    render(<CaseTreePanel />);

    expect(await screen.findByText('子系统查询失败')).toBeInTheDocument();
    expect(screen.getByText('Discovery crashed')).toBeInTheDocument();
  });
});

describe('CaseTreePanel case tree rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectState.currentProjectId = 'test-project';
    mocks.projectState.plugins = [
      {
        id: 'unisoc-subsys-discoverer',
        kind: 'subsys-discoverer',
        enabled: true,
      },
    ];
    vi.mocked(trpc.project.getSubsystems.query).mockResolvedValue([
      { name: 'cpu_sub_sys', path: 'D:/rtl/cpu_sub_sys', caseCount: 2 },
    ]);
    vi.mocked(trpc.project.getCases.query).mockResolvedValue([
      {
        name: 'case_alpha',
        subsys: 'cpu_sub_sys',
        path: '/path/case_alpha',
        filePath: '/path/cases.sv',
        status: 'pass',
      },
      {
        name: 'case_beta',
        subsys: 'cpu_sub_sys',
        path: '/path/case_beta',
        filePath: '/path/other.sv',
        status: 'pending',
      },
    ]);
  });

  it('file nodes are auto-expanded by default after cases are loaded', async () => {
    render(<CaseTreePanel />);

    // Expand the subsystem
    fireEvent.click(await screen.findByText('cpu_sub_sys'));

    // CaseTreePanel auto-expands file nodes, so case names should be visible
    await screen.findByText('case_alpha');
    await screen.findByText('case_beta');
  });

  it('collapse all button collapses all file nodes', async () => {
    render(<CaseTreePanel />);

    fireEvent.click(await screen.findByText('cpu_sub_sys'));
    // Cases are auto-expanded, wait for them
    await screen.findByText('case_alpha');
    await screen.findByText('case_beta');

    // Collapse all
    fireEvent.click(screen.getByRole('button', { name: '折叠全部' }));

    // All case names should be collapsed (file node container has grid-rows-[0fr])
    // In jsdom, CSS grid animation does not hide elements from the DOM,
    // so we verify the collapse by checking the file node's container class.
    const caseAlpha = screen.getByText('case_alpha');
    const fileNodeContainer = caseAlpha.closest('.grid');
    expect(fileNodeContainer).toHaveClass('grid-rows-[0fr]');
  });

  it('expand all and collapse all buttons toggle all file nodes', async () => {
    render(<CaseTreePanel />);

    fireEvent.click(await screen.findByText('cpu_sub_sys'));
    // Auto-expanded, so cases are visible
    await screen.findByText('case_alpha');

    // Collapse all first
    fireEvent.click(screen.getByRole('button', { name: '折叠全部' }));
    // File node container should be collapsed (grid-rows-[0fr])
    {
      const caseAlpha = screen.getByText('case_alpha');
      const fileNodeContainer = caseAlpha.closest('.grid');
      expect(fileNodeContainer).toHaveClass('grid-rows-[0fr]');
    }

    // Expand all
    fireEvent.click(screen.getByRole('button', { name: '展开全部' }));
    // File node container should be expanded (grid-rows-[1fr])
    {
      const caseAlpha = await screen.findByText('case_alpha');
      const fileNodeContainer = caseAlpha.closest('.grid');
      expect(fileNodeContainer).toHaveClass('grid-rows-[1fr]');
    }
    await screen.findByText('case_beta');
  });

  it('search input is visible with placeholder', async () => {
    render(<CaseTreePanel />);

    // Wait for subsystems to load
    await screen.findByText('cpu_sub_sys');

    // Search input should be visible
    expect(screen.getByPlaceholderText('搜索用例...')).toBeInTheDocument();
  });

  it('status filter buttons are visible when not searching', async () => {
    render(<CaseTreePanel />);

    await screen.findByText('cpu_sub_sys');

    // Status filters should be visible
    expect(screen.getByText('全部')).toBeInTheDocument();
    expect(screen.getByText('通过')).toBeInTheDocument();
    expect(screen.getByText('失败')).toBeInTheDocument();
    expect(screen.getByText('运行中')).toBeInTheDocument();
    expect(screen.getByText('待运行')).toBeInTheDocument();
    expect(screen.getByText('后仿')).toBeInTheDocument();
  });

  it('batch mode toggle button is visible', async () => {
    render(<CaseTreePanel />);

    await screen.findByText('cpu_sub_sys');

    // Batch mode button should be visible (accessible name is "批量", title is "批量选择模式")
    expect(screen.getByRole('button', { name: '批量' })).toBeInTheDocument();
  });

  it('subsys filter dropdown shows all subsystems', async () => {
    render(<CaseTreePanel />);

    await screen.findByText('cpu_sub_sys');

    // Click the subsys filter dropdown (accessible name is "全部子系统", title is "筛选子系统")
    fireEvent.click(screen.getByRole('button', { name: '全部子系统' }));

    // Dropdown should show "全部子系统" option and the subsystem name
    // After opening dropdown, there are now two "全部子系统" texts (button + dropdown item)
    expect(screen.getAllByText('全部子系统').length).toBeGreaterThanOrEqual(2);
    // cpu_sub_sys appears in the dropdown list (in addition to the subsystem list)
    expect(screen.getAllByText('cpu_sub_sys').length).toBeGreaterThanOrEqual(1);
  });
});

describe('CaseTreePanel header', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectState.currentProjectId = 'test-project';
    mocks.projectState.plugins = [
      {
        id: 'unisoc-subsys-discoverer',
        kind: 'subsys-discoverer',
        enabled: true,
      },
    ];
    vi.mocked(trpc.project.getSubsystems.query).mockResolvedValue([
      { name: 'cpu_sub_sys', path: 'D:/rtl/cpu_sub_sys', caseCount: 2 },
    ]);
  });

  it('shows the panel title and data-testid', async () => {
    render(<CaseTreePanel />);

    expect(screen.getByTestId('case-tree-panel')).toBeInTheDocument();
    expect(screen.getByText('用例树')).toBeInTheDocument();
  });
});
