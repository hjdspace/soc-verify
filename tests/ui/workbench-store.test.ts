import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkbenchStore } from '@renderer/stores/workbench';

describe('Workbench navigation', () => {
  beforeEach(() => {
    useWorkbenchStore.setState({ tabs: [], activeTabId: null });
  });

  it('opens a typed destination once and activates it', () => {
    const destination = { type: 'file' as const, path: 'rtl/core.sv', name: 'core.sv' };

    useWorkbenchStore.getState().open(destination);
    useWorkbenchStore.getState().open(destination);

    const state = useWorkbenchStore.getState();
    expect(state.tabs).toEqual([
      {
        id: 'file:rtl/core.sv',
        title: 'core.sv',
        closable: true,
        destination,
      },
    ]);
    expect(state.activeTabId).toBe('file:rtl/core.sv');
  });

  it('activates the most recently opened remaining destination when closing the active tab', () => {
    const workbench = useWorkbenchStore.getState();
    workbench.open({ type: 'dashboard' });
    workbench.open({ type: 'simulation-history' });

    useWorkbenchStore.getState().closeActive();

    const state = useWorkbenchStore.getState();
    expect(state.tabs.map((tab) => tab.destination.type)).toEqual(['dashboard']);
    expect(state.activeTabId).toBe('dashboard');
  });

  it('updates terminal metadata without exposing tab identity rules to callers', () => {
    useWorkbenchStore.getState().open({
      type: 'terminal',
      terminalTabId: 'tab-1',
      title: 'Terminal 1',
    });

    useWorkbenchStore.getState().open({
      type: 'terminal',
      terminalTabId: 'tab-1',
      title: 'Simulation terminal',
    });

    const state = useWorkbenchStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].title).toBe('Simulation terminal');
    expect(state.activeTabId).toBe('terminal:tab-1');
  });
});
