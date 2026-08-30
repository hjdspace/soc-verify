import { beforeEach, describe, expect, it, vi } from 'vitest';

/* workbench 记录最近打开文件时会调用 project store（含 tRPC），mock 隔离 IPC 依赖 */
vi.mock('@renderer/stores/project', () => ({
  useProjectStore: {
    getState: () => ({ pushRecentFile: vi.fn() }),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

import { useWorkbenchStore, parsePathLineRange, openFileTab, openFileDestination } from '@renderer/stores/workbench';

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
    // dashboard/coverage 等视图型目的地已分流到视图路由（Issue #2），此处用 Tab 型目的地
    workbench.open({ type: 'to-checklist' });
    workbench.open({ type: 'simulation-history' });

    useWorkbenchStore.getState().closeActive();

    const state = useWorkbenchStore.getState();
    expect(state.tabs.map((tab) => tab.destination.type)).toEqual(['to-checklist']);
    expect(state.activeTabId).toBe('to-checklist');
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

// ── `:line[-end]` 行号后缀解析与定位打开 ─────────────────────────

describe('parsePathLineRange', () => {
  it('strips a :line-end suffix and reports the range', () => {
    expect(
      parsePathLineRange('D:\\proj\\src\\config\\settings-schema.ts:4889-4940'),
    ).toEqual({ path: 'D:\\proj\\src\\config\\settings-schema.ts', line: 4889, endLine: 4940 });
  });

  it('strips a single :line suffix without an end', () => {
    expect(parsePathLineRange('/rtl/core.sv:120')).toEqual({ path: '/rtl/core.sv', line: 120, endLine: undefined });
  });

  it('strips a :line:col suffix using the line segment for reveal', () => {
    expect(parsePathLineRange('/rtl/core.sv:12:5')).toEqual({ path: '/rtl/core.sv', line: 12, endLine: undefined });
  });

  it('keeps windows drive paths without a numeric suffix intact', () => {
    expect(parsePathLineRange('C:\\proj\\rtl\\core.sv')).toEqual({ path: 'C:\\proj\\rtl\\core.sv' });
  });

  it('treats :0 as a plain path because line numbers start at 1', () => {
    expect(parsePathLineRange('/rtl/core.sv:0')).toEqual({ path: '/rtl/core.sv:0' });
  });
});

describe('openFileTab', () => {
  beforeEach(() => {
    useWorkbenchStore.setState({ tabs: [], activeTabId: null });
  });

  it('opens a path with a line range as a clean file tab carrying reveal info', () => {
    openFileTab(useWorkbenchStore.getState().open, 'D:\\proj\\settings-schema.ts:4889-4940', 'settings-schema.ts');

    const tab = useWorkbenchStore.getState().tabs[0];
    expect(tab?.id).toBe('file:D:\\proj\\settings-schema.ts');
    expect(tab?.destination).toEqual({
      type: 'file',
      path: 'D:\\proj\\settings-schema.ts',
      name: 'settings-schema.ts',
      line: 4889,
      endLine: 4940,
      revealSeq: expect.any(Number),
    });
    expect(useWorkbenchStore.getState().activeTabId).toBe('file:D:\\proj\\settings-schema.ts');
  });

  it('keeps a plain file tab free of reveal fields', () => {
    openFileTab(useWorkbenchStore.getState().open, 'rtl/core.sv', 'core.sv');

    expect(useWorkbenchStore.getState().tabs[0]?.destination).toEqual({
      type: 'file',
      path: 'rtl/core.sv',
      name: 'core.sv',
    });
  });

  it('bumps revealSeq on every line-range open so the editor re-reveals the same range', () => {
    openFileTab(useWorkbenchStore.getState().open, 'core.sv:10-20', 'core.sv');
    const first = (useWorkbenchStore.getState().tabs[0]?.destination as { revealSeq?: number }).revealSeq;

    openFileTab(useWorkbenchStore.getState().open, 'core.sv:10-20', 'core.sv');
    const second = (useWorkbenchStore.getState().tabs[0]?.destination as { revealSeq?: number }).revealSeq;

    expect(first).toBeDefined();
    expect(second).toBe((first ?? 0) + 1);
    expect(useWorkbenchStore.getState().tabs).toHaveLength(1);
  });
});

describe('openFileDestination with line ranges', () => {
  beforeEach(() => {
    useWorkbenchStore.setState({ tabs: [], activeTabId: null });
  });

  it('strips the suffix before extension routing and passes the explicit range through', () => {
    openFileDestination(useWorkbenchStore.getState().open, 'D:\\proj\\src\\core.sv:100-200', 'core.sv', { line: 100, endLine: 200 });

    expect(useWorkbenchStore.getState().tabs[0]?.destination).toEqual({
      type: 'file',
      path: 'D:\\proj\\src\\core.sv',
      name: 'core.sv',
      line: 100,
      endLine: 200,
      revealSeq: expect.any(Number),
    });
  });

  it('still routes office documents without touching line-range logic', () => {
    openFileDestination(useWorkbenchStore.getState().open, 'D:\\proj\\docs\\report.xlsx', 'report.xlsx');

    expect(useWorkbenchStore.getState().tabs[0]?.destination.type).toBe('office-document');
  });
});
