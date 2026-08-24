// @vitest-environment jsdom
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  CoverageData,
  CoverageMergeSession,
  CoverageMetric,
  CoverageNode,
  CoverageSummary,
  CoverageTriplet,
  UncoveredItem,
} from '@shared/types';

/**
 * 覆盖率视图（Issue #5）测试：双 Tab 切换 / Bin 骨架→数据态 /
 * 趋势图折线与 90% 目标线 / 汇总面板数值与收敛预测 / 模块排序交互与
 * 低覆盖着色 / 行点击下钻 / 空状态与骨架 / 数据加载。
 * coverage store mock（selector 直读可变状态）；ui / workbench 真实 store。
 */

const mocks = vi.hoisted(() => ({
  cov: {
    sessions: [] as CoverageMergeSession[],
    currentSessionId: null as string | null,
    tree: null as CoverageData | null,
    overview: null as CoverageSummary | null,
    targets: {} as Partial<Record<CoverageMetric, number>>,
    trend: [] as Array<{ sessionId: string; createdAt: number; summary: CoverageSummary }>,
    uncoveredItems: {} as Partial<Record<CoverageMetric, UncoveredItem[]>>,
    loading: false,
    loadSessions: vi.fn().mockResolvedValue(undefined),
    loadTree: vi.fn().mockResolvedValue(undefined),
    loadTrend: vi.fn().mockResolvedValue(undefined),
    loadUncovered: vi.fn().mockResolvedValue(undefined),
    openExportDialog: vi.fn(),
    // CoverageImportDialog 依赖
    importing: false,
    importProgress: 0,
    importStep: '',
    importStepLog: [] as Array<{ step: string; message: string; timestamp: number; durationMs?: number }>,
    showImportProgress: false,
    registerImportProgressListener: vi.fn(),
    clearImportProgress: vi.fn(),
    importCoverage: vi.fn().mockResolvedValue(null),
    browseDirectory: vi.fn().mockResolvedValue(null),
  },
  proj: {
    currentProjectId: 'proj-1' as string | null,
    projects: [
      { id: 'proj-1', name: 'neckar-dv', rootPath: '/proj/neckar-dv', createdAt: 0, lastOpenedAt: 0 },
    ],
  },
}));

vi.mock('@renderer/stores/coverage', () => ({
  useCoverageCoreStore: (selector: (s: typeof mocks.cov) => unknown) => selector(mocks.cov),
  useCoverageGapsStore: (selector: (s: typeof mocks.cov) => unknown) => selector(mocks.cov),
  useCoverageClosureStore: (selector: (s: typeof mocks.cov) => unknown) => selector(mocks.cov),
  useCoverageExportStore: (selector: (s: typeof mocks.cov) => unknown) => selector(mocks.cov),
}));

vi.mock('@renderer/stores/project', () => ({
  useProjectStore: (selector: (s: typeof mocks.proj) => unknown) => selector(mocks.proj),
}));

import { CoverageView } from '@renderer/components/views/CoverageView';
import { useUiStore } from '@renderer/stores/ui';
import { useWorkbenchStore } from '@renderer/stores/workbench';

const DAY = 86_400_000;
const SESSION_ID = 'merge-20260821-a1b2c3d4';

function tripletOf(p: number | null | undefined): CoverageTriplet {
  return p == null
    ? { percentage: null, covered: null, total: null }
    : { percentage: p, covered: Math.round(p), total: 100 };
}

function makeNode(opts: {
  name: string;
  path: string;
  depth?: number;
  functional?: number | null;
  line?: number | null;
  branch?: number | null;
  assertion?: number | null;
  children?: CoverageNode[];
}): CoverageNode {
  const metrics = {} as Record<CoverageMetric, CoverageTriplet>;
  for (const m of ['line', 'branch', 'toggle', 'condition', 'fsm_state', 'fsm_transition', 'functional', 'assertion'] as CoverageMetric[]) {
    metrics[m] = tripletOf(null);
  }
  return {
    name: opts.name,
    path: opts.path,
    depth: opts.depth ?? 1,
    metrics: {
      ...metrics,
      functional: tripletOf(opts.functional),
      line: tripletOf(opts.line),
      branch: tripletOf(opts.branch),
      assertion: tripletOf(opts.assertion),
    },
    children: opts.children ?? [],
  };
}

/** 5 个模块（四类均值见各注释），uart 无 functional（N/A 沉底用例） */
function makeTree(): CoverageData {
  const root = makeNode({
    name: 'tb_top',
    path: 'tb_top',
    depth: 0,
    functional: 90, line: 90, branch: 88, assertion: 90,
    children: [
      // overall = (97.8+92.3+90.6+99.7)/4 = 95.1
      makeNode({ name: 'qspi_ctrl', path: 'tb_top.qspi_ctrl', functional: 97.8, line: 92.3, branch: 90.6, assertion: 99.7 }),
      // overall = (91.6+88.7+84.0)/3 = 88.1（functional N/A）
      makeNode({ name: 'uart_ctrl', path: 'tb_top.uart_ctrl', line: 91.6, branch: 88.7, assertion: 84.0 }),
      // overall = (72.8+66.2+61.9+81.6)/4 = 70.625（低覆盖黄区）
      makeNode({ name: 'pcie_phy_rc', path: 'tb_top.pcie_phy_rc', functional: 72.8, line: 66.2, branch: 61.9, assertion: 81.6 }),
      // overall = (68.3+60.4+55.2+78.6)/4 = 65.625（极低红区）
      makeNode({ name: 'i2c_master', path: 'tb_top.i2c_master', functional: 68.3, line: 60.4, branch: 55.2, assertion: 78.6 }),
      // overall = (99.1+96.8+94.2+100)/4 = 97.525
      makeNode({ name: 'apb_bridge', path: 'tb_top.apb_bridge', functional: 99.1, line: 96.8, branch: 94.2, assertion: 100 }),
    ],
  });
  return {
    sessionId: SESSION_ID,
    source: { covMergeDir: '/proj/cov_merge', edaTool: 'vcs-urg', reportGeneratedAt: 0 },
    root,
    targets: {},
  };
}

function makeSummary(partial: Partial<CoverageSummary>): CoverageSummary {
  return {
    overall: 85.7,
    line: 92.1,
    branch: 84.6,
    toggle: 80,
    condition: 82,
    fsm_state: 78,
    fsm_transition: 76,
    functional: 87.3,
    assertion: 78.9,
    ...partial,
  };
}

function makeTrendPoint(functional: number, line: number, createdAt: number): {
  sessionId: string;
  createdAt: number;
  summary: CoverageSummary;
} {
  return { sessionId: `s-${createdAt}`, createdAt, summary: makeSummary({ functional, line }) };
}

/** 完整数据种子：session + tree + overview + targets + 3 点趋势 */
function seedFull(): void {
  const now = Date.now();
  mocks.cov.sessions = [{
    sessionId: SESSION_ID,
    covMergeDir: '/proj/cov_merge',
    edaTool: 'vcs-urg',
    createdAt: now,
    reportDir: '/proj/report',
  }];
  mocks.cov.currentSessionId = SESSION_ID;
  mocks.cov.tree = makeTree();
  mocks.cov.overview = makeSummary({});
  mocks.cov.targets = { functional: 90 };
  // 功能 86.0 → 87.0 → 87.3：速率 0.65pp/天，距 90 差 2.7pp → 预计 5 天
  mocks.cov.trend = [
    makeTrendPoint(86.0, 91.5, now - 2 * DAY),
    makeTrendPoint(87.0, 91.8, now - DAY),
    makeTrendPoint(87.3, 92.1, now),
  ];
}

beforeEach(() => {
  mocks.cov.sessions = [];
  mocks.cov.currentSessionId = null;
  mocks.cov.tree = null;
  mocks.cov.overview = null;
  mocks.cov.targets = {};
  mocks.cov.trend = [];
  mocks.cov.uncoveredItems = {};
  mocks.cov.loading = false;
  mocks.cov.loadSessions.mockClear().mockResolvedValue(undefined);
  mocks.cov.loadTree.mockClear().mockResolvedValue(undefined);
  mocks.cov.loadTrend.mockClear().mockResolvedValue(undefined);
  mocks.cov.loadUncovered.mockClear().mockResolvedValue(undefined);
  mocks.cov.openExportDialog.mockClear();
  mocks.proj.currentProjectId = 'proj-1';
  useUiStore.setState({ activeView: 'coverage' });
  useWorkbenchStore.setState({ tabs: [], activeTabId: null });
});

/** 模块行顺序（提取 data-testid 尾段模块名） */
function moduleNames(): string[] {
  return screen
    .getAllByTestId(/^cov-mod-row-/)
    .map((el) => (el.getAttribute('data-testid') ?? '').replace('cov-mod-row-tb_top.', ''));
}

/** 手动 resolve 的受控 Promise（模拟 loadUncovered 查询挂起） */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('CoverageView 数据加载', () => {
  it('mount 时链式拉取 sessions→tree，并以 limit 7 加载趋势', async () => {
    render(<CoverageView />);

    expect(mocks.cov.loadSessions).toHaveBeenCalledWith('proj-1');
    expect(mocks.cov.loadTrend).toHaveBeenCalledWith('proj-1', 7);
    // loadTree 在 loadSessions 的 promise 链中，等待微任务刷新
    await vi.waitFor(() => expect(mocks.cov.loadTree).toHaveBeenCalledWith('proj-1'));
  });

  it('无当前项目时不加载', () => {
    mocks.proj.currentProjectId = null;
    render(<CoverageView />);

    expect(mocks.cov.loadSessions).not.toHaveBeenCalled();
    expect(mocks.cov.loadTree).not.toHaveBeenCalled();
    expect(mocks.cov.loadTrend).not.toHaveBeenCalled();
  });

  it('tree 与 trend 已有数据时不重复加载', () => {
    seedFull();
    render(<CoverageView />);

    expect(mocks.cov.loadSessions).not.toHaveBeenCalled();
    expect(mocks.cov.loadTree).not.toHaveBeenCalled();
    expect(mocks.cov.loadTrend).not.toHaveBeenCalled();
  });
});

describe('CoverageView 空状态与骨架', () => {
  it('无数据时趋势/汇总/模块表均显示空状态引导', () => {
    render(<CoverageView />);

    expect(screen.getByTestId('cov-trend-empty')).toBeInTheDocument();
    expect(screen.getByTestId('cov-sum-empty')).toBeInTheDocument();
    expect(screen.getByTestId('cov-mod-empty')).toBeInTheDocument();
    // 副标题与模块表空态均提示无数据（两处）
    expect(screen.getAllByText('暂无覆盖率数据')).toHaveLength(2);
  });

  it('loading 时汇总与模块表显示骨架屏', () => {
    mocks.cov.loading = true;
    render(<CoverageView />);

    expect(screen.getByTestId('cov-sum-skeleton')).toBeInTheDocument();
    expect(screen.getByTestId('cov-mod-skeleton')).toBeInTheDocument();
    // 趋势查询不经过全局 loading（独立加载），空趋势仍显示空态
    expect(screen.getByTestId('cov-trend-empty')).toBeInTheDocument();
  });
});

describe('CoverageView 双 Tab 切换', () => {
  it('默认模块排序 Tab；切换到 Bin 明细后互斥显示', async () => {
    seedFull();
    render(<CoverageView />);

    expect(screen.getByTestId('cov-tab-module')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('cov-tab-bin')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('cov-mod-table')).toBeInTheDocument();
    expect(screen.queryByTestId('cov-bin-panel')).toBeNull();

    fireEvent.click(screen.getByTestId('cov-tab-bin'));
    expect(screen.getByTestId('cov-tab-bin')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('cov-mod-table')).toBeNull();
    expect(screen.getByTestId('cov-bin-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('cov-tab-module'));
    expect(screen.getByTestId('cov-mod-table')).toBeInTheDocument();
    expect(screen.queryByTestId('cov-bin-panel')).toBeNull();
    // 冲刷 bin 加载微任务，避免测试后残留状态更新
    await act(async () => {});
  });
});

describe('CoverageView 趋势图', () => {
  it('渲染功能/代码双折线与 90% 目标虚线', () => {
    seedFull();
    render(<CoverageView />);

    expect(screen.getByTestId('cov-trend-chart')).toBeInTheDocument();
    expect(screen.getByTestId('cov-trend-line-functional')).toBeInTheDocument();
    expect(screen.getByTestId('cov-trend-line-code')).toBeInTheDocument();
    expect(screen.getByTestId('cov-trend-target-line')).toBeInTheDocument();
    expect(screen.getByText('7 日趋势')).toBeInTheDocument();
  });

  it('无趋势数据时显示空态，不渲染图表', () => {
    render(<CoverageView />);

    expect(screen.getByTestId('cov-trend-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('cov-trend-chart')).toBeNull();
  });

  it('单点趋势只画末端点，不画折线', () => {
    mocks.cov.trend = [makeTrendPoint(87.3, 92.1, Date.now())];
    render(<CoverageView />);

    expect(screen.getByTestId('cov-trend-chart')).toBeInTheDocument();
    expect(screen.queryByTestId('cov-trend-line-functional')).toBeNull();
    expect(screen.queryByTestId('cov-trend-line-code')).toBeNull();
    expect(screen.getByTestId('cov-trend-target-line')).toBeInTheDocument();
  });
});

describe('CoverageView 汇总面板', () => {
  it('四类覆盖率数值、距目标差值与 session 间 delta', () => {
    seedFull();
    render(<CoverageView />);

    expect(screen.getByTestId('cov-sum-row-functional').textContent).toContain('87.3%');
    expect(screen.getByTestId('cov-sum-row-line').textContent).toContain('92.1%');
    expect(screen.getByTestId('cov-sum-row-branch').textContent).toContain('84.6%');
    expect(screen.getByTestId('cov-sum-row-assertion').textContent).toContain('78.9%');
    // 差值：functional 目标 90（覆盖默认）；line/branch 用默认 95/90；assertion 无默认目标
    expect(screen.getByTestId('cov-sum-diff-functional').textContent).toContain('差 2.7pp');
    expect(screen.getByTestId('cov-sum-diff-line').textContent).toContain('差 2.9pp');
    expect(screen.getByTestId('cov-sum-diff-branch').textContent).toContain('差 5.4pp');
    expect(screen.getByTestId('cov-sum-diff-assertion').textContent).toBe('无目标');
    // 与上一 session 的 delta（87.0→87.3 / 91.8→92.1）
    expect(screen.getByTestId('cov-sum-delta-functional').textContent).toBe('+0.3');
    expect(screen.getByTestId('cov-sum-delta-line').textContent).toBe('+0.3');
  });

  it('收敛预测：按近期增速预估达成天数', () => {
    seedFull();
    render(<CoverageView />);

    const text = screen.getByTestId('cov-convergence').textContent ?? '';
    expect(text).toContain('距 90% 目标还差 2.7pp');
    expect(text).toContain('预计 5 天内达成');
  });

  it('已达目标时提示已完成', () => {
    mocks.cov.overview = makeSummary({ functional: 90.5 });
    mocks.cov.targets = { functional: 90 };
    render(<CoverageView />);

    expect(screen.getByTestId('cov-convergence').textContent).toContain('已达 90% 目标');
  });

  it('趋势点不足时给出无趋势提示', () => {
    mocks.cov.overview = makeSummary({ functional: 87.3 });
    mocks.cov.targets = { functional: 90 };
    mocks.cov.trend = [makeTrendPoint(87.3, 92.1, Date.now())];
    render(<CoverageView />);

    expect(screen.getByTestId('cov-convergence').textContent).toContain('暂无收敛趋势数据');
  });

  it('近期未收敛时建议优先处理低覆盖模块', () => {
    const now = Date.now();
    mocks.cov.overview = makeSummary({ functional: 86.0 });
    mocks.cov.targets = { functional: 90 };
    // 86.0 → 87.0 → 86.0：近期增速 ≤ 0，判定未收敛
    mocks.cov.trend = [
      makeTrendPoint(86.0, 92.1, now - 2 * DAY),
      makeTrendPoint(87.0, 91.8, now - DAY),
      makeTrendPoint(86.0, 92.1, now),
    ];
    render(<CoverageView />);

    expect(screen.getByTestId('cov-convergence').textContent).toContain('近期未在收敛');
  });
});

describe('CoverageView 模块排序表', () => {
  it('默认按综合覆盖率升序：低覆盖置顶，N/A 沉底', () => {
    seedFull();
    render(<CoverageView />);

    expect(moduleNames()).toEqual([
      'i2c_master',   // 65.6
      'pcie_phy_rc',  // 70.6
      'uart_ctrl',    // 88.1
      'qspi_ctrl',    // 95.1
      'apb_bridge',   // 97.5
    ]);
  });

  it('点击当前排序列翻转方向；切换其他列重置方向', () => {
    seedFull();
    render(<CoverageView />);

    // overall 已是默认列：点击翻转为降序（高覆盖置顶）
    fireEvent.click(screen.getByTestId('cov-sort-overall'));
    expect(moduleNames()).toEqual([
      'apb_bridge',
      'qspi_ctrl',
      'uart_ctrl',
      'pcie_phy_rc',
      'i2c_master',
    ]);

    // 切换到模块名列：重置为名称升序
    fireEvent.click(screen.getByTestId('cov-sort-module'));
    expect(moduleNames()).toEqual([
      'apb_bridge',
      'i2c_master',
      'pcie_phy_rc',
      'qspi_ctrl',
      'uart_ctrl',
    ]);
  });

  it('N/A 指标显示占位且排序时沉底', () => {
    seedFull();
    render(<CoverageView />);

    // uart_ctrl 无 functional
    expect(screen.getByTestId('cov-cell-tb_top.uart_ctrl-functional').textContent).toBe('N/A');
    // 按 functional 降序：uart_ctrl（N/A）沉底
    fireEvent.click(screen.getByTestId('cov-sort-functional'));
    expect(moduleNames()[4]).toBe('uart_ctrl');
  });

  it('低覆盖着色：综合 <70% 红、<75% 黄、正常主色', () => {
    seedFull();
    render(<CoverageView />);

    // 综合覆盖率条：i2c 65.6%（红）/ pcie 70.6%（黄）/ qspi 95.1%（正常）
    expect(screen.getByTestId('cov-bar-tb_top.i2c_master').className).toContain('bg-status-fail');
    expect(screen.getByTestId('cov-bar-tb_top.pcie_phy_rc').className).toContain('bg-warning');
    expect(screen.getByTestId('cov-bar-tb_top.qspi_ctrl').className).toContain('bg-primary');
    // 单指标文本色：i2c functional 68.3（红）/ pcie functional 72.8（黄）/ apb 99.1（正常）
    expect(screen.getByTestId('cov-cell-tb_top.i2c_master-functional').className).toContain('text-status-fail-foreground');
    expect(screen.getByTestId('cov-cell-tb_top.pcie_phy_rc-functional').className).toContain('text-warning-foreground');
    expect(screen.getByTestId('cov-cell-tb_top.apb_bridge-functional').className).toContain('text-foreground');
  });

  it('行点击打开覆盖率明细 Tab；重复点击不重复开 Tab', () => {
    seedFull();
    render(<CoverageView />);

    fireEvent.click(screen.getByTestId('cov-mod-row-tb_top.i2c_master'));
    expect(useUiStore.getState().activeView).toBe('workspace');
    const tabs = useWorkbenchStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].destination.type).toBe('coverage-detail');

    fireEvent.click(screen.getByTestId('cov-mod-row-tb_top.qspi_ctrl'));
    expect(useWorkbenchStore.getState().tabs).toHaveLength(1);
  });
});

describe('CoverageView Bin 明细', () => {
  it('首次进入显示骨架屏（loadUncovered loading 态），完成后展示未命中 Bin', async () => {
    seedFull();
    mocks.cov.uncoveredItems = {
      functional: [
        { module: 'tb_top.i2c_master', description: 'reg_write_burst bin 未命中', signal: 'scl', file: 'i2c_master.sv', line: 142 },
        { module: 'tb_top.pcie_phy_rc', description: 'ltssm_l0s_entry bin 未命中' },
      ],
    };
    const d = deferred();
    mocks.cov.loadUncovered.mockReturnValueOnce(d.promise);
    render(<CoverageView />);

    // 模块 Tab 下不触发 Bin 查询
    expect(mocks.cov.loadUncovered).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('cov-tab-bin'));
    expect(mocks.cov.loadUncovered).toHaveBeenCalledWith('proj-1', SESSION_ID, 'functional');
    expect(screen.getByTestId('cov-bin-skeleton')).toBeInTheDocument();

    await act(async () => {
      d.resolve();
    });
    expect(screen.queryByTestId('cov-bin-skeleton')).toBeNull();
    expect(screen.getByTestId('cov-bin-row-0').textContent).toContain('tb_top.i2c_master');
    expect(screen.getByTestId('cov-bin-row-0').textContent).toContain('reg_write_burst bin 未命中');
    expect(screen.getByTestId('cov-bin-row-0').textContent).toContain('i2c_master.sv:142');
    expect(screen.getByTestId('cov-bin-row-1').textContent).toContain('ltssm_l0s_entry bin 未命中');
  });

  it('未命中 Bin 为空时显示空态', async () => {
    seedFull();
    mocks.cov.uncoveredItems = { functional: [] };
    render(<CoverageView />);

    fireEvent.click(screen.getByTestId('cov-tab-bin'));
    await act(async () => {});
    expect(screen.getByTestId('cov-bin-empty')).toBeInTheDocument();
  });

  it('已加载后再次切换 Tab 不重复查询', async () => {
    seedFull();
    mocks.cov.uncoveredItems = { functional: [] };
    render(<CoverageView />);

    fireEvent.click(screen.getByTestId('cov-tab-bin'));
    await act(async () => {});
    expect(mocks.cov.loadUncovered).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('cov-tab-module'));
    fireEvent.click(screen.getByTestId('cov-tab-bin'));
    await act(async () => {});
    expect(mocks.cov.loadUncovered).toHaveBeenCalledTimes(1);
  });
});

describe('CoverageView 头部与顶栏动作', () => {
  it('副标题显示当前 merge session 摘要（session 简写）', () => {
    seedFull();
    render(<CoverageView />);

    expect(screen.getByText(/merge 自 a1b2c3d4/)).toBeInTheDocument();
  });

  it('导出按钮触发 openExportDialog', () => {
    seedFull();
    render(<CoverageView />);

    fireEvent.click(screen.getByTestId('cov-export-btn'));
    expect(mocks.cov.openExportDialog).toHaveBeenCalledTimes(1);
  });
});
