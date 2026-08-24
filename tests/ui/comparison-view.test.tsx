// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SimulationHistoryEntry } from '@shared/types';

/**
 * ComparisonView 测试：
 * - result 为 null 时显示提示
 * - 渲染运行 A/B 摘要（用例、子系统、状态、耗时、时间）
 * - 渲染差异表格
 * - 运行 A/B 为 null 时不渲染对应卡片
 * - 差异为空时不渲染差异表格
 *
 * Mock: simulation store (compareResult)
 */

type CompareResult = {
  runA: SimulationHistoryEntry | null;
  runB: SimulationHistoryEntry | null;
  differences: Array<{ field: string; valueA?: unknown; valueB?: unknown }>;
} | null;

const mocks = vi.hoisted(() => ({
  sim: {
    compareResult: null as CompareResult,
  },
}));

vi.mock('@renderer/stores/simulation', () => ({
  useSimulationStore: (selector: (s: typeof mocks.sim) => unknown) => selector(mocks.sim),
}));

import { ComparisonView } from '@renderer/components/simulation/views/ComparisonView';

function makeEntry(partial: Partial<SimulationHistoryEntry> & { runId: string }): SimulationHistoryEntry {
  const now = Date.now();
  return {
    caseId: `case-${partial.runId}`,
    caseName: 'test_case',
    subsys: 'ALU',
    options: {},
    status: 'pass',
    startTime: now,
    endTime: now + 1000,
    duration: 500,
    ...partial,
  };
}

describe('ComparisonView', () => {
  beforeEach(() => {
    mocks.sim.compareResult = null;
  });

  it('result 为 null 时显示提示', () => {
    render(<ComparisonView />);
    expect(screen.getByText('请从仿真历史中选择两条运行进行对比')).toBeTruthy();
  });

  it('渲染运行 A 和 B 的摘要', () => {
    mocks.sim.compareResult = {
      runA: makeEntry({ runId: 'r1', caseName: 'test_a', subsys: 'ALU' }),
      runB: makeEntry({ runId: 'r2', caseName: 'test_b', subsys: 'DMA' }),
      differences: [],
    };
    render(<ComparisonView />);
    expect(screen.getByText('运行 A')).toBeTruthy();
    expect(screen.getByText('运行 B')).toBeTruthy();
    expect(screen.getByText('test_a')).toBeTruthy();
    expect(screen.getByText('test_b')).toBeTruthy();
  });

  it('渲染差异表格', () => {
    mocks.sim.compareResult = {
      runA: makeEntry({ runId: 'r1' }),
      runB: makeEntry({ runId: 'r2' }),
      differences: [
        { field: 'status', valueA: 'pass', valueB: 'fail' },
        { field: 'duration', valueA: 100, valueB: 200 },
      ],
    };
    render(<ComparisonView />);
    expect(screen.getByText('2 项差异')).toBeTruthy();
    expect(screen.getByText('status')).toBeTruthy();
    expect(screen.getByText('duration')).toBeTruthy();
    expect(screen.getAllByText('pass').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('fail').length).toBeGreaterThanOrEqual(1);
  });

  it('差异为空时不渲染差异表格', () => {
    mocks.sim.compareResult = {
      runA: makeEntry({ runId: 'r1' }),
      runB: makeEntry({ runId: 'r2' }),
      differences: [],
    };
    render(<ComparisonView />);
    expect(screen.getByText('0 项差异')).toBeTruthy();
    expect(screen.queryByText('差异')).toBeNull();
  });

  it('runA 为 null 时不渲染运行 A 卡片', () => {
    mocks.sim.compareResult = {
      runA: null,
      runB: makeEntry({ runId: 'r2', caseName: 'test_b' }),
      differences: [],
    };
    render(<ComparisonView />);
    expect(screen.queryByText('运行 A')).toBeNull();
    expect(screen.getByText('运行 B')).toBeTruthy();
  });

  it('runB 为 null 时不渲染运行 B 卡片', () => {
    mocks.sim.compareResult = {
      runA: makeEntry({ runId: 'r1', caseName: 'test_a' }),
      runB: null,
      differences: [],
    };
    render(<ComparisonView />);
    expect(screen.getByText('运行 A')).toBeTruthy();
    expect(screen.queryByText('运行 B')).toBeNull();
  });

  it('差异 valueA/valueB 为 undefined 时显示 -', () => {
    mocks.sim.compareResult = {
      runA: makeEntry({ runId: 'r1' }),
      runB: makeEntry({ runId: 'r2' }),
      differences: [{ field: 'missing_field' }],
    };
    render(<ComparisonView />);
    // 两个 '-' 分别对应 valueA 和 valueB
    const dashes = screen.getAllByText('-');
    expect(dashes.length).toBe(2);
  });
});
