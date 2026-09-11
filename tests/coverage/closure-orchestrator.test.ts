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
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isTargetMet } from '../../src/main/coverage/closure-manager';
import { ClosureOrchestrator, type ClosureEvent } from '../../src/main/coverage/closure-orchestrator';
import type {
  ClosureSession,
  ClosureTarget,
  TargetIteration,
  ClosureTargetStatus,
  StoredExclusionSuggestion,
} from '../../src/main/coverage/closure-manager';
import type { ExclusionSuggestion } from '../../src/main/coverage/exclusion-suggestions';
import type { ClosureManager } from '../../src/main/coverage/closure-manager';
import type { SessionManagerImpl } from '../../src/main/agent/session-manager';
import type { CoverageManager } from '../../src/main/coverage/coverage-manager';
import type {
  PluginBackedDiscovery,
  PluginBackedSimulation,
  PluginBackedCoverage,
} from '../../src/main/plugin-adapters';
import type {
  CoverageGap,
  CoverageSummary,
  CoverageDelta,
  CoverageMetric,
  CoverageNode,
  CoverageData,
  EdaToolConfig,
} from '@shared/types';
import { COVERAGE_METRICS, DEFAULT_COVERAGE_TARGETS } from '@shared/types';
import type { CommandRunner, CommandResult } from '../../src/main/coverage/coverage-report-generator';

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
function _makeDeltas(delta: number): CoverageDelta[] {
  const metrics: CoverageMetric[] = [
    'line', 'branch', 'toggle', 'condition',
    'fsm_state', 'fsm_transition', 'functional', 'assertion',
  ];
  return metrics.map((m) => ({ metric: m, before: 0, after: delta, delta }));
}

const SAMPLE_GAPS: CoverageGap[] = [
  makeGap('cpu_core', 'line', 80, 95),
];

const MULTI_GAPS: CoverageGap[] = [
  makeGap('cpu_core', 'line', 80, 95),
  makeGap('memory_ctrl', 'toggle', 75, 85),
];

// ─── Mock SessionManager ────────────────────────────────────────

/**
 * 创建 mock SessionManager。
 * - autoEmit=true 时，createSession 后自动在 delay ms 后发出 agent_end 事件
 * - assistantText 提供时，agent_end 前先发出携带该文本的 assistant message_end（工单 07）
 * - autoEmit=false 时，不发出 agent_end（用于中止测试）
 */
function createMockSessionManager(
  autoEmit = true,
  delay = 50,
  assistantText?: string,
): SessionManagerImpl {
  const mgr = Object.assign(new EventEmitter(), {
    createSession: vi.fn(),
    getClient: vi.fn(),
    destroySession: vi.fn(),
    promptFireAndForget: vi.fn(),
    sendPromptAndWait: vi.fn(),
  }) as unknown as SessionManagerImpl;

  let counter = 0;
  (mgr as unknown as { createSession: ReturnType<typeof vi.fn> }).createSession =
    vi.fn(async () => {
      const sid = `agent-session-${++counter}`;
      if (autoEmit) {
        setTimeout(() => {
          if (assistantText !== undefined) {
            mgr.emit('sessionEvent', {
              sessionId: sid,
              event: {
                type: 'message_end',
                message: { role: 'assistant', content: assistantText },
              },
            });
          }
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

  // Deep Agent Turn interface: fire-and-forget prompt (matches real SessionManager)
  (mgr as unknown as { promptFireAndForget: ReturnType<typeof vi.fn> }).promptFireAndForget =
    vi.fn(async () => {});

  // Deep Agent Turn interface: send prompt + wait for agent_end + capture assistant text
  // Simulates the real SessionManager.sendPromptAndWait by emitting events after delay.
  (mgr as unknown as { sendPromptAndWait: ReturnType<typeof vi.fn> }).sendPromptAndWait =
    vi.fn(async (
      _sessionId: string,
      _message: string,
      _images: string[] | undefined,
      opts?: { timeoutMs?: number; signal?: AbortSignal },
    ): Promise<string> => {
      return new Promise<string>((resolve, reject) => {
        const sid = _sessionId; // use the actual sessionId passed by the caller
        let lastText = '';
        const cleanup = (): void => {
          clearTimeout(timer);
          opts?.signal?.removeEventListener('abort', onAbort);
          mgr.removeListener('sessionEvent', onEvent);
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('Agent timed out'));
        }, opts?.timeoutMs ?? 600000);
        timer.unref?.();
        const onAbort = (): void => {
          cleanup();
          reject(new Error('Aborted'));
        };
        if (opts?.signal) {
          if (opts.signal.aborted) { cleanup(); reject(new Error('Aborted')); return; }
          opts.signal.addEventListener('abort', onAbort, { once: true });
        }
        const onEvent = (data: { sessionId: string; event: unknown }): void => {
          if (data.sessionId !== sid) return;
          const evt = data.event as Record<string, unknown> | null;
          if (!evt || typeof evt.type !== 'string') return;
          if (evt.type === 'message_end') {
            const msg = evt.message as Record<string, unknown> | undefined;
            if (msg?.role === 'assistant') {
              if (typeof msg.content === 'string') lastText = msg.content;
              else if (Array.isArray(msg.content)) {
                for (const b of msg.content) {
                  if (typeof b === 'object' && b !== null && (b as Record<string, unknown>).type === 'text')
                    lastText += (b as Record<string, unknown>).text as string;
                }
              }
            }
          } else if (evt.type === 'agent_end') {
            cleanup();
            resolve(lastText);
          } else if (evt.type === 'error') {
            cleanup();
            reject(new Error(String(evt.message ?? evt.error ?? 'Agent error')));
          }
        };
        mgr.on('sessionEvent', onEvent);
      });
    });

  return mgr;
}

/** 创建 mock CoverageManager
 * moduleMetrics 可传入自定义模块 metric 值，控制 getTargetCoverageSnapshot 的返回值
 */
function createMockCoverageManager(moduleMetrics?: {
  cpu_core?: Partial<Record<CoverageMetric, number>>;
  memory_ctrl?: Partial<Record<CoverageMetric, number>>;
}): CoverageManager {
  // 样例树：与 SAMPLE_GAPS / MULTI_GAPS 的模块对应
  const na = (): { percentage: null; covered: null; total: null } => ({
    percentage: null,
    covered: null,
    total: null,
  });
  const mkMetrics = (pcts: Partial<Record<CoverageMetric, number>>): CoverageNode['metrics'] => {
    const m = {} as CoverageNode['metrics'];
    for (const metric of COVERAGE_METRICS) {
      m[metric] = pcts[metric] !== undefined ? { percentage: pcts[metric]!, covered: null, total: null } : na();
    }
    return m;
  };
  const root: CoverageNode = {
    name: 'top',
    path: 'top',
    depth: 0,
    metrics: mkMetrics({}),
    children: [
      { name: 'cpu_core', path: 'cpu_core', depth: 1, metrics: mkMetrics(moduleMetrics?.cpu_core ?? { line: 80 }), children: [] },
      { name: 'memory_ctrl', path: 'memory_ctrl', depth: 1, metrics: mkMetrics(moduleMetrics?.memory_ctrl ?? { toggle: 75 }), children: [] },
    ],
  };
  return {
    getOverview: vi.fn().mockResolvedValue({
      summary: makeSummary(80),
      sessionId: 'merge-1',
    }),
    getTree: vi.fn().mockResolvedValue({
      sessionId: 'merge-1',
      source: { covMergeDir: 'cov_merge', edaTool: 'imc', reportGeneratedAt: 0 },
      root,
      targets: { line: 95, toggle: 85 },
    }),
    getTargets: vi.fn().mockResolvedValue({ line: 95, toggle: 85 }),
  } as unknown as CoverageManager;
}

// ─── 内存版 ClosureManager（线程安全，避免并行 Target 时的文件 I/O 竞态） ──

const ESCALATION_DELTA_THRESHOLD = 1;
const DEFAULT_ESCALATION_THRESHOLD = 2;
const DEFAULT_MAX_ROUNDS = 5;

/**
 * 创建内存版 ClosureManager mock。
 * 与真实 ClosureManager 行为一致（模块级聚合 + 状态机），但状态全部保存在内存中，
 * 避免多 Target 并行时的 read-modify-write 文件竞态。
 * gapPool 为可用的 CoverageGap 池（按模块分组聚合为 target，modules 可过滤）。
 */
function createInMemoryClosureManager(gapPool: CoverageGap[]): ClosureManager {
  const sessions = new Map<string, ClosureSession>();
  /** 工单 07：exclusion 建议存储（closureId → targetId → 建议列表），与真实 triage.json 行为一致 */
  const triageStore = new Map<string, Record<string, StoredExclusionSuggestion[]>>();
  let closureCounter = 0;
  let targetCounter = 0;
  let suggCounter = 0;

  function shouldEscalate(target: ClosureTarget, threshold = DEFAULT_ESCALATION_THRESHOLD): boolean {
    const completed = target.iterations.filter(
      (it) => it.status === 'completed' && it.deltaBefore !== undefined && it.deltaAfter !== undefined,
    );
    if (completed.length < threshold) return false;
    const recent = completed.slice(-threshold);
    return recent.every((it) => {
      const delta = it.deltaAfter!.overall - it.deltaBefore!.overall;
      return delta < ESCALATION_DELTA_THRESHOLD;
    });
  }

  function maybeCompleteClosure(session: ClosureSession): void {
    const allTerminal = session.targets.every((t) =>
      ['closed', 'escalated', 'failed'].includes(t.status));
    if (allTerminal && session.status === 'running') {
      session.status = 'completed';
    }
  }

  const mgr = {
    startClosure: async (input: {
      sessionId: string;
      modules?: string[];
      maxRounds?: number;
      escalationThreshold?: number;
    }): Promise<ClosureSession> => {
      const closureId = `closure_test_${++closureCounter}`;
      const selected = input.modules
        ? gapPool.filter((g) => input.modules!.includes(g.nodePath))
        : gapPool;
      // 按模块分组聚合（与真实 ClosureManager.startClosure 一致）
      const byModule = new Map<string, CoverageGap[]>();
      for (const gap of selected) {
        const list = byModule.get(gap.nodePath) ?? [];
        list.push(gap);
        byModule.set(gap.nodePath, list);
      }
      if (byModule.size === 0) {
        throw new Error('选中的模块均无未达标 metric，无法启动 Closure');
      }
      const session: ClosureSession = {
        id: closureId,
        sessionId: input.sessionId,
        createdAt: Date.now(),
        status: 'running',
        targets: Array.from(byModule.entries()).map(([path, gaps]) => ({
          id: `target_${++targetCounter}`,
          module: { path, name: gaps[0].nodeName },
          gaps,
          iterations: [],
          status: 'pending' as ClosureTargetStatus,
        })),
        maxRounds: input.maxRounds ?? DEFAULT_MAX_ROUNDS,
        escalationThreshold: input.escalationThreshold ?? DEFAULT_ESCALATION_THRESHOLD,
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
    startIteration: async (closureId: string, targetId: string): Promise<TargetIteration> => {
      const session = sessions.get(closureId);
      if (!session) throw new Error(`Closure ${closureId} not found`);
      if (session.status !== 'running') throw new Error(`Closure ${closureId} is ${session.status}`);
      const target = session.targets.find((t) => t.id === targetId);
      if (!target) throw new Error(`Target ${targetId} not found in closure ${closureId}`);
      const round = target.iterations.length + 1;
      const iteration: TargetIteration = { round, generatedTests: [], status: 'running' };
      target.iterations.push(iteration);
      if (target.status === 'pending') target.status = 'in_progress';
      return iteration;
    },
    completeIteration: async (
      closureId: string,
      targetId: string,
      result: {
        generatedTests: string[];
        deltaBefore: CoverageSummary;
        deltaAfter: CoverageSummary;
        deltas: CoverageDelta[];
        coverage?: { metrics: Record<CoverageMetric, { percentage: number | null; covered: number | null; total: number | null }>; targets: Partial<Record<CoverageMetric, number>> };
      },
    ): Promise<TargetIteration> => {
      const session = sessions.get(closureId);
      if (!session) throw new Error(`Closure ${closureId} not found`);
      const target = session.targets.find((t) => t.id === targetId);
      if (!target) throw new Error(`Target ${targetId} not found`);
      const iteration = target.iterations[target.iterations.length - 1];
      if (!iteration) throw new Error(`No active iteration in target ${targetId}`);
      iteration.generatedTests = result.generatedTests;
      iteration.deltaBefore = result.deltaBefore;
      iteration.deltaAfter = result.deltaAfter;
      iteration.deltas = result.deltas;
      iteration.status = 'completed';
      // 达标判定优先：模块全部 metric 达到 Coverage Target → closed
      // 与真实 ClosureManager.completeIteration 行为一致（ADR 0025 决策 2）
      if (
        result.coverage &&
        isTargetMet(target, result.coverage.metrics, result.coverage.targets)
      ) {
        target.status = 'closed';
      } else if (mgr.shouldEscalate(target, session.escalationThreshold)) {
        target.status = 'escalated';
        target.escalationReason =
          `连续 ${session.escalationThreshold} 轮 overall delta < ${ESCALATION_DELTA_THRESHOLD}%`;
      }
      maybeCompleteClosure(session);
      return iteration;
    },
    failIteration: async (closureId: string, targetId: string, error: string): Promise<void> => {
      const session = sessions.get(closureId);
      if (!session) return;
      const target = session.targets.find((t) => t.id === targetId);
      if (!target) return;
      const iteration = target.iterations[target.iterations.length - 1];
      if (iteration) {
        iteration.status = 'failed';
        iteration.error = error;
      }
    },
    failTarget: async (closureId: string, targetId: string, reason: string): Promise<void> => {
      const session = sessions.get(closureId);
      if (!session) return;
      const target = session.targets.find((t) => t.id === targetId);
      if (!target) return;
      target.status = 'failed';
      target.escalationReason = reason;
      maybeCompleteClosure(session);
    },
    shouldEscalate,
    closeTarget: async (closureId: string, targetId: string): Promise<void> => {
      const session = sessions.get(closureId);
      if (!session) return;
      const target = session.targets.find((t) => t.id === targetId);
      if (!target) return;
      target.status = 'closed';
      maybeCompleteClosure(session);
    },
    escalateTarget: async (closureId: string, targetId: string, reason: string): Promise<void> => {
      const session = sessions.get(closureId);
      if (!session) return;
      const target = session.targets.find((t) => t.id === targetId);
      if (!target) return;
      target.status = 'escalated';
      target.escalationReason = reason;
      maybeCompleteClosure(session);
    },
    abortClosure: async (closureId: string): Promise<void> => {
      const session = sessions.get(closureId);
      if (!session) return;
      for (const target of session.targets) {
        if (target.status === 'pending' || target.status === 'in_progress') {
          target.status = 'failed';
        }
      }
      session.status = 'aborted';
    },
    getWorkspaceDir: (closureId: string): string => {
      return `/tmp/closure-test-${closureId}`;
    },
    addExclusionSuggestions: async (
      closureId: string,
      targetId: string,
      suggestions: ExclusionSuggestion[],
    ): Promise<StoredExclusionSuggestion[]> => {
      const session = sessions.get(closureId);
      if (!session) throw new Error(`Closure ${closureId} not found`);
      if (!session.targets.some((t) => t.id === targetId)) {
        throw new Error(`Target ${targetId} not found in closure ${closureId}`);
      }
      if (!Array.isArray(suggestions) || suggestions.length === 0) {
        throw new Error('suggestions must be a non-empty array');
      }
      const stored = suggestions.map((s) => ({
        ...s,
        // 固定 pending + ai-triage 来源（AI 只建议不排除，PRD US-33）
        status: 'pending' as const,
        requestedBy: 'ai-triage' as const,
        id: `sugg_${++suggCounter}`,
        createdAt: Date.now(),
      }));
      const byTarget = triageStore.get(closureId) ?? {};
      byTarget[targetId] = [...(byTarget[targetId] ?? []), ...stored];
      triageStore.set(closureId, byTarget);
      return stored;
    },
    listExclusionSuggestions: async (
      closureId: string,
    ): Promise<Record<string, StoredExclusionSuggestion[]>> => {
      return triageStore.get(closureId) ?? {};
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
  gaps: CoverageGap[],
  opts: {
    maxRounds?: number;
    autoEmit?: boolean;
    emitDelay?: number;
    /** 注入 Recovery 配置（baselineVdbDir + edaConfig + recoveryRunner）后，闭环走 Recovery 路径 */
    withRecovery?: boolean;
    /** Recovery runner 返回的覆盖率数据（withRecovery=true 时生效） */
    recoveryCoveragePct?: number;
    /** 模块 metric 是否已达标（true=getTargetCoverageSnapshot 返回达标值→gap 关闭） */
    coverageMet?: boolean;
    /** agent_end 前发出的 assistant 回复文本（工单 07：exclusion 建议解析） */
    assistantText?: string;
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
    opts.assistantText,
  );
  // 模块 metric 默认已达标（line=96 >= 95, toggle=86 >= 85）
  // → completeIteration 的 isTargetMet 判定通过 → gap 关闭
  // 需要"不关闭"的测试可传 coverageMet=false
  const coverageMet = opts.coverageMet ?? true;
  const coverageManager = createMockCoverageManager(
    coverageMet
      ? { cpu_core: { line: 96 }, memory_ctrl: { toggle: 86 } }
      : { cpu_core: { line: 80 }, memory_ctrl: { toggle: 75 } },
  );
  const closureManager = createInMemoryClosureManager(gaps);

  // Recovery 配置注入
  const tmpDir = mkdtempSync(join(tmpdir(), 'closure-recovery-'));
  const baselineVdbDir = join(tmpDir, 'cov_merge');
  mkdirSync(baselineVdbDir, { recursive: true });

  const edaConfig: EdaToolConfig = {
    tool: 'vcs-urg',
    covMergeDir: 'cov_merge',
    summaryCommand: 'urg -full64 -dir {covMergeDir} -xml_verbose -format text -show summary -report {reportDir}',
    detailCommand: 'urg -full64 -dir {covMergeDir} -format text -report {reportDir}/detail',
    gradeCommand: 'urg -full64 -dir {covMergeDir} -grade testfile -format text -report {reportDir}/grade',
    execBackend: 'direct',
  };

  const recoveryPct = opts.recoveryCoveragePct ?? 82;
  const recoveryRunner: CommandRunner = vi.fn(async (): Promise<CommandResult> => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
  }));

  // Recovery 后的 CoverageData（coverageAdapter.parse 返回）
  const triplet = { percentage: recoveryPct, covered: Math.round(recoveryPct * 10), total: 1000 };
  const recoveryMetrics = {} as CoverageNode['metrics'];
  for (const m of COVERAGE_METRICS) {
    recoveryMetrics[m] = triplet;
  }
  const recoveryData: CoverageData = {
    sessionId: 'merge-1',
    source: { covMergeDir: baselineVdbDir, edaTool: 'vcs-urg', reportGeneratedAt: Date.now() },
    root: {
      name: 'top',
      path: 'top',
      depth: 0,
      metrics: recoveryMetrics,
      children: [
        { name: 'cpu_core', path: 'cpu_core', depth: 1, metrics: recoveryMetrics, children: [] },
        { name: 'memory_ctrl', path: 'memory_ctrl', depth: 1, metrics: recoveryMetrics, children: [] },
      ],
    },
    targets: { ...DEFAULT_COVERAGE_TARGETS },
    summaryOnly: true,
  };

  const recoveryAdapter = {
    hasParser: () => true,
    parse: vi.fn(async () => ({
      data: recoveryData,
      jsonStr: JSON.stringify(recoveryData),
    })),
  } as unknown as PluginBackedCoverage;

  // 覆盖 coverageManager.cache 方法（persistRecoveryResult 调用）
  const mockCache = vi.fn().mockResolvedValue(undefined);
  (coverageManager as unknown as { cache: ReturnType<typeof vi.fn> }).cache = mockCache;

  // 覆盖 coverageManager.registerMergeSession 方法（finalizeRecovery 调用）
  const mockRegisterMergeSession = vi.fn(async (data: CoverageData) => ({
    sessionId: data.sessionId,
    covMergeDir: baselineVdbDir,
    edaTool: edaConfig.tool,
    createdAt: Date.now(),
    reportDir: '',
  }));
  (coverageManager as unknown as { registerMergeSession: ReturnType<typeof vi.fn> }).registerMergeSession =
    mockRegisterMergeSession;

  const orchestratorOpts: ConstructorParameters<typeof ClosureOrchestrator>[0] = {
    sessionManager,
    coverageManager,
    closureManager,
    projectId: 'test-project',
    discovery: {} as PluginBackedDiscovery,
    simulationAdapter: {} as PluginBackedSimulation,
    coverageAdapter: recoveryAdapter,
    agentEnv: {},
    emit,
  };

  if (opts.withRecovery) {
    orchestratorOpts.baselineVdbDir = baselineVdbDir;
    orchestratorOpts.edaConfig = edaConfig;
    orchestratorOpts.recoveryRunner = recoveryRunner;
  }

  const orchestrator = new ClosureOrchestrator(orchestratorOpts);

  void opts.maxRounds;

  return {
    orchestrator,
    closureManager,
    sessionManager,
    coverageManager,
    events,
    donePromise,
    cleanup: () => {
      rmSync(tmpDir, { recursive: true });
    },
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
      const setup = setupOrchestrator(SAMPLE_GAPS, { maxRounds: 5, emitDelay: 30, coverageMet: false });
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
        expect(finalSession!.targets[0].status).toBe('escalated');
        expect(finalSession!.targets[0].iterations).toHaveLength(5);
      } finally {
        setup.cleanup();
      }
    });
  });

  describe('升级判定', () => {
    it('连续 2 轮 delta < 1% 触发升级', async () => {
      const setup = setupOrchestrator(SAMPLE_GAPS, { emitDelay: 30, coverageMet: false });
      try {
        // Round 1: delta=0.5%, Round 2: delta=0.3% → 连续 2 轮 < 1% → 升级
        setOverviewSequence(setup.coverageManager, [
          80.0, 80.5, // Round 1: delta=0.5
          80.5, 80.8, // Round 2: delta=0.3 → shouldEscalate=true
        ]);

        const session = await setup.closureManager.startClosure({
          sessionId: 'merge-1',
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
        expect(finalSession!.targets[0].status).toBe('escalated');
        expect(finalSession!.targets[0].escalationReason).toContain('连续');
      } finally {
        setup.cleanup();
      }
    });
  });

  describe('达标判定与迭代关闭', () => {
    it('metric 达标时关闭 Gap（isTargetMet 判定）', async () => {
      const setup = setupOrchestrator(SAMPLE_GAPS, { emitDelay: 30 });
      try {
        // Round 1: delta=1.5% → >= 1% → 关闭
        setOverviewSequence(setup.coverageManager, [
          80.0, 81.5, // Round 1: delta=1.5
        ]);

        const session = await setup.closureManager.startClosure({
          sessionId: 'merge-1',
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
        expect(finalSession!.targets[0].status).toBe('closed');
        expect(finalSession!.targets[0].iterations).toHaveLength(1);
        expect(finalSession!.targets[0].iterations[0].deltaAfter!.overall).toBe(81.5);
      } finally {
        setup.cleanup();
      }
    });

    it('deltaOverall < 1% 且 metric 未达标时不关闭 Gap，连续 2 轮后升级', async () => {
      const setup = setupOrchestrator(SAMPLE_GAPS, { emitDelay: 30, coverageMet: false });
      try {
        // Round 1: delta=0.5% → 不关闭（metric 未达标 + delta < 1%）
        // Round 2: delta=0.3% → 连续 2 轮 < 1% → 升级
        setOverviewSequence(setup.coverageManager, [
          80.0, 80.5, // Round 1: delta=0.5
          80.5, 80.8, // Round 2: delta=0.3 → shouldEscalate=true
        ]);

        const session = await setup.closureManager.startClosure({
          sessionId: 'merge-1',
          maxRounds: 5,
        });

        await setup.orchestrator.startClosure(session);
        await setup.donePromise;

        // 验证：2 轮迭代后升级（连续 2 轮 delta < 1%）
        const iterations = setup.events.filter(
          (e) => e.type === 'closure:iteration_done',
        );
        expect(iterations).toHaveLength(2);

        // 验证：无 gap_closed（metric 未达标，从未关闭）
        const closed = setup.events.find(
          (e) => e.type === 'closure:gap_closed',
        );
        expect(closed).toBeUndefined();

        // 验证：升级事件
        const escalated = setup.events.find(
          (e) => e.type === 'closure:gap_escalated',
        );
        expect(escalated).toBeDefined();

        // 验证：gap 状态为 escalated
        const finalSession = await setup.closureManager.getClosure(session.id);
        expect(finalSession!.targets[0].status).toBe('escalated');
        expect(finalSession!.targets[0].iterations).toHaveLength(2);
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
        expect(finalSession!.targets[0].status).toBe('failed');

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
        expect(finalSession!.targets).toHaveLength(2);
        expect(finalSession!.targets.every((g) => g.status === 'closed')).toBe(true);

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
        expect(finalSession!.targets).toHaveLength(2);
        // 第一个 target 失败
        const failedTarget = finalSession!.targets.find(
          (g) => g.status === 'failed',
        );
        expect(failedTarget).toBeDefined();
        // 第二个 target 关闭
        const closedTarget = finalSession!.targets.find(
          (g) => g.status === 'closed',
        );
        expect(closedTarget).toBeDefined();
      } finally {
        setup.cleanup();
      }
    });
  });

  describe('事件流', () => {
    it('发出 closure:started 事件，包含 targetCount', async () => {
      const setup = setupOrchestrator(MULTI_GAPS, { emitDelay: 30 });
      try {
        setIncrementingOverview(setup.coverageManager, 80, 1);

        const session = await setup.closureManager.startClosure({
          sessionId: 'merge-1',
          maxRounds: 5,
        });

        await setup.orchestrator.startClosure(session);
        // 不等完成，仅检查 started 事件
        await wait(10);

        const started = setup.events.find(
          (e) => e.type === 'closure:started',
        );
        expect(started).toBeDefined();
        expect((started as { targetCount: number }).targetCount).toBe(2);

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

  // ─── Recovery 集成测试（Issue #03） ────────────────────────────

  describe('Coverage Recovery 集成', () => {
    it('Recovery 注入后，事件序列包含 recovery_started → recovery_done', async () => {
      const setup = setupOrchestrator(SAMPLE_GAPS, {
        emitDelay: 30,
        withRecovery: true,
        recoveryCoveragePct: 82,
      });
      try {
        // deltaBefore=80, Recovery 后=82 → deltaOverall=2 >= 1% → gap 关闭
        setOverviewSequence(setup.coverageManager, [80.0]);

        const session = await setup.closureManager.startClosure({
          sessionId: 'merge-1',
          maxRounds: 5,
        });

        await setup.orchestrator.startClosure(session);
        await setup.donePromise;

        // 验证事件序列包含 recovery_started
        const recoveryStarted = setup.events.find(
          (e) => e.type === 'closure:recovery_started',
        );
        expect(recoveryStarted).toBeDefined();

        // 验证 recovery_done 事件存在，且 deltaOverall=2
        const recoveryDone = setup.events.find(
          (e) => e.type === 'closure:recovery_done',
        );
        expect(recoveryDone).toBeDefined();
        expect((recoveryDone as { deltaOverall: number }).deltaOverall).toBe(2);

        // 验证：gap 在第 1 轮关闭（delta >= 1%）
        const closed = setup.events.find(
          (e) => e.type === 'closure:gap_closed',
        );
        expect(closed).toBeDefined();

        // 验证事件顺序：recovery_started 在 recovery_done 之前，recovery_done 在 iteration_done 之前
        const recoveryStartedIdx = setup.events.findIndex(
          (e) => e.type === 'closure:recovery_started',
        );
        const recoveryDoneIdx = setup.events.findIndex(
          (e) => e.type === 'closure:recovery_done',
        );
        const iterationDoneIdx = setup.events.findIndex(
          (e) => e.type === 'closure:iteration_done',
        );
        expect(recoveryStartedIdx).toBeGreaterThan(-1);
        expect(recoveryDoneIdx).toBeGreaterThan(recoveryStartedIdx);
        expect(iterationDoneIdx).toBeGreaterThan(recoveryDoneIdx);
      } finally {
        setup.cleanup();
      }
    });

    it('Recovery 失败时发出 recovery_failed 事件并标记 target 失败', async () => {
      const setup = setupOrchestrator(SAMPLE_GAPS, {
        emitDelay: 30,
        withRecovery: true,
      });
      try {
        // 让 recoveryRunner 返回失败
        const runner = vi.fn(async (): Promise<CommandResult> => ({
          exitCode: 1,
          stdout: '',
          stderr: 'urg: error: cannot open vdb',
        }));
        // 覆盖 orchestrator 的 recoveryRunner（通过重新 setup）
        // 由于 setupOrchestrator 内部已注入 recoveryRunner，这里通过闭包无法直接覆盖
        // 改为直接测试 setupOrchestrator 中注入的 runner 的 mock
        // 实际上，setupOrchestrator 内的 runner 默认返回 exitCode=0
        // 要测试失败场景，需要手动 mock runner 返回失败
        // 这里我们通过 mockImplementation 覆盖

        // 获取注入的 recoveryRunner 并覆盖
        const orchestratorOpts = (setup.orchestrator as unknown as {
          opts: { recoveryRunner?: CommandRunner };
        }).opts;
        if (orchestratorOpts?.recoveryRunner) {
          (orchestratorOpts.recoveryRunner as unknown as ReturnType<typeof vi.fn>)
            .mockImplementation(async () => ({
              exitCode: 1,
              stdout: '',
              stderr: 'urg: error: cannot open vdb',
            }));
        }

        setOverviewSequence(setup.coverageManager, [80.0]);

        const session = await setup.closureManager.startClosure({
          sessionId: 'merge-1',
          maxRounds: 5,
        });

        await setup.orchestrator.startClosure(session);
        await setup.donePromise;

        // 验证 recovery_failed 事件
        const recoveryFailed = setup.events.find(
          (e) => e.type === 'closure:recovery_failed',
        );
        expect(recoveryFailed).toBeDefined();
        expect((recoveryFailed as { error: string }).error).toContain('urg');

        // 验证 gap_failed 事件
        const gapFailed = setup.events.find(
          (e) => e.type === 'closure:gap_failed',
        );
        expect(gapFailed).toBeDefined();

        // 验证 target 状态为 failed
        const finalSession = await setup.closureManager.getClosure(session.id);
        expect(finalSession!.targets[0].status).toBe('failed');

        // 不使用 runner 变量以避免 lint 警告
        void runner;
      } finally {
        setup.cleanup();
      }
    });

    it('无 Recovery 配置时走降级路径（无 recovery 事件，delta=0）', async () => {
      const setup = setupOrchestrator(SAMPLE_GAPS, {
        emitDelay: 30,
        withRecovery: false,
      });
      try {
        // 降级路径：delta 恒为零
        setOverviewSequence(setup.coverageManager, [80.0, 80.0]);

        const session = await setup.closureManager.startClosure({
          sessionId: 'merge-1',
          maxRounds: 5,
        });

        await setup.orchestrator.startClosure(session);
        await setup.donePromise;

        // 验证：无 recovery_started 事件
        const recoveryStarted = setup.events.find(
          (e) => e.type === 'closure:recovery_started',
        );
        expect(recoveryStarted).toBeUndefined();

        // 验证：无 recovery_done 事件
        const recoveryDone = setup.events.find(
          (e) => e.type === 'closure:recovery_done',
        );
        expect(recoveryDone).toBeUndefined();

        // 验证：iteration_done 的 deltaOverall=0（降级路径 delta 恒为零）
        const iterationDone = setup.events.find(
          (e) => e.type === 'closure:iteration_done',
        );
        expect(iterationDone).toBeDefined();
        expect((iterationDone as { deltaOverall: number }).deltaOverall).toBe(0);
      } finally {
        setup.cleanup();
      }
    });

    it('闭环完成后发出 closure:finalized 事件，将最终 Recovery 报告固化为 Merge Session', async () => {
      const setup = setupOrchestrator(SAMPLE_GAPS, {
        emitDelay: 30,
        withRecovery: true,
        recoveryCoveragePct: 96, // Recovery 后 line=96 >= 95 target → 达标关闭
      });
      try {
        setOverviewSequence(setup.coverageManager, [80.0]);

        const session = await setup.closureManager.startClosure({
          sessionId: 'merge-1',
          maxRounds: 5,
        });

        await setup.orchestrator.startClosure(session);
        await setup.donePromise;

        // 验证：closure:finalized 事件存在
        const finalized = setup.events.find(
          (e) => e.type === 'closure:finalized',
        );
        expect(finalized).toBeDefined();
        expect((finalized as { mergeSessionId: string }).mergeSessionId).toBe('merge-1');

        // 验证：registerMergeSession 被调用
        const mockRegister = (setup.coverageManager as unknown as {
          registerMergeSession: ReturnType<typeof vi.fn>;
        }).registerMergeSession;
        expect(mockRegister).toHaveBeenCalledTimes(1);

        // 验证事件顺序：finalized 在 completed 之前
        const finalizedIdx = setup.events.findIndex(
          (e) => e.type === 'closure:finalized',
        );
        const completedIdx = setup.events.findIndex(
          (e) => e.type === 'closure:completed',
        );
        expect(finalizedIdx).toBeGreaterThan(-1);
        expect(completedIdx).toBeGreaterThan(finalizedIdx);
      } finally {
        setup.cleanup();
      }
    });

    it('Recovery 路径下多 Target 并行，全部达标后发出 closure:completed', async () => {
      const setup = setupOrchestrator(MULTI_GAPS, {
        emitDelay: 30,
        withRecovery: true,
        recoveryCoveragePct: 96, // 两模块都达标
      });
      try {
        setOverviewSequence(setup.coverageManager, [80.0]);

        const session = await setup.closureManager.startClosure({
          sessionId: 'merge-1',
          maxRounds: 5,
        });

        await setup.orchestrator.startClosure(session);
        await setup.donePromise;

        // 验证：2 个 gap_closed 事件
        const closedEvents = setup.events.filter(
          (e) => e.type === 'closure:gap_closed',
        );
        expect(closedEvents).toHaveLength(2);

        // 验证：2 个 recovery_done 事件（每个 target 各一次）
        const recoveryDoneEvents = setup.events.filter(
          (e) => e.type === 'closure:recovery_done',
        );
        expect(recoveryDoneEvents).toHaveLength(2);

        // 验证：closure:completed
        const completed = setup.events.find(
          (e) => e.type === 'closure:completed',
        );
        expect(completed).toBeDefined();

        // 验证：closure:finalized（只需一次固化，最后一个 Recovery 结果）
        const finalized = setup.events.find(
          (e) => e.type === 'closure:finalized',
        );
        expect(finalized).toBeDefined();

        // 验证：两个 target 都为 closed
        const finalSession = await setup.closureManager.getClosure(session.id);
        expect(finalSession!.status).toBe('completed');
        expect(finalSession!.targets.every((t) => t.status === 'closed')).toBe(true);
      } finally {
        setup.cleanup();
      }
    });

    it('Recovery 失败时其余 target 不受影响（fail-closed 隔离）', async () => {
      // 两个 target：第一个 Recovery 失败，第二个正常
      const setup = setupOrchestrator(MULTI_GAPS, {
        emitDelay: 30,
        withRecovery: true,
        recoveryCoveragePct: 96,
      });
      try {
        // 覆盖 recoveryRunner：第一次调用失败，第二次成功
        let recoveryCallCount = 0;
        const orchestratorOpts = (setup.orchestrator as unknown as {
          opts: { recoveryRunner?: CommandRunner };
        }).opts;
        if (orchestratorOpts?.recoveryRunner) {
          (orchestratorOpts.recoveryRunner as unknown as ReturnType<typeof vi.fn>)
            .mockImplementation(async (): Promise<CommandResult> => {
              recoveryCallCount++;
              if (recoveryCallCount === 1) {
                return { exitCode: 1, stdout: '', stderr: 'urg: error: vdb not found' };
              }
              return { exitCode: 0, stdout: '', stderr: '' };
            });
        }

        setOverviewSequence(setup.coverageManager, [80.0]);

        const session = await setup.closureManager.startClosure({
          sessionId: 'merge-1',
          maxRounds: 5,
        });

        await setup.orchestrator.startClosure(session);
        await setup.donePromise;

        // 验证：1 个 recovery_failed 事件
        const recoveryFailed = setup.events.filter(
          (e) => e.type === 'closure:recovery_failed',
        );
        expect(recoveryFailed.length).toBeGreaterThanOrEqual(1);

        // 验证：1 个 gap_failed 事件（Recovery 失败的 target）
        const gapFailed = setup.events.filter(
          (e) => e.type === 'closure:gap_failed',
        );
        expect(gapFailed.length).toBeGreaterThanOrEqual(1);

        // 验证：至少 1 个 gap_closed 事件（另一个 target 正常关闭）
        const gapClosed = setup.events.filter(
          (e) => e.type === 'closure:gap_closed',
        );
        expect(gapClosed.length).toBeGreaterThanOrEqual(1);

        // 验证：closure:completed（所有 target 都进入终态）
        const completed = setup.events.find(
          (e) => e.type === 'closure:completed',
        );
        expect(completed).toBeDefined();
      } finally {
        setup.cleanup();
      }
    });

    it('降级路径（无 Recovery）不发出 closure:finalized 事件', async () => {
      const setup = setupOrchestrator(SAMPLE_GAPS, {
        emitDelay: 30,
        withRecovery: false,
        coverageMet: true,
      });
      try {
        setOverviewSequence(setup.coverageManager, [80.0, 82.0]);

        const session = await setup.closureManager.startClosure({
          sessionId: 'merge-1',
          maxRounds: 5,
        });

        await setup.orchestrator.startClosure(session);
        await setup.donePromise;

        // 验证：无 closure:finalized 事件（无 Recovery 结果，跳过固化）
        const finalized = setup.events.find(
          (e) => e.type === 'closure:finalized',
        );
        expect(finalized).toBeUndefined();
      } finally {
        setup.cleanup();
      }
    });
  });

  // ─── AI Exclusion 建议链路（工单 07 / PRD US-30~33） ──────────

  describe('AI Exclusion 建议', () => {
    /** 含单条 file/line 建议 + 单条 bin 建议的 AI 回复文本 */
    const AI_TEXT_WITH_SUGGESTIONS = [
      '经分析，以下覆盖项判定为 dead_code，建议人工审查豁免：',
      '```exclusion-suggestions',
      JSON.stringify(
        [
          {
            module: 'cpu_core',
            metric: 'line',
            file: 'rtl/cpu_core.sv',
            line: 142,
            reason: '该分支受 power-down 门控，正常功能模式下不可达，仅 DFT 模式可激活',
            confidence: 0.86,
          },
          {
            module: 'cpu_core',
            metric: 'functional',
            bin: 'err_inject.bin_backdoor',
            reason: 'backdoor 注入路径仅验证平台自检使用，前门访问永不触发',
            confidence: 0.92,
          },
        ],
        null,
        2,
      ),
      '```',
    ].join('\n');

    it('AI 输出 exclusion-suggestions 块时，建议被持久化并发出 closure:exclusion_suggested 事件', async () => {
      const setup = setupOrchestrator(SAMPLE_GAPS, {
        emitDelay: 30,
        assistantText: AI_TEXT_WITH_SUGGESTIONS,
      });
      try {
        setOverviewSequence(setup.coverageManager, [80.0, 82.0]);

        const session = await setup.closureManager.startClosure({
          sessionId: 'merge-1',
          maxRounds: 5,
        });

        await setup.orchestrator.startClosure(session);
        await setup.donePromise;

        // 验证：closure:exclusion_suggested 事件（count=2）
        const suggested = setup.events.find(
          (e) => e.type === 'closure:exclusion_suggested',
        );
        expect(suggested).toBeDefined();
        expect((suggested as { count: number }).count).toBe(2);
        expect((suggested as { targetId: string }).targetId).toBe(
          session.targets[0].id,
        );
        expect((suggested as { round: number }).round).toBe(1);

        // 验证：建议已持久化（listExclusionSuggestions 可查）
        const byTarget = await setup.closureManager.listExclusionSuggestions(session.id);
        const list = byTarget[session.targets[0].id];
        expect(list).toHaveLength(2);
        expect(list[0].module).toBe('cpu_core');
        expect(list[0].file).toBe('rtl/cpu_core.sv');
        expect(list[0].line).toBe(142);
        expect(list[1].bin).toBe('err_inject.bin_backdoor');
      } finally {
        setup.cleanup();
      }
    });

    it('AI 无自动排除断言：持久化建议状态固定 pending、来源固定 ai-triage', async () => {
      const setup = setupOrchestrator(SAMPLE_GAPS, {
        emitDelay: 30,
        assistantText: AI_TEXT_WITH_SUGGESTIONS,
      });
      try {
        setOverviewSequence(setup.coverageManager, [80.0, 82.0]);

        const session = await setup.closureManager.startClosure({
          sessionId: 'merge-1',
          maxRounds: 5,
        });

        await setup.orchestrator.startClosure(session);
        await setup.donePromise;

        const byTarget = await setup.closureManager.listExclusionSuggestions(session.id);
        const list = byTarget[session.targets[0].id];
        expect(list).toHaveLength(2);
        // 安全底线（PRD US-33）：AI 只能建议（pending），绝不自动审批
        for (const s of list) {
          expect(s.status).toBe('pending');
          expect(s.requestedBy).toBe('ai-triage');
        }
      } finally {
        setup.cleanup();
      }
    });

    it('AI 回复无 exclusion 块时不产生建议、不发出事件', async () => {
      const setup = setupOrchestrator(SAMPLE_GAPS, {
        emitDelay: 30,
        assistantText: '根因为缺少定向测试，已生成新用例，无需豁免。',
      });
      try {
        setOverviewSequence(setup.coverageManager, [80.0, 82.0]);

        const session = await setup.closureManager.startClosure({
          sessionId: 'merge-1',
          maxRounds: 5,
        });

        await setup.orchestrator.startClosure(session);
        await setup.donePromise;

        // 验证：无 exclusion_suggested 事件
        const suggested = setup.events.find(
          (e) => e.type === 'closure:exclusion_suggested',
        );
        expect(suggested).toBeUndefined();

        // 验证：无持久化建议
        const byTarget = await setup.closureManager.listExclusionSuggestions(session.id);
        expect(Object.keys(byTarget)).toHaveLength(0);
      } finally {
        setup.cleanup();
      }
    });

    it('AI 输出畸形 JSON 块时静默跳过，不阻断迭代主流程', async () => {
      const setup = setupOrchestrator(SAMPLE_GAPS, {
        emitDelay: 30,
        assistantText: '```exclusion-suggestions\n[{ broken json !!\n```',
      });
      try {
        setOverviewSequence(setup.coverageManager, [80.0, 82.0]);

        const session = await setup.closureManager.startClosure({
          sessionId: 'merge-1',
          maxRounds: 5,
        });

        await setup.orchestrator.startClosure(session);
        await setup.donePromise;

        // 验证：无事件、无建议
        expect(
          setup.events.find((e) => e.type === 'closure:exclusion_suggested'),
        ).toBeUndefined();
        const byTarget = await setup.closureManager.listExclusionSuggestions(session.id);
        expect(Object.keys(byTarget)).toHaveLength(0);

        // 验证：迭代主流程不受影响（正常关闭 + completed）
        const closed = setup.events.find((e) => e.type === 'closure:gap_closed');
        expect(closed).toBeDefined();
        const completed = setup.events.find((e) => e.type === 'closure:completed');
        expect(completed).toBeDefined();
      } finally {
        setup.cleanup();
      }
    });
  });
});
