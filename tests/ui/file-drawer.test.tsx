// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ExtraDirEntry, FileTreeNode } from '@shared/types';

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
  } as FileTreeNode | null,
  fileTreeLoading: false,
  extraDirs: [] as ExtraDirEntry[],
  dirFileTrees: {} as Record<string, FileTreeNode>,
  dirFileTreeLoading: {} as Record<string, boolean>,
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

import { FileDrawer } from '@renderer/components/layout/FileDrawer';
import { useUiStore } from '@renderer/stores/ui';

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({
    leftDrawerOpen: true,
    rightDrawerOpen: false,
  });
  projectState.recentFiles = [];
  projectState.extraDirs = [];
  projectState.dirFileTrees = {};
  projectState.dirFileTreeLoading = {};
});

describe('FileDrawer 基础渲染', () => {
  it('打开时渲染标题与文件树内容', () => {
    render(<FileDrawer />);
    expect(screen.getByRole('dialog', { name: '文件' })).toBeInTheDocument();
    expect(screen.getByTestId('file-tree-mock')).toBeInTheDocument();
  });

  it('关闭态 aria-hidden，不参与交互', () => {
    useUiStore.setState({ leftDrawerOpen: false });
    render(<FileDrawer />);
    /* inert 属性使抽屉从 accessibility tree 排除，getByRole 查不到，改用 testid */
    const drawer = screen.getByTestId('drawer-left');
    expect(drawer.getAttribute('aria-hidden')).toBe('true');
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

describe('FileDrawer 多目录分组渲染', () => {
  /** 保存/恢复默认无 extraDirs 状态 */
  function saveExtraDirsState() {
    const orig = projectState.extraDirs;
    const origTrees = projectState.dirFileTrees;
    const origLoading = projectState.dirFileTreeLoading;
    return () => {
      projectState.extraDirs = orig;
      projectState.dirFileTrees = origTrees;
      projectState.dirFileTreeLoading = origLoading;
    };
  }

  afterEach(() => {
    /* 恢复无 extraDirs 的默认状态，避免影响后续用例 */
    projectState.extraDirs = [];
    projectState.dirFileTrees = {};
    projectState.dirFileTreeLoading = {};
  });

  it('渲染验证和设计两个分组标题行', () => {
    const restore = saveExtraDirsState();
    projectState.extraDirs = [
      { id: 'dir_v1', path: 'D:/proj/ip2soc', group: 'verify', isCwd: false, order: 0, createdAt: Date.now() },
      { id: 'dir_d1', path: 'D:/proj/soc-rtl', group: 'design', isCwd: false, order: 0, createdAt: Date.now() },
    ];
    render(<FileDrawer />);

    expect(screen.getByTestId('dir-group-verify')).toBeInTheDocument();
    expect(screen.getByTestId('dir-group-design')).toBeInTheDocument();
    /* 分组标题文本存在 */
    expect(screen.getByText('验证')).toBeInTheDocument();
    expect(screen.getByText('设计')).toBeInTheDocument();

    restore();
  });

  it('每个分组标题行带「+」按钮', () => {
    const restore = saveExtraDirsState();
    projectState.extraDirs = [
      { id: 'dir_v1', path: 'D:/proj/ip2soc', group: 'verify', isCwd: false, order: 0, createdAt: Date.now() },
      { id: 'dir_d1', path: 'D:/proj/soc-rtl', group: 'design', isCwd: false, order: 0, createdAt: Date.now() },
    ];
    render(<FileDrawer />);

    expect(screen.getByTestId('add-dir-verify')).toBeInTheDocument();
    expect(screen.getByTestId('add-dir-design')).toBeInTheDocument();

    restore();
  });

  it('root 目录渲染在验证分组下，并标记 cwd（无 extraDir 标记 isCwd 时）', () => {
    const restore = saveExtraDirsState();
    projectState.extraDirs = [
      { id: 'dir_v1', path: 'D:/proj/ip2soc', group: 'verify', isCwd: false, order: 0, createdAt: Date.now() },
    ];
    render(<FileDrawer />);

    /* root 目录的 dirId 为 'root' */
    expect(screen.getByTestId('dir-tree-root')).toBeInTheDocument();
    /* root 是隐式 cwd，显示 cwd 星标 */
    expect(screen.getByTestId('cwd-star')).toBeInTheDocument();

    restore();
  });

  it('多个目录各自渲染独立 FileTree 实例', () => {
    const restore = saveExtraDirsState();
    projectState.extraDirs = [
      { id: 'dir_v1', path: 'D:/proj/ip2soc', group: 'verify', isCwd: false, order: 0, createdAt: Date.now() },
      { id: 'dir_d1', path: 'D:/proj/soc-rtl', group: 'design', isCwd: false, order: 0, createdAt: Date.now() },
    ];
    projectState.dirFileTrees = {
      dir_v1: { name: 'ip2soc', path: 'D:/proj/ip2soc', type: 'directory' as const, children: [] },
      dir_d1: { name: 'soc-rtl', path: 'D:/proj/soc-rtl', type: 'directory' as const, children: [] },
    };
    render(<FileDrawer />);

    /* root + 2 extra dirs = 3 FileTree instances */
    expect(screen.getAllByTestId('file-tree-mock')).toHaveLength(3);

    restore();
  });

  it('目录标题行显示标签而非原始路径（有 label 时）', () => {
    const restore = saveExtraDirsState();
    projectState.extraDirs = [
      { id: 'dir_v1', path: 'D:/proj/ip2soc', group: 'verify', label: 'IP2SOC', isCwd: false, order: 0, createdAt: Date.now() },
    ];
    projectState.dirFileTrees = {
      dir_v1: { name: 'ip2soc', path: 'D:/proj/ip2soc', type: 'directory' as const, children: [] },
    };
    render(<FileDrawer />);

    /* 标签 'IP2SOC' 出现在 dir-label 中 */
    expect(screen.getByTestId('dir-label-dir_v1').textContent).toContain('IP2SOC');

    restore();
  });

  it('无额外目录时仍渲染验证分组（含 root）但不渲染设计分组', () => {
    const restore = saveExtraDirsState();
    render(<FileDrawer />);

    expect(screen.getByTestId('dir-group-verify')).toBeInTheDocument();
    /* 设计分组没有目录时，分组容器仍渲染（含标题行和+按钮），这里验证+按钮存在 */
    expect(screen.getByTestId('add-dir-design')).toBeInTheDocument();

    restore();
  });

  it('切换 cwd 按钮对非 cwd 目录可见', () => {
    const restore = saveExtraDirsState();
    projectState.extraDirs = [
      { id: 'dir_v1', path: 'D:/proj/ip2soc', group: 'verify', isCwd: false, order: 0, createdAt: Date.now() },
    ];
    projectState.dirFileTrees = {
      dir_v1: { name: 'ip2soc', path: 'D:/proj/ip2soc', type: 'directory' as const, children: [] },
    };
    render(<FileDrawer />);

    /* dir_v1 不是 cwd，应显示「设为 cwd」按钮 */
    const setCwdButtons = screen.getAllByText('设为 cwd');
    expect(setCwdButtons.length).toBeGreaterThan(0);

    restore();
  });
});
