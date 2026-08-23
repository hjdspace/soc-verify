// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

/* ── 可变 project store mock（逐用例注入状态） ── */
const projectState = vi.hoisted(() => ({
  projects: [
    { id: 'proj-1', name: 'chipnorth', rootPath: 'D:/proj/chipnorth' },
    { id: 'proj-2', name: 'soc-lite', rootPath: 'D:/proj/soc-lite' },
  ],
  currentProjectId: 'proj-1' as string | null,
  fileTree: {
    name: 'chipnorth',
    path: 'D:/proj/chipnorth',
    type: 'directory' as const,
    children: [],
  },
  fileTreeLoading: false,
  extraDirs: [],
  dirFileTrees: {},
  dirFileTreeLoading: {},
  recentFiles: [] as Array<{ path: string; name: string; openedAt: number }>,
  openProjectDialog: vi.fn(),
  switchProject: vi.fn(),
  closeProject: vi.fn(),
  renameProject: vi.fn(),
  refreshFileTree: vi.fn(),
  loadExtraDirs: vi.fn(),
  loadDirFileTree: vi.fn(),
  addDir: vi.fn(),
  removeDir: vi.fn(),
  pushRecentFile: vi.fn(),
}));

vi.mock('@renderer/stores/project', () => ({
  useProjectStore: (selector: (s: typeof projectState) => unknown) => selector(projectState),
}));

/* ── diff-review mock（记录文件打开调用） ── */
const openReviewAwareFile = vi.hoisted(() => vi.fn());
vi.mock('@renderer/stores/diff-review', () => ({
  openReviewAwareFile,
  useDiffReviewStore: { getState: () => ({ queue: [] }) },
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    project: {
      pickDirDialog: { mutate: vi.fn() },
      setCwd: { mutate: vi.fn() },
    },
  },
}));

vi.mock('@renderer/lib/trpc-utils', () => ({
  tRPCError: vi.fn(() => 'mock-error'),
  getToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));

vi.mock('@renderer/components/project/FileTree', () => ({
  FileTree: () => <div data-testid="file-tree-mock" />,
}));

vi.mock('@renderer/components/project/SubsysList', () => ({
  SubsysList: () => <div data-testid="subsys-list-mock" />,
}));

import { FileDrawer } from '@renderer/components/layout/FileDrawer';
import { useUiStore } from '@renderer/stores/ui';

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ leftDrawerOpen: true, rightDrawerOpen: false });
  projectState.recentFiles = [];
});

describe('FileDrawer 基础渲染', () => {
  it('打开时渲染标题与文件/子系统双 Tab，默认文件 Tab', () => {
    render(<FileDrawer />);
    expect(screen.getByRole('dialog', { name: '文件' })).toBeInTheDocument();
    expect(screen.getByTestId('file-drawer-tab-files')).toBeInTheDocument();
    expect(screen.getByTestId('file-drawer-tab-subsystems')).toBeInTheDocument();
    expect(screen.getByTestId('file-tree-mock')).toBeInTheDocument();
  });

  it('关闭态 aria-hidden，不参与交互', () => {
    useUiStore.setState({ leftDrawerOpen: false });
    render(<FileDrawer />);
    /* inert 属性使抽屉从 accessibility tree 排除，getByRole 查不到，改用 testid */
    const drawer = screen.getByTestId('drawer-left');
    expect(drawer.getAttribute('aria-hidden')).toBe('true');
  });

  it('点击子系统 Tab 切换内容', () => {
    render(<FileDrawer />);
    fireEvent.click(screen.getByTestId('file-drawer-tab-subsystems'));
    expect(screen.getByTestId('subsys-list-mock')).toBeInTheDocument();
    expect(screen.queryByTestId('file-tree-mock')).toBeNull();
  });

  it('无项目时显示空态引导', () => {
    projectState.currentProjectId = null;
    render(<FileDrawer />);
    expect(screen.getByText('点击上方按钮打开项目')).toBeInTheDocument();
    projectState.currentProjectId = 'proj-1';
  });
});

describe('FileDrawer 项目切换', () => {
  it('项目下拉列出全部项目，点击切换', () => {
    render(<FileDrawer />);
    fireEvent.click(screen.getByTestId('project-dropdown-btn'));
    /* 当前项目 chipnorth 同时出现在头部按钮与文件树 root 标签，用非当前项目断言下拉展开 */
    expect(screen.getByText('soc-lite')).toBeInTheDocument();

    fireEvent.click(screen.getByText('soc-lite'));
    expect(projectState.switchProject).toHaveBeenCalledWith('proj-2');
  });
});

describe('FileDrawer 最近打开', () => {
  it('recentFiles 为空时不渲染列表', () => {
    render(<FileDrawer />);
    expect(screen.queryByTestId('recent-files')).toBeNull();
  });

  it('显示最近文件列表，点击条目打开文件', () => {
    projectState.recentFiles = [
      { path: 'D:/proj/chipnorth/tb_alu.sv', name: 'tb_alu.sv', openedAt: Date.now() },
      { path: 'D:/proj/chipnorth/alu_pkg.sv', name: 'alu_pkg.sv', openedAt: Date.now() },
    ];
    render(<FileDrawer />);

    expect(screen.getByTestId('recent-files')).toBeInTheDocument();
    expect(screen.getByTestId('recent-file-tb_alu.sv')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('recent-file-tb_alu.sv'));
    expect(openReviewAwareFile).toHaveBeenCalledWith(
      'D:/proj/chipnorth/tb_alu.sv',
      'tb_alu.sv',
    );
  });
});
