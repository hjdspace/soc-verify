import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkbenchStore } from '@renderer/stores/workbench';

describe('Workbench timing-violation destination', () => {
  beforeEach(() => {
    useWorkbenchStore.setState({ tabs: [], activeTabId: null });
  });

  it('opens timing-violation destination with correct tab metadata', () => {
    useWorkbenchStore.getState().open({ type: 'timing-violation' });

    const state = useWorkbenchStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toEqual({
      id: 'timing-violation',
      title: '时序违例',
      closable: true,
      destination: { type: 'timing-violation' },
    });
    expect(state.activeTabId).toBe('timing-violation');
  });

  it('does not create duplicate tabs for timing-violation', () => {
    useWorkbenchStore.getState().open({ type: 'timing-violation' });
    useWorkbenchStore.getState().open({ type: 'timing-violation' });

    expect(useWorkbenchStore.getState().tabs).toHaveLength(1);
  });

  it('closes timing-violation tab correctly', () => {
    useWorkbenchStore.getState().open({ type: 'timing-violation' });
    useWorkbenchStore.getState().open({ type: 'dashboard' });

    useWorkbenchStore.getState().close('timing-violation');

    const state = useWorkbenchStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].destination.type).toBe('dashboard');
    expect(state.activeTabId).toBe('dashboard');
  });
});
