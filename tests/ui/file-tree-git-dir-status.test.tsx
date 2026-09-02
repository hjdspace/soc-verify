// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { FileTreeNode, SourceControlStatus } from '@shared/types';

// ─── Store / trpc mocks ───────────────────────────────────

const { trpc } = vi.hoisted(() => ({
  trpc: {
    project: {
      getDirChildren: { query: vi.fn().mockResolvedValue([]) },
      openInSystem: { mutate: vi.fn().mockResolvedValue(undefined) },
      deleteNode: { mutate: vi.fn().mockResolvedValue(undefined) },
    },
  },
}));

const { scmFiles, refreshStatusMock } = vi.hoisted(() => ({
  scmFiles: [] as SourceControlStatus['files'],
  refreshStatusMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@renderer/lib/trpc', () => ({ trpc }));

// 使用真实的 Zustand store 来 mock project store，
// 这样 toggleDirExpanded 修改状态后能正常触发组件重新渲染。
const { useMockProjectStore } = vi.hoisted(() => {
  const { create } = require('zustand') as typeof import('zustand');
  const useMockProjectStore = create<{
    currentProjectId: string | null;
    expandedDirs: Set<string>;
    expandedRootsSeeded: Set<string>;
    toggleDirExpanded: (path: string) => void;
    setDirExpanded: (path: string, expanded: boolean) => void;
    seedRootExpanded: (path: string) => void;
  }>((set) => ({
    currentProjectId: 'project-1',
    expandedDirs: new Set<string>(),
    expandedRootsSeeded: new Set<string>(),
    toggleDirExpanded: (path: string) =>
      set((s) => {
        const next = new Set(s.expandedDirs);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        return { expandedDirs: next };
      }),
    setDirExpanded: (path: string, expanded: boolean) =>
      set((s) => {
        const next = new Set(s.expandedDirs);
        if (expanded) next.add(path);
        else next.delete(path);
        return { expandedDirs: next };
      }),
    seedRootExpanded: (path: string) =>
      set((s) => {
        if (s.expandedRootsSeeded.has(path)) return {};
        const nextSeeded = new Set(s.expandedRootsSeeded);
        nextSeeded.add(path);
        const nextExpanded = new Set(s.expandedDirs);
        nextExpanded.add(path);
        return { expandedRootsSeeded: nextSeeded, expandedDirs: nextExpanded };
      }),
  }));
  return { useMockProjectStore };
});

vi.mock('@renderer/stores/project', () => ({
  useProjectStore: useMockProjectStore,
}));
vi.mock('@renderer/stores/session-core', () => ({
  useSessionCoreStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ addContextFile: vi.fn(), currentSessionId: null })),
}));
vi.mock('@renderer/stores/toast', () => ({
  useToastStore: Object.assign(vi.fn(), {
    getState: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
  }),
}));
vi.mock('@renderer/stores/source-control', () => ({
  useSourceControlStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      status: {
        isRepository: true,
        branch: 'main',
        ahead: 0,
        behind: 0,
        files: scmFiles,
      },
      loadStatus: vi.fn().mockResolvedValue(undefined),
      refreshStatus: refreshStatusMock,
    })),
}));

import { FileTree } from '@renderer/components/project/FileTree';

// ─── Fixtures ─────────────────────────────────────────────

const ROOT = 'D:\\project';

function file(path: string, name: string): FileTreeNode {
  return { name, path, type: 'file' };
}

function dir(path: string, name: string, children: FileTreeNode[]): FileTreeNode {
  return { name, path, type: 'directory', children };
}

function status(path: string, indexStatus: string, workTreeStatus: string) {
  return {
    path,
    indexStatus,
    workTreeStatus,
    staged: indexStatus !== ' ' && indexStatus !== '?',
    unstaged: workTreeStatus !== ' ',
  };
}

const tree: FileTreeNode = dir(ROOT, 'project', [
  dir(`${ROOT}\\src`, 'src', [
    file(`${ROOT}\\src\\core.sv`, 'core.sv'),
    file(`${ROOT}\\src\\new.sv`, 'new.sv'),
  ]),
  dir(`${ROOT}\\docs`, 'docs', [file(`${ROOT}\\docs\\guide.md`, 'guide.md')]),
  dir(`${ROOT}\\out`, 'out', [file(`${ROOT}\\out\\build.log`, 'build.log')]),
]);

function renderTree() {
  return render(
    <FileTree node={tree} onSelectFile={vi.fn()} projectRootPath={ROOT} />,
  );
}

// ─── Tests ────────────────────────────────────────────────

describe('FileTree git directory status markers', () => {
  beforeEach(() => {
    useMockProjectStore.setState({
      expandedDirs: new Set<string>(),
      expandedRootsSeeded: new Set<string>(),
    });
  });
  it('marks folders containing modified files yellow with a yellow dot', () => {
    scmFiles.length = 0;
    scmFiles.push(status('src/core.sv', 'M', ' '));
    renderTree();

    const srcRow = screen.getByRole('button', { name: 'src' });
    // Folder name is yellow
    expect(srcRow.querySelector('.text-warning-foreground')).toBeTruthy();
    // Yellow dot on the right with tooltip
    const dot = within(srcRow).getByTitle('包含修改的文件');
    expect(dot.className).toContain('text-warning-foreground');
    expect(dot.className).toContain('rounded-full');
  });

  it('marks folders containing only new files green with a green dot', () => {
    scmFiles.length = 0;
    scmFiles.push(status('docs/guide.md', '?', '?'));
    renderTree();

    const docsRow = screen.getByRole('button', { name: 'docs' });
    expect(docsRow.querySelector('.text-status-pass-foreground')).toBeTruthy();
    const dot = within(docsRow).getByTitle('包含新增的文件');
    expect(dot.className).toContain('text-status-pass-foreground');
  });

  it('prefers yellow (modified) when a folder has both modified and added files', () => {
    scmFiles.length = 0;
    scmFiles.push(
      status('src/core.sv', 'M', ' '),
      status('src/new.sv', '?', '?'),
    );
    renderTree();

    const srcRow = screen.getByRole('button', { name: 'src' });
    expect(srcRow.querySelector('.text-warning-foreground')).toBeTruthy();
    expect(within(srcRow).queryByTitle('包含新增的文件')).toBeNull();
  });

  it('propagates status up to ancestor folders', () => {
    scmFiles.length = 0;
    scmFiles.push(status('docs/guide.md', '?', '?'));
    renderTree();

    // docs itself…
    const docsRow = screen.getByRole('button', { name: 'docs' });
    expect(within(docsRow).getByTitle('包含新增的文件')).toBeTruthy();
    // …but not the project root (VS Code does not decorate the workspace root)
    const rootRow = screen.getByRole('button', { name: 'project' });
    expect(within(rootRow).queryByTitle('包含新增的文件')).toBeNull();
    expect(within(rootRow).queryByTitle('包含修改的文件')).toBeNull();
  });

  it('leaves clean folders undecorated', () => {
    scmFiles.length = 0;
    scmFiles.push(status('src/core.sv', 'M', ' '));
    renderTree();

    const outRow = screen.getByRole('button', { name: 'out' });
    expect(within(outRow).queryByTitle('包含修改的文件')).toBeNull();
    expect(within(outRow).queryByTitle('包含新增的文件')).toBeNull();
    expect(outRow.querySelector('.text-warning-foreground')).toBeNull();
    expect(outRow.querySelector('.text-status-pass-foreground')).toBeNull();
  });

  it('still renders file-level badges after expanding a marked folder', () => {
    scmFiles.length = 0;
    scmFiles.push(
      status('src/core.sv', 'M', ' '),
      status('src/new.sv', '?', '?'),
    );
    renderTree();

    fireEvent.click(screen.getByRole('button', { name: 'src' }));

    const coreRow = screen.getByRole('button', { name: /core\.sv/ });
    expect(within(coreRow).getByText('M')).toBeTruthy();
    const newRow = screen.getByRole('button', { name: /new\.sv/ });
    expect(within(newRow).getByText('U')).toBeTruthy();
  });
});

describe('FileTree root collapse', () => {
  beforeEach(() => {
    useMockProjectStore.setState({
      expandedDirs: new Set<string>(),
      expandedRootsSeeded: new Set<string>(),
    });
  });

  it('root is expanded by default and can be collapsed by clicking', () => {
    renderTree();

    // 子节点始终渲染、仅通过 CSS grid-rows 折叠/展开（同 VS Code 动画行为），
    // 因此断言折叠容器类而非子节点是否存在。
    const gridClass = () => {
      const rootBtn = screen.getByRole('button', { name: 'project' });
      const wrapper = rootBtn.parentElement as HTMLElement;
      const grid = wrapper.querySelector(':scope > div.grid') as HTMLElement;
      return grid.className;
    };

    // 默认展开（seed 生效后仍在 expandedDirs 中）
    expect(gridClass()).toContain('grid-rows-[1fr]');

    // 点击根目录折叠
    fireEvent.click(screen.getByRole('button', { name: 'project' }));
    expect(gridClass()).toContain('grid-rows-[0fr]');
    expect(useMockProjectStore.getState().expandedDirs.has(ROOT)).toBe(false);

    // 再次点击恢复展开
    fireEvent.click(screen.getByRole('button', { name: 'project' }));
    expect(gridClass()).toContain('grid-rows-[1fr]');
    expect(useMockProjectStore.getState().expandedDirs.has(ROOT)).toBe(true);
  });
});

describe('FileTree refreshes git badges on filetree:update events', () => {
  let fileTreeUpdateCb: ((update: { projectId: string; type: 'add' | 'unlink' | 'change'; path: string }) => void) | null = null;

  beforeEach(() => {
    refreshStatusMock.mockClear();
    // 模拟 preload eventBridge：捕获 onFileTreeUpdate 订阅回调
    (window as unknown as { eventBridge: unknown }).eventBridge = {
      onFileTreeUpdate: (cb: typeof fileTreeUpdateCb) => {
        fileTreeUpdateCb = cb;
        return () => {
          fileTreeUpdateCb = null;
        };
      },
    };
  });

  afterEach(() => {
    delete (window as unknown as { eventBridge?: unknown }).eventBridge;
    fileTreeUpdateCb = null;
  });

  it('calls refreshStatus when a filetree:add event arrives for the current project', () => {
    render(
      <FileTree node={tree} onSelectFile={vi.fn()} projectRootPath={ROOT} />,
    );

    expect(refreshStatusMock).not.toHaveBeenCalled();
    fileTreeUpdateCb?.({ projectId: 'project-1', type: 'add', path: 'D:/project/new.py' });
    expect(refreshStatusMock).toHaveBeenCalledWith('project-1');
  });

  it('ignores filetree:update events from other projects', () => {
    render(
      <FileTree node={tree} onSelectFile={vi.fn()} projectRootPath={ROOT} />,
    );

    fileTreeUpdateCb?.({ projectId: 'other-project', type: 'add', path: 'D:/elsewhere/new.py' });
    expect(refreshStatusMock).not.toHaveBeenCalled();
  });

  it('stops listening after unmount', () => {
    const { unmount } = render(
      <FileTree node={tree} onSelectFile={vi.fn()} projectRootPath={ROOT} />,
    );
    unmount();

    fileTreeUpdateCb?.({ projectId: 'project-1', type: 'add', path: 'D:/project/new.py' });
    expect(refreshStatusMock).not.toHaveBeenCalled();
  });
});
