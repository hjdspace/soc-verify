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
          files: [{
            path: 'src/main.ts',
            indexStatus: ' ',
            workTreeStatus: 'M',
            staged: false,
            unstaged: true,
          }],
        }),
      },
      generateCommitMessage: {
        mutate: vi.fn().mockResolvedValue({ message: 'feat: add scm panel' }),
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
  useSessionStore: vi.fn((selector: (s: { lastModel: { id: string } }) => unknown) => selector({
    lastModel: { id: 'test-model' },
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
    });
  });

  it('renders changed files and generates a commit message', async () => {
    render(<SourceControlPanel />);

    await screen.findByText('src/main.ts');

    fireEvent.click(screen.getByText('AI 生成'));

    await waitFor(() => {
      expect(vi.mocked(trpc.scm.generateCommitMessage.mutate)).toHaveBeenCalledWith({
        projectId: 'project-1',
        modelId: 'test-model',
      });
    });
    await waitFor(() => {
      expect(screen.getByPlaceholderText('提交信息')).toHaveValue('feat: add scm panel');
    });
  });
});
