// @vitest-environment jsdom
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SimulationRunRecord } from '@renderer/stores/simulation';

/* ── simulation store mock（NavRail 只读 activeRuns，可变状态便于逐用例注入） ── */
const simState = vi.hoisted(() => ({ activeRuns: [] as SimulationRunRecord[] }));

vi.mock('@renderer/stores/simulation', () => ({
  useSimulationStore: (selector: (s: { activeRuns: SimulationRunRecord[] }) => unknown) =>
    selector(simState),
}));

import { NavRail } from '@renderer/components/layout/NavRail';
import { useUiStore } from '@renderer/stores/ui';

function makeRun(status: SimulationRunRecord['status'], runId: string): SimulationRunRecord {
  return {
    runId,
    projectId: 'proj-1',
    caseId: `case-${runId}`,
    subsys: 'alu',
    status,
    startTime: Date.now(),
  };
}

beforeEach(() => {
  useUiStore.setState({ activeView: 'dashboard', sourceControlOpen: false, settingsOpen: false });
  simState.activeRuns = [];
});

describe('NavRail 视图切换', () => {
  it('渲染五个视图按钮与全部 tooltip（视图按钮含 Ctrl+N 快捷键提示）', () => {
    render(<NavRail />);
    for (const label of [/总览/, /仿真/, /覆盖率/, /回归/, /工作区/, '文件', '版本控制', 'AI 助手', '设置']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('点击切换视图并标记激活态（aria-current）', () => {
    render(<NavRail />);
    fireEvent.click(screen.getByRole('button', { name: /回归/ }));
    expect(useUiStore.getState().activeView).toBe('regression');
    expect(screen.getByRole('button', { name: /回归/ }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: /总览/ }).getAttribute('aria-current')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '工作区' }));
    expect(useUiStore.getState().activeView).toBe('workspace');
  });
});

describe('NavRail 仿真 badge', () => {
  it('显示运行中（running/pending）数量', () => {
    simState.activeRuns = [
      makeRun('running', 'r1'),
      makeRun('pending', 'r2'),
      makeRun('pass', 'r3'),
    ];
    render(<NavRail />);
    expect(screen.getByTestId('nav-simulation-badge').textContent).toBe('2');
  });

  it('无运行时隐藏 badge', () => {
    simState.activeRuns = [makeRun('pass', 'r1')];
    render(<NavRail />);
    expect(screen.queryByTestId('nav-simulation-badge')).toBeNull();
  });
});

describe('NavRail Ctrl+1..4 快捷键', () => {
  it('Ctrl+1..4 依次切换四大视图', () => {
    render(<NavRail />);
    const keyToView: Array<[string, string]> = [
      ['1', 'dashboard'],
      ['2', 'simulation'],
      ['3', 'regression'],
      ['4', 'coverage'],
    ];
    for (const [key, view] of keyToView) {
      fireEvent.keyDown(window, { key, ctrlKey: true });
      expect(useUiStore.getState().activeView).toBe(view);
    }
  });

  it('仅 ctrl 按下时拦截：输入框内普通数字键不影响视图', () => {
    render(
      <>
        <NavRail />
        <input aria-label="测试输入框" />
      </>,
    );
    const input = screen.getByLabelText('测试输入框');
    input.focus();
    act(() => {
      useUiStore.setState({ activeView: 'workspace' });
    });
    fireEvent.keyDown(input, { key: '3' });
    expect(useUiStore.getState().activeView).toBe('workspace');
  });
});

describe('NavRail 其他按钮', () => {
  it('版本控制按钮打开 SourceControlDialog，设置按钮打开 SettingsPanel', () => {
    render(<NavRail />);
    fireEvent.click(screen.getByRole('button', { name: '版本控制' }));
    expect(useUiStore.getState().sourceControlOpen).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(useUiStore.getState().settingsOpen).toBe(true);
  });

  it('文件 / AI 按钮 toggle 左右抽屉（Issue #7）', () => {
    useUiStore.setState({ leftDrawerOpen: false, rightDrawerOpen: false, aiPanelMode: 'drawer' });
    render(<NavRail />);

    fireEvent.click(screen.getByRole('button', { name: '文件' }));
    expect(useUiStore.getState().leftDrawerOpen).toBe(true);
    expect(useUiStore.getState().rightDrawerOpen).toBe(false);
    expect(screen.getByRole('button', { name: '文件' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'AI 助手' }));
    expect(useUiStore.getState().rightDrawerOpen).toBe(true);
    /* 左右抽屉独立 toggle，左抽屉保持打开 */
    expect(useUiStore.getState().leftDrawerOpen).toBe(true);
  });

  it('AI 助手按钮在 docked 模式下切换固定右栏并跳工作区', () => {
    useUiStore.setState({ aiPanelMode: 'docked', rightPanelCollapsed: true, activeView: 'dashboard' });
    render(<NavRail />);
    fireEvent.click(screen.getByRole('button', { name: 'AI 助手' }));
    expect(useUiStore.getState().rightPanelCollapsed).toBe(false);
    expect(useUiStore.getState().activeView).toBe('workspace');
  });
});
