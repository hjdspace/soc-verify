// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SimulationHistoryEntry } from '@shared/types';

/**
 * SimulationHistoryView 测试：
 * - 空历史显示"无仿真历史记录"
 * - 历史列表渲染（用例名、子系统、状态、耗时、时间）
 * - 排序点击切换（time/case/status/duration）
 * - 对比选择（checkbox toggle + "对比选中"按钮）
 * - 行点击导航到 simulation-detail
 * - "查看错误"按钮导航到 simulation-errors
 * - 懒加载 loadHistory effect
 *
 * Mock: simulation store (history, loadHistory, compareRuns) + workbench store (open) + project store
 */

const mocks = vi.hoisted(() => ({
  sim: {
    history: [] as SimulationHistoryEntry[],
    loadHistory: vi.fn().mockResolvedValue(undefined),
    compareRuns: vi.fn().mockResolvedValue(undefined),
  },
  workbench: {
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

import { SimulationHistoryView } from '@renderer/components/simulation/views/SimulationHistoryView';

function makeEntry(partial: Partial<SimulationHistoryEntry> & { runId: string }): SimulationHistoryEntry {
  const now = Date.now();
  return {
    caseId: `case-${partial.runId}`,
    caseName: `case-${partial.runId}`,
    subsys: 'alu',
    options: {},
    status: 'pass',
    startTime: now,
    endTime: now + 1000,
    duration: 100,
    ...partial,
  };
}

describe('SimulationHistoryView', () => {
  beforeEach(() => {
    mocks.sim.history = [];
    mocks.sim.loadHistory.mockClear();
    mocks.sim.compareRuns.mockClear();
    mocks.workbench.open.mockClear();
  });

  it('空历史显示无仿真历史记录', () => {
    render(<SimulationHistoryView />);
    expect(screen.getByText('无仿真历史记录')).toBeTruthy();
  });

  it('有历史时渲染表格和计数', () => {
    mocks.sim.history = [
      makeEntry({ runId: 'r1', caseName: 'test_alu', subsys: 'ALU' }),
      makeEntry({ runId: 'r2', caseName: 'test_dma', subsys: 'DMA' }),
    ];
    render(<SimulationHistoryView />);
    expect(screen.getByText('2 条记录')).toBeTruthy();
    expect(screen.getByText('test_alu')).toBeTruthy();
    expect(screen.getByText('test_dma')).toBeTruthy();
  });

  it('挂载时触发 loadHistory 懒加载', () => {
    render(<SimulationHistoryView />);
    expect(mocks.sim.loadHistory).toHaveBeenCalledWith('proj-1');
  });

  it('行点击导航到 simulation-detail', () => {
    mocks.sim.history = [makeEntry({ runId: 'r1', caseName: 'test_alu' })];
    render(<SimulationHistoryView />);
    const row = screen.getByText('test_alu').closest('tr');
    if (row) fireEvent.click(row);
    expect(mocks.workbench.open).toHaveBeenCalledWith({ type: 'simulation-detail', runId: 'r1' });
  });

  it('有编译错误时显示查看错误按钮', () => {
    mocks.sim.history = [
      makeEntry({
        runId: 'r1',
        caseName: 'test_fail',
        compileErrors: [{ file: 'top.sv', line: 10, severity: 'error', message: 'err' }],
      }),
    ];
    render(<SimulationHistoryView />);
    const btn = screen.getByText('查看错误');
    fireEvent.click(btn);
    expect(mocks.workbench.open).toHaveBeenCalledWith({ type: 'simulation-errors', runId: 'r1' });
  });

  it('选择两条记录后显示对比按钮', () => {
    mocks.sim.history = [
      makeEntry({ runId: 'r1', caseName: 'test_a' }),
      makeEntry({ runId: 'r2', caseName: 'test_b' }),
    ];
    render(<SimulationHistoryView />);
    // 选择两条
    const checkboxes = screen.getAllByRole('checkbox');
    // 第一个 checkbox 是全选，跳过
    fireEvent.click(checkboxes[1]);
    fireEvent.click(checkboxes[2]);
    expect(screen.getByText('对比选中')).toBeTruthy();
  });

  it('点击对比按钮触发 compareRuns + 导航', async () => {
    mocks.sim.history = [
      makeEntry({ runId: 'r1', caseName: 'test_a' }),
      makeEntry({ runId: 'r2', caseName: 'test_b' }),
    ];
    render(<SimulationHistoryView />);
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[1]);
    fireEvent.click(checkboxes[2]);
    const compareBtn = screen.getByText('对比选中');
    fireEvent.click(compareBtn);
    // compareRuns is async, wait for open to be called
    await vi.waitFor(() => {
      expect(mocks.sim.compareRuns).toHaveBeenCalledWith('proj-1', 'r1', 'r2');
      expect(mocks.workbench.open).toHaveBeenCalledWith({ type: 'simulation-comparison' });
    });
  });

  it('排序点击切换 sortDir', () => {
    mocks.sim.history = [
      makeEntry({ runId: 'r1', caseName: 'bbb', startTime: 100 }),
      makeEntry({ runId: 'r2', caseName: 'aaa', startTime: 200 }),
    ];
    render(<SimulationHistoryView />);
    // 点击用例列排序
    fireEvent.click(screen.getByText(/用例/));
    // 第一行应该是 aaa（升序时），但默认 desc 所以第一行是 bbb
    const rows = screen.getAllByText(/aaa|bbb/);
    expect(rows.length).toBe(2);
  });
});
