// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SimulationHistoryEntry } from '@shared/types';

/**
 * RunDetailView 测试：
 * - loading 时显示"加载中..."
 * - 无 detailRun 时显示"无运行详情"
 * - 渲染详情卡片（用例、子系统、状态、耗时、开始/结束时间）
 * - 渲染仿真选项
 * - 渲染编译错误（前5条 + "查看全部"按钮）
 * - "查看全部"按钮导航到 simulation-errors
 * - loadRunDetail effect 在 runId 变化时触发
 *
 * Mock: simulation store (detailRun, loadingDetail, loadRunDetail) + workbench store (tabs, activeTabId, open) + project store
 */

const mocks = vi.hoisted(() => ({
  sim: {
    detailRun: null as SimulationHistoryEntry | null,
    loadingDetail: false,
    loadRunDetail: vi.fn().mockResolvedValue(undefined),
  },
  workbench: {
    tabs: [{ id: 'tab-1', title: 'detail', closable: true, destination: { type: 'simulation-detail' as const, runId: 'r1' } }],
    activeTabId: 'tab-1',
    open: vi.fn(),
  },
  project: {
    currentProjectId: 'proj-1',
  },
}));

vi.mock('@renderer/stores/simulation', () => ({
  useSimulationStore: (selector: (s: typeof mocks.sim) => unknown) => selector(mocks.sim),
}));

vi.mock('@renderer/stores/workbench', () => ({
  useWorkbenchStore: (selector: (s: typeof mocks.workbench) => unknown) => selector(mocks.workbench),
}));

vi.mock('@renderer/stores/project', () => ({
  useProjectStore: (selector: (s: typeof mocks.project) => unknown) => selector(mocks.project),
}));

import { RunDetailView } from '@renderer/components/simulation/views/RunDetailView';

function makeEntry(partial: Partial<SimulationHistoryEntry> & { runId: string }): SimulationHistoryEntry {
  const now = Date.now();
  return {
    caseId: `case-${partial.runId}`,
    caseName: 'test_alu',
    subsys: 'ALU',
    options: { seed: '0x1234', waves: true },
    status: 'pass',
    startTime: now,
    endTime: now + 500,
    duration: 500,
    ...partial,
  };
}

describe('RunDetailView', () => {
  beforeEach(() => {
    mocks.sim.detailRun = null;
    mocks.sim.loadingDetail = false;
    mocks.sim.loadRunDetail.mockClear();
    mocks.workbench.open.mockClear();
  });

  it('loading 时显示加载中', () => {
    mocks.sim.loadingDetail = true;
    render(<RunDetailView />);
    expect(screen.getByText('加载中...')).toBeTruthy();
  });

  it('无 detailRun 时显示无运行详情', () => {
    render(<RunDetailView />);
    expect(screen.getByText('无运行详情')).toBeTruthy();
  });

  it('渲染详情卡片', () => {
    mocks.sim.detailRun = makeEntry({ runId: 'r-abc123', caseName: 'test_alu', subsys: 'ALU' });
    render(<RunDetailView />);
    // Header text is split across elements by JSX whitespace, use getAllByText
    expect(screen.getAllByText((_, node) => !!node?.textContent?.includes('运行详情') && !!node?.textContent?.includes('abc123')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('test_alu')).toBeTruthy();
    expect(screen.getByText('ALU')).toBeTruthy();
  });

  it('渲染仿真选项', () => {
    mocks.sim.detailRun = makeEntry({ runId: 'r1', options: { seed: '0xABCD', waves: true } });
    render(<RunDetailView />);
    expect(screen.getByText('seed:')).toBeTruthy();
    expect(screen.getByText('0xABCD')).toBeTruthy();
    expect(screen.getByText('waves:')).toBeTruthy();
    expect(screen.getByText('true')).toBeTruthy();
  });

  it('无选项时显示无选项', () => {
    mocks.sim.detailRun = makeEntry({ runId: 'r1', options: {} });
    render(<RunDetailView />);
    expect(screen.getByText('无选项')).toBeTruthy();
  });

  it('有编译错误时显示错误列表和查看全部按钮', () => {
    mocks.sim.detailRun = makeEntry({
      runId: 'r1',
      compileErrors: [
        { file: 'top.sv', line: 10, severity: 'error', message: 'syntax error' },
        { file: 'mid.sv', line: 20, severity: 'warning', message: 'unused var' },
      ],
    });
    render(<RunDetailView />);
    expect(screen.getByText('编译错误 (2)')).toBeTruthy();
    expect(screen.getByText('top.sv:10')).toBeTruthy();
    expect(screen.getByText('syntax error')).toBeTruthy();
    expect(screen.getByText('mid.sv:20')).toBeTruthy();
  });

  it('查看全部按钮导航到 simulation-errors', () => {
    mocks.sim.detailRun = makeEntry({
      runId: 'r1',
      compileErrors: [{ file: 'top.sv', line: 10, severity: 'error', message: 'err' }],
    });
    render(<RunDetailView />);
    fireEvent.click(screen.getByText('查看全部'));
    expect(mocks.workbench.open).toHaveBeenCalledWith({ type: 'simulation-errors', runId: 'r1' });
  });

  it('挂载时触发 loadRunDetail', () => {
    render(<RunDetailView />);
    expect(mocks.sim.loadRunDetail).toHaveBeenCalledWith('proj-1', 'r1');
  });

  it('编译错误超过5条只显示前5条', () => {
    const errors = Array.from({ length: 7 }, (_, i) => ({
      file: `file${i}.sv`,
      line: i + 1,
      severity: 'error' as const,
      message: `error ${i}`,
    }));
    mocks.sim.detailRun = makeEntry({ runId: 'r1', compileErrors: errors });
    render(<RunDetailView />);
    expect(screen.getByText('编译错误 (7)')).toBeTruthy();
    // 前5条应显示
    expect(screen.getByText('file0.sv:1')).toBeTruthy();
    expect(screen.getByText('file4.sv:5')).toBeTruthy();
    // 第6条不应显示
    expect(screen.queryByText('file5.sv:6')).toBeNull();
  });
});
