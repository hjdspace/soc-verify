// @vitest-environment jsdom
/**
 * Waive UI 测试 — CoveragePanel 工具栏生成按钮 + WaiveSection Tab。
 *
 * 验证：
 * - detail 已解析时工具栏显示「生成 waive」按钮，点击调 store generateWaive
 * - 生成中按钮禁用并显示进度文案
 * - detail 未解析时按钮不显示；WaiveTab 显示前置引导（需先解析 detail）
 * - WaiveSection 历史列表渲染（runId / rule 数 / 三类计数）+ 展开/打开/删除操作
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CoverageData, CoverageNode, CoverageMetric, CoverageTriplet, WaiveHistoryEntry } from '@shared/types';

// ─── store mocks ───────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  cov: {
    currentSessionId: 'merge_test' as string | null,
    tree: null as CoverageData | null,
    sessions: [{ sessionId: 'merge_test', covMergeDir: 'cov_merge', edaTool: 'imc', createdAt: 0, reportDir: '/r' }],
    loading: false,
    detailParsing: false,
    detailParsed: false,
    detailMetricsParsed: false,
    detailMetricsParsing: false,
    parseDetailMetrics: vi.fn().mockResolvedValue(true),
    parseDetails: vi.fn().mockResolvedValue(true),
    loadTree: vi.fn().mockResolvedValue(undefined),
    loadSessions: vi.fn().mockResolvedValue(undefined),
    loadEdaConfig: vi.fn().mockResolvedValue(undefined),
    registerDetailProgressListener: vi.fn(),
    registerImportProgressListener: vi.fn(),
    importWarnings: [] as string[],
    clearImportWarnings: vi.fn(),
    deleteSession: vi.fn().mockResolvedValue(true),
    loadImportLog: vi.fn().mockResolvedValue(undefined),
    toggleDebugPanel: vi.fn(),
    showDebugPanel: false,
    importLog: null,
    view: 'tree-table',
    setView: vi.fn(),
  },
  waive: {
    generating: false,
    progress: 0,
    step: '',
    stepLog: [] as Array<{ step: string; message: string; timestamp: number; durationMs?: number }>,
    showProgress: false,
    history: [] as WaiveHistoryEntry[],
    historyLoading: false,
    expandedRunId: null as string | null,
    expandedAnalysis: null,
    analysisLoading: false,
    generateWaive: vi.fn().mockResolvedValue(true),
    loadHistory: vi.fn().mockResolvedValue(undefined),
    deleteHistoryEntry: vi.fn().mockResolvedValue(undefined),
    toggleExpand: vi.fn().mockResolvedValue(undefined),
    openWaiveDir: vi.fn().mockResolvedValue(undefined),
    registerProgressListener: vi.fn(),
    clearProgress: vi.fn(),
  },
  closure: {
    currentClosure: null,
    closureLive: { running: false },
    registerClosureEventListener: vi.fn(),
    loadClosures: vi.fn().mockResolvedValue(undefined),
    abortClosure: vi.fn().mockResolvedValue(undefined),
  },
  proj: {
    currentProjectId: 'proj-1',
  },
}));

vi.mock('@renderer/stores/coverage', () => ({
  useCoverageCoreStore: (selector: (s: typeof mocks.cov) => unknown) => selector(mocks.cov),
  useCoverageGapsStore: (selector: (s: Record<string, unknown>) => unknown) => selector({}),
  useCoverageClosureStore: (selector: (s: typeof mocks.closure) => unknown) => selector(mocks.closure),
  useCoverageExportStore: (selector: (s: Record<string, unknown>) => unknown) => selector({}),
  useCoverageWaiveStore: (selector: (s: typeof mocks.waive) => unknown) => selector(mocks.waive),
}));

vi.mock('@renderer/stores/project', () => ({
  useProjectStore: (selector: (s: typeof mocks.proj) => unknown) => selector(mocks.proj),
}));

import { CoveragePanel } from '@renderer/components/coverage/CoveragePanel';
import { WaiveSection } from '@renderer/components/coverage/WaiveSection';

function makeTree(withDetail: boolean): CoverageData {
  const na: CoverageTriplet = { percentage: null, covered: null, total: null };
  const metrics = {} as Record<CoverageMetric, CoverageTriplet>;
  for (const m of ['line', 'branch', 'toggle', 'condition', 'fsm_state', 'fsm_transition', 'functional', 'assertion'] as CoverageMetric[]) {
    metrics[m] = { ...na };
  }
  const root: CoverageNode = { name: 'tb_top', path: 'tb_top', depth: 0, metrics, children: [] };
  return {
    sessionId: 'merge_test',
    source: { covMergeDir: 'cov_merge', edaTool: 'imc', reportGeneratedAt: 0 },
    root,
    targets: {},
    summaryOnly: true,
    ...(withDetail ? { detail: { instanceCount: 2, parsedAt: 1 } } : {}),
  };
}

const HISTORY_ENTRY: WaiveHistoryEntry = {
  runId: 'waive_20260911_100000_00',
  sessionId: 'merge_test',
  generatedAt: 1757600000000,
  ruleCount: 42,
  signalCounts: { const_assign: 20, input_tie: 12, output_floating: 10 },
  outputPath: '/tmp/waive.vRefine',
  durationMs: 1500,
  warnings: [],
};

describe('CoveragePanel 工具栏生成 waive 按钮', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cov.detailMetricsParsed = false;
    mocks.cov.tree = makeTree(false);
    mocks.waive.history = [];
    mocks.waive.generating = false;
  });

  it('detail 已解析时显示按钮，点击触发 generateWaive', () => {
    mocks.cov.detailMetricsParsed = true;
    render(<CoveragePanel />);
    const btn = screen.getByTestId('coverage-generate-waive-button');
    fireEvent.click(btn);
    expect(mocks.waive.generateWaive).toHaveBeenCalledWith('proj-1', 'merge_test');
  });

  it('detail 未解析时不显示生成按钮', () => {
    render(<CoveragePanel />);
    expect(screen.queryByTestId('coverage-generate-waive-button')).toBeNull();
  });

  it('生成中按钮禁用并显示进度文案', () => {
    mocks.cov.detailMetricsParsed = true;
    mocks.waive.generating = true;
    render(<CoveragePanel />);
    const btn = screen.getByTestId('coverage-generate-waive-button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain('生成 waive 中');
  });
});

describe('WaiveSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.waive.history = [];
    mocks.waive.generating = false;
    mocks.waive.showProgress = false;
  });

  it('detail 未解析时显示前置引导', () => {
    mocks.cov.detailMetricsParsed = false;
    render(<WaiveSection currentProjectId="proj-1" currentSessionId="merge_test" />);
    expect(screen.getByTestId('waive-need-detail')).toBeDefined();
    expect(screen.getByTestId('waive-need-detail').textContent).toContain('解析 detail');
  });

  it('detail 已解析时显示生成按钮和历史空态', () => {
    mocks.cov.detailMetricsParsed = true;
    render(<WaiveSection currentProjectId="proj-1" currentSessionId="merge_test" />);
    expect(screen.getByTestId('waive-generate-button')).toBeDefined();
    // loadHistory 已被调用（挂载时）
    expect(mocks.waive.loadHistory).toHaveBeenCalledWith('proj-1');
    expect(screen.getByText(/暂无生成记录/)).toBeDefined();
  });

  it('渲染历史列表并支持展开/打开/删除', () => {
    mocks.cov.detailMetricsParsed = true;
    mocks.waive.history = [HISTORY_ENTRY];
    render(<WaiveSection currentProjectId="proj-1" currentSessionId="merge_test" />);
    expect(screen.getByTestId('waive-history-rules-waive_20260911_100000_00').textContent).toBe('42');
    // 展开明细
    fireEvent.click(screen.getByTestId('waive-history-expand-waive_20260911_100000_00'));
    expect(mocks.waive.toggleExpand).toHaveBeenCalledWith('proj-1', 'waive_20260911_100000_00');
    // 打开产物
    fireEvent.click(screen.getByTestId('waive-history-open-waive_20260911_100000_00'));
    expect(mocks.waive.openWaiveDir).toHaveBeenCalledWith('proj-1', 'waive_20260911_100000_00');
    // 删除
    fireEvent.click(screen.getByTestId('waive-history-delete-waive_20260911_100000_00'));
    expect(mocks.waive.deleteHistoryEntry).toHaveBeenCalledWith('proj-1', 'waive_20260911_100000_00');
  });

  it('生成进度面板渲染步骤日志', () => {
    mocks.cov.detailMetricsParsed = true;
    mocks.waive.showProgress = true;
    mocks.waive.progress = 60;
    mocks.waive.step = '正在静态分析 RTL...';
    mocks.waive.stepLog = [
      { step: 'load_detail', message: '读取 detail', timestamp: 1757600000000 },
      { step: 'analyze_rtl', message: '正在静态分析 RTL...', timestamp: 1757600001000 },
    ];
    render(<WaiveSection currentProjectId="proj-1" currentSessionId="merge_test" />);
    const panel = screen.getByTestId('waive-progress-panel');
    expect(panel.textContent).toContain('正在静态分析 RTL...');
    expect(panel.textContent).toContain('60%');
    expect(panel.textContent).toContain('读取 detail');
  });
});
