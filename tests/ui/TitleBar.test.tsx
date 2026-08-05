// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/stores/ui', () => ({
  useUiStore: vi.fn((selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      leftRailCollapsed: false,
      rightPanelCollapsed: false,
      bottomPanelCollapsed: true,
      toggleLeftRail: vi.fn(),
      toggleRightPanel: vi.fn(),
      toggleBottomPanel: vi.fn(),
      setBottomPanelCollapsed: vi.fn(),
      setBottomPanelHeight: vi.fn(),
      settingsOpen: false,
      setSettingsOpen: vi.fn(),
      setCommandPaletteOpen: vi.fn(),
      sourceControlOpen: false,
      setSourceControlOpen: vi.fn(),
    }),
  ),
}));

vi.mock('@renderer/stores/terminal', () => ({
  useTerminalStore: vi.fn((selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      tabs: [],
      bottomActiveTabId: null,
      createTerminal: vi.fn(),
    }),
  ),
}));

vi.mock('@renderer/stores/project', () => ({
  useProjectStore: vi.fn((selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      currentProjectId: 'project-1',
      projects: [{ id: 'project-1', name: 'chipnorth' }],
      selectedSubsys: 'alu_core',
    }),
  ),
}));

vi.mock('@renderer/stores/simulation', () => ({
  useSimulationStore: vi.fn((selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      activeRuns: [],
      simOptions: { case: 'alu_add_test' },
    }),
  ),
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    tools: {
      open: { mutate: vi.fn() },
    },
  },
}));

vi.mock('@renderer/stores/toast', () => ({
  useToastStore: vi.fn((selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      error: vi.fn(),
      info: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
    }),
  ),
}));

import { TitleBar } from '@renderer/components/layout/TitleBar';

describe('TitleBar context', () => {
  it('shows the current project, subsystem, and case in the breadcrumb', () => {
    render(<TitleBar />);

    const breadcrumb = screen.getByRole('navigation');
    expect(within(breadcrumb).getByText('chipnorth')).toBeInTheDocument();
    expect(within(breadcrumb).getByText('alu_core')).toBeInTheDocument();
    expect(within(breadcrumb).getByText('alu_add_test')).toBeInTheDocument();
  });
});
