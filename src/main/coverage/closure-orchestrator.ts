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
 *   - closure:iteration_done  { closureId, targetId, round, deltaBefore, deltaAfter }
 *   - closure:gap_closed      { closureId, targetId }
 *   - closure:gap_escalated   { closureId, targetId, reason }
 *   - closure:gap_failed      { closureId, targetId, error }
 *   - closure:completed       { closureId }
 *   - closure:aborted         { closureId }
 *   - closure:error           { closureId, error }
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CoverageSummary, CoverageDelta, CoverageNode } from '@shared/types';
import { calculateDelta } from '@shared/types';
import type { ClosureManager } from './closure-manager';
import type { ClosureTarget, ClosureSession, TargetCoverageSnapshot } from './closure-manager';
import type { CoverageManager } from './coverage-manager';
import type { SessionManagerImpl } from '../agent/session-manager';
import type { PluginBackedDiscovery, PluginBackedSimulation, PluginBackedCoverage } from '../plugin-adapters';

/** Closure 事件载荷：所有事件都带 type + closureId，具体字段按 type 不同 */
export type ClosureEvent =
  | { type: 'closure:started'; closureId: string; targetCount: number }
  | { type: 'closure:gap_started'; closureId: string; targetId: string; round: number }
  | { type: 'closure:agent_prompting'; closureId: string; targetId: string; round: number; sessionId: string }
  | { type: 'closure:agent_ended'; closureId: string; targetId: string; round: number; sessionId: string }
  | { type: 'closure:tests_scanned'; closureId: string; targetId: string; round: number; files: string[] }
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
  | { type: 'closure:gap_failed'; closureId: string; targetId: string; error: string }
  | { type: 'closure:completed'; closureId: string }
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

      // 3. 发送 prompt（fire-and-forget）
      this.emit({
        type: 'closure:agent_prompting',
        closureId: session.id,
        targetId: target.id,
        round,
        sessionId: agentSessionId,
      });

      try {
        const client = this.opts.sessionManager.getClient(agentSessionId);
        if (!client) {
          throw new Error('Agent client not available after session creation');
        }
        const prompt = this.buildClosurePrompt(session, currentTarget, round);
        await client.prompt(prompt);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await closureManager.failIteration(session.id, target.id, `prompt failed: ${errorMsg}`);
        await closureManager.failTarget(session.id, target.id, `prompt failed: ${errorMsg}`);
        await this.safeDestroySession(agentSessionId);
        this.emit({
          type: 'closure:gap_failed',
          closureId: session.id,
          targetId: target.id,
          error: errorMsg,
        });
        return;
      }

      // 4. 等待 agent_end 事件
      try {
        await this.waitForAgentEnd(agentSessionId, controller);
        this.emit({
          type: 'closure:agent_ended',
          closureId: session.id,
          targetId: target.id,
          round,
          sessionId: agentSessionId,
        });
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

      // 6. 计算 delta（通过 coverageManager 重新获取覆盖率；
      //    当前为缓存的 getOverview，工单 05 接 Coverage Recovery 后为真实 re-merge 数据）
      const deltaAfter = await this.getCoverageSummary(session.sessionId);

      // 7. 完成本轮迭代：传入目标模块的缓存覆盖率快照，
      //    closureManager 内部据此做达标判定（isTargetMet）与升级判定
      const deltas: CoverageDelta[] = calculateDelta(deltaBefore, deltaAfter);
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

      // Delta Validation Phase 1 占位判定：若 delta >= 1%（ESCALATION_DELTA_THRESHOLD），
      // 视为已关闭。精确的模块级达标判定已由 completeIteration 的 coverage 快照完成，
      // 此占位逻辑在工单 05 接入 Coverage Recovery 后移除。
      const deltaOverall = deltaAfter.overall - deltaBefore.overall;
      if (deltaOverall >= 1) {
        await closureManager.closeTarget(session.id, target.id);
        this.emit({ type: 'closure:gap_closed', closureId: session.id, targetId: target.id });
        return;
      }

      // 否则进入下一轮迭代
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
   * 等待 agent_end 事件或超时。
   *
   * 监听 sessionManager 的 'sessionEvent' 事件，过滤 sessionId === agentSessionId：
   *   - event.type === 'agent_end' → resolve
   *   - event.type === 'error' → reject
   *   - 超时（10 分钟）→ reject
   *   - abort signal → reject
   */
  private waitForAgentEnd(
    agentSessionId: string,
    controller: AbortController,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`Agent timed out after ${AGENT_END_TIMEOUT_MS / 60000} minutes`));
      }, AGENT_END_TIMEOUT_MS);
      timeoutId.unref();

      const onAbort = (): void => {
        cleanup();
        reject(new Error('Aborted'));
      };
      controller.signal.addEventListener('abort', onAbort, { once: true });

      const onSessionEvent = ({ sessionId, event }: { sessionId: string; event: unknown }): void => {
        if (sessionId !== agentSessionId) return;
        const evt = event as Record<string, unknown> | null;
        if (!evt || typeof evt.type !== 'string') return;

        if (evt.type === 'agent_end') {
          cleanup();
          resolve();
        } else if (evt.type === 'error') {
          cleanup();
          const errMsg = typeof evt.message === 'string'
            ? evt.message
            : typeof evt.error === 'string'
              ? evt.error
              : 'Agent reported an error';
          reject(new Error(errMsg));
        }
      };

      const cleanup = (): void => {
        clearTimeout(timeoutId);
        controller.signal.removeEventListener('abort', onAbort);
        this.opts.sessionManager.off('sessionEvent', onSessionEvent);
      };

      this.opts.sessionManager.on('sessionEvent', onSessionEvent);
    });
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

  /** 安全销毁会话，吞掉异常 */
  private async safeDestroySession(sessionId: string | null): Promise<void> {
    if (!sessionId) return;
    try {
      await this.opts.sessionManager.destroySession(sessionId);
    } catch {
      // best-effort
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
