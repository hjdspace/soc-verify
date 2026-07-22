// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CoverageTreeTable } from '@renderer/components/coverage/CoverageTreeTable';
import type { CoverageData, CoverageMetric, CoverageTriplet } from '@shared/types';
import { COVERAGE_METRICS, NA_TRIPLET } from '@shared/types';

// ─── Mock 数据 ───────────────────────────────────────────────────

/** 构建全 N/A 的 metrics 记录 */
function naMetrics(): Record<CoverageMetric, CoverageTriplet> {
  return COVERAGE_METRICS.reduce(
    (acc, m) => ({ ...acc, [m]: NA_TRIPLET }),
    {} as Record<CoverageMetric, CoverageTriplet>,
  );
}

/** 构建指定覆盖的 metrics 记录 */
function makeMetrics(
  overrides: Partial<Record<CoverageMetric, CoverageTriplet>>,
): Record<CoverageMetric, CoverageTriplet> {
  return { ...naMetrics(), ...overrides };
}

/**
 * Mock 树结构（2 层 + 孙节点）：
 *   tb_top (root, 含全状态指标)
 *   ├── chip_top (有子节点，用于展开/折叠测试)
 *   │   ├── dut_a
 *   │   └── dut_b
 *   └── io_block (全 N/A，用于"仅看未达标"测试)
 */
const mockData: CoverageData = {
  sessionId: 'test-session',
  source: {
    covMergeDir: 'cov_merge',
    edaTool: 'imc',
    reportGeneratedAt: 0,
  },
  root: {
    name: 'tb_top',
    path: 'tb_top',
    depth: 0,
    metrics: makeMetrics({
      // pass: 96% >= 95
      line: { percentage: 96, covered: 96, total: 100 },
      // warn: 88% >= 85 (90-5) 但 < 90
      branch: { percentage: 88, covered: 88, total: 100 },
      // fail: 70% < 80 (85-5)
      toggle: { percentage: 70, covered: 70, total: 100 },
      // na: null
      condition: NA_TRIPLET,
      // pass: 100% = 100
      fsm_state: { percentage: 100, covered: 10, total: 10 },
      // pass: 92% >= 90
      fsm_transition: { percentage: 92, covered: 92, total: 100 },
      // pass: 100% = 100
      functional: { percentage: 100, covered: 50, total: 50 },
      // warn (无目标): 85% >= 80 但 < 90
      assertion: { percentage: 85, covered: 17, total: 20 },
    }),
    children: [
      {
        name: 'chip_top',
        path: 'tb_top/chip_top',
        depth: 1,
        metrics: makeMetrics({
          line: { percentage: 90, covered: 90, total: 100 },
        }),
        children: [
          {
            name: 'dut_a',
            path: 'tb_top/chip_top/dut_a',
            depth: 2,
            metrics: naMetrics(),
            children: [],
          },
          {
            name: 'dut_b',
            path: 'tb_top/chip_top/dut_b',
            depth: 2,
            metrics: naMetrics(),
            children: [],
          },
        ],
      },
      {
        name: 'io_block',
        path: 'tb_top/io_block',
        depth: 1,
        metrics: naMetrics(),
        children: [],
      },
    ],
  },
  targets: {},
};

// ─── 测试 ────────────────────────────────────────────────────────

describe('CoverageTreeTable', () => {
  it('渲染 8 个概览卡片', () => {
    render(<CoverageTreeTable data={mockData} targets={{}} />);

    // 8 个 metric 标签都应出现（概览卡片 + 表头各出现一次，用 getAllByText）
    expect(screen.getAllByText('Line').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Branch').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Toggle').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Cond').length).toBeGreaterThan(0);
    expect(screen.getAllByText('FSM St').length).toBeGreaterThan(0);
    expect(screen.getAllByText('FSM Tr').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Func').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Assert').length).toBeGreaterThan(0);
  });

  it('渲染树表格行（模块名 + 指标列）', () => {
    render(<CoverageTreeTable data={mockData} targets={{}} />);

    // 根节点始终可见
    expect(screen.getByText('tb_top')).toBeInTheDocument();
    // 根默认展开，子节点可见
    expect(screen.getByText('chip_top')).toBeInTheDocument();
    expect(screen.getByText('io_block')).toBeInTheDocument();
    // chip_top 默认折叠，孙节点不可见
    expect(screen.queryByText('dut_a')).not.toBeInTheDocument();
    expect(screen.queryByText('dut_b')).not.toBeInTheDocument();
  });

  it('展开和折叠节点', () => {
    render(<CoverageTreeTable data={mockData} targets={{}} />);

    // 初始：孙节点不可见
    expect(screen.queryByText('dut_a')).not.toBeInTheDocument();

    // 点击 chip_top 展开
    fireEvent.click(screen.getByText('chip_top'));
    expect(screen.getByText('dut_a')).toBeInTheDocument();
    expect(screen.getByText('dut_b')).toBeInTheDocument();

    // 再次点击折叠
    fireEvent.click(screen.getByText('chip_top'));
    expect(screen.queryByText('dut_a')).not.toBeInTheDocument();
    expect(screen.queryByText('dut_b')).not.toBeInTheDocument();
  });

  it('根据达标状态应用颜色编码', () => {
    render(<CoverageTreeTable data={mockData} targets={{}} />);

    // Line 96% → pass (绿色)
    const lineValues = screen.getAllByText('96.0%');
    expect(lineValues.some((el) => el.className.includes('text-emerald-500'))).toBe(true);

    // Branch 88% → warn (黄色)
    const branchValues = screen.getAllByText('88.0%');
    expect(branchValues.some((el) => el.className.includes('text-yellow-500'))).toBe(true);

    // Toggle 70% → fail (红色)
    const toggleValues = screen.getAllByText('70.0%');
    expect(toggleValues.some((el) => el.className.includes('text-destructive'))).toBe(true);

    // Condition null → na (灰色)
    const naValues = screen.getAllByText('N/A');
    expect(naValues.some((el) => el.className.includes('text-muted-foreground'))).toBe(true);
  });

  it('按模块名过滤', () => {
    render(<CoverageTreeTable data={mockData} targets={{}} />);

    const input = screen.getByPlaceholderText('过滤模块...') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'dut' } });

    // dut_a、dut_b 匹配，自动展开父节点 chip_top
    expect(screen.getByText('dut_a')).toBeInTheDocument();
    expect(screen.getByText('dut_b')).toBeInTheDocument();
    // tb_top 保留（有匹配后代）
    expect(screen.getByText('tb_top')).toBeInTheDocument();
    // chip_top 保留（有匹配后代）
    expect(screen.getByText('chip_top')).toBeInTheDocument();
    // io_block 不匹配且无匹配后代 → 隐藏
    expect(screen.queryByText('io_block')).not.toBeInTheDocument();
  });

  it('"仅看未达标"过滤：暗化无 fail 的行', () => {
    render(<CoverageTreeTable data={mockData} targets={{}} />);

    // 初始：io_block 行无 dimmed 类
    const ioBlockRow = screen.getByText('io_block').closest('tr');
    expect(ioBlockRow?.className).not.toContain('opacity-30');

    // 开启"仅看未达标"
    fireEvent.click(screen.getByText('仅看未达标'));

    // io_block 全 N/A，无 fail → 暗化
    const ioBlockRowAfter = screen.getByText('io_block').closest('tr');
    expect(ioBlockRowAfter?.className).toContain('opacity-30');

    // tb_top 有 toggle=70% (fail) → 不暗化
    const rootRow = screen.getByText('tb_top').closest('tr');
    expect(rootRow?.className).not.toContain('opacity-30');
  });

  it('全部展开和全部折叠', () => {
    render(<CoverageTreeTable data={mockData} targets={{}} />);

    // 初始：孙节点不可见
    expect(screen.queryByText('dut_a')).not.toBeInTheDocument();

    // 全部展开
    fireEvent.click(screen.getByText('全部展开'));
    expect(screen.getByText('dut_a')).toBeInTheDocument();
    expect(screen.getByText('dut_b')).toBeInTheDocument();
    expect(screen.getByText('chip_top')).toBeInTheDocument();
    expect(screen.getByText('io_block')).toBeInTheDocument();

    // 全部折叠
    fireEvent.click(screen.getByText('全部折叠'));
    // 只有根节点可见
    expect(screen.getByText('tb_top')).toBeInTheDocument();
    expect(screen.queryByText('chip_top')).not.toBeInTheDocument();
    expect(screen.queryByText('io_block')).not.toBeInTheDocument();
    expect(screen.queryByText('dut_a')).not.toBeInTheDocument();
  });
});
