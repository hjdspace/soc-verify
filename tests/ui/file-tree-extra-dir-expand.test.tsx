// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { FileTreeNode } from '@shared/types';

// ─── Store / trpc mocks ───────────────────────────────────

const { trpc } = vi.hoisted(() => ({
  trpc: {
    project: {
      getDirChildren: { query: vi.fn() },
      openInSystem: { mutate: vi.fn().mockResolvedValue(undefined) },
      deleteNode: { mutate: vi.fn().mockResolvedValue(undefined) },
    },
  },
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
    selector({ status: null, loadStatus: vi.fn().mockResolvedValue(undefined) })),
}));

import { FileTree } from '@renderer/components/project/FileTree';

// 每个测试前重置 mock store 的展开状态
function resetExpandedDirs() {
  useMockProjectStore.setState({
    expandedDirs: new Set<string>(),
    expandedRootsSeeded: new Set<string>(),
  });
}

// ─── Fixtures ─────────────────────────────────────────────

// 模拟一个「设计」分组下的额外目录（位于项目根之外），其子目录为 lazy 节点。
const EXTRA_ROOT = 'E:\\rtl\\soc-rtl';

function lazyDir(path: string, name: string): FileTreeNode {
  return { name, path, type: 'directory', children: [], lazy: true };
}

const tree: FileTreeNode = {
  name: 'soc-rtl',
  path: EXTRA_ROOT,
  type: 'directory',
  children: [lazyDir(`${EXTRA_ROOT}\\sub`, 'sub')],
};

describe('FileTree lazy expansion for out-of-root extra dirs (verify/design groups)', () => {
  beforeEach(() => {
    resetExpandedDirs();
  });
  it('sends the owning dirId when expanding a lazy directory', async () => {
    const children: FileTreeNode[] = [
      { name: 'a.sv', path: `${EXTRA_ROOT}\\sub\\a.sv`, type: 'file' },
    ];
    trpc.project.getDirChildren.query.mockResolvedValue(children);

    render(
      <FileTree
        node={tree}
        onSelectFile={vi.fn()}
        projectRootPath={EXTRA_ROOT}
        dirId="dir_x1"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'sub' }));

    expect(trpc.project.getDirChildren.query).toHaveBeenCalledWith({
      projectId: 'project-1',
      dirPath: `${EXTRA_ROOT}\\sub`,
      dirId: 'dir_x1',
    });

    // 子目录内容在 fetch 完成后渲染出来
    expect(await screen.findByRole('button', { name: /a\.sv/ })).toBeTruthy();
  });

  it('root tree sends dirId "root"', async () => {
    trpc.project.getDirChildren.query.mockResolvedValue([]);

    const rootTree: FileTreeNode = {
      name: 'project',
      path: 'D:\\proj\\p1',
      type: 'directory',
      children: [lazyDir('D:\\proj\\p1\\src', 'src')],
    };
    render(
      <FileTree
        node={rootTree}
        onSelectFile={vi.fn()}
        projectRootPath="D:\\proj\\p1"
        dirId="root"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'src' }));

    expect(trpc.project.getDirChildren.query).toHaveBeenCalledWith({
      projectId: 'project-1',
      dirPath: 'D:\\proj\\p1\\src',
      dirId: 'root',
    });
  });

  it('logs a warning and allows retry when expansion fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    trpc.project.getDirChildren.query
      .mockRejectedValueOnce(new Error('Path is outside project root'))
      .mockResolvedValueOnce([
        { name: 'b.sv', path: `${EXTRA_ROOT}\\sub\\b.sv`, type: 'file' },
      ]);

    render(
      <FileTree
        node={tree}
        onSelectFile={vi.fn()}
        projectRootPath={EXTRA_ROOT}
        dirId="dir_x1"
      />,
    );

    // 第一次展开失败：不应静默吞错
    fireEvent.click(screen.getByRole('button', { name: 'sub' }));
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());

    // 折叠后再次展开可重试，成功后内容渲染
    fireEvent.click(screen.getByRole('button', { name: 'sub' }));
    await vi.waitFor(() => {
      // 等待折叠生效（expandedDirs 已移除路径）
      expect(useMockProjectStore.getState().expandedDirs.has(`${EXTRA_ROOT}\\sub`)).toBe(false);
    });
    fireEvent.click(screen.getByRole('button', { name: 'sub' }));
    expect(await screen.findByRole('button', { name: /b\.sv/ })).toBeTruthy();

    warn.mockRestore();
  });
});
