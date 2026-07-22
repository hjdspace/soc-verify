/**
 * ClosureManager 测试（ADR 0009 / GitHub Issue #7 Slice 6a）。
 *
 * 覆盖：
 * - startClosure: 创建 closure session + workspace 目录 + gaps 列表
 * - startClosure: 缺省 gaps 时自动从 CoverageManager.listGaps 获取
 * - getClosure / listClosures
 * - startIteration / completeIteration: 记录迭代历史
 * - shouldEscalate: 连续 2 轮 delta < 1% 触发升级
 * - closeGap / escalateGap
 * - abortClosure: 中止后所有 in_progress gaps 变 failed
 * - 持久化：closure.json 读写
 */

import { describe, it, expect, vi } from 'vitest';
import { ClosureManager } from '../../src/main/coverage/closure-manager';
import type { ClosureGap } from '../../src/main/coverage/closure-manager';
import type { CoverageManager } from '../../src/main/coverage/coverage-manager';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  CoverageGap,
  CoverageSummary,
  CoverageDelta,
  CoverageMetric,
} from '@shared/types';

// ─── Mock 数据辅助 ──────────────────────────────────────────────

/** 构造一个 CoverageGap。 */
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

/** 构造一个 CoverageSummary，所有 metric 统一为 overall 值。 */
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

/** 构造 CoverageDelta[]（8 个 metric，delta 统一）。 */
function makeDeltas(delta: number): CoverageDelta[] {
  const metrics: CoverageMetric[] = [
    'line', 'branch', 'toggle', 'condition',
    'fsm_state', 'fsm_transition', 'functional', 'assertion',
  ];
  return metrics.map((m) => ({ metric: m, before: 0, after: delta, delta }));
}

/** 创建 mock CoverageManager，仅实现 listGaps。 */
function createMockCoverageManager(gaps: CoverageGap[] = []): CoverageManager {
  return {
    listGaps: vi.fn(async (_sessionId?: string) => ({ sessionId: 'mock-session', gaps })),
  } as unknown as CoverageManager;
}

/** 创建临时目录 + ClosureManager。 */
function setupClosureManager(gaps: CoverageGap[] = []) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'closure-'));
  const coverageManager = createMockCoverageManager(gaps);
  const mgr = new ClosureManager({ projectRoot: tmpDir, coverageManager });
  return {
    mgr,
    tmpDir,
    coverageManager,
    cleanup: () => rmSync(tmpDir, { recursive: true }),
  };
}

const SAMPLE_GAPS: CoverageGap[] = [
  makeGap('top/cpu_core', 'line', 80, 95),
  makeGap('top/memory_ctrl', 'toggle', 75, 85),
];

describe('ClosureManager', () => {
  describe('startClosure', () => {
    it('创建 closure session + workspace 目录 + gaps 列表', async () => {
      const { mgr, tmpDir, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test_1',
          gaps: SAMPLE_GAPS,
        });

        // closureId 格式
        expect(session.id).toMatch(/^closure_\d{8}_\d{6}_/);
        expect(session.sessionId).toBe('merge_test_1');
        expect(session.status).toBe('running');
        expect(session.createdAt).toBeGreaterThan(0);
        expect(session.maxRounds).toBe(5); // 默认值
        expect(session.escalationThreshold).toBe(2); // 默认值

        // 每个 gap 创建独立工作项
        expect(session.gaps).toHaveLength(2);
        expect(session.gaps[0].gap.nodePath).toBe('top/cpu_core');
        expect(session.gaps[0].status).toBe('pending');
        expect(session.gaps[0].iterations).toEqual([]);
        expect(session.gaps[1].gap.nodePath).toBe('top/memory_ctrl');

        // workspace 目录已创建
        expect(session.workspaceDir).toBe(join(tmpDir, '.socverify', 'coverage', 'closure', session.id));
        expect(existsSync(session.workspaceDir)).toBe(true);
        // 每个 gap 的子目录已创建
        for (const gap of session.gaps) {
          expect(existsSync(join(session.workspaceDir, gap.id))).toBe(true);
        }
      } finally {
        cleanup();
      }
    });

    it('缺省 gaps 时自动从 CoverageManager.listGaps 获取', async () => {
      const { mgr, coverageManager, cleanup } = setupClosureManager(SAMPLE_GAPS);
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test_2',
          // 不传 gaps，应自动调用 listGaps
        });

        // listGaps 被调用
        expect(coverageManager.listGaps).toHaveBeenCalledWith('merge_test_2');
        // gaps 来自 mock 返回
        expect(session.gaps).toHaveLength(2);
        expect(session.gaps[0].gap.nodePath).toBe('top/cpu_core');
      } finally {
        cleanup();
      }
    });

    it('自定义 maxRounds 生效', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test_3',
          gaps: SAMPLE_GAPS,
          maxRounds: 3,
        });
        expect(session.maxRounds).toBe(3);
      } finally {
        cleanup();
      }
    });
  });

  describe('getClosure / listClosures', () => {
    it('getClosure 返回指定 session', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test',
          gaps: SAMPLE_GAPS,
        });
        const found = await mgr.getClosure(session.id);
        expect(found).not.toBeNull();
        expect(found!.id).toBe(session.id);
        expect(found!.gaps).toHaveLength(2);
      } finally {
        cleanup();
      }
    });

    it('getClosure 对未知 id 返回 null', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const found = await mgr.getClosure('closure_unknown');
        expect(found).toBeNull();
      } finally {
        cleanup();
      }
    });

    it('listClosures 返回所有 session', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        await mgr.startClosure({ sessionId: 'merge_1', gaps: SAMPLE_GAPS });
        await mgr.startClosure({ sessionId: 'merge_2', gaps: [SAMPLE_GAPS[0]] });
        const list = await mgr.listClosures();
        expect(list).toHaveLength(2);
      } finally {
        cleanup();
      }
    });
  });

  describe('startIteration / completeIteration', () => {
    it('记录迭代历史并推进 gap 状态', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test',
          gaps: [SAMPLE_GAPS[0]],
        });
        const gapId = session.gaps[0].id;

        // 第一轮
        const it1 = await mgr.startIteration(session.id, gapId);
        expect(it1.round).toBe(1);
        expect(it1.status).toBe('running');

        // gap 从 pending 进入 in_progress
        const afterStart = await mgr.getClosure(session.id);
        expect(afterStart!.gaps[0].status).toBe('in_progress');

        // 完成第一轮（delta=2%，不触发升级）
        const completed = await mgr.completeIteration(session.id, gapId, {
          generatedTests: ['test_r1.sv'],
          deltaBefore: makeSummary(80),
          deltaAfter: makeSummary(82),
          deltas: makeDeltas(2),
        });
        expect(completed.status).toBe('completed');
        expect(completed.generatedTests).toEqual(['test_r1.sv']);
        expect(completed.deltaBefore!.overall).toBe(80);
        expect(completed.deltaAfter!.overall).toBe(82);

        // 迭代历史已记录
        const afterComplete = await mgr.getClosure(session.id);
        expect(afterComplete!.gaps[0].iterations).toHaveLength(1);
        expect(afterComplete!.gaps[0].iterations[0].round).toBe(1);
        expect(afterComplete!.gaps[0].iterations[0].status).toBe('completed');
        // 仅 1 轮，未达升级阈值，gap 仍为 in_progress
        expect(afterComplete!.gaps[0].status).toBe('in_progress');
      } finally {
        cleanup();
      }
    });

    it('多轮迭代 round 递增', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test',
          gaps: [SAMPLE_GAPS[0]],
        });
        const gapId = session.gaps[0].id;

        await mgr.startIteration(session.id, gapId);
        await mgr.completeIteration(session.id, gapId, {
          generatedTests: [],
          deltaBefore: makeSummary(80),
          deltaAfter: makeSummary(85), // delta=5%，不触发升级
          deltas: makeDeltas(5),
        });

        await mgr.startIteration(session.id, gapId);
        const it2 = await mgr.completeIteration(session.id, gapId, {
          generatedTests: [],
          deltaBefore: makeSummary(85),
          deltaAfter: makeSummary(90), // delta=5%，不触发升级
          deltas: makeDeltas(5),
        });
        expect(it2.round).toBe(2);

        const found = await mgr.getClosure(session.id);
        expect(found!.gaps[0].iterations).toHaveLength(2);
        expect(found!.gaps[0].iterations[1].round).toBe(2);
      } finally {
        cleanup();
      }
    });
  });

  describe('shouldEscalate', () => {
    it('连续 2 轮 delta < 1% 触发升级', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test',
          gaps: [SAMPLE_GAPS[0]],
        });
        const gapId = session.gaps[0].id;

        // 第一轮 delta=0.5%
        await mgr.startIteration(session.id, gapId);
        await mgr.completeIteration(session.id, gapId, {
          generatedTests: [],
          deltaBefore: makeSummary(80),
          deltaAfter: makeSummary(80.5),
          deltas: makeDeltas(0.5),
        });

        // 仅 1 轮，不应升级
        let found = await mgr.getClosure(session.id);
        expect(found!.gaps[0].status).toBe('in_progress');

        // 第二轮 delta=0.3%
        await mgr.startIteration(session.id, gapId);
        await mgr.completeIteration(session.id, gapId, {
          generatedTests: [],
          deltaBefore: makeSummary(80.5),
          deltaAfter: makeSummary(80.8),
          deltas: makeDeltas(0.3),
        });

        // 连续 2 轮 delta < 1%，应升级
        found = await mgr.getClosure(session.id);
        expect(found!.gaps[0].status).toBe('escalated');
        expect(found!.gaps[0].escalationReason).toContain('连续 2 轮');
      } finally {
        cleanup();
      }
    });

    it('delta >= 1% 时不触发升级', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test',
          gaps: [SAMPLE_GAPS[0]],
        });
        const gapId = session.gaps[0].id;

        // 第一轮 delta=1.5%
        await mgr.startIteration(session.id, gapId);
        await mgr.completeIteration(session.id, gapId, {
          generatedTests: [],
          deltaBefore: makeSummary(80),
          deltaAfter: makeSummary(81.5),
          deltas: makeDeltas(1.5),
        });

        // 第二轮 delta=0.5%（但第一轮 >= 1%，不满足连续 2 轮）
        await mgr.startIteration(session.id, gapId);
        await mgr.completeIteration(session.id, gapId, {
          generatedTests: [],
          deltaBefore: makeSummary(81.5),
          deltaAfter: makeSummary(82),
          deltas: makeDeltas(0.5),
        });

        const found = await mgr.getClosure(session.id);
        expect(found!.gaps[0].status).toBe('in_progress');
      } finally {
        cleanup();
      }
    });

    it('不足 2 轮时不触发升级', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test',
          gaps: [SAMPLE_GAPS[0]],
        });
        const gapId = session.gaps[0].id;

        await mgr.startIteration(session.id, gapId);
        await mgr.completeIteration(session.id, gapId, {
          generatedTests: [],
          deltaBefore: makeSummary(80),
          deltaAfter: makeSummary(80.1), // delta=0.1%
          deltas: makeDeltas(0.1),
        });

        const found = await mgr.getClosure(session.id);
        expect(found!.gaps[0].status).toBe('in_progress');
      } finally {
        cleanup();
      }
    });

    it('shouldEscalate 直接调用：纯函数逻辑验证', () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        // 2 轮均 < 1% → true
        const gapLowDelta: ClosureGap = {
          id: 'g1',
          gap: SAMPLE_GAPS[0],
          iterations: [
            { round: 1, generatedTests: [], status: 'completed', deltaBefore: makeSummary(80), deltaAfter: makeSummary(80.5), deltas: [] },
            { round: 2, generatedTests: [], status: 'completed', deltaBefore: makeSummary(80.5), deltaAfter: makeSummary(80.8), deltas: [] },
          ],
          status: 'in_progress',
        };
        expect(mgr.shouldEscalate(gapLowDelta)).toBe(true);

        // 第二轮 delta >= 1% → false
        const gapMixedDelta: ClosureGap = {
          id: 'g2',
          gap: SAMPLE_GAPS[0],
          iterations: [
            { round: 1, generatedTests: [], status: 'completed', deltaBefore: makeSummary(80), deltaAfter: makeSummary(80.5), deltas: [] },
            { round: 2, generatedTests: [], status: 'completed', deltaBefore: makeSummary(80.5), deltaAfter: makeSummary(82), deltas: [] },
          ],
          status: 'in_progress',
        };
        expect(mgr.shouldEscalate(gapMixedDelta)).toBe(false);

        // 仅 1 轮 → false
        const gapOneRound: ClosureGap = {
          id: 'g3',
          gap: SAMPLE_GAPS[0],
          iterations: [
            { round: 1, generatedTests: [], status: 'completed', deltaBefore: makeSummary(80), deltaAfter: makeSummary(80.1), deltas: [] },
          ],
          status: 'in_progress',
        };
        expect(mgr.shouldEscalate(gapOneRound)).toBe(false);

        // 空迭代 → false
        const gapEmpty: ClosureGap = {
          id: 'g4',
          gap: SAMPLE_GAPS[0],
          iterations: [],
          status: 'pending',
        };
        expect(mgr.shouldEscalate(gapEmpty)).toBe(false);
      } finally {
        cleanup();
      }
    });
  });

  describe('closeGap / escalateGap', () => {
    it('closeGap 标记 gap 为 closed', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test',
          gaps: [SAMPLE_GAPS[0]],
        });
        const gapId = session.gaps[0].id;
        await mgr.closeGap(session.id, gapId);
        const found = await mgr.getClosure(session.id);
        expect(found!.gaps[0].status).toBe('closed');
        // 所有 gap 终态后 closure 自动完成
        expect(found!.status).toBe('completed');
      } finally {
        cleanup();
      }
    });

    it('escalateGap 标记 gap 为 escalated 并记录原因', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test',
          gaps: [SAMPLE_GAPS[0]],
        });
        const gapId = session.gaps[0].id;
        await mgr.escalateGap(session.id, gapId, 'manual review needed');
        const found = await mgr.getClosure(session.id);
        expect(found!.gaps[0].status).toBe('escalated');
        expect(found!.gaps[0].escalationReason).toBe('manual review needed');
        expect(found!.status).toBe('completed');
      } finally {
        cleanup();
      }
    });
  });

  describe('abortClosure', () => {
    it('中止后所有 in_progress gaps 变 failed', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test',
          gaps: SAMPLE_GAPS, // 2 个 gap，初始 pending
        });
        // 启动第一个 gap 的迭代 → 变 in_progress
        await mgr.startIteration(session.id, session.gaps[0].id);
        // 第二个 gap 仍 pending

        await mgr.abortClosure(session.id);
        const found = await mgr.getClosure(session.id);
        expect(found!.status).toBe('aborted');
        // in_progress gap → failed
        expect(found!.gaps[0].status).toBe('failed');
        // pending gap 也 → failed
        expect(found!.gaps[1].status).toBe('failed');
      } finally {
        cleanup();
      }
    });

    it('中止后无法再启动新迭代', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test',
          gaps: [SAMPLE_GAPS[0]],
        });
        await mgr.abortClosure(session.id);
        await expect(
          mgr.startIteration(session.id, session.gaps[0].id),
        ).rejects.toThrow(/aborted/);
      } finally {
        cleanup();
      }
    });
  });

  describe('failIteration', () => {
    it('标记当前迭代为 failed 并记录错误', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test',
          gaps: [SAMPLE_GAPS[0]],
        });
        const gapId = session.gaps[0].id;
        await mgr.startIteration(session.id, gapId);
        await mgr.failIteration(session.id, gapId, 'compile error');
        const found = await mgr.getClosure(session.id);
        const it = found!.gaps[0].iterations[0];
        expect(it.status).toBe('failed');
        expect(it.error).toBe('compile error');
      } finally {
        cleanup();
      }
    });
  });

  describe('持久化', () => {
    it('closure.json 写入并可重新加载', async () => {
      const { mgr, tmpDir, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test',
          gaps: SAMPLE_GAPS,
        });
        const gapId = session.gaps[0].id;
        await mgr.startIteration(session.id, gapId);
        await mgr.completeIteration(session.id, gapId, {
          generatedTests: ['test_persist.sv'],
          deltaBefore: makeSummary(80),
          deltaAfter: makeSummary(83),
          deltas: makeDeltas(3),
        });

        // closures.json 存在
        const closuresFile = join(tmpDir, '.socverify', 'coverage', 'closure', 'closures.json');
        expect(existsSync(closuresFile)).toBe(true);
        const closuresRaw = readFileSync(closuresFile, 'utf-8');
        const closuresList = JSON.parse(closuresRaw);
        expect(Array.isArray(closuresList)).toBe(true);
        expect(closuresList).toHaveLength(1);
        expect(closuresList[0].id).toBe(session.id);

        // closure.json 存在且包含完整数据
        const closureFile = join(session.workspaceDir, 'closure.json');
        expect(existsSync(closureFile)).toBe(true);
        const closureRaw = readFileSync(closureFile, 'utf-8');
        const closureData = JSON.parse(closureRaw);
        expect(closureData.id).toBe(session.id);
        expect(closureData.gaps).toHaveLength(2);
        expect(closureData.gaps[0].iterations).toHaveLength(1);
        expect(closureData.gaps[0].iterations[0].generatedTests).toEqual(['test_persist.sv']);

        // 新 ClosureManager 实例（模拟重启）能加载已持久化的数据
        const newMgr = new ClosureManager({
          projectRoot: tmpDir,
          coverageManager: createMockCoverageManager(),
        });
        const reloaded = await newMgr.getClosure(session.id);
        expect(reloaded).not.toBeNull();
        expect(reloaded!.gaps).toHaveLength(2);
        expect(reloaded!.gaps[0].iterations).toHaveLength(1);
        expect(reloaded!.gaps[0].iterations[0].status).toBe('completed');
      } finally {
        cleanup();
      }
    });

    it('getWorkspaceDir 返回正确路径', async () => {
      const { mgr, tmpDir, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test',
          gaps: SAMPLE_GAPS,
        });
        const wsDir = mgr.getWorkspaceDir(session.id);
        expect(wsDir).toBe(join(tmpDir, '.socverify', 'coverage', 'closure', session.id));
        expect(existsSync(wsDir)).toBe(true);
      } finally {
        cleanup();
      }
    });
  });

  describe('错误处理', () => {
    it('startIteration 对不存在的 closure 抛错', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        await expect(
          mgr.startIteration('closure_unknown', 'gap_unknown'),
        ).rejects.toThrow(/not found/);
      } finally {
        cleanup();
      }
    });

    it('startIteration 对不存在的 gap 抛错', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test',
          gaps: [SAMPLE_GAPS[0]],
        });
        await expect(
          mgr.startIteration(session.id, 'gap_unknown'),
        ).rejects.toThrow(/not found/);
      } finally {
        cleanup();
      }
    });

    it('completeIteration 无活动迭代时抛错', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test',
          gaps: [SAMPLE_GAPS[0]],
        });
        const gapId = session.gaps[0].id;
        // 未先 startIteration 直接 completeIteration
        await expect(
          mgr.completeIteration(session.id, gapId, {
            generatedTests: [],
            deltaBefore: makeSummary(80),
            deltaAfter: makeSummary(82),
            deltas: makeDeltas(2),
          }),
        ).rejects.toThrow(/No active iteration/);
      } finally {
        cleanup();
      }
    });
  });
});
