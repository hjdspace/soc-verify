// @vitest-environment jsdom
/**
 * CoveragePanel detail 覆盖率解析按钮测试。
 *
 * 验证（分层解析第三步 UI 入口）：
 * - 有 session + 树 + 未解析 detail 时显示「解析 detail 覆盖率」按钮
 * - 已解析（detail 标记）时按钮消失、显示「detail 已解析」标记
 * - 点击按钮调用 store 的 parseDetailMetrics
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CoverageData, CoverageNode, CoverageMetric, CoverageTriplet } from '@shared/types';

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
}));

vi.mock('@renderer/stores/project', () => ({
  useProjectStore: (selector: (s: typeof mocks.proj) => unknown) => selector(mocks.proj),
}));

import { CoveragePanel } from '@renderer/components/coverage/CoveragePanel';

function makeTree(withDetail: boolean): CoverageData {
  const na: CoverageTriplet = { percentage: null, covered: null, total: null };
  const metrics = {} as Record<CoverageMetric, CoverageTriplet>;
  for (const m of ['line', 'branch', 'toggle', 'condition', 'fsm_state', 'fsm_transition', 'functional', 'assertion'] as CoverageMetric[]) {
    metrics[m] = { ...na };
  }
  const root: CoverageNode = {
    name: 'tb_top',
    path: 'tb_top',
    depth: 0,
    metrics,
    children: [],
  };
  return {
    sessionId: 'merge_test',
    source: { covMergeDir: 'cov_merge', edaTool: 'imc', reportGeneratedAt: 0 },
    root,
    targets: {},
    summaryOnly: true,
    ...(withDetail ? { detail: { instanceCount: 2, parsedAt: 1 } } : {}),
  };
}

describe('CoveragePanel detail 覆盖率解析按钮', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cov.detailMetricsParsed = false;
    mocks.cov.detailMetricsParsing = false;
    mocks.cov.tree = makeTree(false);
  });

  it('未解析时显示按钮，点击触发 parseDetailMetrics', () => {
    render(<CoveragePanel />);
    const btn = screen.getByTestId('coverage-parse-detail-metrics-button');
    expect(btn).toBeDefined();
    fireEvent.click(btn);
    expect(mocks.cov.parseDetailMetrics).toHaveBeenCalledWith('proj-1', 'merge_test');
  });

  it('已解析时按钮消失、显示已解析标记', () => {
    mocks.cov.detailMetricsParsed = true;
    render(<CoveragePanel />);
    expect(screen.queryByTestId('coverage-parse-detail-metrics-button')).toBeNull();
    expect(screen.getByTestId('coverage-detail-metrics-parsed')).toBeDefined();
  });

  it('解析中按钮禁用并显示进度文案', () => {
    mocks.cov.detailMetricsParsing = true;
    render(<CoveragePanel />);
    const btn = screen.getByTestId('coverage-parse-detail-metrics-button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain('解析 detail 中');
  });
});
