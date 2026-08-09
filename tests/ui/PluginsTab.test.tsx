// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  project: {
    currentProjectId: 'project-1' as string | null,
    pluginsLoading: false,
    plugins: [{
      id: 'eda-log-summary',
      name: 'EDA Log Summary',
      version: '0.1.0',
      kind: 'ui',
      source: 'local',
      origin: 'user',
      path: 'C:\\Users\\tester\\.socverify\\plugins\\eda-log-summary\\index.cjs',
      enabled: true,
      active: true,
      contributes: {
        views: [{ id: 'summary', name: 'EDA Log Summary', location: 'center', html: '<p>summary</p>' }],
      },
    }],
    loadPlugins: vi.fn().mockResolvedValue(undefined),
    reloadPlugins: vi.fn().mockResolvedValue(undefined),
    togglePlugin: vi.fn().mockResolvedValue(undefined),
  },
  open: vi.fn(),
  setSettingsOpen: vi.fn(),
}));

vi.mock('@renderer/stores/project', () => ({
  useProjectStore: (selector: (state: typeof mocks.project) => unknown) => selector(mocks.project),
}));

vi.mock('@renderer/stores/workbench', () => ({
  useWorkbenchStore: (selector: (state: { open: typeof mocks.open }) => unknown) => selector({ open: mocks.open }),
}));

vi.mock('@renderer/stores/ui', () => ({
  useUiStore: (selector: (state: { setSettingsOpen: typeof mocks.setSettingsOpen }) => unknown) => (
    selector({ setSettingsOpen: mocks.setSettingsOpen })
  ),
}));

import { PluginsTab } from '@renderer/components/settings/PluginsTab';

describe('PluginsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.project.currentProjectId = 'project-1';
    mocks.project.pluginsLoading = false;
  });

  it('shows discovered plugin state and exposes management actions', async () => {
    render(<PluginsTab />);

    expect(screen.getAllByText('EDA Log Summary')).toHaveLength(2);
    expect(screen.getByText('用户')).toBeInTheDocument();
    expect(screen.getByText('运行中')).toBeInTheDocument();
    await waitFor(() => expect(mocks.project.loadPlugins).toHaveBeenCalledWith('project-1'));

    fireEvent.click(screen.getByRole('button', { name: '重新扫描' }));
    expect(mocks.project.reloadPlugins).toHaveBeenCalledOnce();

    const enableSwitch = screen.getByRole('switch', { name: '停用 EDA Log Summary' });
    expect(enableSwitch.firstElementChild).toHaveClass('left-0.5', 'translate-x-4');

    fireEvent.click(enableSwitch);
    expect(mocks.project.togglePlugin).toHaveBeenCalledWith('eda-log-summary', false);
  });

  it('opens a contributed view in the workbench and closes settings', () => {
    render(<PluginsTab />);

    fireEvent.click(screen.getByRole('button', { name: 'EDA Log Summary' }));
    expect(mocks.open).toHaveBeenCalledWith({
      type: 'plugin-view',
      pluginId: 'eda-log-summary',
      viewId: 'summary',
      title: 'EDA Log Summary',
    });
    expect(mocks.setSettingsOpen).toHaveBeenCalledWith(false);
  });

  it('explains that a project is required before plugins can be managed', () => {
    mocks.project.currentProjectId = null;
    render(<PluginsTab />);

    expect(screen.getByText('打开项目后管理插件')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重新扫描' })).not.toBeInTheDocument();
  });
});
