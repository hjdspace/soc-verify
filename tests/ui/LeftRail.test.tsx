// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { openReviewAwareFile } = vi.hoisted(() => ({ openReviewAwareFile: vi.fn() }));

vi.mock('@renderer/stores/diff-review', () => ({ openReviewAwareFile }));
vi.mock('@renderer/stores/project', () => ({
  useProjectStore: Object.assign(
    vi.fn((selector: (state: Record<string, unknown>) => unknown) => selector({
      projects: [{ id: 'project-1', name: 'Demo', rootPath: 'D:\\project' }],
      currentProjectId: 'project-1',
      fileTree: { type: 'directory', name: 'project', path: 'D:\\project', children: [] },
      fileTreeLoading: false,
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
  FileTree: ({ onSelectFile }: { onSelectFile: (path: string, name: string) => void }) => (
    <button onClick={() => onSelectFile('D:\\project\\rtl\\core.sv', 'core.sv')}>core.sv</button>
  ),
}));
vi.mock('@renderer/components/project/SubsysList', () => ({ SubsysList: () => null }));
vi.mock('@renderer/components/plugins/PluginViewHost', () => ({ PluginViewHost: () => null }));
vi.mock('@renderer/components/dashboard/DashboardSummary', () => ({ DashboardSummary: () => null }));

import { LeftRail } from '@renderer/components/layout/LeftRail';

describe('LeftRail file tree', () => {
  it('opens a selected file through the review-aware entry', () => {
    render(<LeftRail width={240} />);

    fireEvent.click(screen.getByRole('button', { name: 'core.sv' }));

    expect(openReviewAwareFile).toHaveBeenCalledWith('D:\\project\\rtl\\core.sv', 'core.sv');
  });
});
