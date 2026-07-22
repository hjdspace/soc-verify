/**
 * ClosureOrchestrator 测试（ADR 0009 / GitHub Issue #8 Slice 6b）。
 *
 * 覆盖：
 * - 5 轮循环逻辑（每轮 startIteration → prompt → agent_end → completeIteration）
 * - 升级判定（连续 2 轮 delta < 1% → escalated）
 * - Delta Validation Phase 1（deltaOverall >= 1% → gap 关闭）
 * - 中止逻辑（AbortController 触发 → waitForAgentEnd 拒绝 → closure:aborted）
 * - 多 Gap 并行（Promise.allSettled 并发调度）
 * - 单 Gap 失败不影响其他 Gap（createSession 失败 → gap_failed，其他 gap 正常关闭）
 *
 * 使用 mock SessionManager/CoverageManager，不真实创建 omp 会话。
 * ClosureManager 使用内存版 mock（与真实 ClosureManager 行为一致），
 * 避免多 Gap 并行时的文件 I/O read-modify-write 竞态。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { ClosureOrchestrator, type ClosureEvent } from '../../src/main/coverage/closure-orchestrator';
import type {
  ClosureSession,
  ClosureGap,
  GapIteration,
  ClosureGapStatus,
} from '../../src/main/coverage/closure-manager';
import type { ClosureManager } from '../../src/main/coverage/closure-manager';
import type { SessionManagerImpl } from '../../src/main/agent/session-manager';
import type { CoverageManager } from '../../src/main/coverage/coverage-manager';
import type {
  PluginBackedDiscovery,
  PluginBackedSimulation,
  PluginBackedCoverage,
} from '../../src/main/host/plugin-discovery';
import type {
  CoverageGap,
  CoverageSummary,
  CoverageDelta,
  CoverageMetric,
} from '@shared/types';

// ─── Mock 数据辅助 ──────────────────────────────────────────────

/** 构造一个 CoverageGap */
function makeGap(
  nodePath: string,
  metric: CoverageMetric,
  actual: number,
  target: number,
): CoverageGap {
  return {
    nodePath,
    nodeName: nodePath.split('/').pop() ?? nodePath,
    metric,
    target,
    actual,
    deficit: target - actual,
  };
}

/** 构造一个 CoverageSummary，所有 metric 统一为 overall 值 */
function makeSummary(overall: number): CoverageSummary {
  return {
    overall,
    line: overall,
    branch: overall,
    toggle: overall,
    condition: overall,
    fsm_state: overall,
    fsm_transition: overall,
    functional: overall,
    assertion: overall,
  };
}

/** 构造 CoverageDelta[]（8 个 metric，delta 统一） */
function makeDeltas(delta: number): CoverageDelta[] {
  const metrics: CoverageMetric[] = [
    'line', 'branch', 'toggle', 'condition',
    'fsm_state', 'fsm_transition', 'functional', 'assertion',
  ];
  return metrics.map((m) => ({ metric: m, before: 0, after: delta, delta }));
}

const SAMPLE_GAPS: CoverageGap[] = [
  makeGap('top/cpu_core', 'line', 80, 95),
];

const MULTI_GAPS: CoverageGap[] = [
  makeGap('top/cpu_core', 'line', 80, 95),
  makeGap('top/memory_ctrl', 'toggle', 75, 85),
];

// ─── Mock SessionManager ────────────────────────────────────────

/**
 * 创建 mock SessionManager。
 * - autoEmit=true 时，createSession 后自动在 delay ms 后发出 agent_end 事件
 * - autoEmit=false 时，不发出 agent_end（用于中止测试）
 */
function createMockSessionManager(
  autoEmit = true,
  delay = 50,
): SessionManagerImpl {
  const mgr = Object.assign(new EventEmitter(), {
    createSession: vi.fn(),
    getClient: vi.fn(),
    destroySession: vi.fn(),
  }) as unknown as SessionManagerImpl;

  let counter = 0;
  (mgr as unknown as { createSession: ReturnType<typeof vi.fn> }).createSession =
    vi.fn(async () => {
      const sid = `agent-session-${++counter}`;
      if (autoEmit) {
        setTimeout(() => {
          mgr.emit('sessionEvent', { sessionId: sid, event: { type: 'agent_end' } });
        }, delay);
      }
      return sid;
    });

  (mgr as unknown as { getClient: ReturnType<typeof vi.fn> }).getClient = vi.fn(
    () => ({ prompt: vi.fn().mockResolvedValue(undefined) }),
  );

  (mgr as unknown as { destroySession: ReturnType<typeof vi.fn> }).destroySession =
    vi.fn().mockResolvedValue(undefined);

  return mgr;
}

/** 创建 mock CoverageManager */
function createMockCoverageManager(): CoverageManager {
  return {
    getOverview: vi.fn().mockResolvedValue({
      summary: makeSummary(80),
      sessionId: 'merge-1',
    }),
  } as unknown as CoverageManager;
}

// ─── 内存版 ClosureManager（线程安全，避免并行 Gap 时的文件 I/O 竞态） ──

const ESCALATION_DELTA_THRESHOLD = 1;
const DEFAULT_ESCALATION_THRESHOLD = 2;
const DEFAULT_MAX_ROUNDS = 5;

/**
 * 创建内存版 ClosureManager mock。
 * 与真实 ClosureManager 行为一致，但状态全部保存在内存中，
 * 避免多 Gap 并行时的 read-modify-write 文件竞态。
 */
function createInMemoryClosureManager(): ClosureManager {
  const sessions = new Map<string, ClosureSession>();
  let closureCounter = 0;
  let gapCounter = 0;

  function shouldEscalate(gap: ClosureGap): boolean {
    const completed = gap.iterations.filter(
      (it) => it.status === 'completed' && it.deltaBefore !== undefined && it.deltaAfter !== undefined,
    );
    if (completed.length < DEFAULT_ESCALATION_THRESHOLD) return false;
    const recent = completed.slice(-DEFAULT_ESCALATION_THRESHOLD);
    return recent.every((it) => {
      const delta = it.deltaAfter!.overall - it.deltaBefore!.overall;
      return delta < ESCALATION_DELTA_THRESHOLD;
    });
  }

  function maybeCompleteClosure(session: ClosureSession): void {
    const allTerminal = session.gaps.every((g) =>
      ['closed', 'escalated', 'failed'].includes(g.status));
    if (allTerminal && session.status === 'running') {
      session.status = 'completed';
    }
  }

  const mgr = {
    startClosure: async (input: {
      sessionId: string;
      gaps?: CoverageGap[];
      maxRounds?: number;
    }): Promise<ClosureSession> => {
      const closureId = `closure_test_${++closureCounter}`;
      const gaps = input.gaps ?? [];
      const session: ClosureSession = {
        id: closureId,
        sessionId: input.sessionId,
        createdAt: Date.now(),
        status: 'running',
        gaps: gaps.map((g) => ({
          id: `gap_${++gapCounter}`,
          gap: g,
          iterations: [],
          status: 'pending' as ClosureGapStatus,
        })),
        maxRounds: input.maxRounds ?? DEFAULT_MAX_ROUNDS,
        escalationThreshold: DEFAULT_ESCALATION_THRESHOLD,
        workspaceDir: `/tmp/closure-test-${closureId}`,
      };
      sessions.set(closureId, session);
      return session;
    },
    getClosure: async (closureId: string): Promise<ClosureSession | null> => {
      return sessions.get(closureId) ?? null;
    },
    listClosures: async (): Promise<ClosureSession[]> => {
      return Array.from(sessions.values());
    },
    startIteration: async (closureId: string, gapId: string): Promise<GapIteration> => {
      const session = sessions.get(closureId);
      if (!session) throw new Error(`Closure ${closureId} not found`);
      if (session.status !== 'running') throw new Error(`Closure ${closureId} is ${session.status}`);
      const gap = session.gaps.find((g) => g.id === gapId);
      if (!gap) throw new Error(`Gap ${gapId} not found in closure ${closureId}`);
      const round = gap.iterations.length + 1;
      const iteration: GapIteration = { round, generatedTests: [], status: 'running' };
      gap.iterations.push(iteration);
      if (gap.status === 'pending') gap.status = 'in_progress';
      return iteration;
    },
    completeIteration: async (
      closureId: string,
      gapId: string,
      result: {
        generatedTests: string[];
        deltaBefore: CoverageSummary;
        deltaAfter: CoverageSummary;
        deltas: CoverageDelta[];
      },
    ): Promise<GapIteration> => {
      const session = sessions.get(closureId);
      if (!session) throw new Error(`Closure ${closureId} not found`);
      const gap = session.gaps.find((g) => g.id === gapId);
      if (!gap) throw new Error(`Gap ${gapId} not found`);
      const iteration = gap.iterations[gap.iterations.length - 1];
      if (!iteration) throw new Error(`No active iteration in gap ${gapId}`);
      iteration.generatedTests = result.generatedTests;
      iteration.deltaBefore = result.deltaBefore;
      iteration.deltaAfter = result.deltaAfter;
      iteration.deltas = result.deltas;
      iteration.status = 'completed';
      // 使用 mgr.shouldEscalate 而非独立函数，以便 vi.spyOn 可以拦截
      if (mgr.shouldEscalate(gap)) {
        gap.status = 'escalated';
        gap.escalationReason =
          `连续 ${session.escalationThreshold} 轮 overall delta < ${ESCALATION_DELTA_THRESHOLD}%`;
      }
      maybeCompleteClosure(session);
      return iteration;
    },
    failIteration: async (closureId: string, gapId: string, error: string): Promise<void> => {
      const session = sessions.get(closureId);
      if (!session) return;
      const gap = session.gaps.find((g) => g.id === gapId);
      if (!gap) return;
      const iteration = gap.iterations[gap.iterations.length - 1];
      if (iteration) {
        iteration.status = 'failed';
        iteration.error = error;
      }
    },
    failGap: async (closureId: string, gapId: string, reason: string): Promise<void> => {
      const session = sessions.get(closureId);
      if (!session) return;
      const gap = session.gaps.find((g) => g.id === gapId);
      if (!gap) return;
      gap.status = 'failed';
      gap.escalationReason = reason;
      maybeCompleteClosure(session);
    },
    shouldEscalate,
    closeGap: async (closureId: string, gapId: string): Promise<void> => {
      const session = sessions.get(closureId);
      if (!session) return;
      const gap = session.gaps.find((g) => g.id === gapId);
      if (!gap) return;
      gap.status = 'closed';
      maybeCompleteClosure(session);
    },
    escalateGap: async (closureId: string, gapId: string, reason: string): Promise<void> => {
      const session = sessions.get(closureId);
      if (!session) return;
      const gap = session.gaps.find((g) => g.id === gapId);
      if (!gap) return;
      gap.status = 'escalated';
      gap.escalationReason = reason;
      maybeCompleteClosure(session);
    },
    abortClosure: async (closureId: string): Promise<void> => {
      const session = sessions.get(closureId);
      if (!session) return;
      for (const gap of session.gaps) {
        if (gap.status === 'pending' || gap.status === 'in_progress') {
          gap.status = 'failed';
        }
      }
      session.status = 'aborted';
    },
    getWorkspaceDir: (closureId: string): string => {
      return `/tmp/closure-test-${closureId}`;
    },
  };

  return mgr as unknown as ClosureManager;
}

// ─── 测试环境搭建 ────────────────────────────────────────────────

interface SetupResult {
  orchestrator: ClosureOrchestrator;
  closureManager: ClosureManager;
  sessionManager: SessionManagerImpl;
  coverageManager: CoverageManager;
  events: ClosureEvent[];
  donePromise: Promise<void>;
  /** No-op（内存版 ClosureManager 无需清理文件） */
  cleanup: () => void;
}

/**
 * 搭建测试环境：mock SessionManager + mock CoverageManager + 内存版 ClosureManager。
 * emit 回调捕获所有事件，donePromise 在终态事件（completed/aborted/error）时 resolve。
 */
function setupOrchestrator(
  _gaps: CoverageGap[],
  opts: {
    maxRounds?: number;
    autoEmit?: boolean;
    emitDelay?: number;
  } = {},
): SetupResult {
  const events: ClosureEvent[] = [];
  let resolveDone: () => void = () => {};
  const donePromise = new Promise<void>((r) => {
    resolveDone = r;
  });

  const emit = (e: ClosureEvent): void => {
    events.push(e);
    if (
      e.type === 'closure:completed' ||
      e.type === 'closure:aborted' ||
      e.type === 'closure:error'
    ) {
      resolveDone();
    }
  };

  const sessionManager = createMockSessionManager(
    opts.autoEmit ?? true,
    opts.emitDelay ?? 50,
  );
  const coverageManager = createMockCoverageManager();
  const closureManager = createInMemoryClosureManager();

  const orchestrator = new ClosureOrchestrator({
    sessionManager,
    coverageManager,
    closureManager,
    projectId: 'test-project',
    discovery: {} as PluginBackedDiscovery,
    simulationAdapter: {} as PluginBackedSimulation,
    coverageAdapter: {} as PluginBackedCoverage,
    agentEnv: {},
    emit,
  });

  void opts.maxRounds;

  return {
    orchestrator,
    closureManager,
    sessionManager,
    coverageManager,
    events,
    donePromise,
    cleanup: () => {},
  };
}

/** 设置 CoverageManager.getOverview 的返回值序列 */
function setOverviewSequence(
  coverageManager: CoverageManager,
  values: number[],
): void {
  let idx = 0;
  (coverageManager.getOverview as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async () => ({
      summary: makeSummary(values[idx++] ?? values[values.length - 1] ?? 80),
      sessionId: 'merge-1',
    }),
  );
}

/**
 * 设置 CoverageManager.getOverview 返回递增序列。
 * 用于多 Gap 并行场景：每次调用返回 start + n*increment，
 * 确保 after 总是大于 before（delta > 0），避免并行交错导致 delta=0。
 */
function setIncrementingOverview(
  coverageManager: CoverageManager,
  start: number,
  increment: number,
): void {
  let current = start - increment;
  (coverageManager.getOverview as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async () => {
      current += increment;
      return { summary: makeSummary(current), sessionId: 'merge-1' };
    },
  );
}

/** 等待指定毫秒 */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── 测试 ────────────────────────────────────────────────────────

describe('ClosureOrchestrator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('5 轮循环逻辑', () => {
    it('每轮执行 startIteration → prompt → completeIteration，达到 maxRounds 后升级', async () => {
      const setup = setupOrchestrator(SAMPLE_GAPS, { maxRounds: 5, emitDelay: 30 });
      try {
        // 抑制 shouldEscalate，确保 5 轮都能跑完（不被连续低 delta 升级打断）
        vi.spyOn(setup.closureManager, 'shouldEscalate').mockReturnValue(false);

        // 设置 overview 序列：每轮 delta < 1%（不触发关闭），共 5 轮 × 2 次调用 = 10 次
        setOverviewSequence(setup.coverageManager, [
          80.0, 80.5, // Round 1: delta=0.5
          80.5, 80.8, // Round 2: delta=0.3
          80.8, 81.0, // Round 3: delta=0.2
          81.0, 81.2, // Round 4: delta=0.2
          81.2, 81.3, // Round 5: delta=0.1
        ]);

        const session = await setup.closureManager.startClosure({
          sessionId: 'merge-1',
          gaps: SAMPLE_GAPS,
          maxRounds: 5,
        });

        await setup.orchestrator.startClosure(session);
        await setup.donePromise;

        // 验证：5 轮 gap_started 事件
        const gapStarteds = setup.events.filter(
          (e) => e.type === 'closure:gap_started',
        );
        expect(gapStarteds).toHaveLength(5);
        expect(gapStarteds.map((e) => (e as { round: number }).round)).toEqual([
          1, 2, 3, 4, 5,
        ]);

        // 验证：5 轮 agent_prompting 事件
        const promptings = setup.events.filter(
          (e) => e.type === 'closure:agent_prompting',
        );
        expect(promptings).toHaveLength(5);

        // 验证：5 轮 agent_ended 事件
        const ended = setup.events.filter(
          (e) => e.type === 'closure:agent_ended',
        );
        expect(ended).toHaveLength(5);

        // 验证：5 轮 iteration_done 事件
        const iterations = setup.events.filter(
          (e) => e.type === 'closure:iteration_done',
        );
        expect(iterations).toHaveLength(5);

        // 验证：SessionManager.createSession 被调用 5 次（每轮一个独立会话）
        expect(
          (setup.sessionManager as unknown as { createSession: ReturnType<typeof vi.fn> })
            .createSession,
        ).toHaveBeenCalledTimes(5);

        // 验证：达到 maxRounds 后升级
        const escalated = setup.events.find(
          (e) => e.type === 'closure:gap_escalated',
        );
        expect(escalated).toBeDefined();
        expect((escalated as { reason: string }).reason).toContain(
          '达到最大迭代轮数',
        );

        // 验证：最终发出 closure:completed
        const completed = setup.events.find(
          (e) => e.type === 'closure:completed',
        );
        expect(completed).toBeDefined();

        // 验证：ClosureSession 状态为 completed
        const finalSession = await setup.closureManager.getClosure(session.id);
        expect(finalSession!.status).toBe('completed');
        expect(finalSession!.gaps[0].status).toBe('escalated');
        expect(finalSession!.gaps[0].iterations).toHaveLength(5);
      } finally {
        setup.cleanup();
      }
    });
  });

  describe('升级判定', () => {
    it('连续 2 轮 delta < 1% 触发升级', async () => {
      const setup = setupOrchestrator(SAMPLE_GAPS, { emitDelay: 30 });
      try {
        // Round 1: delta=0.5%, Round 2: delta=0.3% → 连续 2 轮 < 1% → 升级
        setOverviewSequence(setup.coverageManager, [
          80.0, 80.5, // Round 1: delta=0.5
          80.5, 80.8, // Round 2: delta=0.3 → shouldEscalate=true
        ]);

        const session = await setup.closureManager.startClosure({
          sessionId: 'merge-1',
          gaps: SAMPLE_GAPS,
          maxRounds: 5,
        });

        await setup.orchestrator.startClosure(session);
        await setup.donePromise;

        // 验证：仅 2 轮迭代
        const iterations = setup.events.filter(
          (e) => e.type === 'closure:iteration_done',
        );
        expect(iterations).toHaveLength(2);

        // 验证：升级事件
        const escalated = setup.events.find(
          (e) => e.type === 'closure:gap_escalated',
        );
        expect(escalated).toBeDefined();
        expect((escalated as { reason: string }).reason).toContain('连续');

        // 验证：gap 状态为 escalated
        const finalSession = await setup.closureManager.getClosure(session.id);
        expect(finalSession!.gaps[0].status).toBe('escalated');
        expect(finalSession!.gaps[0].escalationReason).toContain('连续');
      } finally {
        setup.cleanup();
      }
    });
  });

  describe('Delta Validation Phase 1', () => {
    it('deltaOverall >= 1% 时关闭 Gap（数字上升即有效）', async () => {
      const setup = setupOrchestrator(SAMPLE_GAPS, { emitDelay: 30 });
      try {
        // Round 1: delta=1.5% → >= 1% → 关闭
        setOverviewSequence(setup.coverageManager, [
          80.0, 81.5, // Round 1: delta=1.5
        ]);

        const session = await setup.closureManager.startClosure({
          sessionId: 'merge-1',
          gaps: SAMPLE_GAPS,
          maxRounds: 5,
        });

        await setup.orchestrator.startClosure(session);
        await setup.donePromise;

        // 验证：仅 1 轮迭代（第 1 轮就关闭）
        const iterations = setup.events.filter(
          (e) => e.type === 'closure:iteration_done',
        );
        expect(iterations).toHaveLength(1);

        // 验证：gap 关闭事件
        const closed = setup.events.find(
          (e) => e.type === 'closure:gap_closed',
        );
        expect(closed).toBeDefined();

        // 验证：无升级事件
        const escalated = setup.events.find(
          (e) => e.type === 'closure:gap_escalated',
        );
        expect(escalated).toBeUndefined();

        // 验证：closure 完成
        const completed = setup.events.find(
          (e) => e.type === 'closure:completed',
        );
        expect(completed).toBeDefined();

        // 验证：gap 状态为 closed
        const finalSession = await setup.closureManager.getClosure(session.id);
        expect(finalSession!.gaps[0].status).toBe('closed');
        expect(finalSession!.gaps[0].iterations).toHaveLength(1);
        expect(finalSession!.gaps[0].iterations[0].deltaAfter!.overall).toBe(81.5);
      } finally {
        setup.cleanup();
      }
    });

    it('deltaOverall < 1% 时不关闭 Gap，继续迭代', async () => {
      const setup = setupOrchestrator(SAMPLE_GAPS, { emitDelay: 30 });
      try {
        // Round 1: delta=0.5% → 不关闭，继续
        // Round 2: delta=1.5% → >= 1% → 关闭
        setOverviewSequence(setup.coverageManager, [
          80.0, 80.5, // Round 1: delta=0.5 (不关闭)
          80.5, 82.0, // Round 2: delta=1.5 (关闭)
        ]);

        // 抑制 shouldEscalate（因为 Round 1 delta < 1%，Round 2 不会连续 2 轮低 delta）
        // 实际上 shouldEscalate 检查最近 2 轮都 < 1%，Round 2 delta=1.5 所以不会升级
        // 但为了确保不被升级干扰，这里不 mock shouldEscalate

        const session = await setup.closureManager.startClosure({
          sessionId: 'merge-1',
          gaps: SAMPLE_GAPS,
          maxRounds: 5,
        });

        await setup.orchestrator.startClosure(session);
        await setup.donePromise;

        // 验证：2 轮迭代
        const iterations = setup.events.filter(
          (e) => e.type === 'closure:iteration_done',
        );
        expect(iterations).toHaveLength(2);

        // 验证：gap 在第 2 轮关闭
        const closed = setup.events.find(
          (e) => e.type === 'closure:gap_closed',
        );
        expect(closed).toBeDefined();

        // 验证：无升级
        const escalated = setup.events.find(
          (e) => e.type === 'closure:gap_escalated',
        );
        expect(escalated).toBeUndefined();

        // 验证：gap 状态为 closed
        const finalSession = await setup.closureManager.getClosure(session.id);
        expect(finalSession!.gaps[0].status).toBe('closed');
        expect(finalSession!.gaps[0].iterations).toHaveLength(2);
      } finally {
        setup.cleanup();
      }
    });
  });

  describe('中止逻辑', () => {
    it('abort 触发 AbortController，waitForAgentEnd 拒绝，发出 closure:aborted', async () => {
      // autoEmit=false：不自动发出 agent_end，让 waitForAgentEnd 挂起
      const setup = setupOrchestrator(SAMPLE_GAPS, { autoEmit: false });
      try {
        setOverviewSequence(setup.coverageManager, [80.0, 80.5]);

        const session = await setup.closureManager.startClosure({
          sessionId: 'merge-1',
          gaps: SAMPLE_GAPS,
          maxRounds: 5,
        });

        await setup.orchestrator.startClosure(session);

        // 等待 runGapLoop 到达 waitForAgentEnd（注册监听器）
        await wait(30);

        // 中止
        await setup.orchestrator.abort(session.id);

        // 验证：发出 closure:aborted 事件
        const aborted = setup.events.find(
          (e) => e.type === 'closure:aborted',
        );
        expect(aborted).toBeDefined();

        // 验证：未发出 closure:completed
        const completed = setup.events.find(
          (e) => e.type === 'closure:completed',
        );
        expect(completed).toBeUndefined();

        // 注意：中止时 orchestrator 在 catch 块中检查 controller.signal.aborted，
        // 若已中止则直接 return，不发出 closure:gap_failed 事件。
        // gap 的 failed 状态由 closureManager.abortClosure 标记。

        // 验证：ClosureSession 状态为 aborted
        const finalSession = await setup.closureManager.getClosure(session.id);
        expect(finalSession!.status).toBe('aborted');
        // gap 状态由 abortClosure 标记为 failed
        expect(finalSession!.gaps[0].status).toBe('failed');

        // 验证：orchestrator 不再追踪该 closure
        expect(setup.orchestrator.isRunning(session.id)).toBe(false);
      } finally {
        setup.cleanup();
      }
    });
  });

  describe('多 Gap 并行', () => {
    it('多个 Gap 并行执行，全部关闭后发出 closure:completed', async () => {
      const setup = setupOrchestrator(MULTI_GAPS, { emitDelay: 30 });
      try {
        // 两个 Gap 都在第 1 轮关闭（delta >= 1%）
        // 使用递增序列确保每次 after > before，避免并行交错导致 delta=0
        setIncrementingOverview(setup.coverageManager, 80, 1);

        const session = await setup.closureManager.startClosure({
          sessionId: 'merge-1',
          gaps: MULTI_GAPS,
          maxRounds: 5,
        });

        await setup.orchestrator.startClosure(session);
        await setup.donePromise;

        // 验证：2 个 gap_closed 事件
        const closedEvents = setup.events.filter(
          (e) => e.type === 'closure:gap_closed',
        );
        expect(closedEvents).toHaveLength(2);

        // 验证：closure:completed
        const completed = setup.events.find(
          (e) => e.type === 'closure:completed',
        );
        expect(completed).toBeDefined();

        // 验证：两个 gap 都为 closed
        const finalSession = await setup.closureManager.getClosure(session.id);
        expect(finalSession!.status).toBe('completed');
        expect(finalSession!.gaps).toHaveLength(2);
        expect(finalSession!.gaps.every((g) => g.status === 'closed')).toBe(true);

        // 验证：createSession 被调用 2 次（每个 gap 一个）
        expect(
          (setup.sessionManager as unknown as { createSession: ReturnType<typeof vi.fn> })
            .createSession,
        ).toHaveBeenCalledTimes(2);
      } finally {
        setup.cleanup();
      }
    });
  });

  describe('单 Gap 失败不影响其他 Gap', () => {
    it('一个 Gap 的 createSession 失败，另一个 Gap 仍正常关闭', async () => {
      const setup = setupOrchestrator(MULTI_GAPS, { emitDelay: 30 });
      try {
        // 让第一个 createSession 调用抛错，第二个正常
        let createCallCount = 0;
        const mgr = setup.sessionManager as unknown as {
          createSession: ReturnType<typeof vi.fn>;
        };
        mgr.createSession.mockImplementation(async () => {
          createCallCount++;
          if (createCallCount === 1) {
            throw new Error('Failed to create session');
          }
          const sid = `agent-session-${createCallCount}`;
          setTimeout(() => {
            (setup.sessionManager as unknown as EventEmitter).emit('sessionEvent', {
              sessionId: sid,
              event: { type: 'agent_end' },
            });
          }, 30);
          return sid;
        });

        setIncrementingOverview(setup.coverageManager, 80, 1);

        const session = await setup.closureManager.startClosure({
          sessionId: 'merge-1',
          gaps: MULTI_GAPS,
          maxRounds: 5,
        });

        await setup.orchestrator.startClosure(session);
        await setup.donePromise;

        // 验证：1 个 gap_failed 事件（第一个 gap）
        const failedEvents = setup.events.filter(
          (e) => e.type === 'closure:gap_failed',
        );
        expect(failedEvents).toHaveLength(1);
        // orchestrator 发出原始错误消息（非 failIteration 的包装消息）
        expect((failedEvents[0] as { error: string }).error).toContain(
          'Failed to create session',
        );

        // 验证：1 个 gap_closed 事件（第二个 gap）
        const closedEvents = setup.events.filter(
          (e) => e.type === 'closure:gap_closed',
        );
        expect(closedEvents).toHaveLength(1);

        // 验证：closure:completed（所有 gap 都进入终态）
        const completed = setup.events.find(
          (e) => e.type === 'closure:completed',
        );
        expect(completed).toBeDefined();

        // 验证：最终状态
        const finalSession = await setup.closureManager.getClosure(session.id);
        expect(finalSession!.status).toBe('completed');
        expect(finalSession!.gaps).toHaveLength(2);
        // 第一个 gap 失败
        const failedGap = finalSession!.gaps.find(
          (g) => g.status === 'failed',
        );
        expect(failedGap).toBeDefined();
        // 第二个 gap 关闭
        const closedGap = finalSession!.gaps.find(
          (g) => g.status === 'closed',
        );
        expect(closedGap).toBeDefined();
      } finally {
        setup.cleanup();
      }
    });
  });

  describe('事件流', () => {
    it('发出 closure:started 事件，包含 gapCount', async () => {
      const setup = setupOrchestrator(MULTI_GAPS, { emitDelay: 30 });
      try {
        setIncrementingOverview(setup.coverageManager, 80, 1);

        const session = await setup.closureManager.startClosure({
          sessionId: 'merge-1',
          gaps: MULTI_GAPS,
          maxRounds: 5,
        });

        await setup.orchestrator.startClosure(session);
        // 不等完成，仅检查 started 事件
        await wait(10);

        const started = setup.events.find(
          (e) => e.type === 'closure:started',
        );
        expect(started).toBeDefined();
        expect((started as { gapCount: number }).gapCount).toBe(2);

        await setup.donePromise;
      } finally {
        setup.cleanup();
      }
    });

    it('发出 tests_scanned 事件，包含扫描到的文件列表', async () => {
      const setup = setupOrchestrator(SAMPLE_GAPS, { emitDelay: 30 });
      try {
        setOverviewSequence(setup.coverageManager, [80, 82]);

        const session = await setup.closureManager.startClosure({
          sessionId: 'merge-1',
          gaps: SAMPLE_GAPS,
          maxRounds: 5,
        });

        await setup.orchestrator.startClosure(session);
        await setup.donePromise;

        // tests_scanned 事件存在（文件列表可能为空，因为 roundDir 不存在）
        const scanned = setup.events.find(
          (e) => e.type === 'closure:tests_scanned',
        );
        expect(scanned).toBeDefined();
        expect(
          Array.isArray((scanned as { files: string[] }).files),
        ).toBe(true);
      } finally {
        setup.cleanup();
      }
    });
  });
});
