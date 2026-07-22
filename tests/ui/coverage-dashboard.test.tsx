// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Mock stores：AiClosurePanel（CoverageDashboard 内部组件）依赖 useCoverageStore / useProjectStore。
// 不 mock 会导致真实 store 导入 trpc.ts，而 trpc.ts 需要 electronTRPC 全局变量（测试环境不存在）。
vi.mock('@renderer/stores/coverage', () => ({
  useCoverageStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      currentClosure: null,
      closureLive: { running: false },
      startClosure: vi.fn(),
      abortClosure: vi.fn(),
      currentSessionId: null,
    }),
  ),
}));

vi.mock('@renderer/stores/project', () => ({
  useProjectStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ currentProjectId: null }),
  ),
}));

import { CoverageDashboard } from '@renderer/components/coverage/CoverageDashboard';
import type {
  CoverageData, CoverageMetric, CoverageSummary, CoverageTriplet,
} from '@shared/types';
import { COVERAGE_METRICS, NA_TRIPLET } from '@shared/types';

// ─── Mock 数据辅助 ───────────────────────────────────────────────

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
 *   └── io_block (全 N/A)
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
  // 未覆盖项数据（仅 line 和 branch 有数据，其他无）
  uncovered: {
    line: [
      { module: 'u_analog_mphy', file: 'mphy.sv', line: 45, description: 'if 分支未覆盖' },
      { module: 'u_g3_glue', file: 'glue.sv', line: 128, description: 'always 块未执行' },
    ],
    branch: [
      { module: 'u_analog_mphy', file: 'mphy.sv', line: 67, signal: 'sig_clk', description: '条件分支未覆盖' },
    ],
  },
};

/** 无未覆盖项的 mock 数据 */
const mockDataNoUncovered: CoverageData = {
  ...mockData,
  uncovered: undefined,
};

/** 空未覆盖项的 mock 数据 */
const mockDataEmptyUncovered: CoverageData = {
  ...mockData,
  uncovered: {},
};

// ─── Mock overview ───────────────────────────────────────────────

const mockOverview: CoverageSummary = {
  overall: 87.5,
  line: 96,
  branch: 88,
  toggle: 70,
  condition: 0,
  fsm_state: 100,
  fsm_transition: 92,
  functional: 100,
  assertion: 85,
};

// ─── Mock trend 数据 ─────────────────────────────────────────────

const mockTrend: Array<{ sessionId: string; createdAt: number; summary: CoverageSummary }> = [
  {
    sessionId: '2024-01-10_merge_001',
    createdAt: 1704844800000,
    summary: {
      overall: 70, line: 75.2, branch: 68.1, toggle: 62,
      condition: 0, fsm_state: 0, fsm_transition: 0, functional: 0, assertion: 0,
    },
  },
  {
    sessionId: '2024-01-12_merge_002',
    createdAt: 1705017600000,
    summary: {
      overall: 78, line: 82.1, branch: 76.8, toggle: 70.2,
      condition: 0, fsm_state: 0, fsm_transition: 0, functional: 0, assertion: 0,
    },
  },
  {
    sessionId: '2024-01-15_merge_003',
    createdAt: 1705276800000,
    summary: {
      overall: 87.5, line: 96, branch: 88, toggle: 82,
      condition: 0, fsm_state: 0, fsm_transition: 0, functional: 0, assertion: 0,
    },
  },
];

const mockSessions = mockTrend.map((t) => ({ sessionId: t.sessionId, createdAt: t.createdAt }));

// ─── 默认 props ──────────────────────────────────────────────────

const defaultProps = {
  data: mockData,
  overview: mockOverview,
  targets: {},
  sessions: mockSessions,
  trend: mockTrend,
};

// ─── 测试 ────────────────────────────────────────────────────────

describe('CoverageDashboard', () => {
  it('渲染 8 个概览卡片（含 metric 标签和达标状态）', () => {
    render(<CoverageDashboard {...defaultProps} />);

    // 8 个 metric 标签都应出现（在概览卡片、树表格表头、未覆盖 tab 中重复，用 getAllByText）
    expect(screen.getAllByText('Line').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Branch').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Toggle').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Cond').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('FSM St').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('FSM Tr').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Func').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Assert').length).toBeGreaterThanOrEqual(1);

    // 总体覆盖率卡片
    expect(screen.getByText('总体覆盖率（8 项均值）')).toBeInTheDocument();
    expect(screen.getByText('87.5%')).toBeInTheDocument();

    // 达标状态标签（文本在"目标 95% · 达标"中，需用 exact: false）
    expect(screen.getAllByText('达标', { exact: false }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('接近', { exact: false }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('未达标', { exact: false }).length).toBeGreaterThanOrEqual(1);
  });

  it('渲染趋势折线图（SVG 存在，含三条折线）', () => {
    const { container } = render(<CoverageDashboard {...defaultProps} />);

    // SVG 元素存在
    const svg = container.querySelector('svg[aria-label="覆盖率趋势图"]');
    expect(svg).toBeInTheDocument();

    // 三条折线（polyline 元素）
    const polylines = container.querySelectorAll('svg[aria-label="覆盖率趋势图"] polyline');
    expect(polylines.length).toBe(3);

    // 图例标签
    expect(screen.getByText('覆盖率趋势')).toBeInTheDocument();

    // 数据点（3 个 session × 3 条线 = 9 个 circle）
    const circles = container.querySelectorAll('svg[aria-label="覆盖率趋势图"] circle');
    expect(circles.length).toBe(9);

    // X 轴 session 标签（取最后一段简写）
    expect(screen.getByText('001')).toBeInTheDocument();
    expect(screen.getByText('002')).toBeInTheDocument();
    expect(screen.getByText('003')).toBeInTheDocument();
  });

  it('渲染紧凑树表格（根节点 + 三列指标）', () => {
    render(<CoverageDashboard {...defaultProps} />);

    // 模块层级覆盖率标题
    expect(screen.getByText('模块层级覆盖率')).toBeInTheDocument();

    // 根节点始终可见
    expect(screen.getByText('tb_top')).toBeInTheDocument();
    // 根默认展开，子节点可见
    expect(screen.getByText('chip_top')).toBeInTheDocument();
    expect(screen.getByText('io_block')).toBeInTheDocument();
    // chip_top 默认折叠，孙节点不可见
    expect(screen.queryByText('dut_a')).not.toBeInTheDocument();
  });

  it('紧凑树表格支持展开和折叠', () => {
    render(<CoverageDashboard {...defaultProps} />);

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

  it('紧凑树表格支持全部展开和全部折叠', () => {
    render(<CoverageDashboard {...defaultProps} />);

    // 初始：孙节点不可见
    expect(screen.queryByText('dut_a')).not.toBeInTheDocument();

    // 全部展开
    fireEvent.click(screen.getByText('全部展开'));
    expect(screen.getByText('dut_a')).toBeInTheDocument();
    expect(screen.getByText('dut_b')).toBeInTheDocument();

    // 全部折叠
    fireEvent.click(screen.getByText('全部折叠'));
    expect(screen.getByText('tb_top')).toBeInTheDocument();
    expect(screen.queryByText('chip_top')).not.toBeInTheDocument();
    expect(screen.queryByText('dut_a')).not.toBeInTheDocument();
  });

  it('未覆盖项 tab 切换显示不同 metric 的未覆盖项', () => {
    render(<CoverageDashboard {...defaultProps} />);

    // 默认显示 line tab 的未覆盖项
    expect(screen.getByText('if 分支未覆盖')).toBeInTheDocument();
    expect(screen.getByText('always 块未执行')).toBeInTheDocument();

    // 切换到 branch tab：'Branch' 出现在概览卡片、树表格表头、未覆盖 tab 中
    // 找到未覆盖项区域的 tab 按钮（在"未覆盖项"标题附近的 button）
    const uncoveredSection = screen.getByText('未覆盖项').closest('div');
    expect(uncoveredSection).toBeDefined();
    const tabButtons = uncoveredSection!.querySelectorAll('button');
    // 找到文本为 'Branch' 的 tab 按钮
    const branchTab = Array.from(tabButtons).find((btn) => btn.textContent === 'Branch');
    expect(branchTab).toBeDefined();
    fireEvent.click(branchTab!);

    // 显示 branch 的未覆盖项
    expect(screen.getByText('条件分支未覆盖')).toBeInTheDocument();
    expect(screen.queryByText('if 分支未覆盖')).not.toBeInTheDocument();
  });

  it('未覆盖项显示 module/file/line/signal/description', () => {
    render(<CoverageDashboard {...defaultProps} />);

    // 默认 line tab：显示 module + file:line + description
    expect(screen.getByText('u_analog_mphy')).toBeInTheDocument();
    expect(screen.getByText('mphy.sv:45')).toBeInTheDocument();
    expect(screen.getByText('if 分支未覆盖')).toBeInTheDocument();

    // GAP 标签
    expect(screen.getAllByText('GAP').length).toBeGreaterThan(0);

    // 切换到 branch tab 验证 signal 显示
    const uncoveredSection = screen.getByText('未覆盖项').closest('div');
    const tabButtons = uncoveredSection!.querySelectorAll('button');
    const branchTab = Array.from(tabButtons).find((btn) => btn.textContent === 'Branch');
    fireEvent.click(branchTab!);

    // branch 项有 signal 字段
    expect(screen.getByText('sig_clk')).toBeInTheDocument();
  });

  it('uncovered 数据不存在时显示"暂无未覆盖项数据"', () => {
    render(
      <CoverageDashboard
        {...defaultProps}
        data={mockDataNoUncovered}
      />,
    );

    expect(screen.getByText('暂无未覆盖项数据')).toBeInTheDocument();
  });

  it('uncovered 为空对象时显示"全部覆盖"', () => {
    render(
      <CoverageDashboard
        {...defaultProps}
        data={mockDataEmptyUncovered}
      />,
    );

    expect(screen.getByText('全部覆盖')).toBeInTheDocument();
  });

  it('AI 覆盖收敛面板显示启动按钮（无 session 时 disabled）', () => {
    render(<CoverageDashboard {...defaultProps} />);

    // 标题
    expect(screen.getByText('AI 覆盖收敛分析')).toBeInTheDocument();
    // Slice 6b 描述文本
    expect(screen.getByText('AI 将自动识别覆盖率缺口，生成定向测试并迭代验证，直至达标或触发升级转人工审查。')).toBeInTheDocument();
    // 启动按钮（无 session/project 时 disabled）
    const launchBtn = screen.getByText('启动 AI Closure').closest('button');
    expect(launchBtn).toBeInTheDocument();
    expect(launchBtn).toBeDisabled();
    // 当前总体覆盖率
    expect(screen.getByText('当前总体覆盖率 87.5%')).toBeInTheDocument();
  });

  it('无 session 时趋势图显示空状态', () => {
    const { container } = render(
      <CoverageDashboard
        {...defaultProps}
        trend={[]}
        sessions={[]}
      />,
    );

    expect(screen.getByText('暂无趋势数据（需要多个 merge session）')).toBeInTheDocument();
    // SVG 不应渲染
    expect(container.querySelector('svg[aria-label="覆盖率趋势图"]')).toBeNull();
  });

  it('单个 session 时趋势图显示单点', () => {
    const singleTrend = [mockTrend[0]];
    const { container } = render(
      <CoverageDashboard
        {...defaultProps}
        trend={singleTrend}
        sessions={[{ sessionId: mockTrend[0].sessionId, createdAt: mockTrend[0].createdAt }]}
      />,
    );

    // SVG 存在
    const svg = container.querySelector('svg[aria-label="覆盖率趋势图"]');
    expect(svg).toBeInTheDocument();

    // 三条线各一个点 = 3 个 circle
    const circles = container.querySelectorAll('svg[aria-label="覆盖率趋势图"] circle');
    expect(circles.length).toBe(3);

    // session 标签显示
    expect(screen.getByText('001')).toBeInTheDocument();
  });

  it('根据达标状态应用颜色编码', () => {
    render(<CoverageDashboard {...defaultProps} />);

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

  it('无 overview 时总体覆盖率卡片不显示', () => {
    render(
      <CoverageDashboard
        {...defaultProps}
        overview={null}
      />,
    );

    expect(screen.queryByText('总体覆盖率（8 项均值）')).not.toBeInTheDocument();
    // AI 面板在无 overview 时显示导入提示
    expect(screen.getByText('导入覆盖率数据后可启动 AI Closure')).toBeInTheDocument();
  });
});
