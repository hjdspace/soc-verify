/**
 * Test Promotion 端到端集成测试（ADR 0009 决策 10 / Issue #10 Slice 8；工单 04 适配模块级 Target）。
 *
 * 端到端验证 Closure 结束后 → Test Promotion 完整流程：
 *   1. 构建真实 ClosureSession（ClosureManager + 真实文件 IO，模块级 target）
 *   2. 模拟多轮迭代，写入生成的测试文件到 Closure Workspace
 *   3. 关闭/升级各 Target，使 Closure 进入终态
 *   4. TestPromoter.getPromotionQueue 扫描队列
 *   5. TestPromoter.promoteTests 复制 accepted 文件到正式 testbench 目录
 *   6. 验证目标目录文件内容、源文件保留
 *   7. TestPromoter.getClosureSummary 返回 target 状态 / delta / 计数
 *   8. TestPromoter.cleanupClosure 删除整个 workspace 目录
 *
 * 这条链路正是 coverage-router 中 promoteTests/getClosureSummary/cleanupClosure
 * procedure 内部编排的逻辑，此处用真实的 ClosureManager + TestPromoter + 真实文件
 * IO 完成端到端覆盖，避免在测试中引入 electron BrowserWindow 等重 mock。
 */
import { describe, it, expect } from 'vitest';
import { ClosureManager } from '../../src/main/coverage/closure-manager';
import { TestPromoter } from '../../src/main/coverage/test-promoter';
import type { CoverageManager } from '../../src/main/coverage/coverage-manager';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  CoverageGap, CoverageSummary, CoverageDelta, CoverageMetric, CoverageNode,
} from '@shared/types';
import { COVERAGE_METRICS } from '@shared/types';

// ─── Mock 数据辅助 ──────────────────────────────────────────────

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

function makeDeltas(delta: number): CoverageDelta[] {
  const metrics: CoverageMetric[] = [
    'line', 'branch', 'toggle', 'condition',
    'fsm_state', 'fsm_transition', 'functional', 'assertion',
  ];
  return metrics.map((m) => ({ metric: m, before: 0, after: delta, delta }));
}

/**
 * 创建 mock CoverageManager：按 gap 列表构建 Coverage Tree（每个模块一个节点），
 * 供 ClosureManager.startClosure 用 detectGaps 做模块级聚合。
 */
function createMockCoverageManager(gaps: CoverageGap[] = []): CoverageManager {
  const byPath = new Map<string, { name: string; pcts: Partial<Record<CoverageMetric, number>> }>();
  const targets: Partial<Record<CoverageMetric, number>> = {};
  for (const gap of gaps) {
    targets[gap.metric] = gap.target;
    const entry = byPath.get(gap.nodePath) ?? { name: gap.nodeName, pcts: {} };
    entry.pcts[gap.metric] = gap.actual;
    byPath.set(gap.nodePath, entry);
  }
  const mkMetrics = (pcts: Partial<Record<CoverageMetric, number>>): CoverageNode['metrics'] => {
    const m = {} as CoverageNode['metrics'];
    for (const metric of COVERAGE_METRICS) {
      m[metric] = { percentage: pcts[metric] ?? null, covered: null, total: null };
    }
    return m;
  };
  const root: CoverageNode = {
    name: 'top',
    path: 'top',
    depth: 0,
    metrics: mkMetrics({}),
    children: Array.from(byPath.entries()).map(([path, { name, pcts }]) => ({
      name,
      path,
      depth: 1,
      metrics: mkMetrics(pcts),
      children: [],
    })),
  };
  const data = {
    sessionId: 'mock-session',
    source: { covMergeDir: 'cov_merge', edaTool: 'imc' as const, reportGeneratedAt: 0 },
    root,
    targets,
  };
  return {
    getTree: async () => data,
    getTargets: async () => targets,
  } as unknown as CoverageManager;
}

/** 创建临时目录 + ClosureManager + TestPromoter */
function setup(gaps: CoverageGap[] = []) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'test-promotion-e2e-'));
  const coverageManager = createMockCoverageManager(gaps);
  const closureManager = new ClosureManager({ projectRoot: tmpDir, coverageManager });
  const promoter = new TestPromoter({ projectRoot: tmpDir, closureManager });
  return {
    tmpDir,
    closureManager,
    promoter,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
}

/** 在 Closure Workspace 中写入测试文件 */
function writeTestFile(
  workspaceDir: string,
  targetId: string,
  round: number,
  fileName: string,
  content: string,
): void {
  const dir = join(workspaceDir, targetId, `round_${round}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), content, 'utf-8');
}

const SAMPLE_GAPS: CoverageGap[] = [
  makeGap('cpu_core', 'line', 80, 95),
  makeGap('memory_ctrl', 'toggle', 75, 85),
];

// ─── 端到端集成测试 ─────────────────────────────────────────────

describe('Test Promotion 端到端集成', () => {
  it('完整流程：Closure 终态 → 队列扫描 → 提升接受文件 → 摘要 → 清理', async () => {
    const { tmpDir, closureManager, promoter, cleanup } = setup(SAMPLE_GAPS);
    try {
      // ── 步骤 1：启动 Closure，两个模块级 Target ───────────────
      const session = await closureManager.startClosure({
        sessionId: 'merge_e2e',
        modules: ['cpu_core', 'memory_ctrl'],
      });
      const target0 = session.targets[0]; // cpu_core
      const target1 = session.targets[1]; // memory_ctrl

      // ── 步骤 2：target0 进行 1 轮迭代，生成 2 个测试文件，delta=3% ──
      await closureManager.startIteration(session.id, target0.id);
      await closureManager.completeIteration(session.id, target0.id, {
        generatedTests: ['test_cpu_r1.sv', 'vseq_cpu_r1.sv'],
        deltaBefore: makeSummary(80),
        deltaAfter: makeSummary(83),
        deltas: makeDeltas(3),
      });
      writeTestFile(session.workspaceDir, target0.id, 1, 'test_cpu_r1.sv', '// CPU test round 1');
      writeTestFile(session.workspaceDir, target0.id, 1, 'vseq_cpu_r1.sv', '// CPU vseq round 1');
      // 关闭 target0
      await closureManager.closeTarget(session.id, target0.id);

      // ── 步骤 3：target1 进行 1 轮迭代后升级（无显著提升） ──────
      await closureManager.startIteration(session.id, target1.id);
      await closureManager.completeIteration(session.id, target1.id, {
        generatedTests: ['test_mem_r1.sv'],
        deltaBefore: makeSummary(75),
        deltaAfter: makeSummary(75.5), // delta=0.5% < 1%
        deltas: makeDeltas(0.5),
      });
      writeTestFile(session.workspaceDir, target1.id, 1, 'test_mem_r1.sv', '// MEM test round 1');
      // 第二轮低 delta 触发升级
      await closureManager.startIteration(session.id, target1.id);
      await closureManager.completeIteration(session.id, target1.id, {
        generatedTests: ['test_mem_r2.sv'],
        deltaBefore: makeSummary(75.5),
        deltaAfter: makeSummary(75.8), // delta=0.3% < 1%，连续 2 轮升级
        deltas: makeDeltas(0.3),
      });
      writeTestFile(session.workspaceDir, target1.id, 2, 'test_mem_r2.sv', '// MEM test round 2');

      // 此时 Closure 应已自动 completed（两个 target 均进入终态）
      const finalSession = await closureManager.getClosure(session.id);
      expect(finalSession?.status).toBe('completed');

      // ── 步骤 4：扫描 Test Promotion 审阅队列 ──────────────────
      const queue = await promoter.getPromotionQueue(session.id);
      // target0 round1: 2 个文件 + target1 round1: 1 个 + target1 round2: 1 个 = 4
      expect(queue).toHaveLength(4);
      expect(queue.every((i) => i.status === 'pending')).toBe(true);
      expect(queue.every((i) => i.closureId === session.id)).toBe(true);

      // 验证 sourcePath 都在 Closure Workspace 下且文件存在
      for (const item of queue) {
        expect(item.sourcePath.startsWith(session.workspaceDir)).toBe(true);
        expect(existsSync(item.sourcePath)).toBe(true);
      }

      // ── 步骤 5：执行 Test Promotion ──────────────────────────
      // 接受 target0 的两个文件 + target1 round1 的文件，拒绝 target1 round2 的文件
      const acceptIds = queue
        .filter((i) => i.fileName !== 'test_mem_r2.sv')
        .map((i) => i.id);
      const rejectIds = queue
        .filter((i) => i.fileName === 'test_mem_r2.sv')
        .map((i) => i.id);
      expect(acceptIds).toHaveLength(3);
      expect(rejectIds).toHaveLength(1);

      const targetDir = join(tmpDir, 'formal_testbench');
      const result = await promoter.promoteTests(
        session.id,
        acceptIds,
        rejectIds,
        targetDir,
      );

      // ── 步骤 6：验证复制结果 ─────────────────────────────────
      expect(result.promoted).toBe(3);
      expect(result.rejected).toBe(1);

      // accepted 文件已复制到目标目录，内容正确
      expect(existsSync(join(targetDir, 'test_cpu_r1.sv'))).toBe(true);
      expect(existsSync(join(targetDir, 'vseq_cpu_r1.sv'))).toBe(true);
      expect(existsSync(join(targetDir, 'test_mem_r1.sv'))).toBe(true);
      expect(readFileSync(join(targetDir, 'test_cpu_r1.sv'), 'utf-8'))
        .toBe('// CPU test round 1');

      // rejected 文件未复制
      expect(existsSync(join(targetDir, 'test_mem_r2.sv'))).toBe(false);

      // 源文件仍保留在 Closure Workspace（promote 不删除源）
      expect(existsSync(join(session.workspaceDir, target0.id, 'round_1', 'test_cpu_r1.sv'))).toBe(true);

      // promotion.json 决策记录已持久化
      const promotionFile = join(session.workspaceDir, 'promotion.json');
      expect(existsSync(promotionFile)).toBe(true);
      const record = JSON.parse(readFileSync(promotionFile, 'utf-8'));
      expect(record.closureId).toBe(session.id);
      expect(record.accepted).toHaveLength(3);
      expect(record.rejected).toHaveLength(1);

      // ── 步骤 7：重新加载队列，状态已更新 ─────────────────────
      const reloadedQueue = await promoter.getPromotionQueue(session.id);
      const acceptedItems = reloadedQueue.filter((i) => i.status === 'accepted');
      const rejectedItems = reloadedQueue.filter((i) => i.status === 'rejected');
      const pendingItems = reloadedQueue.filter((i) => i.status === 'pending');
      expect(acceptedItems).toHaveLength(3);
      expect(rejectedItems).toHaveLength(1);
      expect(pendingItems).toHaveLength(0);

      // ── 步骤 8：获取 Closure Summary ─────────────────────────
      const summary = await promoter.getClosureSummary(session.id);
      expect(summary.closureId).toBe(session.id);
      expect(summary.status).toBe('completed');
      expect(summary.gaps).toHaveLength(2);

      // target0: closed, 1 round, finalDelta = 83 - 80 = 3
      const sg0 = summary.gaps.find((g) => g.gapId === target0.id)!;
      expect(sg0.status).toBe('closed');
      expect(sg0.moduleName).toBe('cpu_core');
      expect(sg0.metric).toBe('line');
      expect(sg0.rounds).toBe(1);
      expect(sg0.finalDelta).toBe(3);

      // target1: escalated, 2 rounds, finalDelta = 75.8 - 75.5 = 0.3
      const sg1 = summary.gaps.find((g) => g.gapId === target1.id)!;
      expect(sg1.status).toBe('escalated');
      expect(sg1.moduleName).toBe('memory_ctrl');
      expect(sg1.rounds).toBe(2);
      expect(sg1.finalDelta).toBeCloseTo(0.3, 5);
      expect(sg1.escalationReason).toBeTruthy();

      // totalDelta = 3 + 0.3 = 3.3
      expect(summary.totalDelta).toBeCloseTo(3.3, 5);

      // 计数：3 accepted, 1 rejected, 0 pending
      expect(summary.promotedCount).toBe(3);
      expect(summary.rejectedCount).toBe(1);
      expect(summary.pendingCount).toBe(0);

      // ── 步骤 9：清理 Closure Workspace ───────────────────────
      expect(existsSync(session.workspaceDir)).toBe(true);
      const cleanupResult = await promoter.cleanupClosure(session.id);
      expect(cleanupResult.ok).toBe(true);
      expect(existsSync(session.workspaceDir)).toBe(false);

      // 正式 testbench 目录不受清理影响
      expect(existsSync(join(targetDir, 'test_cpu_r1.sv'))).toBe(true);

      // 清理后 promotion 记录不可读（目录已删除），但 closure 记录仍在
      // ClosureManager 的 closures.json 在 .socverify/coverage/closure/ 下，
      // 不在 <closureId>/ 内，因此不受 cleanupClosure 影响
      const closureAfterCleanup = await closureManager.getClosure(session.id);
      expect(closureAfterCleanup).not.toBeNull();
      expect(closureAfterCleanup?.id).toBe(session.id);
    } finally {
      cleanup();
    }
  });

  it('空 Closure（无迭代）的 Test Promotion 流程', async () => {
    const { tmpDir, closureManager, promoter, cleanup } = setup(SAMPLE_GAPS);
    try {
      const session = await closureManager.startClosure({
        sessionId: 'merge_empty',
        modules: ['cpu_core', 'memory_ctrl'],
      });

      // 直接关闭所有 target，不进行任何迭代
      await closureManager.closeTarget(session.id, session.targets[0].id);
      await closureManager.closeTarget(session.id, session.targets[1].id);

      // 队列为空
      const queue = await promoter.getPromotionQueue(session.id);
      expect(queue).toEqual([]);

      // 执行 promotion（空列表），不复制任何文件
      const targetDir = join(tmpDir, 'tb');
      const result = await promoter.promoteTests(session.id, [], [], targetDir);
      expect(result.promoted).toBe(0);
      expect(result.rejected).toBe(0);

      // summary 仍可生成，totalDelta 为 null（无迭代）
      const summary = await promoter.getClosureSummary(session.id);
      expect(summary.status).toBe('completed');
      expect(summary.totalDelta).toBeNull();
      expect(summary.promotedCount).toBe(0);
      expect(summary.pendingCount).toBe(0);
      expect(summary.rejectedCount).toBe(0);
      for (const g of summary.gaps) {
        expect(g.finalDelta).toBeNull();
        expect(g.rounds).toBe(0);
      }

      // 清理
      const cleanupResult = await promoter.cleanupClosure(session.id);
      expect(cleanupResult.ok).toBe(true);
      expect(existsSync(session.workspaceDir)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('中止的 Closure 仍可执行 Test Promotion 流程', async () => {
    const { tmpDir, closureManager, promoter, cleanup } = setup(SAMPLE_GAPS);
    try {
      const session = await closureManager.startClosure({
        sessionId: 'merge_aborted',
        modules: ['cpu_core', 'memory_ctrl'],
      });
      const target0 = session.targets[0];

      // target0 进行 1 轮迭代后中止整个 Closure
      await closureManager.startIteration(session.id, target0.id);
      await closureManager.completeIteration(session.id, target0.id, {
        generatedTests: ['pre_abort.sv'],
        deltaBefore: makeSummary(80),
        deltaAfter: makeSummary(82),
        deltas: makeDeltas(2),
      });
      writeTestFile(session.workspaceDir, target0.id, 1, 'pre_abort.sv', '// before abort');
      await closureManager.abortClosure(session.id);

      // 中止后仍可扫描队列
      const queue = await promoter.getPromotionQueue(session.id);
      expect(queue).toHaveLength(1);
      expect(queue[0].fileName).toBe('pre_abort.sv');

      // 提升测试
      const targetDir = join(tmpDir, 'tb');
      const result = await promoter.promoteTests(
        session.id,
        [queue[0].id],
        [],
        targetDir,
      );
      expect(result.promoted).toBe(1);
      expect(existsSync(join(targetDir, 'pre_abort.sv'))).toBe(true);

      // summary 状态为 aborted
      const summary = await promoter.getClosureSummary(session.id);
      expect(summary.status).toBe('aborted');
      expect(summary.promotedCount).toBe(1);

      // 清理
      await promoter.cleanupClosure(session.id);
      expect(existsSync(session.workspaceDir)).toBe(false);
    } finally {
      cleanup();
    }
  });
});
