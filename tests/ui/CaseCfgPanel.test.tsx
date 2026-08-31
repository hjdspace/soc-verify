// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * CaseCfgPanel 单元测试：
 *
 * 覆盖：
 * - 顶部按钮（解析环境、加载用例）
 * - 已加载 cfg 文件的用例树渲染
 * - 右键菜单（删除用例、刷新）
 * - 选中用例联动 simulation store
 *
 * Mock 策略：
 * - project store: currentProjectId
 * - simulation store: selectCase
 * - env store: config（PROJ_ENV）
 * - trpc: caseCfg.scanEnv / loadFromEnv / loadFiles / removeFile / refresh / getLoadedFiles
 */

const mocks = vi.hoisted(() => ({
  projectState: {
    currentProjectId: 'test-project' as string | null,
  },
  envState: {
    config: {
      envVars: {
        PROJ_ENV: '/proj/dv',
      },
    } as unknown,
    systemEnvVars: {} as Record<string, string>,
    loadSystemEnv: vi.fn().mockResolvedValue(undefined),
    loadConfig: vi.fn().mockResolvedValue(undefined),
  },
  selectCase: vi.fn(),
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    caseCfg: {
      scanEnv: { query: vi.fn().mockResolvedValue([]) },
      scanUdtbDirs: { query: vi.fn().mockResolvedValue([]) },
      loadFromEnv: { mutate: vi.fn().mockResolvedValue({ files: [] }) },
      loadFiles: { mutate: vi.fn().mockResolvedValue({ files: [] }) },
      removeFile: { mutate: vi.fn().mockResolvedValue({ files: [] }) },
      refresh: { mutate: vi.fn().mockResolvedValue({ files: [] }) },
      getLoadedFiles: { query: vi.fn().mockResolvedValue({ files: [] }) },
    },
    project: {
      setCasePostSim: { mutate: vi.fn().mockResolvedValue({}) },
      pickFiles: { mutate: vi.fn().mockResolvedValue({ canceled: true }) },
      openInSystem: { mutate: vi.fn().mockResolvedValue({}) },
    },
  },
}));

vi.mock('@renderer/stores/project', () => ({
  useProjectStore: vi.fn((selector: (state: unknown) => unknown) =>
    selector(mocks.projectState),
  ),
}));

vi.mock('@renderer/stores/simulation', () => ({
  useSimulationStore: Object.assign(
    vi.fn((selector: (state: unknown) => unknown) =>
      selector({
        selectCase: mocks.selectCase,
      }),
    ),
    {
      getState: () => ({
        startCaseRun: vi.fn().mockResolvedValue(null),
      }),
    },
  ),
}));

vi.mock('@renderer/stores/env', () => ({
  useEnvStore: vi.fn((selector: (state: unknown) => unknown) =>
    selector(mocks.envState),
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

import { CaseCfgPanel } from '@renderer/components/simulation/CaseCfgPanel';
import { trpc } from '@renderer/lib/trpc';

describe('CaseCfgPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectState.currentProjectId = 'test-project';
    vi.mocked(trpc.caseCfg.getLoadedFiles.query).mockResolvedValue({ files: [] });
  });

  it('shows toolbar buttons for parse env and load files', async () => {
    render(<CaseCfgPanel />);

    expect(await screen.findByText('解析环境')).toBeInTheDocument();
    expect(screen.getByText('加载用例')).toBeInTheDocument();
  });

  it('shows empty state when no files loaded', async () => {
    render(<CaseCfgPanel />);

    expect(await screen.findByText('未加载用例文件')).toBeInTheDocument();
  });

  it('renders loaded cfg files with case tree', async () => {
    vi.mocked(trpc.caseCfg.getLoadedFiles.query).mockResolvedValue({
      files: [
        {
          name: 'test.cfg',
          fullPath: '/proj/dv/apcpu_sys/bin/case_cfg/test.cfg',
          nodes: ['case_a', 'case_b'],
          childCases: [{ case: 'child_x', base: 'case_a' }],
          base: '',
          block: 'apcpu_sys',
        },
      ],
    });

    render(<CaseCfgPanel />);

    expect(await screen.findByText('test.cfg')).toBeInTheDocument();
    expect(await screen.findByText('case_a')).toBeInTheDocument();
    expect(await screen.findByText('case_b')).toBeInTheDocument();
  });

  it('triggers scanEnv on parse env button click and shows next button', async () => {
    vi.mocked(trpc.caseCfg.scanEnv.query).mockResolvedValue([
      { name: 'apcpu_sys', path: '/proj/dv/apcpu_sys' },
    ]);

    render(<CaseCfgPanel />);

    const btn = await screen.findByText('解析环境');
    fireEvent.click(btn);

    await waitFor(() => {
      expect(trpc.caseCfg.scanEnv.query).toHaveBeenCalledWith({
        projectId: 'test-project',
        projEnv: '/proj/dv',
      });
    });

    // Should show "下一步" button instead of "加载"
    expect(screen.getByText('下一步')).toBeInTheDocument();
  });

  it('shows UDTB dialog when subsystem has udtb dirs', async () => {
    vi.mocked(trpc.caseCfg.scanEnv.query).mockResolvedValue([
      { name: 'apcpu_sys', path: '/proj/dv/apcpu_sys' },
    ]);
    vi.mocked(trpc.caseCfg.scanUdtbDirs.query).mockResolvedValue([
      { relPath: 'ip2soc_a', fullPath: '/proj/dv/udtb/apcpu_sys/ip2soc_a' },
      { relPath: 'ip2soc_b', fullPath: '/proj/dv/udtb/apcpu_sys/ip2soc_b' },
    ]);
    vi.mocked(trpc.caseCfg.loadFromEnv.mutate).mockResolvedValue({
      files: [
        {
          name: 'test.cfg',
          fullPath: '/proj/dv/apcpu_sys/bin/case_cfg/test.cfg',
          nodes: ['case_a'],
          childCases: [],
          base: '',
          block: 'apcpu_sys',
        },
      ],
    });

    render(<CaseCfgPanel />);

    // Click parse env
    const parseBtn = await screen.findByText('解析环境');
    fireEvent.click(parseBtn);

    // Wait for subsystem dialog and select one
    await waitFor(() => {
      expect(trpc.caseCfg.scanEnv.query).toHaveBeenCalled();
    });

    // Click subsystem to select it
    const subsysItem = await screen.findByText('apcpu_sys');
    fireEvent.click(subsysItem);

    // Click "下一步"
    const nextBtn = screen.getByText('下一步');
    fireEvent.click(nextBtn);

    // Should show UDTB dialog with ip2soc_a and ip2soc_b
    await waitFor(() => {
      expect(trpc.caseCfg.scanUdtbDirs.query).toHaveBeenCalledWith({
        projectId: 'test-project',
        projEnv: '/proj/dv',
        subsys: 'apcpu_sys',
      });
    });

    await waitFor(() => {
      expect(screen.getByText('选择 UDTB 目录')).toBeInTheDocument();
    });

    // Select ip2soc_a
    const udtbItem = await screen.findByText('ip2soc_a');
    fireEvent.click(udtbItem);

    // Click 确定
    const confirmBtn = screen.getByText('确定');
    fireEvent.click(confirmBtn);

    // Should call loadFromEnv with udtbDirs
    await waitFor(() => {
      expect(trpc.caseCfg.loadFromEnv.mutate).toHaveBeenCalledWith({
        projectId: 'test-project',
        projEnv: '/proj/dv',
        subsystems: ['apcpu_sys'],
        udtbDirs: ['/proj/dv/udtb/apcpu_sys/ip2soc_a'],
      });
    });
  });

  it('skips UDTB dialog when subsystem has no udtb dirs', async () => {
    vi.mocked(trpc.caseCfg.scanEnv.query).mockResolvedValue([
      { name: 'apcpu_sys', path: '/proj/dv/apcpu_sys' },
    ]);
    vi.mocked(trpc.caseCfg.scanUdtbDirs.query).mockResolvedValue([]);
    vi.mocked(trpc.caseCfg.loadFromEnv.mutate).mockResolvedValue({
      files: [
        {
          name: 'test.cfg',
          fullPath: '/proj/dv/apcpu_sys/bin/case_cfg/test.cfg',
          nodes: ['case_a'],
          childCases: [],
          base: '',
          block: 'apcpu_sys',
        },
      ],
    });

    render(<CaseCfgPanel />);

    const parseBtn = await screen.findByText('解析环境');
    fireEvent.click(parseBtn);

    // Select subsystem
    const subsysItem = await screen.findByText('apcpu_sys');
    fireEvent.click(subsysItem);

    // Click "下一步"
    fireEvent.click(screen.getByText('下一步'));

    // scanUdtbDirs is called but returns empty, so loadFromEnv should be called directly
    await waitFor(() => {
      expect(trpc.caseCfg.loadFromEnv.mutate).toHaveBeenCalledWith({
        projectId: 'test-project',
        projEnv: '/proj/dv',
        subsystems: ['apcpu_sys'],
        udtbDirs: [],
      });
    });
  });

  it('triggers refresh via context menu', async () => {
    vi.mocked(trpc.caseCfg.getLoadedFiles.query).mockResolvedValue({
      files: [
        {
          name: 'test.cfg',
          fullPath: '/proj/dv/test.cfg',
          nodes: ['case_a'],
          childCases: [],
          base: '',
          block: '',
        },
      ],
    });
    vi.mocked(trpc.caseCfg.refresh.mutate).mockResolvedValue({
      files: [
        {
          name: 'test.cfg',
          fullPath: '/proj/dv/test.cfg',
          nodes: ['case_a'],
          childCases: [],
          base: '',
          block: '',
        },
      ],
    });

    render(<CaseCfgPanel />);

    // Wait for file to render
    const fileNode = await screen.findByText('test.cfg');
    // Right-click on file node
    fireEvent.contextMenu(fileNode);

    // Click refresh in context menu
    const refreshItem = await screen.findByText('刷新');
    fireEvent.click(refreshItem);

    await waitFor(() => {
      expect(trpc.caseCfg.refresh.mutate).toHaveBeenCalledWith({
        projectId: 'test-project',
      });
    });
  });

  it('triggers removeFile via context menu', async () => {
    vi.mocked(trpc.caseCfg.getLoadedFiles.query).mockResolvedValue({
      files: [
        {
          name: 'test.cfg',
          fullPath: '/proj/dv/test.cfg',
          nodes: ['case_a'],
          childCases: [],
          base: '',
          block: '',
        },
      ],
    });
    vi.mocked(trpc.caseCfg.removeFile.mutate).mockResolvedValue({ files: [] });

    render(<CaseCfgPanel />);

    const fileNode = await screen.findByText('test.cfg');
    fireEvent.contextMenu(fileNode);

    const removeItem = await screen.findByText('删除用例');
    fireEvent.click(removeItem);

    await waitFor(() => {
      expect(trpc.caseCfg.removeFile.mutate).toHaveBeenCalledWith({
        projectId: 'test-project',
        filePath: '/proj/dv/test.cfg',
      });
    });
  });

  it('calls selectCase when a case is clicked', async () => {
    vi.mocked(trpc.caseCfg.getLoadedFiles.query).mockResolvedValue({
      files: [
        {
          name: 'test.cfg',
          fullPath: '/proj/dv/apcpu_sys/bin/case_cfg/test.cfg',
          nodes: ['case_a'],
          childCases: [],
          base: '',
          block: 'apcpu_sys',
        },
      ],
    });

    render(<CaseCfgPanel />);

    const caseNode = await screen.findByText('case_a');
    fireEvent.click(caseNode);

    expect(mocks.selectCase).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'case_a',
        subsys: 'apcpu_sys',
      }),
    );
  });
});
