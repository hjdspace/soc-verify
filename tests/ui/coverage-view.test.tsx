// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  CoverageData,
  CoverageMergeSession,
  CoverageMetric,
  CoverageNode,
  CoverageSummary,
  CoverageTriplet,
} from '@shared/types';

/**
 * 覆盖率视图（Issue #5 + SoC 代码覆盖率重构）测试：
 * 趋势图单折线与 90% 目标线 / 汇总面板代码覆盖率与收敛预测 /
 * 模块排序交互与低覆盖着色 / 行点击下钻 / 空状态与骨架 / 数据加载。
 * SoC 重构：功能/断言覆盖率退役，Bin 明细 Tab 移除，只看代码覆盖率（line）。
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
  line?: number | null;
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
      line: tripletOf(opts.line),
    },
    children: opts.children ?? [],
  };
}

/** 5 个模块（模块排序见各注释），uart 无 line（N/A 沉底用例）；qspi 下挂深层子模块 */
function makeTree(): CoverageData {
  const root = makeNode({
    name: 'tb_top',
    path: 'tb_top',
    depth: 0,
    line: 90,
    children: [
      makeNode({
        name: 'qspi_ctrl',
        path: 'tb_top.qspi_ctrl',
        line: 92.3,
        children: [
          // 深层节点：path 列展示完整点号层级（同名模块靠 path 区分）
          makeNode({ name: 'U_SYNC_UPDT', path: 'tb_top.qspi_ctrl.u_reg_blk.U_SYNC_UPDT', depth: 3, line: 50 }),
        ],
      }),
      makeNode({ name: 'uart_ctrl', path: 'tb_top.uart_ctrl' }), // line N/A → 沉底
      makeNode({ name: 'pcie_phy_rc', path: 'tb_top.pcie_phy_rc', line: 66.2 }), // 低覆盖黄区
      makeNode({ name: 'i2c_master', path: 'tb_top.i2c_master', line: 60.4 }), // 极低红区
      makeNode({ name: 'apb_bridge', path: 'tb_top.apb_bridge', line: 96.8 }),
    ],
  });
  return {
    sessionId: SESSION_ID,
    source: { covMergeDir: '/proj/cov_merge', edaTool: 'imc', reportGeneratedAt: 0 },
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

function makeTrendPoint(line: number, createdAt: number): {
  sessionId: string;
  createdAt: number;
  summary: CoverageSummary;
} {
  return { sessionId: `s-${createdAt}`, createdAt, summary: makeSummary({ line }) };
}

/** 完整数据种子：session + tree + overview + targets + 3 点趋势 */
function seedFull(): void {
  const now = Date.now();
  mocks.cov.sessions = [{
    sessionId: SESSION_ID,
    covMergeDir: '/proj/cov_merge',
    edaTool: 'imc',
    createdAt: now,
    reportDir: '/proj/report',
  }];
  mocks.cov.currentSessionId = SESSION_ID;
  mocks.cov.tree = makeTree();
  mocks.cov.overview = makeSummary({});
  mocks.cov.targets = { line: 95 };
  // 代码 91.5 → 91.8 → 92.1：速率 0.3pp/天，距 95 差 2.9pp → 预计 10 天
  mocks.cov.trend = [
    makeTrendPoint(91.5, now - 2 * DAY),
    makeTrendPoint(91.8, now - DAY),
    makeTrendPoint(92.1, now),
  ];
}

beforeEach(() => {
  mocks.cov.sessions = [];
  mocks.cov.currentSessionId = null;
  mocks.cov.tree = null;
  mocks.cov.overview = null;
  mocks.cov.targets = {};
  mocks.cov.trend = [];
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

/** 模块行顺序（取 testid 中 path 的最后一段 = 模块名） */
function moduleNames(): string[] {
  return screen
    .getAllByTestId(/^cov-mod-row-/)
    .map((el) => (el.getAttribute('data-testid') ?? '').split('.').pop() ?? '');
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

  it('Bin 明细 Tab 已移除（SoC 功能覆盖率退役）', () => {
    seedFull();
    render(<CoverageView />);

    expect(screen.queryByTestId('cov-tab-bin')).toBeNull();
    expect(screen.queryByTestId('cov-tab-module')).toBeNull();
    expect(screen.getByTestId('cov-mod-table')).toBeInTheDocument();
  });
});

describe('CoverageView 趋势图', () => {
  it('渲染代码覆盖率单折线与 90% 目标虚线', () => {
    seedFull();
    render(<CoverageView />);

    expect(screen.getByTestId('cov-trend-chart')).toBeInTheDocument();
    expect(screen.getByTestId('cov-trend-line-code')).toBeInTheDocument();
    expect(screen.queryByTestId('cov-trend-line-functional')).toBeNull();
    expect(screen.getByTestId('cov-trend-target-line')).toBeInTheDocument();
    expect(screen.getByText('7 日趋势')).toBeInTheDocument();
  });

  it('无趋势数据时显示空态，不渲染图表', () => {
    render(<CoverageView />);

    expect(screen.getByTestId('cov-trend-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('cov-trend-chart')).toBeNull();
  });

  it('单点趋势只画末端点，不画折线', () => {
    mocks.cov.trend = [makeTrendPoint(92.1, Date.now())];
    render(<CoverageView />);

    expect(screen.getByTestId('cov-trend-chart')).toBeInTheDocument();
    expect(screen.queryByTestId('cov-trend-line-code')).toBeNull();
    expect(screen.getByTestId('cov-trend-target-line')).toBeInTheDocument();
  });
});

describe('CoverageView 汇总面板', () => {
  it('代码覆盖率数值、距目标差值、点数比与 session 间 delta', () => {
    seedFull();
    render(<CoverageView />);

    // 代码覆盖率条与差值（line 目标 95 覆盖默认）
    expect(screen.getByTestId('cov-sum-row-line').textContent).toContain('92.1%');
    expect(screen.getByTestId('cov-sum-diff-line').textContent).toContain('差 2.9pp');
    // 与上一 session 的 delta（91.8→92.1）
    expect(screen.getByTestId('cov-sum-delta-line').textContent).toBe('+0.3');
    // 覆盖点数比（root line triplet）
    expect(screen.getByTestId('cov-sum-points').textContent).toContain('90 / 100');
  });

  it('收敛预测：按近期增速预估达成天数', () => {
    seedFull();
    render(<CoverageView />);

    const text = screen.getByTestId('cov-convergence').textContent ?? '';
    expect(text).toContain('距 95% 目标还差 2.9pp');
    expect(text).toContain('预计 10 天内达成');
  });

  it('已达目标时提示已完成', () => {
    mocks.cov.overview = makeSummary({ line: 95.5 });
    mocks.cov.targets = { line: 95 };
    render(<CoverageView />);

    expect(screen.getByTestId('cov-convergence').textContent).toContain('已达 95% 目标');
  });

  it('趋势点不足时给出无趋势提示', () => {
    mocks.cov.overview = makeSummary({ line: 92.1 });
    mocks.cov.targets = { line: 95 };
    mocks.cov.trend = [makeTrendPoint(92.1, Date.now())];
    render(<CoverageView />);

    expect(screen.getByTestId('cov-convergence').textContent).toContain('暂无收敛趋势数据');
  });

  it('近期未收敛时建议优先处理低覆盖模块', () => {
    const now = Date.now();
    mocks.cov.overview = makeSummary({ line: 91.5 });
    mocks.cov.targets = { line: 95 };
    // 91.5 → 91.8 → 91.5：近期增速 ≤ 0，判定未收敛
    mocks.cov.trend = [
      makeTrendPoint(91.5, now - 2 * DAY),
      makeTrendPoint(91.8, now - DAY),
      makeTrendPoint(91.5, now),
    ];
    render(<CoverageView />);

    expect(screen.getByTestId('cov-convergence').textContent).toContain('近期未在收敛');
  });
});

describe('CoverageView 模块排序表', () => {
  it('默认按代码覆盖率升序：低覆盖置顶，N/A 沉底', () => {
    seedFull();
    render(<CoverageView />);

    expect(moduleNames()).toEqual([
      'U_SYNC_UPDT',  // 50（深层子模块）
      'i2c_master',   // 60.4
      'pcie_phy_rc',  // 66.2
      'qspi_ctrl',    // 92.3
      'apb_bridge',   // 96.8
      'uart_ctrl',    // N/A 沉底
    ]);
  });

  it('层级独立列展示完整点号 path（深层/同名模块区分）', () => {
    seedFull();
    render(<CoverageView />);

    // 深层节点：path 完整点号层级，与模块名分列展示
    expect(screen.getByTestId('cov-path-tb_top.qspi_ctrl.u_reg_blk.U_SYNC_UPDT').textContent)
      .toBe('tb_top.qspi_ctrl.u_reg_blk.U_SYNC_UPDT');
    // 顶层模块 path 即自身（tb_top.qspi_ctrl）
    expect(screen.getByTestId('cov-path-tb_top.qspi_ctrl').textContent).toBe('tb_top.qspi_ctrl');
  });

  it('层级列可排序：path 字典序天然保持树形分组', () => {
    seedFull();
    render(<CoverageView />);

    fireEvent.click(screen.getByTestId('cov-sort-path'));
    const names = moduleNames();
    // 树形分组：父模块 qspi_ctrl 紧跟其子模块 U_SYNC_UPDT（前缀相邻），其余按 path 字典序
    expect(names.indexOf('qspi_ctrl') + 1).toBe(names.indexOf('U_SYNC_UPDT'));
    expect(names).toEqual([
      'tb_top.apb_bridge',
      'tb_top.i2c_master',
      'tb_top.pcie_phy_rc',
      'qspi_ctrl',
      'U_SYNC_UPDT',
      'tb_top.uart_ctrl',
    ].map((p) => p.replace('tb_top.', '')));
  });

  it('点击当前排序列翻转方向；切换其他列重置方向', () => {
    seedFull();
    render(<CoverageView />);

    // line 已是默认列：点击翻转为降序（高覆盖置顶；N/A 沉底）
    fireEvent.click(screen.getByTestId('cov-sort-line'));
    expect(moduleNames()).toEqual([
      'apb_bridge',
      'qspi_ctrl',
      'pcie_phy_rc',
      'i2c_master',
      'U_SYNC_UPDT',
      'uart_ctrl',   // N/A 沉底
    ]);

    // 切换到模块名列：重置为名称升序（localeCompare：U < u，大写在前）
    fireEvent.click(screen.getByTestId('cov-sort-module'));
    expect(moduleNames()).toEqual([
      'apb_bridge',
      'i2c_master',
      'pcie_phy_rc',
      'qspi_ctrl',
      'U_SYNC_UPDT',
      'uart_ctrl',
    ]);
  });

  it('N/A 指标显示占位且排序时沉底', () => {
    seedFull();
    render(<CoverageView />);

    // uart_ctrl 无 line
    expect(screen.getByTestId('cov-cell-tb_top.uart_ctrl-line').textContent).toBe('N/A');
    // 按 line 降序：uart_ctrl（N/A）沉底
    fireEvent.click(screen.getByTestId('cov-sort-line'));
    expect(moduleNames()[5]).toBe('uart_ctrl');
  });

  it('代码覆盖率单元合并展示百分比与覆盖点数比（94.13% (353/375) 格式）', () => {
    seedFull();
    render(<CoverageView />);

    // qspi_ctrl：92.3% + 点数比 (92/100)（tripletOf 生成 covered=round(pct), total=100）
    expect(screen.getByTestId('cov-cell-tb_top.qspi_ctrl-line').textContent).toBe('92.3% (92/100)');
    // N/A 行无点数比
    expect(screen.getByTestId('cov-cell-tb_top.uart_ctrl-line').textContent).toBe('N/A');
  });

  it('blocks/branches/statements 预留列暂显示 N/A（detail.txt 解析后填充）', () => {
    seedFull();
    render(<CoverageView />);

    expect(screen.getByTestId('cov-cell-tb_top.qspi_ctrl-branch').textContent).toBe('N/A');
    expect(screen.getByTestId('cov-cell-tb_top.qspi_ctrl-statement').textContent).toBe('N/A');
    expect(screen.getByTestId('cov-cell-tb_top.qspi_ctrl-block').textContent).toBe('N/A');
  });

  it('低覆盖着色：代码 <70% 红、<75% 黄、正常主色', () => {
    seedFull();
    render(<CoverageView />);

    // 覆盖率条：i2c 60.4%（红）/ pcie 66.2%（红）/ qspi 92.3%（正常）
    expect(screen.getByTestId('cov-bar-tb_top.i2c_master').className).toContain('bg-status-fail');
    expect(screen.getByTestId('cov-bar-tb_top.pcie_phy_rc').className).toContain('bg-status-fail');
    expect(screen.getByTestId('cov-bar-tb_top.qspi_ctrl').className).toContain('bg-primary');
    // 单指标文本色：apb 96.8（正常）/ N/A（muted）
    expect(screen.getByTestId('cov-cell-tb_top.apb_bridge-line').className).toContain('text-foreground');
    expect(screen.getByTestId('cov-cell-tb_top.uart_ctrl-line').className).toContain('text-muted-foreground');
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
