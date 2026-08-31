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
  expandedDirs: new Set<string>(),
  toggleDirExpanded: vi.fn(),
  setDirExpanded: vi.fn(),
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
  FileTree: (props: { dirId?: string }) => (
    <div data-testid="file-tree-mock" data-dir-id={props.dirId ?? ''} />
  ),
}));

import { FileDrawer } from '@renderer/components/layout/FileDrawer';
import { FilePanel } from '@renderer/components/layout/FilePanel';
import { useUiStore } from '@renderer/stores/ui';

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({
    leftDrawerOpen: true,
    rightDrawerOpen: false,
    filePanelMode: 'drawer',
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

  it('关闭态抽屉 aria-hidden，文件树内容不参与交互', () => {
    useUiStore.setState({ leftDrawerOpen: false });
    projectState.extraDirs = [
      { id: 'dir_v1', path: 'D:/proj/ip2soc', group: 'verify', isCwd: false, order: 0, createdAt: Date.now() },
    ];

    render(<FileDrawer />);

    /* FileDrawerContent 常驻挂载，抽屉关闭时通过 aria-hidden 隔离交互 */
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

  it('每个 FileTree 实例携带所属目录的 dirId（懒加载作用域）', () => {
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

    /* root 树的 dirId 固定为 'root'；额外目录树用各自的 dirId，
       懒加载展开时才能按目录作用域请求 getDirChildren（目录在项目根外也能展开）。 */
    expect(screen.getByTestId('dir-tree-root').querySelector('[data-dir-id="root"]')).toBeTruthy();
    expect(screen.getByTestId('dir-tree-dir_v1').querySelector('[data-dir-id="dir_v1"]')).toBeTruthy();
    expect(screen.getByTestId('dir-tree-dir_d1').querySelector('[data-dir-id="dir_d1"]')).toBeTruthy();

    restore();
  });
});

describe('FileDrawer 模式切换', () => {
  it('抽屉模式底部显示「切换为固定侧栏模式」按钮', () => {
    useUiStore.setState({ filePanelMode: 'drawer', leftDrawerOpen: true });
    render(<FileDrawer />);
    expect(screen.getByTestId('file-drawer-dock-switch')).toBeInTheDocument();
    expect(screen.getByText('切换为固定侧栏模式')).toBeInTheDocument();
  });

  it('点击切换按钮 → docked 模式，左抽屉关闭', () => {
    useUiStore.setState({ filePanelMode: 'drawer', leftDrawerOpen: true });
    render(<FileDrawer />);

    fireEvent.click(screen.getByTestId('file-drawer-dock-switch'));
    expect(useUiStore.getState().filePanelMode).toBe('docked');
    expect(useUiStore.getState().leftDrawerOpen).toBe(false);
  });
});

describe('FilePanel docked 模式', () => {
  it('渲染固定左栏面板与解除固定按钮', () => {
    useUiStore.setState({ filePanelMode: 'docked', filePanelCollapsed: false, filePanelWidth: 330 });
    render(<FilePanel width={330} />);

    expect(screen.getByTestId('file-docked-panel')).toBeInTheDocument();
    expect(screen.getByTestId('file-docked-unpin')).toBeInTheDocument();
    /* 内容复用 FileDrawerContent */
    expect(screen.getByTestId('file-tree-mock')).toBeInTheDocument();
  });

  it('点击解除固定 → 切回 drawer 模式', () => {
    useUiStore.setState({ filePanelMode: 'docked', filePanelCollapsed: false, leftDrawerOpen: false });
    render(<FilePanel width={330} />);

    fireEvent.click(screen.getByTestId('file-docked-unpin'));
    expect(useUiStore.getState().filePanelMode).toBe('drawer');
    /* setFilePanelMode('drawer') 会重置 leftDrawerOpen=false；requestAnimationFrame 中的 toggleLeftDrawer 使其变 true */
    /* jsdom 中 requestAnimationFrame 回调在下一 tick 执行，验证 mode 切换即可 */
  });
});

describe('FilePanel 持久化', () => {
  it('hydrateLayout 恢复 filePanelMode docked 状态', () => {
    useUiStore.getState().hydrateLayout({ filePanelMode: 'docked' });
    expect(useUiStore.getState().filePanelMode).toBe('docked');
  });

  it('hydrateLayout 恢复 filePanelCollapsed 状态', () => {
    useUiStore.getState().hydrateLayout({ filePanelCollapsed: true });
    expect(useUiStore.getState().filePanelCollapsed).toBe(true);
  });

  it('hydrateLayout 恢复 filePanelWidth 状态', () => {
    useUiStore.getState().hydrateLayout({ filePanelWidth: 400 });
    expect(useUiStore.getState().filePanelWidth).toBe(400);
  });

  it('hydrateLayout 对缺失字段使用默认值', () => {
    useUiStore.setState({ filePanelMode: 'docked', filePanelCollapsed: true, filePanelWidth: 400 });
    useUiStore.getState().hydrateLayout({});
    /* 缺失字段保持当前状态 */
    expect(useUiStore.getState().filePanelMode).toBe('docked');
    expect(useUiStore.getState().filePanelCollapsed).toBe(true);
    expect(useUiStore.getState().filePanelWidth).toBe(400);
  });

  it('hydrateLayout 对非法 filePanelMode 值保持当前状态', () => {
    useUiStore.setState({ filePanelMode: 'docked' });
    useUiStore.getState().hydrateLayout({ filePanelMode: 'invalid' });
    expect(useUiStore.getState().filePanelMode).toBe('docked');
  });

  it('setFilePanelMode 切到 docked 时关闭左抽屉', () => {
    useUiStore.setState({ filePanelMode: 'drawer', leftDrawerOpen: true });
    useUiStore.getState().setFilePanelMode('docked');
    expect(useUiStore.getState().filePanelMode).toBe('docked');
    expect(useUiStore.getState().leftDrawerOpen).toBe(false);
  });

  it('toggleFilePanel 切换折叠状态', () => {
    useUiStore.setState({ filePanelCollapsed: false });
    useUiStore.getState().toggleFilePanel();
    expect(useUiStore.getState().filePanelCollapsed).toBe(true);
    useUiStore.getState().toggleFilePanel();
    expect(useUiStore.getState().filePanelCollapsed).toBe(false);
  });

  it('setFilePanelWidth 限制在 240–500 范围内', () => {
    useUiStore.getState().setFilePanelWidth(100);
    expect(useUiStore.getState().filePanelWidth).toBe(240);
    useUiStore.getState().setFilePanelWidth(600);
    expect(useUiStore.getState().filePanelWidth).toBe(500);
    useUiStore.getState().setFilePanelWidth(350);
    expect(useUiStore.getState().filePanelWidth).toBe(350);
  });
});
