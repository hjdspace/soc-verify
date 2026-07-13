// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

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
  runSimulation: vi.fn(),
  loadConfig: vi.fn().mockResolvedValue(undefined),
  setWizardOpen: vi.fn(),
  setWizardStep: vi.fn(),
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    project: {
      getSubsystems: { query: vi.fn().mockResolvedValue([]) },
      getCases: { query: vi.fn().mockResolvedValue([]) },
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
      runSimulation: mocks.runSimulation,
      simOptions: {},
    }),
  ),
}));

vi.mock('@renderer/stores/env', () => ({
  useEnvStore: vi.fn((selector: (state: unknown) => unknown) =>
    selector({
      config: null,
      loadConfig: mocks.loadConfig,
      setWizardOpen: mocks.setWizardOpen,
      setWizardStep: mocks.setWizardStep,
    }),
  ),
}));

import { SubsysList } from '@renderer/components/project/SubsysList';
import { trpc } from '@renderer/lib/trpc';

describe('SubsysList discovery states', () => {
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

  it('offers manual rescan and environment configuration when discovery is empty', async () => {
    render(<SubsysList />);

    await screen.findByText('未发现子系统');
    fireEvent.click(screen.getByRole('button', { name: '重新扫描' }));

    await waitFor(() => {
      expect(trpc.project.getSubsystems.query).toHaveBeenCalledTimes(2);
    });

    fireEvent.click(screen.getByRole('button', { name: '配置 PROJ_RTL' }));
    await waitFor(() => {
      expect(mocks.loadConfig).toHaveBeenCalledWith('test-project');
      expect(mocks.setWizardOpen).toHaveBeenCalledWith(true);
      expect(mocks.setWizardStep).toHaveBeenCalledWith('envvars');
    });
  });

  it('reports when no subsystem discoverer is loaded', async () => {
    mocks.projectState.plugins = [];

    render(<SubsysList />);

    expect(await screen.findByText('未加载子系统发现插件')).toBeInTheDocument();
  });

  it('shows discovered subsystems even before plugin metadata is restored', async () => {
    mocks.projectState.plugins = [];
    vi.mocked(trpc.project.getSubsystems.query).mockResolvedValue([
      { name: 'cpu_sub_sys', path: 'D:/rtl/cpu_sub_sys' },
    ]);

    render(<SubsysList />);

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

    render(<SubsysList />);

    expect(await screen.findByText('子系统插件加载失败')).toBeInTheDocument();
    expect(screen.getByText('Plugin path not found')).toBeInTheDocument();
  });

  it('reports a subsystem query failure separately', async () => {
    vi.mocked(trpc.project.getSubsystems.query).mockRejectedValue(
      new Error('Discovery crashed'),
    );

    render(<SubsysList />);

    expect(await screen.findByText('子系统查询失败')).toBeInTheDocument();
    expect(screen.getByText('Discovery crashed')).toBeInTheDocument();
  });
});
