// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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

const { scmFiles } = vi.hoisted(() => ({ scmFiles: [] as SourceControlStatus['files'] }));

vi.mock('@renderer/lib/trpc', () => ({ trpc }));
vi.mock('@renderer/stores/project', () => ({
  useProjectStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ currentProjectId: 'project-1' })),
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
