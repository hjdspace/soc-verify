import { describe, it, expect, beforeEach, vi } from 'vitest';

/* workbench 记录最近打开文件时会调用 project store（含 tRPC），mock 隔离 IPC 依赖 */
vi.mock('@renderer/stores/project', () => ({
  useProjectStore: {
    getState: () => ({ pushRecentFile: vi.fn() }),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

import { useWorkbenchStore } from '@renderer/stores/workbench';
import { useUiStore } from '@renderer/stores/ui';

/**
 * 视图路由（Issue #2 核心）：
 * workbench.open 的目的地分流 + activeView 持久化水合。
 * 直接使用真实 store（两 store 均为纯 zustand，无 IPC 依赖）。
 */

beforeEach(() => {
  useWorkbenchStore.setState({ tabs: [], activeTabId: null });
  useUiStore.setState({ activeView: 'dashboard' });
});

describe('workbench.open 视图型目的地分流', () => {
  it('coverage / dashboard / regression / running-simulations 切换视图且不开 Tab', () => {
    const open = useWorkbenchStore.getState().open;
    open({ type: 'coverage' });
    expect(useUiStore.getState().activeView).toBe('coverage');
    open({ type: 'dashboard' });
    expect(useUiStore.getState().activeView).toBe('dashboard');
    open({ type: 'regression' });
    expect(useUiStore.getState().activeView).toBe('regression');
    open({ type: 'running-simulations' });
    expect(useUiStore.getState().activeView).toBe('simulation');
    expect(useWorkbenchStore.getState().tabs).toHaveLength(0);
    expect(useWorkbenchStore.getState().activeTabId).toBeNull();
  });

  it('视图型目的地重复调用仍不开 Tab', () => {
    const open = useWorkbenchStore.getState().open;
    open({ type: 'coverage' });
    open({ type: 'coverage' });
    open({ type: 'dashboard' });
    expect(useWorkbenchStore.getState().tabs).toHaveLength(0);
  });
});

describe('workbench.open Tab 型目的地分流', () => {
  it('file 目的地开 Tab 并自动切到 workspace 视图', () => {
    useWorkbenchStore.getState().open({ type: 'file', path: '/proj/a.sv', name: 'a.sv' });
    expect(useUiStore.getState().activeView).toBe('workspace');
    const { tabs, activeTabId } = useWorkbenchStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].id).toBe('file:/proj/a.sv');
    expect(activeTabId).toBe('file:/proj/a.sv');
  });

  it('terminal / simulation-detail / browser 目的地同样切 workspace 并开 Tab', () => {
    const open = useWorkbenchStore.getState().open;
    open({ type: 'terminal', terminalTabId: 't1', title: '终端 1' });
    open({ type: 'simulation-detail', runId: 'run-123456' });
    open({ type: 'browser', surfaceId: 's1', url: 'https://example.com' });
    expect(useUiStore.getState().activeView).toBe('workspace');
    expect(useWorkbenchStore.getState().tabs).toHaveLength(3);
  });

  it('视图切换后 Tab 保留，回到 file 目的地复用已有 Tab', () => {
    const open = useWorkbenchStore.getState().open;
    open({ type: 'file', path: '/proj/a.sv', name: 'a.sv' });
    open({ type: 'coverage' });
    // 覆盖率视图下 Tab 不丢失
    expect(useWorkbenchStore.getState().tabs).toHaveLength(1);
    expect(useUiStore.getState().activeView).toBe('coverage');
    // 再次打开同一文件 → 复用 Tab、切回 workspace
    open({ type: 'file', path: '/proj/a.sv', name: 'a.sv' });
    expect(useWorkbenchStore.getState().tabs).toHaveLength(1);
    expect(useUiStore.getState().activeView).toBe('workspace');
  });
});

describe('activeView 状态与持久化水合', () => {
  it('setActiveView 直接切换全部视图（含设计视图）', () => {
    const { setActiveView } = useUiStore.getState();
    for (const view of ['simulation', 'coverage', 'regression', 'design', 'workspace', 'dashboard'] as const) {
      setActiveView(view);
      expect(useUiStore.getState().activeView).toBe(view);
    }
  });

  it('hydrateLayout 恢复持久化的 activeView，非法/缺失值保持现状', () => {
    const { hydrateLayout } = useUiStore.getState();
    hydrateLayout({ activeView: 'coverage' });
    expect(useUiStore.getState().activeView).toBe('coverage');

    // 旧版本持久化状态（无 activeView 字段）→ 保持当前视图
    hydrateLayout({});
    expect(useUiStore.getState().activeView).toBe('coverage');

    // 非法值（数据损坏）→ 保持当前视图
    hydrateLayout({ activeView: 'no-such-view' });
    expect(useUiStore.getState().activeView).toBe('coverage');
  });

  it('默认视图为总览（dashboard）', () => {
    expect(useUiStore.getState().activeView).toBe('dashboard');
  });
});
