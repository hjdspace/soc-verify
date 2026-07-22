// @vitest-environment jsdom
/**
 * AI 覆盖收敛面板 UI 测试（Slice 6b / Issue #8）。
 *
 * AiClosurePanel 是 CoverageDashboard 的内部组件，通过 mock
 * useCoverageStore / useProjectStore 模拟不同 Closure 状态：
 *   - 无 Closure（启动按钮）
 *   - 运行中（中止按钮 + 实时进度 + Gap 队列）
 *   - 已完成（重启按钮 + 摘要）
 *   - 已中止（中止提示）
 *   - Gap 队列渲染（多种状态混合）
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CoverageDashboard } from '@renderer/components/coverage/CoverageDashboard';
import type {
  CoverageData, CoverageMetric, CoverageSummary, CoverageTriplet,
} from '@shared/types';
import { COVERAGE_METRICS, NA_TRIPLET } from '@shared/types';

// ─── Store mock 状态 ─────────────────────────────────────────────

interface CoverageStoreMockState {
  currentClosure: unknown;
  closureLive: unknown;
  startClosure: ReturnType<typeof vi.fn>;
  abortClosure: ReturnType<typeof vi.fn>;
  currentSessionId: string | null;
}

interface ProjectStoreMockState {
  currentProjectId: string | null;
}

let coverageState: CoverageStoreMockState;
let projectState: ProjectStoreMockState;

vi.mock('@renderer/stores/coverage', () => ({
  useCoverageStore: vi.fn((selector: (s: CoverageStoreMockState) => unknown) =>
    selector(coverageState),
  ),
}));

vi.mock('@renderer/stores/project', () => ({
  useProjectStore: vi.fn((selector: (s: ProjectStoreMockState) => unknown) =>
    selector(projectState),
  ),
}));

// ─── Mock 数据 ───────────────────────────────────────────────────

function naMetrics(): Record<CoverageMetric, CoverageTriplet> {
  return COVERAGE_METRICS.reduce(
    (acc, m) => ({ ...acc, [m]: NA_TRIPLET }),
    {} as Record<CoverageMetric, CoverageTriplet>,
  );
}

const mockData: CoverageData = {
  sessionId: 'test-session',
  source: { covMergeDir: 'cov_merge', edaTool: 'imc', reportGeneratedAt: 0 },
  root: {
    name: 'tb_top',
    path: 'tb_top',
    depth: 0,
    metrics: naMetrics(),
    children: [],
  },
  targets: {},
};

const mockOverview: CoverageSummary = {
  overall: 82.3,
  line: 80, branch: 80, toggle: 80, condition: 80,
  fsm_state: 80, fsm_transition: 80, functional: 80, assertion: 80,
};

const defaultProps = {
  data: mockData,
  overview: mockOverview,
  targets: {},
  sessions: [],
  trend: [],
};

// ─── Closure 数据构造辅助 ────────────────────────────────────────

type ClosureSessionLike = {
  id: string;
  sessionId: string;
  createdAt: number;
  status: string;
  gaps: Array<{
    id: string;
    gap: { nodePath: string; nodeName: string; metric: string; target: number; actual: number; deficit: number };
    iterations: Array<{
      round: number;
      generatedTests: string[];
      deltaBefore?: CoverageSummary;
      deltaAfter?: CoverageSummary;
      status: string;
    }>;
    status: string;
    escalationReason?: string;
  }>;
  maxRounds: number;
  escalationThreshold: number;
  workspaceDir: string;
};

function makeClosureSession(
  opts: {
    id?: string;
    status?: string;
    gaps?: ClosureSessionLike['gaps'];
  } = {},
): ClosureSessionLike {
  return {
    id: opts.id ?? 'closure_test_001',
    sessionId: 'merge-1',
    createdAt: Date.now(),
    status: opts.status ?? 'running',
    gaps: opts.gaps ?? [],
    maxRounds: 5,
    escalationThreshold: 2,
    workspaceDir: '/tmp/closure-test',
  };
}

function makeGap(
  opts: {
    id?: string;
    nodeName?: string;
    metric?: string;
    status?: string;
    actual?: number;
    target?: number;
    iterations?: ClosureSessionLike['gaps'][number]['iterations'];
    escalationReason?: string;
  } = {},
): ClosureSessionLike['gaps'][number] {
  const actual = opts.actual ?? 80;
  const target = opts.target ?? 95;
  return {
    id: opts.id ?? 'gap_1',
    gap: {
      nodePath: `top/${opts.nodeName ?? 'cpu_core'}`,
      nodeName: opts.nodeName ?? 'cpu_core',
      metric: opts.metric ?? 'line',
      target,
      actual,
      deficit: target - actual,
    },
    iterations: opts.iterations ?? [],
    status: opts.status ?? 'pending',
    escalationReason: opts.escalationReason,
  };
}

function makeIteration(
  round: number,
  beforeOverall: number,
  afterOverall: number,
): ClosureSessionLike['gaps'][number]['iterations'][number] {
  return {
    round,
    generatedTests: [`test_round_${round}.sv`],
    deltaBefore: { ...mockOverview, overall: beforeOverall },
    deltaAfter: { ...mockOverview, overall: afterOverall },
    status: 'completed',
  };
}

// ─── 渲染辅助 ────────────────────────────────────────────────────

function renderDashboard(): ReturnType<typeof render> {
  return render(<CoverageDashboard {...defaultProps} />);
}

/** 设置 store mock 状态并渲染 */
function setupAndRender(
  cov: Partial<CoverageStoreMockState>,
  proj: Partial<ProjectStoreMockState> = {},
): void {
  coverageState = {
    currentClosure: null,
    closureLive: { running: false },
    startClosure: vi.fn(),
    abortClosure: vi.fn(),
    currentSessionId: null,
    ...cov,
  };
  projectState = {
    currentProjectId: null,
    ...proj,
  };
  renderDashboard();
}

// ─── 测试 ────────────────────────────────────────────────────────

describe('AiClosurePanel', () => {
  beforeEach(() => {
    coverageState = {
      currentClosure: null,
      closureLive: { running: false },
      startClosure: vi.fn(),
      abortClosure: vi.fn(),
      currentSessionId: null,
    };
    projectState = { currentProjectId: null };
  });

  describe('空状态（无 Closure 记录）', () => {
    it('显示启动按钮和描述文本', () => {
      setupAndRender({});

      expect(screen.getByText('AI 覆盖收敛分析')).toBeInTheDocument();
      expect(
        screen.getByText('AI 将自动识别覆盖率缺口，生成定向测试并迭代验证，直至达标或触发升级转人工审查。'),
      ).toBeInTheDocument();
      expect(screen.getByText('启动 AI Closure')).toBeInTheDocument();
    });

    it('无项目/Session 时启动按钮 disabled', () => {
      setupAndRender({});

      const btn = screen.getByTestId('closure-start-btn');
      expect(btn).toBeDisabled();
    });

    it('有项目+Session 时启动按钮 enabled，点击调用 startClosure', () => {
      const startClosure = vi.fn().mockResolvedValue(undefined);
      setupAndRender(
        { startClosure, currentSessionId: 'merge-1' },
        { currentProjectId: 'proj-1' },
      );

      const btn = screen.getByTestId('closure-start-btn');
      expect(btn).toBeEnabled();

      fireEvent.click(btn);
      expect(startClosure).toHaveBeenCalledWith('proj-1', 'merge-1');
    });

    it('有 overview 时显示当前总体覆盖率', () => {
      setupAndRender({});

      expect(screen.getByText('当前总体覆盖率 82.3%')).toBeInTheDocument();
    });
  });

  describe('运行中状态', () => {
    it('显示中止按钮和运行中状态徽章', () => {
      const closure = makeClosureSession({
        status: 'running',
        gaps: [makeGap({ status: 'in_progress', iterations: [makeIteration(1, 80, 80.5)] })],
      });
      setupAndRender({
        currentClosure: closure,
        closureLive: { running: true, activeGapId: 'gap_1', activeRound: 1 },
      });

      expect(screen.getByText('运行中')).toBeInTheDocument();
      expect(screen.getByTestId('closure-abort-btn')).toBeInTheDocument();
      // 启动按钮不显示
      expect(screen.queryByTestId('closure-start-btn')).not.toBeInTheDocument();
    });

    it('点击中止按钮调用 abortClosure', () => {
      const abortClosure = vi.fn().mockResolvedValue(undefined);
      const closure = makeClosureSession({
        status: 'running',
        gaps: [makeGap({ status: 'in_progress' })],
      });
      setupAndRender(
        {
          currentClosure: closure,
          closureLive: { running: true },
          abortClosure,
        },
        { currentProjectId: 'proj-1' },
      );

      fireEvent.click(screen.getByTestId('closure-abort-btn'));
      expect(abortClosure).toHaveBeenCalledWith('proj-1', closure.id);
    });

    it('显示实时进度（Gap 迭代中 + Round + AI 阶段）', () => {
      const closure = makeClosureSession({
        status: 'running',
        gaps: [makeGap({ status: 'in_progress' })],
      });
      setupAndRender({
        currentClosure: closure,
        closureLive: {
          running: true,
          activeGapId: 'gap_1',
          activeRound: 2,
          agentPhase: 'prompting',
          lastDeltaOverall: 1.5,
        },
      });

      expect(screen.getByText(/Gap 迭代中/)).toBeInTheDocument();
      expect(screen.getByText(/Round 2/)).toBeInTheDocument();
      expect(screen.getByText(/AI 生成测试中/)).toBeInTheDocument();
      expect(screen.getByText(/最近 Delta:/)).toBeInTheDocument();
      expect(screen.getByText('+1.50%')).toBeInTheDocument();
    });

    it('agent_ended 阶段显示"AI 完成，计算 Delta"', () => {
      const closure = makeClosureSession({
        status: 'running',
        gaps: [makeGap({ status: 'in_progress' })],
      });
      setupAndRender({
        currentClosure: closure,
        closureLive: {
          running: true,
          activeGapId: 'gap_1',
          activeRound: 1,
          agentPhase: 'ended',
        },
      });

      expect(screen.getByText(/AI 完成，计算 Delta/)).toBeInTheDocument();
    });

    it('显示最近错误信息', () => {
      const closure = makeClosureSession({
        status: 'running',
        gaps: [makeGap({ status: 'in_progress' })],
      });
      setupAndRender({
        currentClosure: closure,
        closureLive: {
          running: true,
          activeGapId: 'gap_1',
          activeRound: 1,
          lastError: 'Agent timed out',
        },
      });

      expect(screen.getByText('Agent timed out')).toBeInTheDocument();
    });
  });

  describe('Gap 队列渲染', () => {
    it('显示 Gap 数量、已关闭、升级、失败统计', () => {
      const closure = makeClosureSession({
        status: 'running',
        gaps: [
          makeGap({ id: 'g1', status: 'closed', nodeName: 'cpu_core' }),
          makeGap({ id: 'g2', status: 'escalated', nodeName: 'memory_ctrl', metric: 'toggle' }),
          makeGap({ id: 'g3', status: 'failed', nodeName: 'dma_engine', metric: 'branch' }),
          makeGap({ id: 'g4', status: 'in_progress', nodeName: 'uart_top', metric: 'condition' }),
        ],
      });
      setupAndRender({
        currentClosure: closure,
        closureLive: { running: true, activeGapId: 'g4', activeRound: 1 },
      });

      // 统计行：Gap 队列（4）· 已关闭 1 · 升级 1 · 失败 1
      expect(screen.getByText(/Gap 队列（4）/)).toBeInTheDocument();
      expect(screen.getByText(/已关闭 1/)).toBeInTheDocument();
      expect(screen.getByText(/升级 1/)).toBeInTheDocument();
      expect(screen.getByText(/失败 1/)).toBeInTheDocument();
    });

    it('渲染每个 Gap 的模块名和指标', () => {
      const closure = makeClosureSession({
        status: 'running',
        gaps: [
          makeGap({ id: 'g1', status: 'closed', nodeName: 'cpu_core', metric: 'line' }),
          makeGap({ id: 'g2', status: 'in_progress', nodeName: 'memory_ctrl', metric: 'toggle' }),
        ],
      });
      setupAndRender({
        currentClosure: closure,
        closureLive: { running: true, activeGapId: 'g2', activeRound: 1 },
      });

      expect(screen.getByText('cpu_core')).toBeInTheDocument();
      expect(screen.getByText('memory_ctrl')).toBeInTheDocument();
    });

    it('Gap 显示状态标签', () => {
      const closure = makeClosureSession({
        status: 'running',
        gaps: [
          makeGap({ id: 'g1', status: 'closed', nodeName: 'cpu_core' }),
          makeGap({ id: 'g2', status: 'escalated', nodeName: 'mem_ctrl' }),
          makeGap({ id: 'g3', status: 'failed', nodeName: 'dma' }),
          makeGap({ id: 'g4', status: 'in_progress', nodeName: 'uart' }),
        ],
      });
      setupAndRender({
        currentClosure: closure,
        closureLive: { running: true, activeGapId: 'g4', activeRound: 1 },
      });

      // 状态文本（GAP_STATUS_LABEL）
      expect(screen.getAllByText('已关闭').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('已升级').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('失败').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('进行中').length).toBeGreaterThanOrEqual(1);
    });

    it('Gap 显示迭代轮次和 delta', () => {
      const closure = makeClosureSession({
        status: 'running',
        gaps: [
          makeGap({
            id: 'g1',
            status: 'in_progress',
            nodeName: 'cpu_core',
            iterations: [makeIteration(1, 80.0, 81.5)],
          }),
        ],
      });
      setupAndRender({
        currentClosure: closure,
        closureLive: { running: true, activeGapId: 'g1', activeRound: 1 },
      });

      // R1 (+1.5%)
      expect(screen.getByText(/R1/)).toBeInTheDocument();
      expect(screen.getByText(/\+1.5%/)).toBeInTheDocument();
    });
  });

  describe('已完成状态', () => {
    it('显示重启按钮和结果摘要', () => {
      const closure = makeClosureSession({
        status: 'completed',
        gaps: [
          makeGap({
            id: 'g1',
            status: 'closed',
            nodeName: 'cpu_core',
            iterations: [makeIteration(1, 80.0, 82.5)],
          }),
        ],
      });
      setupAndRender(
        {
          currentClosure: closure,
          closureLive: { running: false },
        },
        { currentProjectId: 'proj-1' },
      );

      // 重启按钮
      expect(screen.getByTestId('closure-restart-btn')).toBeInTheDocument();
      expect(screen.getByText('重新启动')).toBeInTheDocument();

      // 摘要
      expect(screen.getByText('Closure 结果摘要')).toBeInTheDocument();
      // totalDeltaOverall = 82.5 - 80.0 = 2.5（摘要行包含"总 Delta:"前缀）
      expect(screen.getByText(/总 Delta:/)).toBeInTheDocument();
      expect(screen.getAllByText(/\+2.5%/).length).toBeGreaterThanOrEqual(1);
    });

    it('点击重启按钮调用 startClosure', () => {
      const startClosure = vi.fn().mockResolvedValue(undefined);
      const closure = makeClosureSession({
        status: 'completed',
        gaps: [makeGap({ id: 'g1', status: 'closed' })],
      });
      setupAndRender(
        {
          currentClosure: closure,
          closureLive: { running: false },
          startClosure,
          currentSessionId: 'merge-1',
        },
        { currentProjectId: 'proj-1' },
      );

      fireEvent.click(screen.getByTestId('closure-restart-btn'));
      expect(startClosure).toHaveBeenCalledWith('proj-1', 'merge-1');
    });
  });

  describe('已中止状态', () => {
    it('显示中止提示和重启按钮', () => {
      const closure = makeClosureSession({
        status: 'aborted',
        gaps: [makeGap({ id: 'g1', status: 'failed', nodeName: 'cpu_core' })],
      });
      setupAndRender(
        {
          currentClosure: closure,
          closureLive: { running: false },
        },
        { currentProjectId: 'proj-1' },
      );

      // 状态徽章显示"已中止"
      expect(screen.getByText('已中止')).toBeInTheDocument();
      // 中止提示
      expect(screen.getByText('闭环已被用户中止')).toBeInTheDocument();
      // 重启按钮
      expect(screen.getByTestId('closure-restart-btn')).toBeInTheDocument();
    });
  });

  describe('升级 Gap 摘要', () => {
    it('已完成且有升级 Gap 时显示升级提示', () => {
      const closure = makeClosureSession({
        status: 'completed',
        gaps: [
          makeGap({ id: 'g1', status: 'closed', nodeName: 'cpu_core' }),
          makeGap({
            id: 'g2',
            status: 'escalated',
            nodeName: 'mem_ctrl',
            metric: 'toggle',
            escalationReason: '连续 2 轮 overall delta < 1%',
          }),
        ],
      });
      setupAndRender({
        currentClosure: closure,
        closureLive: { running: false },
      });

      // 升级提示
      expect(
        screen.getByText(/1 个 Gap 已升级至人工审查/),
      ).toBeInTheDocument();
    });
  });
});
