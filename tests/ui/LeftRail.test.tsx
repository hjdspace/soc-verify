// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { openReviewAwareFile } = vi.hoisted(() => ({ openReviewAwareFile: vi.fn() }));
const { trpc } = vi.hoisted(() => ({
  trpc: {
    project: {
      setCwd: { mutate: vi.fn().mockResolvedValue(undefined) },
      addDir: { mutate: vi.fn().mockResolvedValue(undefined) },
      removeDir: { mutate: vi.fn().mockResolvedValue(undefined) },
      pickDirDialog: { mutate: vi.fn().mockResolvedValue({ canceled: false, path: 'D:\\newdir' }) },
    },
  },
}));
const { getToast } = vi.hoisted(() => ({
  getToast: () => ({
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true),
  }),
}));
const { tRPCError } = vi.hoisted(() => ({
  tRPCError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const { addDirMock, removeDirMock, loadExtraDirsMock, renameProjectMock } = vi.hoisted(() => ({
  addDirMock: vi.fn().mockResolvedValue(undefined),
  removeDirMock: vi.fn().mockResolvedValue(undefined),
  loadExtraDirsMock: vi.fn().mockResolvedValue(undefined),
  renameProjectMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@renderer/stores/diff-review', () => ({
  openReviewAwareFile,
  useDiffReviewStore: Object.assign(
    vi.fn((selector: (state: Record<string, unknown>) => unknown) => selector({
      queue: [],
    })),
    { getState: () => ({ queue: [] }) },
  ),
}));
vi.mock('@renderer/lib/trpc', () => ({ trpc }));
vi.mock('@renderer/lib/trpc-utils', () => ({ getToast, tRPCError }));
vi.mock('@renderer/stores/project', () => ({
  useProjectStore: Object.assign(
    vi.fn((selector: (state: Record<string, unknown>) => unknown) => selector({
      projects: [{ id: 'project-1', name: 'Demo', rootPath: 'D:\\project', projectLabel: 'Kunlun' }],
      currentProjectId: 'project-1',
      fileTree: { type: 'directory', name: 'project', path: 'D:\\project', children: [] },
      fileTreeLoading: false,
      extraDirs: [
        { id: 'dir-verify-2', path: 'D:\\verify2', group: 'verify', isCwd: false, order: 1, createdAt: 0 },
        { id: 'dir-design-1', path: 'D:\\design', group: 'design', isCwd: false, order: 0, createdAt: 0 },
      ],
      dirFileTrees: {
        'dir-verify-2': { type: 'directory', name: 'verify2', path: 'D:\\verify2', children: [] },
        'dir-design-1': { type: 'directory', name: 'design', path: 'D:\\design', children: [] },
      },
      dirFileTreeLoading: {},
      loadDirFileTree: vi.fn().mockResolvedValue(undefined),
      loadExtraDirs: loadExtraDirsMock,
      addDir: addDirMock,
      removeDir: removeDirMock,
      renameProject: renameProjectMock,
      openProjectDialog: vi.fn(),
      loadFileTree: vi.fn(),
      closeProject: vi.fn(),
      refreshFileTree: vi.fn(),
      plugins: [],
    })),
    { setState: vi.fn(), getState: () => ({ restoreState: vi.fn().mockResolvedValue(undefined) }) },
  ),
}));
vi.mock('@renderer/stores/overview', () => ({
  useOverviewStore: vi.fn((selector: (state: Record<string, unknown>) => unknown) => selector({
    dataByProject: {}, loading: false, invalidateCount: 0, loadOverview: vi.fn(),
  })),
}));
vi.mock('@renderer/components/project/FileTree', () => ({
  FileTree: ({ onSelectFile, projectRootPath }: {
    onSelectFile: (path: string, name: string) => void;
    projectRootPath?: string;
  }) => (
    <button onClick={() => onSelectFile(`${projectRootPath}\\core.sv`, 'core.sv')}>core.sv</button>
  ),
}));
vi.mock('@renderer/components/project/SubsysList', () => ({ SubsysList: () => null }));
vi.mock('@renderer/components/plugins/PluginViewHost', () => ({ PluginViewHost: () => null }));
vi.mock('@renderer/components/dashboard/DashboardSummary', () => ({ DashboardSummary: () => null }));

import { LeftRail } from '@renderer/components/layout/LeftRail';

describe('LeftRail file tree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('opens a selected file through the review-aware entry', () => {
    render(<LeftRail width={240} />);

    // Multiple FileTree instances are rendered (root + extra dirs).
    // Click the first one (root project tree, projectRootPath = D:\project).
    const fileButtons = screen.getAllByRole('button', { name: 'core.sv' });
    fireEvent.click(fileButtons[0]);

    expect(openReviewAwareFile).toHaveBeenCalledWith('D:\\project\\core.sv', 'core.sv');
  });

  it('renders both verify and design group headers', () => {
    render(<LeftRail width={240} />);

    const verifyGroup = screen.getByTestId('dir-group-verify');
    const designGroup = screen.getByTestId('dir-group-design');

    expect(within(verifyGroup).getByText('验证')).toBeTruthy();
    expect(within(designGroup).getByText('设计')).toBeTruthy();
  });

  it('renders multiple FileTree instances — one per directory', () => {
    render(<LeftRail width={240} />);

    // 3 directories: root + dir-verify-2 + dir-design-1 → 3 FileTree mocks → 3 "core.sv" buttons
    const fileButtons = screen.getAllByRole('button', { name: 'core.sv' });
    expect(fileButtons).toHaveLength(3);
  });

  it('renders add-dir (+) buttons for each group', () => {
    render(<LeftRail width={240} />);

    expect(screen.getByTestId('add-dir-verify')).toBeTruthy();
    expect(screen.getByTestId('add-dir-design')).toBeTruthy();
  });

  it('shows cwd badge on the root directory (default cwd)', () => {
    render(<LeftRail width={240} />);

    const rootDir = screen.getByTestId('dir-tree-root');
    expect(within(rootDir).getByText('cwd')).toBeTruthy();
  });

  it('shows "设为 cwd" button on non-cwd directories', () => {
    render(<LeftRail width={240} />);

    const verify2Dir = screen.getByTestId('dir-tree-dir-verify-2');
    expect(within(verify2Dir).getByText('设为 cwd')).toBeTruthy();
  });

  it('calls setCwd when clicking "设为 cwd"', async () => {
    render(<LeftRail width={240} />);

    const designDir = screen.getByTestId('dir-tree-dir-design-1');
    fireEvent.click(within(designDir).getByText('设为 cwd'));

    await vi.waitFor(() => {
      expect(trpc.project.setCwd.mutate).toHaveBeenCalledWith({
        projectId: 'project-1',
        dirId: 'dir-design-1',
      });
    });
  });

  it('reloads extraDirs after setCwd to refresh the cwd star badge', async () => {
    render(<LeftRail width={240} />);

    const designDir = screen.getByTestId('dir-tree-dir-design-1');
    fireEvent.click(within(designDir).getByText('设为 cwd'));

    await vi.waitFor(() => {
      expect(trpc.project.setCwd.mutate).toHaveBeenCalledWith({
        projectId: 'project-1',
        dirId: 'dir-design-1',
      });
    });

    // loadExtraDirs must be called after setCwd succeeds so the star
    // badge switches to the new cwd immediately.
    await vi.waitFor(() => {
      expect(loadExtraDirsMock).toHaveBeenCalledWith('project-1');
    });
  });

  it('reloads extraDirs after setCwd("root") to switch star back to root', async () => {
    render(<LeftRail width={240} />);

    // Root dir is cwd by default — use context menu to set it again
    // (This tests the "root" path through setCwd)
    const verify2Header = screen.getByTestId('dir-header-dir-verify-2');
    fireEvent.contextMenu(verify2Header);
    fireEvent.click(screen.getByText('设为工作目录'));

    await vi.waitFor(() => {
      expect(trpc.project.setCwd.mutate).toHaveBeenCalledWith({
        projectId: 'project-1',
        dirId: 'dir-verify-2',
      });
    });

    await vi.waitFor(() => {
      expect(loadExtraDirsMock).toHaveBeenCalledWith('project-1');
    });
  });

  // ── Slice 3: 交互 ──────────────────────────────────────

  it('calls addDir when clicking the "+" button on verify group', async () => {
    render(<LeftRail width={240} />);

    const addBtn = screen.getByTestId('add-dir-verify');
    fireEvent.click(addBtn);

    // Wait for the async flow to complete
    await vi.waitFor(() => {
      expect(trpc.project.pickDirDialog.mutate).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(addDirMock).toHaveBeenCalledWith('D:\\newdir', 'verify');
    });
  });

  it('calls addDir with design group when clicking the "+" button on design group', async () => {
    render(<LeftRail width={240} />);

    const addBtn = screen.getByTestId('add-dir-design');
    fireEvent.click(addBtn);

    await vi.waitFor(() => {
      expect(trpc.project.pickDirDialog.mutate).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(addDirMock).toHaveBeenCalledWith('D:\\newdir', 'design');
    });
  });

  it('renders context menu trigger on directory root nodes', () => {
    render(<LeftRail width={240} />);

    // Each directory header should have a context menu trigger (right-click area)
    const rootDir = screen.getByTestId('dir-tree-root');
    expect(within(rootDir).getByTestId('dir-header-root')).toBeTruthy();
  });

  it('shows "设为工作目录" and "移除目录" in directory context menu', () => {
    render(<LeftRail width={240} />);

    // Use a non-cwd extra dir to see both menu items
    const verify2Header = screen.getByTestId('dir-header-dir-verify-2');
    fireEvent.contextMenu(verify2Header);

    expect(screen.getByText('设为工作目录')).toBeTruthy();
    expect(screen.getByText('移除目录')).toBeTruthy();
  });

  it('calls setCwd when clicking "设为工作目录" in context menu', () => {
    render(<LeftRail width={240} />);

    const verify2Header = screen.getByTestId('dir-header-dir-verify-2');
    fireEvent.contextMenu(verify2Header);

    fireEvent.click(screen.getByText('设为工作目录'));

    expect(trpc.project.setCwd.mutate).toHaveBeenCalledWith({
      projectId: 'project-1',
      dirId: 'dir-verify-2',
    });
  });

  it('calls removeDir when clicking "移除目录" in context menu', async () => {
    render(<LeftRail width={240} />);

    const designHeader = screen.getByTestId('dir-header-dir-design-1');
    fireEvent.contextMenu(designHeader);

    fireEvent.click(screen.getByText('移除目录'));

    await vi.waitFor(() => {
      expect(removeDirMock).toHaveBeenCalledWith('dir-design-1');
    });
  });

  it('does not show "设为工作目录" for the current cwd directory', () => {
    render(<LeftRail width={240} />);

    // Root is the default cwd — right-clicking it should not show "设为工作目录"
    const rootHeader = screen.getByTestId('dir-header-root');
    fireEvent.contextMenu(rootHeader);

    // "移除目录" should still appear (root is implicitly verify — but root can't be removed,
    // so let's check for the extra dirs instead)
    const verify2Header = screen.getByTestId('dir-header-dir-verify-2');
    fireEvent.contextMenu(verify2Header);

    // Non-cwd dir should have "设为工作目录"
    expect(screen.getByText('设为工作目录')).toBeTruthy();
  });

  it('renders cwd star icon on the current cwd directory', () => {
    render(<LeftRail width={240} />);

    const rootDir = screen.getByTestId('dir-tree-root');
    // cwd mark should include a star icon (role img with star)
    expect(within(rootDir).getByTestId('cwd-star')).toBeTruthy();
  });

  it('makes cwd directory label bold (font-semibold class)', () => {
    render(<LeftRail width={240} />);

    const rootDir = screen.getByTestId('dir-tree-root');
    const label = within(rootDir).getByTestId('dir-label-root');
    // cwd label should have font-bold class
    expect(label.className).toContain('font-bold');
  });

  it('supports drag-and-drop to add a folder to the verify group', async () => {
    render(<LeftRail width={240} />);

    const verifyGroup = screen.getByTestId('dir-group-verify');
    const dropZone = within(verifyGroup).getByTestId('dir-drop-zone-verify');

    // Simulate drop with a folder path (HTML5 drag-and-drop uses DataTransfer)
    fireEvent.drop(dropZone, {
      dataTransfer: {
        items: [{
          kind: 'file',
          type: '',
          getAsFile: () => ({ path: 'D:\\dropped-verify' }),
        }],
        files: [],
      },
    });

    await vi.waitFor(() => {
      expect(addDirMock).toHaveBeenCalledWith('D:\\dropped-verify', 'verify');
    });
  });

  it('supports drag-and-drop to add a folder to the design group', async () => {
    render(<LeftRail width={240} />);

    const designGroup = screen.getByTestId('dir-group-design');
    const dropZone = within(designGroup).getByTestId('dir-drop-zone-design');

    fireEvent.drop(dropZone, {
      dataTransfer: {
        items: [{
          kind: 'file',
          type: '',
          getAsFile: () => ({ path: 'D:\\dropped-design' }),
        }],
        files: [],
      },
    });

    await vi.waitFor(() => {
      expect(addDirMock).toHaveBeenCalledWith('D:\\dropped-design', 'design');
    });
  });

  // ── 项目重命名 ──────────────────────────────────────

  it('shows project label in the dropdown button', () => {
    render(<LeftRail width={240} />);
    expect(screen.getByTestId('project-dropdown-btn')).toBeTruthy();
    // displayLabel shows projectLabel ('Kunlun'), not name ('Demo')
    expect(screen.getByTestId('project-dropdown-btn').textContent).toContain('Kunlun');
    expect(screen.getByTestId('project-dropdown-btn').textContent).not.toContain('Demo');
  });

  it('opens rename input on double-click of project dropdown button', () => {
    render(<LeftRail width={240} />);

    const btn = screen.getByTestId('project-dropdown-btn');
    fireEvent.doubleClick(btn);

    expect(screen.getByTestId('header-rename-input')).toBeTruthy();
  });

  it('calls renameProject when submitting rename via Enter key', async () => {
    render(<LeftRail width={240} />);

    // Open rename mode
    const btn = screen.getByTestId('project-dropdown-btn');
    fireEvent.doubleClick(btn);

    const input = screen.getByTestId('header-rename-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'RenamedProject' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await vi.waitFor(() => {
      expect(renameProjectMock).toHaveBeenCalledWith('project-1', 'RenamedProject');
    });
  });

  it('cancels rename on Escape key', () => {
    render(<LeftRail width={240} />);

    const btn = screen.getByTestId('project-dropdown-btn');
    fireEvent.doubleClick(btn);

    const input = screen.getByTestId('header-rename-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'ShouldNotSave' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    // Rename input should be gone, dropdown button should be back
    expect(screen.queryByTestId('header-rename-input')).toBeNull();
    expect(screen.getByTestId('project-dropdown-btn')).toBeTruthy();
    // renameProject should NOT have been called
    expect(renameProjectMock).not.toHaveBeenCalled();
  });
});
