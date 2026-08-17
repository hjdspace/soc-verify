/**
 * Closure Manager（ADR 0025：模块级 Closure Target）。
 *
 * 管理 Coverage Closure 的生命周期：用户选中模块 → 聚合该模块全部未达标 metric
 * 为一个 ClosureTarget → 生成定向测试 → 运行仿真 → 检查 Delta → 迭代。
 * 一个 directed test 通常同时提升同模块多种 code metric，模块级工作项避免
 * per-gap 模式下重复读 RTL / 生成冲突测试（取代 ADR 0009 决策 8）。
 *
 * 达标判定：target 模块全部 metric 达到 Coverage Target 才算 met（isTargetMet
 * 纯函数，由 completeIteration 调用方传入最新覆盖率数据评估）。
 * 升级判定：连续 N 轮（默认 2）overall delta < 1% → escalated 转人工审查。
 *
 * 持久化布局（ADR 0009 决策 7 + ADR 0025 决策 5）：
 *   .socverify/coverage/closure/
 *   ├── closures.json                    # Closure Session 列表
 *   ├── <closureId>/
 *   │   ├── closure.json                 # 完整 ClosureSession 数据
 *   │   ├── <targetId>/
 *   │   │   ├── round_1/                 # 每轮迭代的测试文件 / Recovery 报告
 *   │   │   │   ├── test_xxx.sv
 *   │   │   │   └── vseq_xxx.sv
 *   │   │   ├── round_2/
 *   │   │   └── ...
 *   │   └── triage.json
 *
 * 旧数据兼容：加载 per-gap 时代（ADR 0009 决策 8）的 closure.json 时，
 * 每个 gap 迁移为单 metric 的 target（见 migrateLegacySession）。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CoverageGap,
  CoverageDelta,
  CoverageSummary,
  CoverageMetric,
  CoverageTriplet,
} from '@shared/types';
import { detectGaps } from '@shared/types';
import type { CoverageManager } from './coverage-manager';
import type { ExclusionSuggestion } from './exclusion-suggestions';

const SOCVERIFY_DIR = '.socverify';
const COVERAGE_DIR = 'coverage';
const CLOSURE_DIR = 'closure';
const CLOSURES_FILE = 'closures.json';
const CLOSURE_DATA_FILE = 'closure.json';
const TRIAGE_FILE = 'triage.json';

/** 升级判定阈值：overall delta（百分点）低于此值视为无显著提升 */
const ESCALATION_DELTA_THRESHOLD = 1;
/** 默认触发升级的连续低 delta 轮数 */
const DEFAULT_ESCALATION_THRESHOLD = 2;
/** 默认最大迭代轮数 */
const DEFAULT_MAX_ROUNDS = 5;

export type ClosureStatus = 'pending' | 'running' | 'completed' | 'failed' | 'aborted';

export type TargetIterationStatus = 'pending' | 'running' | 'completed' | 'failed';

export type TargetIteration = {
  round: number;
  /** 本轮生成的测试文件路径（在 Closure Workspace 中） */
  generatedTests: string[];
  /** 本轮运行前后的覆盖率 delta */
  deltaBefore?: CoverageSummary;
  deltaAfter?: CoverageSummary;
  /** 逐 metric 变化 */
  deltas?: CoverageDelta[];
  /**
   * 豁免前覆盖率快照（per metric 三元组，ADR 0026 决策 4）。
   * 未应用任何 exclusion 时与 afterExclusionMetrics 相等。
   */
  beforeExclusionMetrics?: Record<CoverageMetric, CoverageTriplet>;
  /**
   * 豁免后覆盖率快照（per metric 三元组）。
   * 达标判定基于此数字——completeIteration 传入的 coverage 即
   * Recovery 应用 EL 后重新生成的报告结果（urg -elfile 天然把被排除项
   * 移出 covered/total 计数，无需额外处理）。
   */
  afterExclusionMetrics?: Record<CoverageMetric, CoverageTriplet>;
  /** 本轮状态 */
  status: TargetIterationStatus;
  /** 失败原因 */
  error?: string;
};

export type ClosureTargetStatus = 'pending' | 'in_progress' | 'closed' | 'escalated' | 'failed';

/** 目标模块标识 */
export type TargetModule = {
  /** 模块在 Coverage Tree 中的路径（如 top/cpu_core） */
  path: string;
  /** 模块名（如 cpu_core） */
  name: string;
};

/**
 * 模块级闭环工作项（ADR 0025 决策 2）。
 * 一个模块的全部未达标 metric 聚合为单 target，一个 omp 会话一轮内一起补。
 */
export type ClosureTarget = {
  id: string;
  /** 目标模块 */
  module: TargetModule;
  /** 该模块全部未达标 metric（启动时的 gap 快照） */
  gaps: CoverageGap[];
  /** 迭代历史 */
  iterations: TargetIteration[];
  /** 当前状态 */
  status: ClosureTargetStatus;
  /** 升级/失败原因（连续 N 轮 delta < 1% 或不可恢复错误） */
  escalationReason?: string;
};

export type ClosureSession = {
  id: string; // closure_YYYYMMDD_HHMMSS_xxxx
  /** 关联的 Coverage Merge Session */
  sessionId: string;
  createdAt: number;
  status: ClosureStatus;
  /** 模块级工作项列表 */
  targets: ClosureTarget[];
  /** 最大迭代轮数（默认 5） */
  maxRounds: number;
  /** 触发升级的连续低 delta 轮数（默认 2） */
  escalationThreshold: number;
  /** Closure Workspace 目录 */
  workspaceDir: string;
};

/** completeIteration 时由调用方传入的最新覆盖率数据（用于达标评估） */
export type TargetCoverageSnapshot = {
  /** 目标模块当前的 8 metric 三元组 */
  metrics: Record<CoverageMetric, CoverageTriplet>;
  /** 当前生效的 Coverage Target 配置 */
  targets: Partial<Record<CoverageMetric, number>>;
};

/** startClosure 输入 */
export type StartClosureInput = {
  sessionId: string;
  /**
   * 用户选中的模块路径列表。缺省时自动聚合 Coverage Tree 中全部有 gap 的模块；
   * 选中的模块若无 gap 则跳过（不产生 target）。
   */
  modules?: string[];
  maxRounds?: number;
  escalationThreshold?: number;
};

/**
 * 持久化到 triage.json 的 AI exclusion 建议（ADR 0026 决策 1）。
 * 状态固定 pending：审批状态以 CoverageManager 排除库为唯一 source of truth，
 * triage.json 只记录 AI 建议的初始形态与镜像 exclusion id。
 */
export type StoredExclusionSuggestion = ExclusionSuggestion & {
  /** 持久化 id */
  id: string;
  /** 镜像写入 CoverageManager 排除库的 exclusion id（审批面板据此逐条 approve/reject） */
  exclusionId?: string;
  createdAt: number;
};

export interface ClosureManagerOptions {
  projectRoot: string;
  coverageManager: CoverageManager;
}

/**
 * 达标判定（纯函数，ADR 0025 决策 2）：
 * target 模块全部未达标 metric 达到 Coverage Target 才算 met。
 * - N/A metric（percentage=null）不阻断
 * - targets 配置中无目标的 metric 不阻断
 */
export function isTargetMet(
  target: ClosureTarget,
  metrics: Record<CoverageMetric, CoverageTriplet>,
  targets: Partial<Record<CoverageMetric, number>>,
): boolean {
  return target.gaps.every((gap) => {
    const current = metrics[gap.metric]?.percentage;
    // N/A metric 不阻断达标判定
    if (current === null || current === undefined) return true;
    const targetPct = targets[gap.metric];
    // 无目标的 metric 不阻断达标判定
    if (targetPct === undefined) return true;
    return current >= targetPct;
  });
}

// ─── 旧数据迁移（per-gap → per-target） ─────────────────────────

/** 旧格式（ADR 0009 决策 8）的 per-gap 工作项 */
type LegacyClosureGap = {
  id: string;
  gap: CoverageGap;
  iterations: TargetIteration[];
  status: ClosureTargetStatus;
  escalationReason?: string;
};

/**
 * 将旧 per-gap 格式的 session 迁移为模块级 target 格式。
 *
 * 迁移决策（单用户桌面应用，选择实现成本最低的保真方案）：
 * - 每个旧 gap 独立转为单 metric 的 target，不合并同模块 gap——
 *   合并会丢失「迭代历史 ↔ workspace round 目录」的对应关系
 * - 保留原 id，使 <targetId>/round_N/ 目录路径与磁盘上已有数据继续对齐
 * - 仅在内存迁移、不回写磁盘；下次加载重复迁移（幂等）
 * - status 缺失时保守置为 failed（终态）
 */
function migrateLegacySession(session: ClosureSession): ClosureSession {
  const legacy = session as unknown as Partial<{ targets: unknown; gaps: unknown }>;
  if (Array.isArray(legacy.targets)) return session; // 已是新格式
  const legacyGaps = legacy.gaps as LegacyClosureGap[] | undefined;
  if (!Array.isArray(legacyGaps)) return session; // 未知格式，原样返回

  return {
    id: session.id,
    sessionId: session.sessionId,
    createdAt: session.createdAt,
    status: session.status,
    targets: legacyGaps.map((g) => ({
      id: g.id,
      module: { path: g.gap.nodePath, name: g.gap.nodeName },
      gaps: [g.gap],
      iterations: Array.isArray(g.iterations) ? g.iterations : [],
      status: g.status ?? 'failed',
      escalationReason: g.escalationReason,
    })),
    maxRounds: session.maxRounds ?? DEFAULT_MAX_ROUNDS,
    escalationThreshold: session.escalationThreshold ?? DEFAULT_ESCALATION_THRESHOLD,
    workspaceDir: session.workspaceDir,
  };
}

/**
 * 管理 Coverage Closure 的生命周期（ADR 0025）。
 * 每次 Closure 为每个选中模块创建独立的模块级工作项（ClosureTarget），
 * 记录迭代历史与 delta，连续 N 轮无显著提升时触发升级。
 * 纯状态机风格：仅做持久化 IO，达标/升级判定为可独立测试的纯函数。
 */
export class ClosureManager {
  private projectRoot: string;
  private coverageManager: CoverageManager;

  constructor(opts: ClosureManagerOptions) {
    this.projectRoot = opts.projectRoot;
    this.coverageManager = opts.coverageManager;
  }

  /**
   * 启动一次 Coverage Closure：从 CoverageManager 读取 Coverage Tree，
   * 用 detectGaps 聚合出每个选中模块的 ClosureTarget。
   * 模块无 gap 时跳过；聚合结果为空（全部无 gap）时抛错。
   */
  async startClosure(input: StartClosureInput): Promise<ClosureSession> {
    // 读取 Coverage Tree + 生效的 targets 配置，detectGaps 全量检测后按模块分组
    const data = await this.coverageManager.getTree(input.sessionId);
    const targetsCfg = await this.coverageManager.getTargets(data.sessionId);
    const allGaps = detectGaps(data.root, targetsCfg);
    const selected = input.modules
      ? allGaps.filter((g) => input.modules!.includes(g.nodePath))
      : allGaps;

    // 按模块路径分组：同模块全部未达标 metric 聚合为单 target（ADR 0025 决策 2）
    const byModule = new Map<string, CoverageGap[]>();
    for (const gap of selected) {
      const list = byModule.get(gap.nodePath) ?? [];
      list.push(gap);
      byModule.set(gap.nodePath, list);
    }
    if (byModule.size === 0) {
      throw new Error(
        input.modules
          ? `选中的模块均无未达标 metric，无法启动 Closure: ${input.modules.join(', ')}`
          : 'Coverage Tree 中无未达标 metric，无法启动 Closure',
      );
    }

    const closureId = this.generateClosureId();
    const workspaceDir = this.workspacePath(closureId);
    const session: ClosureSession = {
      id: closureId,
      sessionId: input.sessionId,
      createdAt: Date.now(),
      status: 'running',
      targets: Array.from(byModule.entries()).map(([path, gaps]) => ({
        id: this.generateTargetId(),
        module: { path, name: gaps[0].nodeName },
        gaps,
        iterations: [],
        status: 'pending' as ClosureTargetStatus,
      })),
      maxRounds: input.maxRounds ?? DEFAULT_MAX_ROUNDS,
      escalationThreshold: input.escalationThreshold ?? DEFAULT_ESCALATION_THRESHOLD,
      workspaceDir,
    };

    // 创建 workspace 目录及每个 target 的子目录
    await mkdir(workspaceDir, { recursive: true });
    for (const target of session.targets) {
      await mkdir(join(workspaceDir, target.id), { recursive: true });
    }

    await this.persist(session);
    return session;
  }

  /** 获取 Closure Session 状态 */
  async getClosure(closureId: string): Promise<ClosureSession | null> {
    const list = await this.loadClosures();
    return list.find((c) => c.id === closureId) ?? null;
  }

  /** 列出所有 Closure Session */
  async listClosures(): Promise<ClosureSession[]> {
    return this.loadClosures();
  }

  /**
   * 记录一轮迭代的开始。
   * 同时创建 <targetId>/round_N/ 目录（AI 生成的测试文件与 Recovery 报告写入此处）。
   */
  async startIteration(closureId: string, targetId: string): Promise<TargetIteration> {
    const session = await this.requireClosure(closureId);
    this.assertActive(session);
    const target = this.requireTarget(session, targetId);
    const round = target.iterations.length + 1;
    const iteration: TargetIteration = {
      round,
      generatedTests: [],
      status: 'running',
    };
    target.iterations.push(iteration);
    // target 从 pending 进入 in_progress
    if (target.status === 'pending') {
      target.status = 'in_progress';
    }
    await mkdir(join(session.workspaceDir, targetId, `round_${round}`), { recursive: true });
    await this.persist(session);
    return iteration;
  }

  /**
   * 记录一轮迭代的结果（生成的测试 + delta）。
   * 若调用方传入最新覆盖率数据（coverage），先做达标评估（达标 → closed），
   * 再做升级评估（连续 N 轮低 delta → escalated）。达标优先于升级。
   *
   * 豁免后达标语义（ADR 0026 决策 4）：传入的 coverage 即 Recovery 应用 EL 后
   * 重新生成的报告快照——urg -elfile 天然将被排除项移出 covered/total 计数，
   * 因此 isTargetMet 的达标判定天然基于豁免后数字，无需额外换算。
   * 迭代历史同时记录豁免前后两套数字（coverageBeforeExclusion 缺省 = coverage，
   * 即未应用豁免时两套相等），保证豁免影响可追溯。
   */
  async completeIteration(
    closureId: string,
    targetId: string,
    result: {
      generatedTests: string[];
      deltaBefore: CoverageSummary;
      deltaAfter: CoverageSummary;
      deltas: CoverageDelta[];
      /** 供达标评估的最新覆盖率数据（豁免后数字）；缺省时仅做升级判定 */
      coverage?: TargetCoverageSnapshot;
      /**
       * 豁免前覆盖率快照（per metric 三元组）。
       * 缺省 = coverage.metrics（未应用豁免时豁免前后两套数字相等）。
       */
      coverageBeforeExclusion?: Record<CoverageMetric, CoverageTriplet>;
    },
  ): Promise<TargetIteration> {
    const session = await this.requireClosure(closureId);
    this.assertActive(session);
    const target = this.requireTarget(session, targetId);
    const iteration = target.iterations[target.iterations.length - 1];
    if (!iteration) {
      throw new Error(`No active iteration in target ${targetId} of closure ${closureId}`);
    }
    iteration.generatedTests = result.generatedTests;
    iteration.deltaBefore = result.deltaBefore;
    iteration.deltaAfter = result.deltaAfter;
    iteration.deltas = result.deltas;
    iteration.status = 'completed';

    // 豁免前后双数字（ADR 0026 决策 4）：未传豁免前快照时两套相等
    if (result.coverage) {
      iteration.afterExclusionMetrics = result.coverage.metrics;
      iteration.beforeExclusionMetrics =
        result.coverageBeforeExclusion ?? result.coverage.metrics;
    }

    // 达标判定优先：模块全部 metric 达到 Coverage Target → closed（基于豁免后数字）
    if (
      result.coverage &&
      isTargetMet(target, result.coverage.metrics, result.coverage.targets)
    ) {
      target.status = 'closed';
    } else if (this.shouldEscalate(target, session.escalationThreshold)) {
      // 连续 N 轮 overall delta < 1% → 升级转人工
      target.status = 'escalated';
      target.escalationReason =
        `连续 ${session.escalationThreshold} 轮 overall delta < ${ESCALATION_DELTA_THRESHOLD}%`;
    }

    this.maybeCompleteClosure(session);
    await this.persist(session);
    return iteration;
  }

  /** 标记一轮迭代失败 */
  async failIteration(closureId: string, targetId: string, error: string): Promise<void> {
    const session = await this.requireClosure(closureId);
    const target = this.requireTarget(session, targetId);
    const iteration = target.iterations[target.iterations.length - 1];
    if (iteration) {
      iteration.status = 'failed';
      iteration.error = error;
    }
    await this.persist(session);
  }

  /**
   * 标记 Target 为失败（不可恢复的错误，如会话创建失败、prompt 失败、agent 执行失败）。
   * 将 target 置于 failed 终态，并尝试自动完成 Closure（当所有 target 均进入终态时）。
   * 复用 escalationReason 字段记录失败原因。
   */
  async failTarget(closureId: string, targetId: string, reason: string): Promise<void> {
    const session = await this.requireClosure(closureId);
    const target = this.requireTarget(session, targetId);
    target.status = 'failed';
    target.escalationReason = reason;
    this.maybeCompleteClosure(session);
    await this.persist(session);
  }

  /** 检查是否应该升级（连续 N 轮 delta < 阈值，纯函数） */
  shouldEscalate(target: ClosureTarget, threshold = DEFAULT_ESCALATION_THRESHOLD): boolean {
    // 仅检查已完成且带有 delta 数据的迭代
    const completed = target.iterations.filter(
      (it) => it.status === 'completed' && it.deltaBefore !== undefined && it.deltaAfter !== undefined,
    );
    if (completed.length < threshold) return false;
    const recent = completed.slice(-threshold);
    // 每轮 overall delta < 1% 才升级
    return recent.every((it) => {
      const delta = it.deltaAfter!.overall - it.deltaBefore!.overall;
      return delta < ESCALATION_DELTA_THRESHOLD;
    });
  }

  /** 标记 Target 为已关闭（达标） */
  async closeTarget(closureId: string, targetId: string): Promise<void> {
    const session = await this.requireClosure(closureId);
    const target = this.requireTarget(session, targetId);
    target.status = 'closed';
    this.maybeCompleteClosure(session);
    await this.persist(session);
  }

  /** 标记 Target 为已升级（转人工审查） */
  async escalateTarget(closureId: string, targetId: string, reason: string): Promise<void> {
    const session = await this.requireClosure(closureId);
    const target = this.requireTarget(session, targetId);
    target.status = 'escalated';
    target.escalationReason = reason;
    this.maybeCompleteClosure(session);
    await this.persist(session);
  }

  // ─── AI Exclusion 建议（ADR 0026 决策 1） ─────────────────────

  /**
   * 记录 AI 在 triage 升级时输出的 exclusion 建议（工单 07）。
   *
   * - 校验：reason 必填、confidence ∈ [0,1]、selector 形态（file/line 或 bin）完整
   * - 持久化：写入 <closureId>/triage.json（按 targetId 分组），状态固定 pending
   * - 镜像：每条建议同步写入 CoverageManager 排除库（requestExclusion，
   *   sessionId 取 closure.sessionId），保证 listExclusions / 审批面板可查
   *
   * 安全底线（PRD US-33）：本方法只产生 pending 建议，绝不调用 approveExclusion
   * ——AI 无任何自动排除路径，approve/reject 只能人工触发（审批面板 UI）。
   *
   * @returns 持久化后的建议列表（含 id 与镜像 exclusionId）
   */
  async addExclusionSuggestions(
    closureId: string,
    targetId: string,
    suggestions: ExclusionSuggestion[],
  ): Promise<StoredExclusionSuggestion[]> {
    const session = await this.requireClosure(closureId);
    this.requireTarget(session, targetId);
    if (!Array.isArray(suggestions) || suggestions.length === 0) {
      throw new Error('addExclusionSuggestions: suggestions must be a non-empty array');
    }
    for (const [i, s] of suggestions.entries()) {
      if (!s || typeof s.reason !== 'string' || s.reason.trim() === '') {
        throw new Error(`addExclusionSuggestions: suggestions[${i}].reason is required`);
      }
      if (
        typeof s.confidence !== 'number' ||
        !Number.isFinite(s.confidence) ||
        s.confidence < 0 ||
        s.confidence > 1
      ) {
        throw new Error(
          `addExclusionSuggestions: suggestions[${i}].confidence must be within [0, 1]`,
        );
      }
      const hasFileLine =
        typeof s.file === 'string' && s.file.trim() !== '' &&
        typeof s.line === 'number' && Number.isInteger(s.line) && s.line > 0;
      const hasBin = typeof s.bin === 'string' && s.bin.trim() !== '';
      if (!hasFileLine && !hasBin) {
        throw new Error(
          `addExclusionSuggestions: suggestions[${i}] needs a file/line or bin selector`,
        );
      }
    }

    // 持久化到 triage.json（镜像写入失败时回滚内存态并抛错，保持两库一致）
    const stored = await this.loadTriage(closureId);
    const entries: StoredExclusionSuggestion[] = [];
    for (const s of suggestions) {
      const entry: StoredExclusionSuggestion = {
        ...s,
        status: 'pending',
        requestedBy: 'ai-triage',
        id: this.generateId('sugg'),
        createdAt: Date.now(),
      };
      // 镜像写入 CoverageManager 排除库（sessionId 域，listExclusions 可查）
      const mirror = await this.coverageManager.requestExclusion({
        sessionId: session.sessionId,
        nodePath: s.module,
        metric: s.metric,
        reason: s.reason,
        requestedBy: 'ai-triage',
        file: s.file,
        line: s.line,
        bin: s.bin,
        confidence: s.confidence,
      });
      entry.exclusionId = mirror.id;
      entries.push(entry);
    }
    stored[targetId] = [...(stored[targetId] ?? []), ...entries];
    await this.saveTriage(closureId, stored);
    return entries;
  }

  /**
   * 列出指定 closure 的 AI exclusion 建议（全部 target，按 targetId 分组）。
   * 审批状态以 CoverageManager.listExclusions 为准（本列表固定记录 pending 初始态）。
   */
  async listExclusionSuggestions(
    closureId: string,
  ): Promise<Record<string, StoredExclusionSuggestion[]>> {
    await this.requireClosure(closureId);
    return this.loadTriage(closureId);
  }

  /** 中止 Closure Session */
  async abortClosure(closureId: string): Promise<void> {
    const session = await this.requireClosure(closureId);
    // 所有未终结的 target（pending / in_progress）标记为 failed
    for (const target of session.targets) {
      if (target.status === 'pending' || target.status === 'in_progress') {
        target.status = 'failed';
      }
    }
    session.status = 'aborted';
    await this.persist(session);
  }

  /** 获取 Closure Workspace 目录路径 */
  getWorkspaceDir(closureId: string): string {
    return this.workspacePath(closureId);
  }

  // ─── 内部实现 ─────────────────────────────────────────────────

  /** 当所有 target 进入终态时，Closure 自动标记为 completed */
  private maybeCompleteClosure(session: ClosureSession): void {
    const terminal: ClosureTargetStatus[] = ['closed', 'escalated', 'failed'];
    const allDone = session.targets.every((t) => terminal.includes(t.status));
    if (allDone && session.targets.length > 0) {
      session.status = 'completed';
    }
  }

  private assertActive(session: ClosureSession): void {
    if (session.status === 'aborted') {
      throw new Error(`Closure ${session.id} has been aborted`);
    }
    if (session.status === 'completed') {
      throw new Error(`Closure ${session.id} has been completed`);
    }
  }

  private async requireClosure(closureId: string): Promise<ClosureSession> {
    const session = await this.getClosure(closureId);
    if (!session) {
      throw new Error(`Closure ${closureId} not found`);
    }
    return session;
  }

  private requireTarget(session: ClosureSession, targetId: string): ClosureTarget {
    const target = session.targets.find((t) => t.id === targetId);
    if (!target) {
      throw new Error(`Target ${targetId} not found in closure ${session.id}`);
    }
    return target;
  }

  private workspacePath(closureId: string): string {
    return join(this.projectRoot, SOCVERIFY_DIR, COVERAGE_DIR, CLOSURE_DIR, closureId);
  }

  private closuresFilePath(): string {
    return join(this.projectRoot, SOCVERIFY_DIR, COVERAGE_DIR, CLOSURE_DIR, CLOSURES_FILE);
  }

  private closureDataPath(closureId: string): string {
    return join(this.workspacePath(closureId), CLOSURE_DATA_FILE);
  }

  /** triage.json 路径：<closureId>/triage.json（AI exclusion 建议持久化） */
  private triageDataPath(closureId: string): string {
    return join(this.workspacePath(closureId), TRIAGE_FILE);
  }

  private async loadTriage(closureId: string): Promise<Record<string, StoredExclusionSuggestion[]>> {
    try {
      const raw = await readFile(this.triageDataPath(closureId), 'utf-8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, StoredExclusionSuggestion[]>)
        : {};
    } catch {
      return {};
    }
  }

  private async saveTriage(
    closureId: string,
    data: Record<string, StoredExclusionSuggestion[]>,
  ): Promise<void> {
    await mkdir(this.workspacePath(closureId), { recursive: true });
    await writeFile(this.triageDataPath(closureId), JSON.stringify(data, null, 2), 'utf-8');
  }

  private async loadClosures(): Promise<ClosureSession[]> {
    try {
      const raw = await readFile(this.closuresFilePath(), 'utf-8');
      const list = JSON.parse(raw);
      // 旧 per-gap 格式在加载时迁移为模块级 target 格式（内存迁移，不回写）
      return Array.isArray(list) ? (list as ClosureSession[]).map(migrateLegacySession) : [];
    } catch {
      return [];
    }
  }

  /** 持久化：同时写入 closures.json（列表）与 <closureId>/closure.json（单条） */
  private async persist(session: ClosureSession): Promise<void> {
    const list = await this.loadClosures();
    const idx = list.findIndex((c) => c.id === session.id);
    if (idx >= 0) {
      list[idx] = session;
    } else {
      list.push(session);
    }
    const dir = join(this.projectRoot, SOCVERIFY_DIR, COVERAGE_DIR, CLOSURE_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(this.closuresFilePath(), JSON.stringify(list, null, 2), 'utf-8');
    await mkdir(this.workspacePath(session.id), { recursive: true });
    await writeFile(this.closureDataPath(session.id), JSON.stringify(session, null, 2), 'utf-8');
  }

  private generateClosureId(): string {
    const ts = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp =
      `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}` +
      `_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
    const rand = Math.random().toString(36).slice(2, 6);
    return `closure_${stamp}_${rand}`;
  }

  private generateTargetId(): string {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 6);
    return `target_${ts}_${rand}`;
  }

  private generateId(prefix: string): string {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `${prefix}_${ts}_${rand}`;
  }
}
