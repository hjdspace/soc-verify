/**
 * TestPromoter 单元测试（ADR 0009 决策 10 / Issue #10 Slice 8）。
 *
 * 覆盖：
 * - getPromotionQueue: 扫描 Closure Workspace 生成审阅队列（多 gap 多轮）
 * - promoteTests: accepted 复制到目标目录，rejected 不复制
 * - cleanupClosure: 删除整个 workspace 目录
 * - getClosureSummary: 各 gap 状态 / finalDelta / 提升计数
 * - 空队列处理（无生成的测试文件）
 * - 决策记录持久化（promotion.json）
 */

import { describe, it, expect } from 'vitest';
import { ClosureManager } from '../../src/main/coverage/closure-manager';
import { TestPromoter } from '../../src/main/coverage/test-promoter';
import type { CoverageManager } from '../../src/main/coverage/coverage-manager';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  CoverageGap,
  CoverageSummary,
  CoverageDelta,
  CoverageMetric,
} from '@shared/types';

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

function createMockCoverageManager(gaps: CoverageGap[] = []): CoverageManager {
  return {
    listGaps: async (_sessionId?: string) => ({ sessionId: 'mock-session', gaps }),
  } as unknown as CoverageManager;
}

/** 创建临时目录 + ClosureManager + TestPromoter */
function setup(gaps: CoverageGap[] = []) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'test-promoter-'));
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

const SAMPLE_GAPS: CoverageGap[] = [
  makeGap('top/cpu_core', 'line', 80, 95),
  makeGap('top/memory_ctrl', 'toggle', 75, 85),
];

/**
 * 在 Closure Workspace 中写入测试文件。
 * 路径：<workspaceDir>/<gapId>/round_<round>/<fileName>
 */
function writeTestFile(
  workspaceDir: string,
  gapId: string,
  round: number,
  fileName: string,
  content: string,
): void {
  const dir = join(workspaceDir, gapId, `round_${round}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), content, 'utf-8');
}

describe('TestPromoter', () => {
  describe('getPromotionQueue', () => {
    it('扫描多 gap 多轮生成审阅队列', async () => {
      const { closureManager, promoter, tmpDir, cleanup } = setup(SAMPLE_GAPS);
      try {
        const session = await closureManager.startClosure({
          sessionId: 'merge_test',
          gaps: SAMPLE_GAPS,
        });
        const gap0 = session.gaps[0];
        const gap1 = session.gaps[1];

        // gap0 round1: 2 个测试文件
        await closureManager.startIteration(session.id, gap0.id);
        await closureManager.completeIteration(session.id, gap0.id, {
          generatedTests: ['test_cpu_r1.sv', 'vseq_cpu_r1.sv'],
          deltaBefore: makeSummary(80),
          deltaAfter: makeSummary(83),
          deltas: makeDeltas(3),
        });
        writeTestFile(session.workspaceDir, gap0.id, 1, 'test_cpu_r1.sv', '// test 1');
        writeTestFile(session.workspaceDir, gap0.id, 1, 'vseq_cpu_r1.sv', '// vseq 1');

        // gap1 round1: 1 个测试文件
        await closureManager.startIteration(session.id, gap1.id);
        await closureManager.completeIteration(session.id, gap1.id, {
          generatedTests: ['test_mem_r1.sv'],
          deltaBefore: makeSummary(75),
          deltaAfter: makeSummary(78),
          deltas: makeDeltas(3),
        });
        writeTestFile(session.workspaceDir, gap1.id, 1, 'test_mem_r1.sv', '// mem test 1');

        const queue = await promoter.getPromotionQueue(session.id);
        expect(queue).toHaveLength(3);

        // 验证队列项字段
        const item0 = queue.find((i) => i.fileName === 'test_cpu_r1.sv')!;
        expect(item0.gapId).toBe(gap0.id);
        expect(item0.round).toBe(1);
        expect(item0.closureId).toBe(session.id);
        expect(item0.status).toBe('pending');
        expect(item0.sourcePath).toBe(join(session.workspaceDir, gap0.id, 'round_1', 'test_cpu_r1.sv'));
        expect(item0.relativePath).toBe('test_cpu_r1.sv');
        // 目标路径为 <projectRoot>/testbench/<fileName>（tmpDir 即为 projectRoot）
        expect(item0.targetPath).toBe(join(tmpDir, 'testbench', 'test_cpu_r1.sv'));
        expect(existsSync(item0.sourcePath)).toBe(true);

        // 不同 gap 的文件
        const memItem = queue.find((i) => i.fileName === 'test_mem_r1.sv')!;
        expect(memItem.gapId).toBe(gap1.id);
      } finally {
        cleanup();
      }
    });

    it('跳过磁盘上不存在的测试文件', async () => {
      const { closureManager, promoter, cleanup } = setup(SAMPLE_GAPS);
      try {
        const session = await closureManager.startClosure({
          sessionId: 'merge_test',
          gaps: [SAMPLE_GAPS[0]],
        });
        const gap0 = session.gaps[0];

        await closureManager.startIteration(session.id, gap0.id);
        await closureManager.completeIteration(session.id, gap0.id, {
          // generatedTests 包含 2 个文件，但只写入 1 个
          generatedTests: ['exists.sv', 'missing.sv'],
          deltaBefore: makeSummary(80),
          deltaAfter: makeSummary(83),
          deltas: makeDeltas(3),
        });
        writeTestFile(session.workspaceDir, gap0.id, 1, 'exists.sv', '// real');

        const queue = await promoter.getPromotionQueue(session.id);
        expect(queue).toHaveLength(1);
        expect(queue[0].fileName).toBe('exists.sv');
      } finally {
        cleanup();
      }
    });

    it('空队列处理（无迭代或无生成测试）', async () => {
      const { closureManager, promoter, cleanup } = setup(SAMPLE_GAPS);
      try {
        const session = await closureManager.startClosure({
          sessionId: 'merge_test',
          gaps: SAMPLE_GAPS,
        });
        // 未执行任何迭代
        const queue = await promoter.getPromotionQueue(session.id);
        expect(queue).toEqual([]);
      } finally {
        cleanup();
      }
    });

    it('对不存在的 closure 抛错', async () => {
      const { promoter, cleanup } = setup();
      try {
        await expect(promoter.getPromotionQueue('closure_unknown')).rejects.toThrow(/not found/);
      } finally {
        cleanup();
      }
    });
  });

  describe('promoteTests', () => {
    it('accepted 文件复制到目标目录，rejected 不复制', async () => {
      const { closureManager, promoter, tmpDir, cleanup } = setup(SAMPLE_GAPS);
      try {
        const session = await closureManager.startClosure({
          sessionId: 'merge_test',
          gaps: [SAMPLE_GAPS[0]],
        });
        const gap0 = session.gaps[0];

        await closureManager.startIteration(session.id, gap0.id);
        await closureManager.completeIteration(session.id, gap0.id, {
          generatedTests: ['accept.sv', 'reject.sv', 'pending.sv'],
          deltaBefore: makeSummary(80),
          deltaAfter: makeSummary(83),
          deltas: makeDeltas(3),
        });
        writeTestFile(session.workspaceDir, gap0.id, 1, 'accept.sv', '// accept content');
        writeTestFile(session.workspaceDir, gap0.id, 1, 'reject.sv', '// reject content');
        writeTestFile(session.workspaceDir, gap0.id, 1, 'pending.sv', '// pending content');

        const queue = await promoter.getPromotionQueue(session.id);
        const acceptId = queue.find((i) => i.fileName === 'accept.sv')!.id;
        const rejectId = queue.find((i) => i.fileName === 'reject.sv')!.id;

        const targetDir = join(tmpDir, 'my-testbench');
        const result = await promoter.promoteTests(
          session.id,
          [acceptId],
          [rejectId],
          targetDir,
        );

        expect(result.promoted).toBe(1);
        expect(result.rejected).toBe(1);

        // accepted 文件已复制到目标目录
        expect(existsSync(join(targetDir, 'accept.sv'))).toBe(true);
        expect(readFileSync(join(targetDir, 'accept.sv'), 'utf-8')).toBe('// accept content');
        // rejected 文件未复制
        expect(existsSync(join(targetDir, 'reject.sv'))).toBe(false);
        // pending 文件未复制
        expect(existsSync(join(targetDir, 'pending.sv'))).toBe(false);

        // 源文件仍保留在 Closure Workspace（promote 不删除源）
        expect(existsSync(join(session.workspaceDir, gap0.id, 'round_1', 'accept.sv'))).toBe(true);
      } finally {
        cleanup();
      }
    });

    it('默认复制到 <projectRoot>/testbench', async () => {
      const { closureManager, promoter, tmpDir, cleanup } = setup([SAMPLE_GAPS[0]]);
      try {
        const session = await closureManager.startClosure({
          sessionId: 'merge_test',
          gaps: [SAMPLE_GAPS[0]],
        });
        const gap0 = session.gaps[0];

        await closureManager.startIteration(session.id, gap0.id);
        await closureManager.completeIteration(session.id, gap0.id, {
          generatedTests: ['default_target.sv'],
          deltaBefore: makeSummary(80),
          deltaAfter: makeSummary(83),
          deltas: makeDeltas(3),
        });
        writeTestFile(session.workspaceDir, gap0.id, 1, 'default_target.sv', '// default');

        const queue = await promoter.getPromotionQueue(session.id);
        const itemId = queue[0].id;

        await promoter.promoteTests(session.id, [itemId], []);

        // 默认目标：<tmpDir>/testbench/default_target.sv
        expect(existsSync(join(tmpDir, 'testbench', 'default_target.sv'))).toBe(true);
      } finally {
        cleanup();
      }
    });

    it('决策记录持久化到 promotion.json，重载后队列状态正确', async () => {
      const { closureManager, promoter, cleanup } = setup([SAMPLE_GAPS[0]]);
      try {
        const session = await closureManager.startClosure({
          sessionId: 'merge_test',
          gaps: [SAMPLE_GAPS[0]],
        });
        const gap0 = session.gaps[0];

        await closureManager.startIteration(session.id, gap0.id);
        await closureManager.completeIteration(session.id, gap0.id, {
          generatedTests: ['persist.sv'],
          deltaBefore: makeSummary(80),
          deltaAfter: makeSummary(83),
          deltas: makeDeltas(3),
        });
        writeTestFile(session.workspaceDir, gap0.id, 1, 'persist.sv', '// persist');

        const queue = await promoter.getPromotionQueue(session.id);
        const itemId = queue[0].id;

        await promoter.promoteTests(session.id, [itemId], []);

        // promotion.json 已写入
        const promotionFile = join(session.workspaceDir, 'promotion.json');
        expect(existsSync(promotionFile)).toBe(true);
        const record = JSON.parse(readFileSync(promotionFile, 'utf-8'));
        expect(record.accepted).toContain(itemId);
        expect(record.closureId).toBe(session.id);

        // 重新加载队列，status 应为 accepted
        const reloaded = await promoter.getPromotionQueue(session.id);
        expect(reloaded[0].status).toBe('accepted');
      } finally {
        cleanup();
      }
    });

    it('空 accepted 列表不复制任何文件', async () => {
      const { closureManager, promoter, tmpDir, cleanup } = setup([SAMPLE_GAPS[0]]);
      try {
        const session = await closureManager.startClosure({
          sessionId: 'merge_test',
          gaps: [SAMPLE_GAPS[0]],
        });
        const gap0 = session.gaps[0];

        await closureManager.startIteration(session.id, gap0.id);
        await closureManager.completeIteration(session.id, gap0.id, {
          generatedTests: ['no_promote.sv'],
          deltaBefore: makeSummary(80),
          deltaAfter: makeSummary(83),
          deltas: makeDeltas(3),
        });
        writeTestFile(session.workspaceDir, gap0.id, 1, 'no_promote.sv', '// no');

        const targetDir = join(tmpDir, 'tb');
        const result = await promoter.promoteTests(session.id, [], [], targetDir);
        expect(result.promoted).toBe(0);
        expect(result.rejected).toBe(0);
        expect(existsSync(join(targetDir, 'no_promote.sv'))).toBe(false);
      } finally {
        cleanup();
      }
    });
  });

  describe('cleanupClosure', () => {
    it('删除整个 Closure Workspace 目录', async () => {
      const { closureManager, promoter, cleanup } = setup([SAMPLE_GAPS[0]]);
      try {
        const session = await closureManager.startClosure({
          sessionId: 'merge_test',
          gaps: [SAMPLE_GAPS[0]],
        });
        const gap0 = session.gaps[0];

        await closureManager.startIteration(session.id, gap0.id);
        await closureManager.completeIteration(session.id, gap0.id, {
          generatedTests: ['cleanup.sv'],
          deltaBefore: makeSummary(80),
          deltaAfter: makeSummary(83),
          deltas: makeDeltas(3),
        });
        writeTestFile(session.workspaceDir, gap0.id, 1, 'cleanup.sv', '// cleanup');

        expect(existsSync(session.workspaceDir)).toBe(true);

        const result = await promoter.cleanupClosure(session.id);
        expect(result.ok).toBe(true);
        expect(existsSync(session.workspaceDir)).toBe(false);
      } finally {
        cleanup();
      }
    });

    it('对已不存在的目录不报错', async () => {
      const { closureManager, promoter, cleanup } = setup([SAMPLE_GAPS[0]]);
      try {
        const session = await closureManager.startClosure({
          sessionId: 'merge_test',
          gaps: [SAMPLE_GAPS[0]],
        });
        // 先清理一次
        await promoter.cleanupClosure(session.id);
        // 再次清理不应报错
        const result = await promoter.cleanupClosure(session.id);
        expect(result.ok).toBe(true);
      } finally {
        cleanup();
      }
    });
  });

  describe('getClosureSummary', () => {
    it('返回各 gap 状态 / finalDelta / 提升计数', async () => {
      const { closureManager, promoter, cleanup } = setup(SAMPLE_GAPS);
      try {
        const session = await closureManager.startClosure({
          sessionId: 'merge_test',
          gaps: SAMPLE_GAPS,
        });
        const gap0 = session.gaps[0];
        const gap1 = session.gaps[1];

        // gap0: 1 轮迭代后关闭，delta=3%
        await closureManager.startIteration(session.id, gap0.id);
        await closureManager.completeIteration(session.id, gap0.id, {
          generatedTests: ['test_a.sv'],
          deltaBefore: makeSummary(80),
          deltaAfter: makeSummary(83),
          deltas: makeDeltas(3),
        });
        await closureManager.closeGap(session.id, gap0.id);
        writeTestFile(session.workspaceDir, gap0.id, 1, 'test_a.sv', '// a');

        // gap1: 升级
        await closureManager.escalateGap(session.id, gap1.id, 'dead code suspected');

        // 执行 promotion：接受 test_a.sv
        const queue = await promoter.getPromotionQueue(session.id);
        const acceptId = queue.find((i) => i.fileName === 'test_a.sv')!.id;
        await promoter.promoteTests(session.id, [acceptId], []);

        const summary = await promoter.getClosureSummary(session.id);
        expect(summary.closureId).toBe(session.id);
        expect(summary.status).toBe('completed');
        expect(summary.gaps).toHaveLength(2);

        // gap0 状态
        const sg0 = summary.gaps.find((g) => g.gapId === gap0.id)!;
        expect(sg0.status).toBe('closed');
        expect(sg0.moduleName).toBe('cpu_core');
        expect(sg0.metric).toBe('line');
        expect(sg0.rounds).toBe(1);
        expect(sg0.finalDelta).toBe(3); // 83 - 80

        // gap1 状态
        const sg1 = summary.gaps.find((g) => g.gapId === gap1.id)!;
        expect(sg1.status).toBe('escalated');
        expect(sg1.escalationReason).toBe('dead code suspected');
        expect(sg1.finalDelta).toBeNull(); // 无迭代

        // totalDelta = 3（仅 gap0 有 finalDelta）
        expect(summary.totalDelta).toBe(3);

        // 计数
        expect(summary.promotedCount).toBe(1);
        expect(summary.pendingCount).toBe(0);
        expect(summary.rejectedCount).toBe(0);
      } finally {
        cleanup();
      }
    });

    it('无迭代时 totalDelta 为 null', async () => {
      const { closureManager, promoter, cleanup } = setup(SAMPLE_GAPS);
      try {
        const session = await closureManager.startClosure({
          sessionId: 'merge_test',
          gaps: SAMPLE_GAPS,
        });
        // 不执行任何迭代
        await closureManager.closeGap(session.id, session.gaps[0].id);
        await closureManager.closeGap(session.id, session.gaps[1].id);

        const summary = await promoter.getClosureSummary(session.id);
        expect(summary.totalDelta).toBeNull();
        expect(summary.gaps[0].finalDelta).toBeNull();
      } finally {
        cleanup();
      }
    });

    it('对不存在的 closure 抛错', async () => {
      const { promoter, cleanup } = setup();
      try {
        await expect(promoter.getClosureSummary('closure_unknown')).rejects.toThrow(/not found/);
      } finally {
        cleanup();
      }
    });
  });
});
