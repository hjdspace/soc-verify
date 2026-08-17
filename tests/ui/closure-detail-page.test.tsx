// @vitest-environment jsdom
/**
 * Closure 详情页 UI 缝测试（Issue 06 / PRD US-22~28）。
 *
 * ClosureDetailPage 是覆盖率两视图（树表格/仪表盘）启动 AI 收敛后的详情入口。
 * 通过 mock useCoverageStore / useProjectStore + 占位子面板（隔离 trpc 依赖）验证：
 *   - 头部：返回按钮 / Closure 选择器 / 状态徽章 / 整体中止
 *   - 实时进度：closureLive 事件流（Round / agentPhase / 最近 Delta / 升级原因 / 错误）
 *   - Target 卡片：状态 / 单 target 中止 / escalationReason / 展开迭代历史
 *   - 迭代历史：生成测试文件列表 + 逐 metric Delta + 豁免前后双数字
 *   - ExclusionApprovalPanel / TestPromotionPanel 的集成时机
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClosureDetailPage } from '@renderer/components/coverage/ClosureDetailPage';

// ─── 子面板 mock（隔离 trpc/store 深层依赖，仅验证集成时机） ──────

vi.mock('@renderer/components/coverage/ExclusionApprovalPanel', () => ({
  ExclusionApprovalPanel: ({ closureId }: { closureId: string }) => (
    <div data-testid="exclusion-approval-panel" data-closure-id={closureId}>
      ExclusionApprovalPanel
    </div>
  ),
}));

vi.mock('@renderer/components/coverage/TestPromotionPanel', () => ({
  TestPromotionPanel: ({ closureId }: { closureId: string }) => (
    <div data-testid="test-promotion-panel" data-closure-id={closureId}>
      TestPromotionPanel
    </div>
  ),
}));

// ─── Store mock 状态 ─────────────────────────────────────────────

interface GapLike {
  nodePath: string;
  nodeName: string;
  metric: string;
  target: number;
  actual: number;
  deficit: number;
}

type IterationLike = {
  round: number;
  generatedTests: string[];
  deltaBefore?: { overall: number };
  deltaAfter?: { overall: number };
  deltas?: Array<{ metric: string; before: number; after: number; delta: number }>;
  beforeExclusionMetrics?: Record<string, { percentage: number | null }>;
  afterExclusionMetrics?: Record<string, { percentage: number | null }>;
  status: string;
  error?: string;
};

type TargetLike = {
  id: string;
  module: { path: string; name: string };
  gaps: GapLike[];
  iterations: IterationLike[];
  status: string;
  escalationReason?: string;
};

type ClosureLike = {
  id: string;
  sessionId: string;
  createdAt: number;
  status: string;
  targets: TargetLike[];
  maxRounds: number;
  escalationThreshold: number;
  workspaceDir: string;
};

interface CoverageStoreMockState {
  closures: ClosureLike[];
  currentClosureId: string | null;
  currentClosure: ClosureLike | null;
  closureLive: {
    running: boolean;
    activeTargetId?: string;
    activeRound?: number;
    agentPhase?: string;
    lastDeltaOverall?: number;
    lastEscalation?: { targetId: string; reason: string };
    lastError?: string;
  };
  setView: ReturnType<typeof vi.fn>;
  loadClosures: ReturnType<typeof vi.fn>;
  loadClosure: ReturnType<typeof vi.fn>;
  abortClosure: ReturnType<typeof vi.fn>;
  abortClosureTarget: ReturnType<typeof vi.fn>;
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

// ─── Mock 数据构造 ───────────────────────────────────────────────

function makeGap(metric: string, nodeName = 'cpu_core'): GapLike {
  return {
    nodePath: `top/${nodeName}`,
    nodeName,
    metric,
    target: 95,
    actual: 80,
    deficit: 15,
  };
}

function makeTarget(opts: {
  id?: string;
  nodeName?: string;
  metrics?: string[];
  status?: string;
  iterations?: IterationLike[];
  escalationReason?: string;
} = {}): TargetLike {
  const nodeName = opts.nodeName ?? 'cpu_core';
  return {
    id: opts.id ?? 'target_1',
    module: { path: `top/${nodeName}`, name: nodeName },
    gaps: (opts.metrics ?? ['line']).map((m) => makeGap(m, nodeName)),
    iterations: opts.iterations ?? [],
    status: opts.status ?? 'pending',
    escalationReason: opts.escalationReason,
  };
}

function makeClosure(opts: {
  id?: string;
  status?: string;
  targets?: TargetLike[];
} = {}): ClosureLike {
  return {
    id: opts.id ?? 'closure_test_001',
    sessionId: 'merge-1',
    createdAt: Date.now(),
    status: opts.status ?? 'running',
    targets: opts.targets ?? [],
    maxRounds: 5,
    escalationThreshold: 2,
    workspaceDir: '/tmp/closure-test',
  };
}

/** 设置 store mock 状态并渲染 */
function setupAndRender(
  cov: Partial<CoverageStoreMockState> = {},
  proj: Partial<ProjectStoreMockState> = {},
): void {
  coverageState = {
    closures: [],
    currentClosureId: null,
    currentClosure: null,
    closureLive: { running: false },
    setView: vi.fn(),
    loadClosures: vi.fn().mockResolvedValue(undefined),
    loadClosure: vi.fn().mockResolvedValue(undefined),
    abortClosure: vi.fn().mockResolvedValue(undefined),
    abortClosureTarget: vi.fn().mockResolvedValue(undefined),
    ...cov,
  };
  projectState = { currentProjectId: null, ...proj };
  render(<ClosureDetailPage />);
}

// ─── 测试 ────────────────────────────────────────────────────────

describe('ClosureDetailPage', () => {
  beforeEach(() => {
    coverageState = {
      closures: [],
      currentClosureId: null,
      currentClosure: null,
      closureLive: { running: false },
      setView: vi.fn(),
      loadClosures: vi.fn().mockResolvedValue(undefined),
      loadClosure: vi.fn().mockResolvedValue(undefined),
      abortClosure: vi.fn().mockResolvedValue(undefined),
      abortClosureTarget: vi.fn().mockResolvedValue(undefined),
    };
    projectState = { currentProjectId: null };
  });

  describe('空状态', () => {
    it('无 Closure 记录时显示空状态提示与返回按钮', () => {
      setupAndRender();

      expect(screen.getByText('暂无 AI 收敛闭环记录')).toBeInTheDocument();
      expect(screen.getByTestId('closure-detail-back')).toBeInTheDocument();
    });

    it('点击返回按钮调用 setView("tree-table")', () => {
      setupAndRender();

      fireEvent.click(screen.getByTestId('closure-detail-back'));
      expect(coverageState.setView).toHaveBeenCalledWith('tree-table');
    });

    it('currentClosureId 存在但数据未加载时调用 loadClosure 拉取', () => {
      setupAndRender(
        { currentClosureId: 'closure_test_001', currentClosure: null },
        { currentProjectId: 'proj-1' },
      );

      expect(coverageState.loadClosure).toHaveBeenCalledWith('proj-1', 'closure_test_001');
    });
  });

  describe('头部', () => {
    it('显示 Closure 状态徽章与选择器（多条历史记录时）', () => {
      const c1 = makeClosure({ id: 'closure_1', status: 'completed' });
      const c2 = makeClosure({ id: 'closure_2', status: 'running' });
      setupAndRender({
        closures: [c1, c2],
        currentClosureId: 'closure_2',
        currentClosure: c2,
        closureLive: { running: true },
      });

      expect(screen.getByTestId('closure-detail-status')).toHaveTextContent('运行中');
      const selector = screen.getByTestId('closure-detail-selector') as HTMLSelectElement;
      expect(selector.value).toBe('closure_2');
      expect(selector.options).toHaveLength(2);
    });

    it('切换 Closure 选择器调用 loadClosure', () => {
      const c1 = makeClosure({ id: 'closure_1', status: 'completed' });
      const c2 = makeClosure({ id: 'closure_2', status: 'completed' });
      setupAndRender(
        {
          closures: [c1, c2],
          currentClosureId: 'closure_1',
          currentClosure: c1,
        },
        { currentProjectId: 'proj-1' },
      );

      fireEvent.change(screen.getByTestId('closure-detail-selector'), {
        target: { value: 'closure_2' },
      });
      expect(coverageState.loadClosure).toHaveBeenCalledWith('proj-1', 'closure_2');
    });

    it('运行中显示"中止整个闭环"按钮，点击调用 abortClosure', () => {
      const closure = makeClosure({
        status: 'running',
        targets: [makeTarget({ status: 'in_progress' })],
      });
      setupAndRender(
        {
          currentClosureId: closure.id,
          currentClosure: closure,
          closureLive: { running: true },
        },
        { currentProjectId: 'proj-1' },
      );

      fireEvent.click(screen.getByTestId('closure-detail-abort'));
      expect(coverageState.abortClosure).toHaveBeenCalledWith('proj-1', closure.id);
    });

    it('非运行状态不显示整体中止按钮', () => {
      const closure = makeClosure({
        status: 'completed',
        targets: [makeTarget({ status: 'closed' })],
      });
      setupAndRender({
        currentClosureId: closure.id,
        currentClosure: closure,
        closureLive: { running: false },
      });

      expect(screen.queryByTestId('closure-detail-abort')).not.toBeInTheDocument();
    });
  });

  describe('实时进度（US-23）', () => {
    it('运行中显示 Target 迭代 Round / agentPhase / 最近 Delta', () => {
      const closure = makeClosure({
        status: 'running',
        targets: [makeTarget({ id: 't1', status: 'in_progress' })],
      });
      setupAndRender({
        currentClosureId: closure.id,
        currentClosure: closure,
        closureLive: {
          running: true,
          activeTargetId: 't1',
          activeRound: 2,
          agentPhase: 'prompting',
          lastDeltaOverall: 1.5,
        },
      });

      expect(screen.getByTestId('closure-live-progress')).toBeInTheDocument();
      expect(screen.getByText(/Target 迭代中/)).toBeInTheDocument();
      expect(screen.getByText(/Round 2/)).toBeInTheDocument();
      // "AI 生成测试中" 同时出现在实时进度条与活跃 Target 卡片
      expect(screen.getAllByText(/AI 生成测试中/).length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('+1.50%')).toBeInTheDocument();
    });

    it('显示最近升级原因与错误信息', () => {
      const closure = makeClosure({
        status: 'running',
        targets: [makeTarget({ id: 't1', status: 'in_progress' })],
      });
      setupAndRender({
        currentClosureId: closure.id,
        currentClosure: closure,
        closureLive: {
          running: true,
          activeTargetId: 't1',
          activeRound: 3,
          lastEscalation: { targetId: 't1', reason: '连续 2 轮 delta < 1%' },
          lastError: 'Agent timed out',
        },
      });

      expect(screen.getByTestId('closure-live-escalation')).toHaveTextContent(
        '连续 2 轮 delta < 1%',
      );
      expect(screen.getByTestId('closure-live-error')).toHaveTextContent('Agent timed out');
    });
  });

  describe('Target 卡片', () => {
    it('渲染模块名 / metric 标签 / 状态徽章', () => {
      const closure = makeClosure({
        status: 'running',
        targets: [
          makeTarget({
            id: 't1',
            nodeName: 'memory_ctrl',
            metrics: ['toggle', 'branch'],
            status: 'in_progress',
          }),
        ],
      });
      setupAndRender({
        currentClosureId: closure.id,
        currentClosure: closure,
        closureLive: { running: true, activeTargetId: 't1', activeRound: 1 },
      });

      expect(screen.getByText('memory_ctrl')).toBeInTheDocument();
      // METRIC_LABELS 拼接（Toggle, Branch）
      expect(screen.getByText('Toggle, Branch')).toBeInTheDocument();
      expect(screen.getByText('进行中')).toBeInTheDocument();
    });

    it('非终态 Target 显示单 target 中止按钮，点击调用 abortClosureTarget', () => {
      const closure = makeClosure({
        status: 'running',
        targets: [
          makeTarget({ id: 't1', status: 'in_progress' }),
          makeTarget({ id: 't2', nodeName: 'memory_ctrl', metrics: ['toggle'], status: 'closed' }),
        ],
      });
      setupAndRender(
        {
          currentClosureId: closure.id,
          currentClosure: closure,
          closureLive: { running: true, activeTargetId: 't1', activeRound: 1 },
        },
        { currentProjectId: 'proj-1' },
      );

      // t1（进行中）有中止按钮
      fireEvent.click(screen.getByTestId('closure-target-abort-t1'));
      expect(coverageState.abortClosureTarget).toHaveBeenCalledWith(
        'proj-1',
        closure.id,
        't1',
      );

      // t2（已达标，终态）无中止按钮
      expect(screen.queryByTestId('closure-target-abort-t2')).not.toBeInTheDocument();
    });

    it('升级 Target 显示 escalationReason（US-28）', () => {
      const closure = makeClosure({
        status: 'completed',
        targets: [
          makeTarget({
            id: 't1',
            status: 'escalated',
            escalationReason: '连续 2 轮 overall delta < 1%',
          }),
        ],
      });
      setupAndRender({
        currentClosureId: closure.id,
        currentClosure: closure,
        closureLive: { running: false },
      });

      expect(screen.getByTestId('closure-target-escalation-t1')).toHaveTextContent(
        '连续 2 轮 overall delta < 1%',
      );
    });

    it('头部行显示最近一轮 Round 与 overall delta', () => {
      const closure = makeClosure({
        status: 'running',
        targets: [
          makeTarget({
            id: 't1',
            status: 'in_progress',
            iterations: [
              {
                round: 1,
                generatedTests: ['test_r1.sv'],
                deltaBefore: { overall: 80.0 },
                deltaAfter: { overall: 81.5 },
                status: 'completed',
              },
            ],
          }),
        ],
      });
      setupAndRender({
        currentClosureId: closure.id,
        currentClosure: closure,
        closureLive: { running: true, activeTargetId: 't1', activeRound: 1 },
      });

      // "Round 1" 同时出现在实时进度条与 Target 卡片头部
      expect(screen.getAllByText(/Round 1/).length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText(/\+1.5%/).length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('迭代历史（展开）', () => {
    /** 带完整迭代数据（测试列表 + delta + 豁免前后双数字）的 target */
    function makeIteratedTarget(): TargetLike {
      return makeTarget({
        id: 't1',
        status: 'in_progress',
        iterations: [
          {
            round: 1,
            generatedTests: ['test_cpu_line_r1.sv', 'test_cpu_branch_r1.sv'],
            deltaBefore: { overall: 80.0 },
            deltaAfter: { overall: 82.0 },
            deltas: [{ metric: 'line', before: 80.0, after: 82.0, delta: 2.0 }],
            beforeExclusionMetrics: { line: { percentage: 82.0 } },
            afterExclusionMetrics: { line: { percentage: 84.5 } },
            status: 'completed',
          },
        ],
      });
    }

    it('点击展开显示生成测试文件列表与逐 metric Delta 表', () => {
      const closure = makeClosure({
        status: 'running',
        targets: [makeIteratedTarget()],
      });
      setupAndRender({
        currentClosureId: closure.id,
        currentClosure: closure,
        closureLive: { running: true, activeTargetId: 't1', activeRound: 1 },
      });

      // 展开前不显示迭代卡片
      expect(screen.queryByTestId('closure-iteration-t1-1')).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId('closure-target-expand-t1'));

      // 迭代卡片 + 测试文件列表（US-25）
      expect(screen.getByTestId('closure-iteration-t1-1')).toBeInTheDocument();
      expect(screen.getByText('test_cpu_line_r1.sv')).toBeInTheDocument();
      expect(screen.getByText('test_cpu_branch_r1.sv')).toBeInTheDocument();
      expect(screen.getByText(/生成测试（2）/)).toBeInTheDocument();

      // 逐 metric Delta 表（US-24）
      const deltaTable = screen.getByTestId('closure-iteration-delta-t1-1');
      expect(deltaTable).toBeInTheDocument();
      expect(deltaTable).toHaveTextContent('Line');
      expect(deltaTable).toHaveTextContent('80.0%');
      expect(deltaTable).toHaveTextContent('82.0%');
      expect(deltaTable).toHaveTextContent('+2.0');
    });

    it('应用豁免后展示豁免前后双数字（ADR 0026 决策 4 / US-32）', () => {
      const closure = makeClosure({
        status: 'running',
        targets: [makeIteratedTarget()],
      });
      setupAndRender({
        currentClosureId: closure.id,
        currentClosure: closure,
        closureLive: { running: true, activeTargetId: 't1', activeRound: 1 },
      });

      fireEvent.click(screen.getByTestId('closure-target-expand-t1'));

      const deltaTable = screen.getByTestId('closure-iteration-delta-t1-1');
      // 豁免影响列：82.0% → 84.5%
      expect(deltaTable).toHaveTextContent('豁免影响');
      expect(deltaTable).toHaveTextContent('82.0% → 84.5%');
    });

    it('多轮迭代按最新在前展示', () => {
      const closure = makeClosure({
        status: 'running',
        targets: [
          makeTarget({
            id: 't1',
            status: 'in_progress',
            iterations: [
              {
                round: 1,
                generatedTests: ['a_r1.sv'],
                deltaBefore: { overall: 80 },
                deltaAfter: { overall: 80.5 },
                status: 'completed',
              },
              {
                round: 2,
                generatedTests: ['a_r2.sv'],
                deltaBefore: { overall: 80.5 },
                deltaAfter: { overall: 81 },
                status: 'completed',
              },
            ],
          }),
        ],
      });
      setupAndRender({
        currentClosureId: closure.id,
        currentClosure: closure,
        closureLive: { running: true, activeTargetId: 't1', activeRound: 2 },
      });

      fireEvent.click(screen.getByTestId('closure-target-expand-t1'));

      expect(screen.getByTestId('closure-iteration-t1-1')).toBeInTheDocument();
      expect(screen.getByTestId('closure-iteration-t1-2')).toBeInTheDocument();
    });
  });

  describe('子面板集成', () => {
    it('有项目时渲染 ExclusionApprovalPanel（工单 07）', () => {
      const closure = makeClosure({
        status: 'running',
        targets: [makeTarget({ status: 'in_progress' })],
      });
      setupAndRender(
        {
          currentClosureId: closure.id,
          currentClosure: closure,
          closureLive: { running: true },
        },
        { currentProjectId: 'proj-1' },
      );

      const panel = screen.getByTestId('exclusion-approval-panel');
      expect(panel).toBeInTheDocument();
      expect(panel).toHaveAttribute('data-closure-id', closure.id);
    });

    it('运行中不渲染 TestPromotionPanel，终态后渲染（US-27）', () => {
      const running = makeClosure({
        status: 'running',
        targets: [makeTarget({ status: 'in_progress' })],
      });
      const rerender = (): void => {
        render(<ClosureDetailPage />);
      };

      coverageState = {
        closures: [],
        currentClosureId: running.id,
        currentClosure: running,
        closureLive: { running: true },
        setView: vi.fn(),
        loadClosures: vi.fn().mockResolvedValue(undefined),
        loadClosure: vi.fn().mockResolvedValue(undefined),
        abortClosure: vi.fn().mockResolvedValue(undefined),
        abortClosureTarget: vi.fn().mockResolvedValue(undefined),
      };
      projectState = { currentProjectId: 'proj-1' };
      rerender();
      expect(screen.queryByTestId('test-promotion-panel')).not.toBeInTheDocument();
    });

    it('终态（completed）渲染 TestPromotionPanel', () => {
      const closure = makeClosure({
        status: 'completed',
        targets: [makeTarget({ status: 'closed' })],
      });
      setupAndRender(
        {
          currentClosureId: closure.id,
          currentClosure: closure,
          closureLive: { running: false },
        },
        { currentProjectId: 'proj-1' },
      );

      const panel = screen.getByTestId('test-promotion-panel');
      expect(panel).toBeInTheDocument();
      expect(panel).toHaveAttribute('data-closure-id', closure.id);
    });
  });
});
