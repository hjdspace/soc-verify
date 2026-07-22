/**
 * Closure Manager（ADR 0009）。
 *
 * 管理 Coverage Closure 的生命周期：识别 Gap → 生成定向测试 → 运行仿真 →
 * 检查 Delta → 迭代。每个 Gap 拥有独立的迭代历史，连续 N 轮 overall delta
 * < 1% 触发升级（转人工审查）。
 *
 * 持久化布局（ADR 0009 决策 7）：
 *   .socverify/coverage/closure/
 *   ├── closures.json                    # Closure Session 列表
 *   ├── <closureId>/
 *   │   ├── closure.json                 # 完整 ClosureSession 数据
 *   │   ├── <gapId>/
 *   │   │   ├── round_1/                 # 每轮迭代的测试文件
 *   │   │   │   ├── test_xxx.sv
 *   │   │   │   └── vseq_xxx.sv
 *   │   │   ├── round_2/
 *   │   │   └── ...
 *   │   └── triage.json
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CoverageGap, CoverageDelta, CoverageSummary } from '@shared/types';
import type { CoverageManager } from './coverage-manager';

const SOCVERIFY_DIR = '.socverify';
const COVERAGE_DIR = 'coverage';
const CLOSURE_DIR = 'closure';
const CLOSURES_FILE = 'closures.json';
const CLOSURE_DATA_FILE = 'closure.json';

/** 升级判定阈值：overall delta（百分点）低于此值视为无显著提升 */
const ESCALATION_DELTA_THRESHOLD = 1;
/** 默认触发升级的连续低 delta 轮数 */
const DEFAULT_ESCALATION_THRESHOLD = 2;
/** 默认最大迭代轮数 */
const DEFAULT_MAX_ROUNDS = 5;

export type ClosureStatus = 'pending' | 'running' | 'completed' | 'failed' | 'aborted';

export type GapIterationStatus = 'pending' | 'running' | 'completed' | 'failed';

export type GapIteration = {
  round: number;
  /** 本轮生成的测试文件路径（在 Closure Workspace 中） */
  generatedTests: string[];
  /** 本轮运行前后的覆盖率 delta */
  deltaBefore?: CoverageSummary;
  deltaAfter?: CoverageSummary;
  /** 逐 metric 变化 */
  deltas?: CoverageDelta[];
  /** 本轮状态 */
  status: GapIterationStatus;
  /** 失败原因 */
  error?: string;
};

export type ClosureGapStatus = 'pending' | 'in_progress' | 'closed' | 'escalated' | 'failed';

export type ClosureGap = {
  id: string;
  /** 关联的覆盖率 Gap */
  gap: CoverageGap;
  /** 迭代历史 */
  iterations: GapIteration[];
  /** 当前状态 */
  status: ClosureGapStatus;
  /** 升级原因（连续 N 轮 delta < 1% 时触发升级） */
  escalationReason?: string;
};

export type ClosureSession = {
  id: string; // closure_YYYYMMDD_HHMMSS_xxxx
  /** 关联的 Coverage Merge Session */
  sessionId: string;
  createdAt: number;
  status: ClosureStatus;
  gaps: ClosureGap[];
  /** 最大迭代轮数（默认 5） */
  maxRounds: number;
  /** 触发升级的连续低 delta 轮数（默认 2） */
  escalationThreshold: number;
  /** Closure Workspace 目录 */
  workspaceDir: string;
};

export interface ClosureManagerOptions {
  projectRoot: string;
  coverageManager: CoverageManager;
}

/**
 * 管理 Coverage Closure 的生命周期（ADR 0009）。
 * 每次 Closure 为每个 Gap 创建独立工作项，记录迭代历史与 delta，
 * 连续 N 轮无显著提升时触发升级。
 */
export class ClosureManager {
  private projectRoot: string;
  private coverageManager: CoverageManager;

  constructor(opts: ClosureManagerOptions) {
    this.projectRoot = opts.projectRoot;
    this.coverageManager = opts.coverageManager;
  }

  /** 启动一次 Coverage Closure，为每个 Gap 创建独立的工作项 */
  async startClosure(input: {
    sessionId: string;
    gaps?: CoverageGap[]; // 缺省自动从 CoverageManager.listGaps 获取
    maxRounds?: number;
  }): Promise<ClosureSession> {
    // 缺省自动从 CoverageManager.listGaps 获取
    let gaps = input.gaps;
    if (!gaps) {
      const result = await this.coverageManager.listGaps(input.sessionId);
      gaps = result.gaps;
    }

    const closureId = this.generateClosureId();
    const workspaceDir = this.workspacePath(closureId);
    const session: ClosureSession = {
      id: closureId,
      sessionId: input.sessionId,
      createdAt: Date.now(),
      status: 'running',
      gaps: gaps.map((g) => ({
        id: this.generateGapId(),
        gap: g,
        iterations: [],
        status: 'pending' as ClosureGapStatus,
      })),
      maxRounds: input.maxRounds ?? DEFAULT_MAX_ROUNDS,
      escalationThreshold: DEFAULT_ESCALATION_THRESHOLD,
      workspaceDir,
    };

    // 创建 workspace 目录及每个 gap 的子目录
    await mkdir(workspaceDir, { recursive: true });
    for (const gap of session.gaps) {
      await mkdir(join(workspaceDir, gap.id), { recursive: true });
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

  /** 记录一轮迭代的开始 */
  async startIteration(closureId: string, gapId: string): Promise<GapIteration> {
    const session = await this.requireClosure(closureId);
    this.assertActive(session);
    const gap = this.requireGap(session, gapId);
    const round = gap.iterations.length + 1;
    const iteration: GapIteration = {
      round,
      generatedTests: [],
      status: 'running',
    };
    gap.iterations.push(iteration);
    // gap 从 pending 进入 in_progress
    if (gap.status === 'pending') {
      gap.status = 'in_progress';
    }
    await this.persist(session);
    return iteration;
  }

  /** 记录一轮迭代的结果（生成的测试 + delta） */
  async completeIteration(
    closureId: string,
    gapId: string,
    result: {
      generatedTests: string[];
      deltaBefore: CoverageSummary;
      deltaAfter: CoverageSummary;
      deltas: CoverageDelta[];
    },
  ): Promise<GapIteration> {
    const session = await this.requireClosure(closureId);
    this.assertActive(session);
    const gap = this.requireGap(session, gapId);
    const iteration = gap.iterations[gap.iterations.length - 1];
    if (!iteration) {
      throw new Error(`No active iteration in gap ${gapId} of closure ${closureId}`);
    }
    iteration.generatedTests = result.generatedTests;
    iteration.deltaBefore = result.deltaBefore;
    iteration.deltaAfter = result.deltaAfter;
    iteration.deltas = result.deltas;
    iteration.status = 'completed';

    // 检查是否应该升级（连续 N 轮 overall delta < 1%）
    if (this.shouldEscalate(gap)) {
      gap.status = 'escalated';
      gap.escalationReason =
        `连续 ${session.escalationThreshold} 轮 overall delta < ${ESCALATION_DELTA_THRESHOLD}%`;
    }

    this.maybeCompleteClosure(session);
    await this.persist(session);
    return iteration;
  }

  /** 标记一轮迭代失败 */
  async failIteration(closureId: string, gapId: string, error: string): Promise<void> {
    const session = await this.requireClosure(closureId);
    const gap = this.requireGap(session, gapId);
    const iteration = gap.iterations[gap.iterations.length - 1];
    if (iteration) {
      iteration.status = 'failed';
      iteration.error = error;
    }
    await this.persist(session);
  }

  /**
   * 标记 Gap 为失败（不可恢复的错误，如会话创建失败、prompt 失败、agent 执行失败）。
   * 将 gap 置于 failed 终态，并尝试自动完成 Closure（当所有 gap 均进入终态时）。
   * 复用 escalationReason 字段记录失败原因。
   */
  async failGap(closureId: string, gapId: string, reason: string): Promise<void> {
    const session = await this.requireClosure(closureId);
    const gap = this.requireGap(session, gapId);
    gap.status = 'failed';
    gap.escalationReason = reason;
    this.maybeCompleteClosure(session);
    await this.persist(session);
  }

  /** 检查是否应该升级（连续 N 轮 delta < 阈值） */
  shouldEscalate(gap: ClosureGap): boolean {
    const threshold = DEFAULT_ESCALATION_THRESHOLD;
    // 仅检查已完成且带有 delta 数据的迭代
    const completed = gap.iterations.filter(
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

  /** 标记 Gap 为已关闭 */
  async closeGap(closureId: string, gapId: string): Promise<void> {
    const session = await this.requireClosure(closureId);
    const gap = this.requireGap(session, gapId);
    gap.status = 'closed';
    this.maybeCompleteClosure(session);
    await this.persist(session);
  }

  /** 标记 Gap 为已升级（转人工审查） */
  async escalateGap(closureId: string, gapId: string, reason: string): Promise<void> {
    const session = await this.requireClosure(closureId);
    const gap = this.requireGap(session, gapId);
    gap.status = 'escalated';
    gap.escalationReason = reason;
    this.maybeCompleteClosure(session);
    await this.persist(session);
  }

  /** 中止 Closure Session */
  async abortClosure(closureId: string): Promise<void> {
    const session = await this.requireClosure(closureId);
    // 所有未终结的 gap（pending / in_progress）标记为 failed
    for (const gap of session.gaps) {
      if (gap.status === 'pending' || gap.status === 'in_progress') {
        gap.status = 'failed';
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

  /** 当所有 gap 进入终态时，Closure 自动标记为 completed */
  private maybeCompleteClosure(session: ClosureSession): void {
    const terminal: ClosureGapStatus[] = ['closed', 'escalated', 'failed'];
    const allDone = session.gaps.every((g) => terminal.includes(g.status));
    if (allDone && session.gaps.length > 0) {
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

  private requireGap(session: ClosureSession, gapId: string): ClosureGap {
    const gap = session.gaps.find((g) => g.id === gapId);
    if (!gap) {
      throw new Error(`Gap ${gapId} not found in closure ${session.id}`);
    }
    return gap;
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

  private async loadClosures(): Promise<ClosureSession[]> {
    try {
      const raw = await readFile(this.closuresFilePath(), 'utf-8');
      const list = JSON.parse(raw);
      return Array.isArray(list) ? (list as ClosureSession[]) : [];
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

  private generateGapId(): string {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 6);
    return `gap_${ts}_${rand}`;
  }
}
