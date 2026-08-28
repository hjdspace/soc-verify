// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    scm: {
      status: {
        query: vi.fn().mockResolvedValue({
          isRepository: true,
          branch: 'main',
          ahead: 0,
          behind: 0,
          files: [
            {
              path: 'src/main.ts',
              indexStatus: ' ',
              workTreeStatus: 'M',
              staged: false,
              unstaged: true,
            },
            {
              path: 'src/utils.ts',
              indexStatus: 'M',
              workTreeStatus: ' ',
              staged: true,
              unstaged: false,
            },
          ],
        }),
      },
      generateCommitMessage: {
        mutate: vi.fn().mockResolvedValue({ message: 'feat: add scm panel' }),
      },
      fileDiff: {
        query: vi.fn().mockResolvedValue({
          diff: {
            path: 'src/main.ts',
            staged: false,
            isNewFile: false,
            isDeleted: false,
            isBinary: false,
            hunks: [
              {
                header: '@@ -1,2 +1,3 @@',
                lines: [
                  { type: 'ctx', content: 'keep me', oldLine: 1, newLine: 1 },
                  { type: 'del', content: 'old line', oldLine: 2 },
                  { type: 'add', content: 'new line', newLine: 2 },
                  { type: 'add', content: 'extra line', newLine: 3 },
                ],
              },
            ],
            totalAdd: 2,
            totalDel: 1,
          },
        }),
      },
      stage: {
        mutate: vi.fn().mockResolvedValue({
          isRepository: true,
          branch: 'main',
          ahead: 0,
          behind: 0,
          files: [
            {
              path: 'src/main.ts',
              indexStatus: 'M',
              workTreeStatus: ' ',
              staged: true,
              unstaged: false,
            },
            {
              path: 'src/utils.ts',
              indexStatus: 'M',
              workTreeStatus: ' ',
              staged: true,
              unstaged: false,
            },
          ],
        }),
      },
      unstage: {
        mutate: vi.fn().mockResolvedValue({
          isRepository: true,
          branch: 'main',
          ahead: 0,
          behind: 0,
          files: [],
        }),
      },
      discard: {
        mutate: vi.fn().mockResolvedValue({
          isRepository: true,
          branch: 'main',
          ahead: 0,
          behind: 0,
          files: [],
        }),
      },
      commit: {
        mutate: vi.fn().mockResolvedValue({ commitHash: 'abc1234', summary: 'ok' }),
      },
      commitAll: {
        mutate: vi.fn().mockResolvedValue({ commitHash: 'abc1234', summary: 'ok' }),
      },
    },
  },
}));

vi.mock('@renderer/stores/project', () => ({
  useProjectStore: vi.fn((selector: (s: {
    currentProjectId: string;
    projects: Array<{ id: string; name: string; rootPath: string }>;
  }) => unknown) => selector({
    currentProjectId: 'project-1',
    projects: [{ id: 'project-1', name: 'Demo', rootPath: 'D:\\repo' }],
  })),
}));

vi.mock('@renderer/stores/session-core', () => ({
  useSessionCoreStore: vi.fn((selector: (s: { lastModel: { id: string; providerId?: string } }) => unknown) => selector({
    lastModel: { id: 'test-model', providerId: 'test-provider' },
  })),
}));

import { SourceControlPanel } from '@renderer/components/scm/SourceControlPanel';
import { useSourceControlStore } from '@renderer/stores/source-control';
import { trpc } from '@renderer/lib/trpc';

describe('SourceControlPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSourceControlStore.setState({
      status: null,
      commitMessage: '',
      loading: false,
      generating: false,
      committing: false,
      staging: false,
      expandedDiffKeys: {},
      fileDiffs: {},
      loadingDiffKeys: {},
    });
  });

  it('renders staged and unstaged file sections', async () => {
    render(<SourceControlPanel />);

    // Both files should be visible
    await screen.findByText('src/main.ts');
    await screen.findByText('src/utils.ts');

    // Section headers
    expect(screen.getByText('已暂存的更改')).toBeInTheDocument();
    expect(screen.getByText('更改')).toBeInTheDocument();
  });

  it('generates a commit message via AI', async () => {
    render(<SourceControlPanel />);

    await screen.findByText('src/main.ts');

    fireEvent.click(screen.getByText('AI 生成'));

    await waitFor(() => {
      expect(vi.mocked(trpc.scm.generateCommitMessage.mutate)).toHaveBeenCalledWith({
        projectId: 'project-1',
        modelId: 'test-model',
        providerId: 'test-provider',
      });
    });
    await waitFor(() => {
      expect(screen.getByPlaceholderText('提交信息（支持 Conventional Commits 格式）')).toHaveValue('feat: add scm panel');
    });
  });

  it('puts the generated body into the commit textarea', async () => {
    vi.mocked(trpc.scm.generateCommitMessage.mutate).mockResolvedValueOnce({
      message: 'feat: add scm panel\n\n- 添加提交正文说明',
    });
    render(<SourceControlPanel />);

    await screen.findByText('src/main.ts');
    fireEvent.click(screen.getByText('AI 生成'));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('提交信息（支持 Conventional Commits 格式）')).toHaveValue(
        'feat: add scm panel\n\n- 添加提交正文说明',
      );
    });
  });

  it('stages a file when the plus button is clicked', async () => {
    render(<SourceControlPanel />);

    await screen.findByText('src/main.ts');

    // Click the stage (+) button for the unstaged file
    const stageButton = screen.getByTitle('暂存');
    fireEvent.click(stageButton);

    await waitFor(() => {
      expect(vi.mocked(trpc.scm.stage.mutate)).toHaveBeenCalledWith({
        projectId: 'project-1',
        filePaths: ['src/main.ts'],
      });
    });
  });

  it('commits staged changes', async () => {
    render(<SourceControlPanel />);

    await screen.findByText('src/utils.ts');

    // Type a commit message
    const textarea = screen.getByPlaceholderText('提交信息（支持 Conventional Commits 格式）');
    fireEvent.change(textarea, { target: { value: 'feat: test commit' } });

    // Click commit
    fireEvent.click(screen.getByText('提交'));

    await waitFor(() => {
      expect(vi.mocked(trpc.scm.commit.mutate)).toHaveBeenCalledWith({
        projectId: 'project-1',
        message: 'feat: test commit',
      });
    });
  });

  // ── expandable diff review ─────────────────────────────────────

  it('expands a file row to show its diff for review', async () => {
    render(<SourceControlPanel />);

    await screen.findByText('src/main.ts');
    fireEvent.click(screen.getByText('src/main.ts'));

    await waitFor(() => {
      expect(vi.mocked(trpc.scm.fileDiff.query)).toHaveBeenCalledWith({
        projectId: 'project-1',
        filePath: 'src/main.ts',
        staged: false,
      });
    });

    // Hunk header and diff lines render
    expect(await screen.findByText('@@ -1,2 +1,3 @@')).toBeInTheDocument();
    expect(screen.getByText('keep me')).toBeInTheDocument();
    expect(screen.getByText('old line')).toBeInTheDocument();
    expect(screen.getByText('new line')).toBeInTheDocument();
    expect(screen.getByText('extra line')).toBeInTheDocument();
  });

  it('collapses the diff when the row is clicked again without refetching', async () => {
    render(<SourceControlPanel />);

    await screen.findByText('src/main.ts');
    fireEvent.click(screen.getByText('src/main.ts'));
    expect(await screen.findByText('@@ -1,2 +1,3 @@')).toBeInTheDocument();

    fireEvent.click(screen.getByText('src/main.ts'));
    await waitFor(() => {
      expect(screen.queryByText('@@ -1,2 +1,3 @@')).not.toBeInTheDocument();
    });
    expect(vi.mocked(trpc.scm.fileDiff.query)).toHaveBeenCalledTimes(1);
  });

  it('requests the staged diff for staged file rows', async () => {
    render(<SourceControlPanel />);

    await screen.findByText('src/utils.ts');
    fireEvent.click(screen.getByText('src/utils.ts'));

    await waitFor(() => {
      expect(vi.mocked(trpc.scm.fileDiff.query)).toHaveBeenCalledWith({
        projectId: 'project-1',
        filePath: 'src/utils.ts',
        staged: true,
      });
    });
  });

  it('does not toggle the diff when an action button is clicked', async () => {
    render(<SourceControlPanel />);

    await screen.findByText('src/main.ts');
    fireEvent.click(screen.getByTitle('暂存'));

    await waitFor(() => {
      expect(vi.mocked(trpc.scm.stage.mutate)).toHaveBeenCalled();
    });
    expect(vi.mocked(trpc.scm.fileDiff.query)).not.toHaveBeenCalled();
  });
});
