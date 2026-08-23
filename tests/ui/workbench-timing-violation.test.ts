import { beforeEach, describe, expect, it, vi } from 'vitest';

/* workbench 记录最近打开文件时会调用 project store（含 tRPC），mock 隔离 IPC 依赖 */
vi.mock('@renderer/stores/project', () => ({
  useProjectStore: {
    getState: () => ({ pushRecentFile: vi.fn() }),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

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
    // dashboard 等视图型目的地已分流到视图路由（Issue #2），此处用 Tab 型目的地
    useWorkbenchStore.getState().open({ type: 'kb' });

    useWorkbenchStore.getState().close('timing-violation');

    const state = useWorkbenchStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].destination.type).toBe('kb');
    expect(state.activeTabId).toBe('kb');
  });
});
