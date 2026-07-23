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

vi.mock('@renderer/stores/session', () => ({
  useSessionStore: vi.fn((selector: (s: { lastModel: { id: string; providerId?: string } }) => unknown) => selector({
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
});
