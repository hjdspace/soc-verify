/**
 * TitleBar 重构测试（Issue #8 验收）：
 *   - 原型布局：Logo / 项目选择器 / 搜索触发框（Ctrl K 键帽）/ 回归徽章 / 铃铛 / 窗口控制
 *   - 回归徽章：x/y 进度、无进度降级、多条计数、无运行隐藏、点击跳回归视图
 *   - 搜索触发框呼出命令面板；项目选择器下拉切换项目
 * 依赖 store 的数据入口（project / regression / env / notification）mock，ui store 用真实实现。
 * NotificationCenter 自身的交互（未读数 / 标为已读 / 事件推送）在
 * notification-center.test.tsx 用真实 store 覆盖。
 */

// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveRegressionRun, AppNotification } from '@shared/types';

const mocks = vi.hoisted(() => ({
  // ProjectSelector 数据面
  proj: {
    projects: [
      { id: 'project-1', name: 'chipnorth', rootPath: '/data/chipnorth' },
      { id: 'project-2', name: 'neckar-dv', rootPath: '/data/neckar' },
    ],
    currentProjectId: 'project-1' as string | null,
    switchProject: vi.fn<(projectId: string) => Promise<void>>().mockResolvedValue(undefined),
    openProjectDialog: vi.fn().mockResolvedValue(undefined),
  },
  // 回归徽章数据面
  reg: {
    activeRegressions: [] as ActiveRegressionRun[],
    initActiveRuns: vi.fn(),
  },
  // 环境变量按钮数据面
  env: {
    managerOpen: false,
    setManagerOpen: vi.fn(),
  },
  // 通知铃铛数据面（未读计数联动在 notification-center.test.tsx 覆盖）
  notif: {
    notifications: [] as AppNotification[],
    init: vi.fn(),
    markRead: vi.fn().mockResolvedValue(undefined),
    markAllRead: vi.fn().mockResolvedValue(undefined),
  },
  // trpc 数据面（ToolsDropdown）
  trpc: {
    toolsOpen: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@renderer/stores/project', () => ({
  useProjectStore: (selector: (s: typeof mocks.proj) => unknown) => selector(mocks.proj),
}));

vi.mock('@renderer/stores/regression', () => ({
  useRegressionStore: (selector: (s: typeof mocks.reg) => unknown) => selector(mocks.reg),
}));

vi.mock('@renderer/stores/env', () => ({
  useEnvStore: (selector: (s: typeof mocks.env) => unknown) => selector(mocks.env),
}));

vi.mock('@renderer/stores/notification', () => ({
  useNotificationStore: (selector: (s: typeof mocks.notif) => unknown) => selector(mocks.notif),
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    tools: {
      open: { mutate: (input: unknown) => mocks.trpc.toolsOpen(input) },
    },
  },
}));

import { TitleBar } from '@renderer/components/layout/TitleBar';
import { useUiStore } from '@renderer/stores/ui';

beforeEach(() => {
  mocks.proj.currentProjectId = 'project-1';
  mocks.proj.switchProject.mockClear();
  mocks.proj.openProjectDialog.mockClear();
  mocks.reg.activeRegressions = [];
  mocks.reg.initActiveRuns.mockClear();
  mocks.env.managerOpen = false;
  mocks.env.setManagerOpen.mockClear();
  mocks.notif.notifications = [];
  mocks.notif.init.mockClear();
  mocks.notif.markRead.mockClear();
  mocks.notif.markAllRead.mockClear();
  useUiStore.setState({
    activeView: 'dashboard',
    commandPaletteOpen: false,
    aiPanelMode: 'drawer',
    rightDrawerOpen: false,
    rightPanelCollapsed: false,
  });
});

describe('TitleBar 原型布局', () => {
  it('渲染 Logo、当前项目名、搜索触发框（Ctrl K 键帽提示）与工具下拉', async () => {
    render(<TitleBar />);

    expect(screen.getByText('SoC Verify')).toBeInTheDocument();
    // 项目选择器显示当前项目
    expect(screen.getByRole('button', { name: '切换项目' })).toHaveTextContent('chipnorth');
    // 搜索触发框：占位文案 + Ctrl K 键帽
    expect(screen.getByTitle('全局搜索（Ctrl+K / Ctrl+P）')).toHaveTextContent('搜索用例、文件、命令…');
    expect(screen.getByTitle('全局搜索（Ctrl+K / Ctrl+P）')).toHaveTextContent('Ctrl K');
    // ToolsDropdown 保留
    expect(screen.getByTitle('工具')).toBeInTheDocument();
    // 通知铃铛挂载
    expect(screen.getByTitle('通知')).toBeInTheDocument();
    // 初始拉取运行中回归
    await waitFor(() => expect(mocks.reg.initActiveRuns).toHaveBeenCalled());
  });

  it('搜索触发框点击 → 打开命令面板', () => {
    render(<TitleBar />);
    fireEvent.click(screen.getByTitle('全局搜索（Ctrl+K / Ctrl+P）'));
    expect(useUiStore.getState().commandPaletteOpen).toBe(true);
  });

  it('项目选择器下拉列出已打开项目，点击切换', () => {
    render(<TitleBar />);
    fireEvent.click(screen.getByRole('button', { name: '切换项目' }));

    const option = screen.getByRole('button', { name: /neckar-dv/ });
    expect(option).toBeInTheDocument();
    fireEvent.click(option);

    expect(mocks.proj.switchProject).toHaveBeenCalledWith('project-2');
  });

  it('点击当前项目不触发切换', () => {
    render(<TitleBar />);
    fireEvent.click(screen.getByRole('button', { name: '切换项目' }));
    fireEvent.click(screen.getByRole('button', { name: /chipnorth/ }));
    expect(mocks.proj.switchProject).not.toHaveBeenCalled();
  });

  it('项目选择器下拉含「打开项目目录」按钮，点击调用 openProjectDialog', () => {
    render(<TitleBar />);
    fireEvent.click(screen.getByRole('button', { name: '切换项目' }));

    const openBtn = screen.getByText('打开项目目录');
    expect(openBtn).toBeInTheDocument();

    fireEvent.click(openBtn);
    expect(mocks.proj.openProjectDialog).toHaveBeenCalledTimes(1);
  });
});

describe('TitleBar 回归运行徽章', () => {
  function makeRun(partial: Partial<ActiveRegressionRun> & { runId: string }): ActiveRegressionRun {
    return { subsys: 'alu', filePath: '/env/alu/lst', submittedAt: Date.now(), ...partial };
  }

  it('运行中回归显示 #短id 与 x/y 进度，点击跳回归视图', () => {
    mocks.reg.activeRegressions = [
      makeRun({ runId: 'run-abcdef123456', completed: 312, total: 480 }),
    ];
    render(<TitleBar />);

    const badge = screen.getByTestId('regression-badge');
    expect(badge).toHaveTextContent('回归 #123456 运行中 · 312/480');

    fireEvent.click(badge);
    expect(useUiStore.getState().activeView).toBe('regression');
  });

  it('进度未解析时降级为「运行中」不显示 x/y', () => {
    mocks.reg.activeRegressions = [makeRun({ runId: 'run-noprogress' })];
    render(<TitleBar />);

    const badge = screen.getByTestId('regression-badge');
    expect(badge).toHaveTextContent('回归 #ogress 运行中');
    expect(badge.textContent).not.toContain('/');
  });

  it('多条运行回归显示计数', () => {
    mocks.reg.activeRegressions = [
      makeRun({ runId: 'run-a111', submittedAt: 1000, completed: 1, total: 10 }),
      makeRun({ runId: 'run-b222', submittedAt: 2000, completed: 2, total: 20 }),
    ];
    render(<TitleBar />);

    expect(screen.getByTestId('regression-badge')).toHaveTextContent('回归 ×2 运行中');
  });

  it('无运行回归时徽章隐藏', () => {
    mocks.reg.activeRegressions = [];
    render(<TitleBar />);
    expect(screen.queryByTestId('regression-badge')).not.toBeInTheDocument();
  });
});

describe('TitleBar AI 面板折叠按钮', () => {
  it('drawer 模式初始折叠状态显示「展开 AI 面板」按钮', () => {
    useUiStore.setState({ aiPanelMode: 'drawer', rightDrawerOpen: false });
    render(<TitleBar />);
    const btn = screen.getByTitle('展开 AI 面板');
    expect(btn).toBeInTheDocument();
  });

  it('drawer 模式点击按钮打开右抽屉', () => {
    useUiStore.setState({ aiPanelMode: 'drawer', rightDrawerOpen: false });
    render(<TitleBar />);
    fireEvent.click(screen.getByTitle('展开 AI 面板'));
    expect(useUiStore.getState().rightDrawerOpen).toBe(true);
  });

  it('drawer 模式已展开时按钮显示「折叠 AI 面板」', () => {
    useUiStore.setState({ aiPanelMode: 'drawer', rightDrawerOpen: true });
    render(<TitleBar />);
    expect(screen.getByTitle('折叠 AI 面板')).toBeInTheDocument();
  });

  it('drawer 模式点击按钮关闭右抽屉', () => {
    useUiStore.setState({ aiPanelMode: 'drawer', rightDrawerOpen: true });
    render(<TitleBar />);
    fireEvent.click(screen.getByTitle('折叠 AI 面板'));
    expect(useUiStore.getState().rightDrawerOpen).toBe(false);
  });

  it('docked 模式面板可见时按钮显示「折叠 AI 面板」', () => {
    useUiStore.setState({ aiPanelMode: 'docked', rightPanelCollapsed: false });
    render(<TitleBar />);
    expect(screen.getByTitle('折叠 AI 面板')).toBeInTheDocument();
  });

  it('docked 模式点击按钮折叠固定侧栏，不切换视图', () => {
    useUiStore.setState({
      aiPanelMode: 'docked',
      rightPanelCollapsed: false,
      activeView: 'dashboard',
    });
    render(<TitleBar />);
    fireEvent.click(screen.getByTitle('折叠 AI 面板'));
    expect(useUiStore.getState().rightPanelCollapsed).toBe(true);
    // 不切换视图
    expect(useUiStore.getState().activeView).toBe('dashboard');
  });

  it('docked 模式折叠后按钮显示「展开 AI 面板」', () => {
    useUiStore.setState({ aiPanelMode: 'docked', rightPanelCollapsed: true });
    render(<TitleBar />);
    expect(screen.getByTitle('展开 AI 面板')).toBeInTheDocument();
  });

  it('docked 模式点击按钮展开固定侧栏', () => {
    useUiStore.setState({ aiPanelMode: 'docked', rightPanelCollapsed: true });
    render(<TitleBar />);
    fireEvent.click(screen.getByTitle('展开 AI 面板'));
    expect(useUiStore.getState().rightPanelCollapsed).toBe(false);
  });
});
