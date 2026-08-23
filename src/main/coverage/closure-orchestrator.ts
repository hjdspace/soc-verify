/**
 * ClosureOrchestrator — AI Coverage Closure 闭环编排器（ADR 0009 / Issue #8 Slice 6b，
 * 工作项模型按 ADR 0025 重构为模块级 ClosureTarget）。
 *
 * 驱动 AI 闭环：模块级 Target（同模块全部未达标 metric 聚合）→ 创建独立 Agent 会话 →
 * 生成定向测试 → 等待 agent_end → 扫描生成的测试 → 计算 delta → 记录迭代 →
 * 判定达标/升级/关闭 → 销毁会话。
 *
 * 关键设计：
 *   - 每个 Target 拥有独立 omp 会话（cwd = Closure Workspace，workspace 隔离）
 *   - 多 Target 并行调度（Promise.allSettled，受 SessionManager 并发上限限制）
 *   - prompt 为 fire-and-forget，通过监听 sessionEvent 的 agent_end 事件获知完成
 *   - waitForAgentEnd 含 10 分钟超时 + error 事件立即拒绝
 *   - AbortController 实现中止：abort 后所有运行中的 Target 循环退出
 *   - 通过注入的 emit 回调向 router 层推送实时事件（router 层负责 mainWindow.webContents.send）
 *
 * 事件流（通过 emit 回调发出；事件名沿用 Slice 6b 契约，载荷字段为 targetId）：
 *   - closure:started         { closureId, targetCount }
 *   - closure:gap_started     { closureId, targetId, round }
 *   - closure:agent_prompting { closureId, targetId, round, sessionId }
 *   - closure:agent_ended     { closureId, targetId, round, sessionId }
 *   - closure:tests_scanned   { closureId, targetId, round, files }
 *   - closure:recovery_started { closureId, targetId, round }
 *   - closure:recovery_done   { closureId, targetId, round, deltaOverall }
 *   - closure:recovery_failed { closureId, targetId, round, error }
 *   - closure:iteration_done  { closureId, targetId, round, deltaBefore, deltaAfter }
 *   - closure:gap_closed      { closureId, targetId }
 *   - closure:gap_escalated   { closureId, targetId, reason }
 *   - closure:exclusion_suggested { closureId, targetId, round, count }  （工单 07）
 *   - closure:gap_failed      { closureId, targetId, error }
 *   - closure:completed       { closureId }
 *   - closure:aborted         { closureId }
 *   - closure:error           { closureId, error }
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CoverageSummary, CoverageDelta, CoverageNode, EdaToolConfig } from '@shared/types';
import { calculateDelta } from '@shared/types';
import type { ClosureManager } from './closure-manager';
import type { ClosureTarget, ClosureSession, TargetCoverageSnapshot } from './closure-manager';
import type { CoverageManager } from './coverage-manager';
import type { SessionManagerImpl } from '../agent/session-manager';
import type { PluginBackedDiscovery, PluginBackedSimulation, PluginBackedCoverage } from '../plugin-adapters';
import { executeRecovery, persistRecoveryResult, type RecoveryResult } from './coverage-recovery';
import type { CommandRunner } from './coverage-report-generator';
import { parseExclusionSuggestions, buildExclusionPromptSection } from './exclusion-suggestions';

/** Closure 事件载荷：所有事件都带 type + closureId，具体字段按 type 不同 */
export type ClosureEvent =
  | { type: 'closure:started'; closureId: string; targetCount: number }
  | { type: 'closure:gap_started'; closureId: string; targetId: string; round: number }
  | { type: 'closure:agent_prompting'; closureId: string; targetId: string; round: number; sessionId: string }
  | { type: 'closure:agent_ended'; closureId: string; targetId: string; round: number; sessionId: string }
  | { type: 'closure:tests_scanned'; closureId: string; targetId: string; round: number; files: string[] }
  | { type: 'closure:recovery_started'; closureId: string; targetId: string; round: number }
  | { type: 'closure:recovery_done'; closureId: string; targetId: string; round: number; deltaOverall: number }
  | { type: 'closure:recovery_failed'; closureId: string; targetId: string; round: number; error: string }
  | {
      type: 'closure:iteration_done';
      closureId: string;
      targetId: string;
      round: number;
      deltaBefore: CoverageSummary;
      deltaAfter: CoverageSummary;
      deltaOverall: number;
    }
  | { type: 'closure:gap_closed'; closureId: string; targetId: string }
  | { type: 'closure:gap_escalated'; closureId: string; targetId: string; reason: string }
  | {
      /** AI 输出 exclusion 建议并已持久化为 pending（工单 07：AI 只建议不排除） */
      type: 'closure:exclusion_suggested';
      closureId: string;
      targetId: string;
      round: number;
      count: number;
    }
  | { type: 'closure:gap_failed'; closureId: string; targetId: string; error: string }
  | { type: 'closure:completed'; closureId: string }
  | { type: 'closure:finalized'; closureId: string; mergeSessionId: string }
  | { type: 'closure:aborted'; closureId: string }
  | { type: 'closure:error'; closureId: string; error: string };

/** emit 回调类型：router 层注入，负责 mainWindow.webContents.send('closure:event', payload) */
export type ClosureEventEmitter = (event: ClosureEvent) => void;

export interface ClosureOrchestratorOptions {
  sessionManager: SessionManagerImpl;
  coverageManager: CoverageManager;
  closureManager: ClosureManager;
  projectId: string;
  /** 用于创建 PluginBacked* 适配器（同 ErrorAnalysisCoordinator 模式） */
  discovery: PluginBackedDiscovery;
  simulationAdapter: PluginBackedSimulation;
  coverageAdapter: PluginBackedCoverage;
  /** 凭据环境变量（buildEnvForAgent 结果） */
  agentEnv: Record<string, string>;
  /** 默认凭据 provider（mapProviderForAgent 结果） */
  provider?: string;
  /** 默认凭据 apiKey */
  apiKey?: string;
  /** 默认凭据 baseUrl */
  baseUrl?: string;
  /** 事件回调（注入） */
  emit: ClosureEventEmitter;
  /** 基线 cov_merge VDB 目录（用于 Coverage Recovery） */
  baselineVdbDir?: string;
  /** EDA Tool Configuration（用于 Recovery urg 合并命令构造） */
  edaConfig?: EdaToolConfig;
  /** 可选的 CommandRunner（用于 Recovery；测试注入 mock） */
  recoveryRunner?: CommandRunner;
}

/** waitForAgentEnd 的超时时间：10 分钟 */
const AGENT_END_TIMEOUT_MS = 10 * 60 * 1000;

/** System Prompt：指导 AI 生成定向测试 */
const CLOSURE_SYSTEM_PROMPT = `You are an EDA verification expert specializing in SystemVerilog coverage closure.

Your task:
1. Analyze the coverage gap described in the prompt
2. Use get_coverage / get_coverage_detail Host Tools to understand the current coverage state
3. Use get_module_source to read the RTL implementation of the target module
4. Use get_test_template to understand the existing test framework style
5. Generate directed test(s) that target the uncovered code/branches/states
6. Write the generated test files to the workspace directory provided in the prompt
7. Use run_simulation to execute the generated tests
8. Check coverage again with get_coverage to verify improvement

Important guidelines:
- Write generated test files into the workspace directory specified in the prompt (NOT the project testbench)
- Follow the existing test framework style (use get_test_template)
- Each generated test must be syntactically valid SystemVerilog (.sv / .v / .svh)
- Focus on the specific gap: do not refactor unrelated code
- After running simulation, verify coverage actually improved
- If coverage did not improve, analyze why and try a different approach
- Do NOT modify the project's formal testbench/ directory`;

export class ClosureOrchestrator {
  private opts: ClosureOrchestratorOptions;
  /** closureId → AbortController，用于中止运行中的闭环 */
  private abortControllers = new Map<string, AbortController>();
  /** closureId → 正在运行的 Promise（用于 await 完成或 abort 后等待退出） */
  private runningPromises = new Map<string, Promise<void>>();
  /** closureId → 最后一轮 Recovery 的结果（用于闭环结束后固化为 Merge Session） */
  private lastRecoveryResults = new Map<string, RecoveryResult>();
  /** 用户单独中止的 target（key = `${closureId}:${targetId}`），runTargetLoop 检查点消费 */
  private abortedTargetIds = new Set<string>();

  constructor(opts: ClosureOrchestratorOptions) {
    this.opts = opts;
  }

  /** 当前是否有该 closureId 对应的闭环在运行 */
  isRunning(closureId: string): boolean {
    return this.abortControllers.has(closureId);
  }

  /**
   * 启动 Closure 闭环：由 router 层在 startClosure procedure 中调用。
   *
   * 流程：
   * 1. 创建 AbortController
   * 2. 发出 closure:started 事件
   * 3. 通过 Promise.allSettled 并行运行所有 Target 的 runTargetLoop
   * 4. 所有 Target 完成后发出 closure:completed 事件
   *
   * @param session 已通过 closureManager.startClosure 创建的 ClosureSession
   */
  async startClosure(session: ClosureSession): Promise<void> {
    // 防止重复启动
    if (this.abortControllers.has(session.id)) {
      throw new Error(`Closure ${session.id} is already running`);
    }

    const controller = new AbortController();
    this.abortControllers.set(session.id, controller);

    this.emit({ type: 'closure:started', closureId: session.id, targetCount: session.targets.length });

    const promise = this.runAllTargets(session, controller).catch((err) => {
      this.emit({
        type: 'closure:error',
        closureId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }).finally(() => {
      this.abortControllers.delete(session.id);
      this.runningPromises.delete(session.id);
      this.lastRecoveryResults.delete(session.id);
      this.clearAbortedTargets(session.id);
    });

    this.runningPromises.set(session.id, promise);
    // fire-and-forget：router 层不等待闭环完成，通过事件流推送状态
    void promise;
  }

  /**
   * 中止 Closure 闭环。
   * - 触发 AbortController，所有 Gap 循环退出
   * - 调用 closureManager.abortClosure 标记状态
   * - 发出 closure:aborted 事件
   */
  async abort(closureId: string): Promise<void> {
    const controller = this.abortControllers.get(closureId);
    if (controller) {
      controller.abort();
    }
    // 等待运行中的 Promise 退出（最多等到下一个 microtask）
    const running = this.runningPromises.get(closureId);
    if (running) {
      try {
        await running;
      } catch {
        // 已经在 startClosure 的 catch 中处理过
      }
    }
    try {
      await this.opts.closureManager.abortClosure(closureId);
    } catch {
      // 可能已被其他路径 abort
    }
    this.emit({ type: 'closure:aborted', closureId });
  }

  /**
   * 单独中止一个 Target（Issue 06 闭环 UI）。
   *
   * 语义：中止即转人工——不引入新的 target 状态。runTargetLoop 在每轮中止
   * 检查点检测到该 target 被标记后，调用 closureManager.escalateTarget
   * （reason = '用户手动中止该 target'）并发出 gap_escalated 事件，然后退出
   * 该 target 的循环。不影响同一闭环中的其他 target。
   *
   * 幂等：对已终态或已标记的 target 重复调用无副作用。
   */
  async abortTarget(closureId: string, targetId: string): Promise<void> {
    this.abortedTargetIds.add(`${closureId}:${targetId}`);
  }

  // ─── 内部实现 ─────────────────────────────────────────────────

  /**
   * 并行运行所有 Target 的迭代循环。
   * 使用 Promise.allSettled 确保单个 Target 失败不影响其他 Target（ADR 0025 决策 3）。
   */
  private async runAllTargets(session: ClosureSession, controller: AbortController): Promise<void> {
    const targetPromises = session.targets.map((target) => this.runTargetLoop(session, target, controller));
    await Promise.allSettled(targetPromises);

    // 所有 Target 完成后，检查是否被中止
    if (controller.signal.aborted) return;

    // 固化最终轮 Recovery 报告为新的 Merge Session（PRD Issue #05）
    await this.finalizeRecovery(session);

    // 发出完成事件（closureManager 内部已自动标记 completed）
    this.emit({ type: 'closure:completed', closureId: session.id });
  }

  /**
   * 单个 Target 的迭代循环：
   *   while (round < maxRounds && !aborted && target not in terminal state):
   *     1. startIteration
   *     2. 创建独立 omp 会话（cwd = workspaceDir）
   *     3. 发送 prompt（fire-and-forget）
   *     4. waitForAgentEnd
   *     5. scanGeneratedTests
   *     6. 计算 delta（通过 coverageManager.getOverview，工单 05 接 Recovery）
   *     7. completeIteration（传入缓存覆盖率快照，内部判定达标/shouldEscalate）
   *     8. 检查 target 是否进入终态（closed/escalated/failed）
   *     9. destroySession
   */
  private async runTargetLoop(
    session: ClosureSession,
    target: ClosureTarget,
    controller: AbortController,
  ): Promise<void> {
    const { closureManager } = this.opts;
    let currentTarget = target;

    while (true) {
      // 中止检查
      if (controller.signal.aborted) return;
      // 单 target 中止检查（Issue 06）：命中后转人工（escalated）并退出该 target 循环
      if (this.isTargetAborted(session.id, target.id)) {
        await this.handleTargetAborted(session.id, target.id);
        return;
      }

      // 重新读取 target 最新状态（可能已被 completeIteration 标记为 closed/escalated）
      const freshSession = await closureManager.getClosure(session.id);
      if (!freshSession) return;
      currentTarget = freshSession.targets.find((t) => t.id === target.id) ?? currentTarget;

      // 终态检查
      if (['closed', 'escalated', 'failed'].includes(currentTarget.status)) {
        return;
      }

      // 最大轮数检查
      const round = currentTarget.iterations.length + 1;
      if (round > session.maxRounds) {
        // 达到最大轮数仍未达标 → 升级转人工
        await closureManager.escalateTarget(
          session.id,
          target.id,
          `达到最大迭代轮数 (${session.maxRounds}) 仍未关闭`,
        );
        this.emit({
          type: 'closure:gap_escalated',
          closureId: session.id,
          targetId: target.id,
          reason: `达到最大迭代轮数 (${session.maxRounds}) 仍未关闭`,
        });
        return;
      }

      // 1. 开始本轮迭代
      await closureManager.startIteration(session.id, target.id);
      this.emit({ type: 'closure:gap_started', closureId: session.id, targetId: target.id, round });

      // 获取本轮 delta 前 baseline
      const deltaBefore = await this.getCoverageSummary(session.sessionId);

      // 2. 创建独立 omp 会话
      let agentSessionId: string | null = null;
      try {
        agentSessionId = await this.createAgentSession(session, currentTarget, round);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await closureManager.failIteration(session.id, target.id, `session creation failed: ${errorMsg}`);
        await closureManager.failTarget(session.id, target.id, `session creation failed: ${errorMsg}`);
        this.emit({
          type: 'closure:gap_failed',
          closureId: session.id,
          targetId: target.id,
          error: errorMsg,
        });
        return;
      }

      if (controller.signal.aborted) {
        await this.safeDestroySession(agentSessionId);
        return;
      }

      // 3-4. 发送 prompt 并等待 agent 完成（fire-and-forget + 事件完成 + assistant 文本提取）
      //     原来分散在两步：promptFireAndForget + waitForAgentEnd
      //     现在统一通过 SessionManager 的深层 Agent Turn 接口完成。
      this.emit({
        type: 'closure:agent_prompting',
        closureId: session.id,
        targetId: target.id,
        round,
        sessionId: agentSessionId,
      });

      try {
        const prompt = this.buildClosurePrompt(session, currentTarget, round);
        const agentText = await this.opts.sessionManager.sendPromptAndWait(
          agentSessionId, prompt, undefined,
          { timeoutMs: AGENT_END_TIMEOUT_MS, signal: controller.signal },
        );
        this.emit({
          type: 'closure:agent_ended',
          closureId: session.id,
          targetId: target.id,
          round,
          sessionId: agentSessionId,
        });

        // 工单 07：解析 AI 的 dead_code 豁免建议并持久化为 pending（AI 只建议不排除）
        await this.collectExclusionSuggestions(session, currentTarget, round, agentText);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await closureManager.failIteration(session.id, target.id, `agent execution failed: ${errorMsg}`);
        await this.safeDestroySession(agentSessionId);
        if (controller.signal.aborted) return;
        await closureManager.failTarget(session.id, target.id, `agent execution failed: ${errorMsg}`);
        this.emit({
          type: 'closure:gap_failed',
          closureId: session.id,
          targetId: target.id,
          error: errorMsg,
        });
        return;
      }

      if (controller.signal.aborted) {
        await this.safeDestroySession(agentSessionId);
        return;
      }
      // 单 target 中止检查（Issue 06）：agent 已结束，销毁会话后转人工退出
      if (this.isTargetAborted(session.id, target.id)) {
        await this.safeDestroySession(agentSessionId);
        await this.handleTargetAborted(session.id, target.id);
        return;
      }

      // 5. 扫描生成的测试文件
      const roundDir = join(session.workspaceDir, target.id, `round_${round}`);
      const generatedTests = await this.scanGeneratedTests(roundDir);
      this.emit({
        type: 'closure:tests_scanned',
        closureId: session.id,
        targetId: target.id,
        round,
        files: generatedTests,
      });

      // 6. Coverage Recovery（ADR 0025 决策 1 + Issue #03）
      //    每轮迭代 agent_end 后，平台自动合并本轮仿真产生的 VDB 并重新生成报告 → 重新解析
      //    → 计算真实 Delta。基线 cov_merge VDB 只读。
      //    Recovery 配置缺失时（baselineVdbDir 或 edaConfig 未注入）走降级路径：
      //    读取 CoverageManager 缓存的 getOverview（与旧行为一致，delta 恒为零的已知缺陷）。
      let deltaAfter: CoverageSummary;
      let deltas: CoverageDelta[];

      if (this.canRunRecovery()) {
        // 发出 recovery_started 事件
        this.emit({
          type: 'closure:recovery_started',
          closureId: session.id,
          targetId: target.id,
          round,
        });

        try {
          const recoveryResult = await this.runRecovery(
            session,
            currentTarget,
            round,
            deltaBefore,
            roundDir,
          );

          // Recovery 成功：结果写入 CoverageManager 缓存（get_coverage 可见最新数据）
          await persistRecoveryResult(this.opts.coverageManager, recoveryResult);

          // 记录最后一轮 Recovery 结果（用于闭环结束后固化为 Merge Session）
          this.lastRecoveryResults.set(session.id, recoveryResult);

          this.emit({
            type: 'closure:recovery_done',
            closureId: session.id,
            targetId: target.id,
            round,
            deltaOverall: recoveryResult.deltaOverall,
          });

          deltaAfter = recoveryResult.after;
          deltas = recoveryResult.deltas;
        } catch (recoveryErr) {
          const recoveryErrorMsg = recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr);

          // Recovery 失败：发出 recovery_failed 事件，该 target 本轮标记失败并暂停
          this.emit({
            type: 'closure:recovery_failed',
            closureId: session.id,
            targetId: target.id,
            round,
            error: recoveryErrorMsg,
          });

          await closureManager.failIteration(session.id, target.id, `recovery failed: ${recoveryErrorMsg}`);
          await this.safeDestroySession(agentSessionId);
          if (controller.signal.aborted) return;
          await closureManager.failTarget(session.id, target.id, `recovery failed: ${recoveryErrorMsg}`);
          this.emit({
            type: 'closure:gap_failed',
            closureId: session.id,
            targetId: target.id,
            error: `Coverage Recovery 失败: ${recoveryErrorMsg}`,
          });
          return;
        }
      } else {
        // 降级路径：无 Recovery 配置，读取 CoverageManager 缓存
        // 此时 delta 恒为零（ADR 0025 修复前的已知缺陷），闭环实际不闭合
        deltaAfter = await this.getCoverageSummary(session.sessionId);
        deltas = calculateDelta(deltaBefore, deltaAfter);
      }

      // 7. 完成本轮迭代：传入目标模块的缓存覆盖率快照，
      //    closureManager 内部据此做达标判定（isTargetMet）与升级判定
      const coverage = await this.getTargetCoverageSnapshot(session.sessionId, currentTarget.module.path);
      await closureManager.completeIteration(session.id, target.id, {
        generatedTests,
        deltaBefore,
        deltaAfter,
        deltas,
        coverage,
      });

      this.emit({
        type: 'closure:iteration_done',
        closureId: session.id,
        targetId: target.id,
        round,
        deltaBefore,
        deltaAfter,
        deltaOverall: deltaAfter.overall - deltaBefore.overall,
      });

      // 8. 销毁会话（每轮独立，避免上下文污染）
      await this.safeDestroySession(agentSessionId);

      // 9. 检查 target 是否因达标/shouldEscalate 进入终态
      // 重新读取以获取最新状态
      const updated = await closureManager.getClosure(session.id);
      if (!updated) return;
      const updatedTarget = updated.targets.find((t) => t.id === target.id);
      if (!updatedTarget) return;

      if (updatedTarget.status === 'escalated') {
        this.emit({
          type: 'closure:gap_escalated',
          closureId: session.id,
          targetId: target.id,
          reason: updatedTarget.escalationReason ?? '连续多轮无显著提升',
        });
        return;
      }

      if (updatedTarget.status === 'closed') {
        this.emit({ type: 'closure:gap_closed', closureId: session.id, targetId: target.id });
        return;
      }

      // 否则进入下一轮迭代（达标判定已由 completeIteration 的 coverage 快照完成，
      // 不再使用 deltaOverall >= 1% 占位逻辑——Recovery 后 delta 真实可信）
    }
  }

  /**
   * 创建独立 omp 会话（cwd = Closure Workspace，实现 workspace 隔离）。
   * 复用 ErrorAnalysisCoordinator 的 session 创建模式。
   */
  private async createAgentSession(
    session: ClosureSession,
    _target: ClosureTarget,
    _round: number,
  ): Promise<string> {
    const workspaceDir = this.opts.closureManager.getWorkspaceDir(session.id);
    // 每轮迭代的 round 目录由 AI 写入测试文件，但 cwd 共用 workspaceDir
    // （run_simulation 由 AI 调用，工作目录由 session cwd 决定）

    return this.opts.sessionManager.createSession({
      projectId: this.opts.projectId,
      cwd: workspaceDir,
      provider: this.opts.provider,
      apiKey: this.opts.apiKey,
      baseUrl: this.opts.baseUrl,
      env: this.opts.agentEnv,
      systemPrompt: CLOSURE_SYSTEM_PROMPT,
      discovery: this.opts.discovery,
      simulationAdapter: this.opts.simulationAdapter,
      coverageAdapter: this.opts.coverageAdapter,
      coverageManager: this.opts.coverageManager,
    });
  }

  /**
   * 从 AI 回复文本解析 exclusion 建议并持久化为 pending（工单 07 链路）。
   *
   * - 仅当 AI 输出了 ```exclusion-suggestions 块（判定 dead_code 根因）时才有建议
   * - addExclusionSuggestions 只产生 pending 建议，绝不自动审批（PRD US-33 安全底线）
   * - best-effort：解析/持久化失败不影响迭代主流程
   */
  private async collectExclusionSuggestions(
    session: ClosureSession,
    target: ClosureTarget,
    round: number,
    agentText: string,
  ): Promise<void> {
    let suggestions;
    try {
      suggestions = parseExclusionSuggestions(agentText);
    } catch {
      return; // AI 输出畸形是常态，静默跳过
    }
    if (suggestions.length === 0) return;

    try {
      await this.opts.closureManager.addExclusionSuggestions(session.id, target.id, suggestions);
      this.emit({
        type: 'closure:exclusion_suggested',
        closureId: session.id,
        targetId: target.id,
        round,
        count: suggestions.length,
      });
    } catch {
      // best-effort：持久化失败不阻断迭代（建议丢失可由下一轮补出）
    }
  }

  /**
   * 扫描 round 目录下生成的 .v/.sv/.svh 文件。
   * 返回相对路径列表（相对于 roundDir）。
   */
  private async scanGeneratedTests(roundDir: string): Promise<string[]> {
    try {
      const entries = await readdir(roundDir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        if (entry.isFile() && /\.(sv|v|svh)$/i.test(entry.name)) {
          files.push(entry.name);
        }
      }
      return files;
    } catch {
      // 目录不存在或无法读取 → 返回空列表
      return [];
    }
  }

  /**
   * 获取目标模块的覆盖率快照（模块 8 metric 三元组 + 生效 targets 配置）。
   * 供 completeIteration 做模块级达标判定；模块不在 Coverage Tree 上时返回
   * undefined（无法评估，交由升级/maxRounds 兜底）。
   * 当前读取的是 CoverageManager 缓存数据，工单 05 接 Coverage Recovery。
   */
  private async getTargetCoverageSnapshot(
    sessionId: string,
    modulePath: string,
  ): Promise<TargetCoverageSnapshot | undefined> {
    try {
      const data = await this.opts.coverageManager.getTree(sessionId);
      const node = findNodeByPath(data.root, modulePath);
      if (!node) return undefined;
      const targets = await this.opts.coverageManager.getTargets(data.sessionId);
      return { metrics: node.metrics, targets };
    } catch {
      // 覆盖率数据不可用时跳过达标评估
      return undefined;
    }
  }

  /**
   * 构造 AI prompt：包含目标模块全部 metric 缺口、当前覆盖率、workspace 路径、round 信息。
   */
  private buildClosurePrompt(session: ClosureSession, target: ClosureTarget, round: number): string {
    const workspaceDir = this.opts.closureManager.getWorkspaceDir(session.id);
    const roundDir = join(workspaceDir, target.id, `round_${round}`);

    const parts: string[] = [
      `## Coverage Closure 任务`,
      ``,
      `**Closure Session**: ${session.id}`,
      `**当前轮次**: ${round} / ${session.maxRounds}`,
      `**Coverage Merge Session**: ${session.sessionId}`,
      ``,
      `### 目标模块（Closure Target）`,
      ``,
      `- **模块路径**: ${target.module.path}`,
      `- **模块名**: ${target.module.name}`,
      `- **未达标指标数**: ${target.gaps.length}`,
      ``,
      `该模块以下覆盖率指标均未达标，请在本轮内一起补齐（一个 directed test 通常`,
      `能同时提升多种 code metric）：`,
      ``,
      ...target.gaps.map(
        (gap) =>
          `- **${gap.metric}**: 当前 ${gap.actual.toFixed(1)}% / 目标 ${gap.target}%（缺口 ${gap.deficit.toFixed(1)}%）`,
      ),
      ``,
      `### 工作目录`,
      ``,
      `请将生成的测试文件写入以下目录（已自动创建）：`,
      ``,
      '```',
      roundDir,
      '```',
      ``,
      `### 任务步骤`,
      ``,
      `1. 使用 get_coverage 工具查看当前覆盖率（sessionId: ${session.sessionId}）`,
      `2. 使用 get_coverage_detail 工具查看模块 ${target.module.path} 的详细覆盖率`,
      `3. 使用 get_module_source 工具读取模块 ${target.module.name} 的 RTL 源码`,
      `4. 使用 get_test_template 工具查看现有测试用例结构`,
      `5. 生成针对上述全部指标缺口的定向测试，写入上述工作目录`,
      `6. 使用 run_simulation 工具运行生成的测试`,
      `7. 使用 get_coverage 工具验证覆盖率是否提升`,
      ``,
      `### 注意事项`,
      ``,
      `- 测试文件必须为 .sv / .v / .svh 格式`,
      `- 遵循现有测试框架的风格（testbench + virtual sequence）`,
      `- 聚焦该目标模块，不要重构无关代码`,
      `- 不要修改项目的正式 testbench/ 目录`,
      ``,
      // 工单 07：告知 AI dead_code 根因时的 exclusion 建议输出格式（可选输出）
      buildExclusionPromptSection(),
    ];

    // 若有历史迭代，附上之前的迭代结果供 AI 参考
    if (target.iterations.length > 0) {
      parts.push('', '### 历史迭代', '');
      for (const it of target.iterations) {
        const deltaOverall = it.deltaBefore && it.deltaAfter
          ? it.deltaAfter.overall - it.deltaBefore.overall
          : 0;
        parts.push(
          `- Round ${it.round}: ${it.status}, delta=${deltaOverall.toFixed(2)}%, ` +
          `生成测试 ${it.generatedTests.length} 个`,
        );
      }
      parts.push('', '请分析历史迭代效果，尝试不同的测试策略。');
    }

    return parts.join('\n');
  }

  /**
   * 获取当前 Coverage Merge Session 的覆盖率摘要。
   * 复用 coverageManager.getOverview，返回 summary 字段。
   */
  private async getCoverageSummary(sessionId: string): Promise<CoverageSummary> {
    const overview = await this.opts.coverageManager.getOverview(sessionId);
    return overview.summary;
  }

  /**
   * 判断是否具备运行 Coverage Recovery 的条件。
   * 需要：基线 VDB 目录 + EDA 配置 + coverageAdapter + recoveryRunner（或 edaConfig.execBackend 配置）。
   */
  private canRunRecovery(): boolean {
    return !!(
      this.opts.baselineVdbDir &&
      this.opts.edaConfig &&
      this.opts.coverageAdapter
    );
  }

  /**
   * 执行 Coverage Recovery（ADR 0025 决策 1 + Issue #03）。
   *
   * 收集本轮仿真产生的 simv.vdb 路径（从 roundDir 扫描 .vdb 目录），
   * 与基线 cov_merge VDB 合并运行 urg 生成新报告 → 重新解析为 Coverage Tree
   * → 计算 Delta。基线 cov_merge VDB 只读。
   *
   * @param session Closure Session
   * @param _target 目标 Target
   * @param round 当前轮次
   * @param before Recovery 前的覆盖率摘要
   * @param roundDir 本轮 round 目录（含 AI 生成的测试和仿真产生的 VDB）
   * @returns Recovery 结果（含 delta）
   */
  private async runRecovery(
    session: ClosureSession,
    _target: ClosureTarget,
    round: number,
    before: CoverageSummary,
    roundDir: string,
  ): Promise<RecoveryResult> {
    const { baselineVdbDir, edaConfig, recoveryRunner, coverageAdapter } = this.opts;

    // 扫描本轮仿真产生的 .vdb 目录
    const newVdbPaths = await this.scanVdbFiles(roundDir);

    // 构造报告输出目录
    const reportDir = join(roundDir, 'report');

    // 获取当前生效的 Coverage Target 配置
    const targets = await this.opts.coverageManager.getTargets(session.sessionId);

    return executeRecovery({
      projectRoot: this.opts.projectId,
      baselineVdbDir: baselineVdbDir!,
      newVdbPaths,
      edaConfig: edaConfig!,
      reportDir,
      sessionId: session.sessionId,
      targets,
      before,
      coverageAdapter: coverageAdapter!,
      runner: recoveryRunner,
    });
  }

  /**
   * 扫描 round 目录下的 .vdb 目录（本轮仿真产生的覆盖率数据库）。
   * VCS 仿真通常在 round 目录下生成 simv.vdb / test_xxx.vdb 等。
   */
  private async scanVdbFiles(roundDir: string): Promise<string[]> {
    try {
      const entries = await readdir(roundDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && /\.vdb$/i.test(e.name))
        .map((e) => join(roundDir, e.name));
    } catch {
      return [];
    }
  }

  /**
   * 固化最终轮 Recovery 报告为新的 Coverage Merge Session（PRD Issue #05 决策）。
   *
   * 闭环结束后（未被中止且有 Recovery 结果时），将最后一轮 Recovery 的 CoverageData
   * 注册为常规 CoverageMergeSession，进入趋势跟踪。
   *
   * 失败时不阻断闭环完成（best-effort），仅发出不含 mergeSessionId 的事件。
   */
  private async finalizeRecovery(session: ClosureSession): Promise<void> {
    const recoveryResult = this.lastRecoveryResults.get(session.id);
    if (!recoveryResult) {
      // 无 Recovery 结果（降级路径或全部 target 在 Recovery 前已终态），跳过固化
      return;
    }

    const { baselineVdbDir, edaConfig } = this.opts;
    if (!baselineVdbDir || !edaConfig) {
      // Recovery 配置不完整（理论上不会到达此处，因为 Recovery 仅在配置完整时运行）
      return;
    }

    try {
      const mergeSession = await this.opts.coverageManager.registerMergeSession(
        recoveryResult.data,
        recoveryResult.reportDir,
        baselineVdbDir,
        edaConfig.tool,
      );
      this.emit({
        type: 'closure:finalized',
        closureId: session.id,
        mergeSessionId: mergeSession.sessionId,
      });
    } catch {
      // 固化失败不阻断闭环完成（best-effort）
      // 用户仍可通过 Test Promotion 审阅测试，手动导入覆盖率
    }
  }

  /** 安全销毁会话，吞掉异常 */
  private async safeDestroySession(sessionId: string | null): Promise<void> {
    if (!sessionId) return;
    try {
      await this.opts.sessionManager.destroySession(sessionId);
    } catch {
      // best-effort
    }
  }

  /** 判断 target 是否被用户单独中止（Issue 06） */
  private isTargetAborted(closureId: string, targetId: string): boolean {
    return this.abortedTargetIds.has(`${closureId}:${targetId}`);
  }

  /**
   * 处理被用户单独中止的 target（Issue 06）：
   * 标记为 escalated（转人工，reason 固定）并发出 gap_escalated 事件，
   * 然后清理标记（幂等）。escalateTarget 抛错时不阻断退出（target 可能已终态）。
   */
  private async handleTargetAborted(closureId: string, targetId: string): Promise<void> {
    const reason = '用户手动中止该 target';
    try {
      await this.opts.closureManager.escalateTarget(closureId, targetId, reason);
    } catch {
      // target 可能已进入终态（closed/escalated/failed），保持原终态
    }
    this.abortedTargetIds.delete(`${closureId}:${targetId}`);
    this.emit({ type: 'closure:gap_escalated', closureId, targetId, reason });
  }

  /** 清理指定 closure 的全部单 target 中止标记（闭环结束时调用） */
  private clearAbortedTargets(closureId: string): void {
    const prefix = `${closureId}:`;
    for (const key of this.abortedTargetIds) {
      if (key.startsWith(prefix)) this.abortedTargetIds.delete(key);
    }
  }

  private emit(event: ClosureEvent): void {
    try {
      this.opts.emit(event);
    } catch {
      // emit 失败不应影响闭环运行
    }
  }
}

/** 在 Coverage Tree 中按 path 查找节点（DFS），未找到返回 null。 */
function findNodeByPath(node: CoverageNode, path: string): CoverageNode | null {
  if (node.path === path) return node;
  for (const child of node.children) {
    const found = findNodeByPath(child, path);
    if (found) return found;
  }
  return null;
}


