/**
 * ClosureManager 测试（ADR 0025 模块级 Closure Target / 工单 04）。
 *
 * 覆盖：
 * - startClosure 模块级聚合：同模块多 metric gap → 单 target；无 gap 模块跳过；
 *   全部无 gap 报错；modules 缺省时自动聚合全部有 gap 模块
 * - 状态机迁移全集：pending → in_progress → closed / escalated / failed
 * - isTargetMet 达标判定矩阵：全部达标 / 任一未达标 / N/A 不阻断 / 无目标配置不阻断
 * - completeIteration 达标评估：传达标 coverage → closed；达标优先于升级
 * - 升级判定：连续 N 轮 delta < 1% → escalated + 原因；中间一轮达标 → closed；
 *   自定义 escalationThreshold 生效
 * - 旧 closure.json（per-gap 格式）迁移：每个 gap 转单 metric target，id 保留
 * - 持久化：targets 结构写入 / <targetId>/round_N 目录 / 新实例重载
 */

import { describe, it, expect, vi } from 'vitest';
import { ClosureManager, isTargetMet } from '../../src/main/coverage/closure-manager';
import type { ClosureTarget } from '../../src/main/coverage/closure-manager';
import type { CoverageManager } from '../../src/main/coverage/coverage-manager';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  CoverageData,
  CoverageNode,
  CoverageTriplet,
  CoverageMetric,
  CoverageSummary,
  CoverageDelta,
} from '@shared/types';
import { COVERAGE_METRICS } from '@shared/types';

// ─── Mock 数据辅助 ──────────────────────────────────────────────

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

/**
 * 构造模块 metrics：指定的 metric 用给定百分比，未指定的 metric 为 N/A（null）。
 * N/A 用于验证「不阻断达标判定」语义。
 */
function makeMetrics(
  pcts: Partial<Record<CoverageMetric, number>>,
): Record<CoverageMetric, CoverageTriplet> {
  const out = {} as Record<CoverageMetric, CoverageTriplet>;
  for (const m of COVERAGE_METRICS) {
    out[m] = { percentage: pcts[m] ?? null, covered: null, total: null };
  }
  return out;
}

/** 构造 CoverageNode（metrics 未指定的项为 N/A）。 */
function makeNode(
  name: string,
  path: string,
  pcts: Partial<Record<CoverageMetric, number>>,
  children: CoverageNode[] = [],
): CoverageNode {
  return {
    name,
    path,
    depth: path.split('/').filter(Boolean).length - 1,
    metrics: makeMetrics(pcts),
    children,
  };
}

/**
 * 样例 Coverage Tree：
 *   top            line 98（达标，无 gap）
 *   ├─ cpu_core    line 80 / branch 70（2 个 gap）、toggle 90（达标）
 *   ├─ memory_ctrl toggle 75（1 个 gap）
 *   └─ clean_mod   line 99 / toggle 90（全达标，无 gap）
 */
function buildSampleTree(): CoverageNode {
  return makeNode('top', 'top', { line: 98 }, [
    makeNode('cpu_core', 'top/cpu_core', { line: 80, branch: 70, toggle: 90 }),
    makeNode('memory_ctrl', 'top/memory_ctrl', { toggle: 75 }),
    makeNode('clean_mod', 'top/clean_mod', { line: 99, toggle: 90 }),
  ]);
}

/** 测试用 Coverage Target 配置（显式传入，避免依赖默认值）。 */
const TARGETS_CFG: Partial<Record<CoverageMetric, number>> = {
  line: 95,
  branch: 90,
  toggle: 85,
};

/** 创建 mock CoverageManager：提供 getTree / getTargets 数据源。 */
function createMockCoverageManager(
  root: CoverageNode,
  targets: Partial<Record<CoverageMetric, number>>,
): CoverageManager {
  const data: CoverageData = {
    sessionId: 'mock-session',
    source: { covMergeDir: 'cov_merge', edaTool: 'imc', reportGeneratedAt: 0 },
    root,
    targets,
  };
  return {
    getTree: vi.fn(async () => data),
    getTargets: vi.fn(async () => targets),
  } as unknown as CoverageManager;
}

/** 创建临时目录 + ClosureManager（默认挂载样例树）。 */
function setupClosureManager(
  root: CoverageNode = buildSampleTree(),
  targets: Partial<Record<CoverageMetric, number>> = TARGETS_CFG,
) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'closure-'));
  const coverageManager = createMockCoverageManager(root, targets);
  const mgr = new ClosureManager({ projectRoot: tmpDir, coverageManager });
  return {
    mgr,
    tmpDir,
    coverageManager,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
}

// ─── 测试 ────────────────────────────────────────────────────────

describe('ClosureManager', () => {
  describe('startClosure 模块级聚合', () => {
    it('同模块多 metric gap 聚合为单个 target', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test_1',
          modules: ['top/cpu_core'],
        });

        expect(session.id).toMatch(/^closure_\d{8}_\d{6}_/);
        expect(session.sessionId).toBe('merge_test_1');
        expect(session.status).toBe('running');
        expect(session.maxRounds).toBe(5); // 默认值
        expect(session.escalationThreshold).toBe(2); // 默认值

        // cpu_core 的 line + branch 两个 gap 聚合为 1 个 target
        expect(session.targets).toHaveLength(1);
        const target = session.targets[0];
        expect(target.id).toMatch(/^target_/);
        expect(target.module).toEqual({ path: 'top/cpu_core', name: 'cpu_core' });
        expect(target.gaps).toHaveLength(2);
        expect(target.gaps.map((g) => g.metric)).toEqual(['line', 'branch']);
        expect(target.gaps[0]).toMatchObject({
          nodePath: 'top/cpu_core',
          nodeName: 'cpu_core',
          target: 95,
          actual: 80,
          deficit: 15,
        });
        expect(target.iterations).toEqual([]);
        expect(target.status).toBe('pending');
      } finally {
        cleanup();
      }
    });

    it('多模块选择 → 每模块一个 target；无 gap 的选中模块被跳过', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test_2',
          modules: ['top/cpu_core', 'top/memory_ctrl', 'top/clean_mod'],
        });

        // clean_mod 无 gap → 跳过，不产生 target
        expect(session.targets).toHaveLength(2);
        expect(session.targets.map((t) => t.module.path)).toEqual([
          'top/cpu_core',
          'top/memory_ctrl',
        ]);
        expect(session.targets[1].gaps.map((g) => g.metric)).toEqual(['toggle']);
      } finally {
        cleanup();
      }
    });

    it('全部选中模块无 gap 时报错', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        await expect(
          mgr.startClosure({ sessionId: 'merge_test_3', modules: ['top/clean_mod'] }),
        ).rejects.toThrow(/无未达标/);
      } finally {
        cleanup();
      }
    });

    it('modules 缺省时自动聚合全部有 gap 的模块', async () => {
      const { mgr, coverageManager, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({ sessionId: 'merge_test_4' });

        expect(coverageManager.getTree).toHaveBeenCalledWith('merge_test_4');
        // top 自身达标、clean_mod 达标 → 只有 cpu_core / memory_ctrl 两个 target
        expect(session.targets).toHaveLength(2);
        expect(session.targets.map((t) => t.module.path)).toEqual([
          'top/cpu_core',
          'top/memory_ctrl',
        ]);
      } finally {
        cleanup();
      }
    });

    it('自定义 maxRounds / escalationThreshold 生效', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test_5',
          modules: ['top/cpu_core'],
          maxRounds: 3,
          escalationThreshold: 4,
        });
        expect(session.maxRounds).toBe(3);
        expect(session.escalationThreshold).toBe(4);
      } finally {
        cleanup();
      }
    });

    it('创建 workspace 目录及每个 target 的子目录', async () => {
      const { mgr, tmpDir, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test_6',
          modules: ['top/cpu_core'],
        });
        expect(session.workspaceDir).toBe(
          join(tmpDir, '.socverify', 'coverage', 'closure', session.id),
        );
        expect(existsSync(session.workspaceDir)).toBe(true);
        for (const target of session.targets) {
          expect(existsSync(join(session.workspaceDir, target.id))).toBe(true);
        }
      } finally {
        cleanup();
      }
    });
  });

  describe('getClosure / listClosures', () => {
    it('getClosure 返回指定 session（targets 结构）', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test',
          modules: ['top/cpu_core', 'top/memory_ctrl'],
        });
        const found = await mgr.getClosure(session.id);
        expect(found).not.toBeNull();
        expect(found!.id).toBe(session.id);
        expect(found!.targets).toHaveLength(2);
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
        await mgr.startClosure({ sessionId: 'merge_1', modules: ['top/cpu_core'] });
        await mgr.startClosure({ sessionId: 'merge_2', modules: ['top/memory_ctrl'] });
        const list = await mgr.listClosures();
        expect(list).toHaveLength(2);
      } finally {
        cleanup();
      }
    });
  });

  describe('状态机迁移', () => {
    it('pending → startIteration → in_progress', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test',
          modules: ['top/cpu_core'],
        });
        const targetId = session.targets[0].id;
        expect(session.targets[0].status).toBe('pending');

        const it1 = await mgr.startIteration(session.id, targetId);
        expect(it1.round).toBe(1);
        expect(it1.status).toBe('running');

        const afterStart = await mgr.getClosure(session.id);
        expect(afterStart!.targets[0].status).toBe('in_progress');
      } finally {
        cleanup();
      }
    });

    it('in_progress → closeTarget → closed，全部终态后 closure 自动 completed', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test',
          modules: ['top/cpu_core'],
        });
        await mgr.startIteration(session.id, session.targets[0].id);
        await mgr.closeTarget(session.id, session.targets[0].id);

        const found = await mgr.getClosure(session.id);
        expect(found!.targets[0].status).toBe('closed');
        expect(found!.status).toBe('completed');
      } finally {
        cleanup();
      }
    });

    it('in_progress → escalateTarget → escalated 并记录原因', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test',
          modules: ['top/cpu_core'],
        });
        await mgr.startIteration(session.id, session.targets[0].id);
        await mgr.escalateTarget(session.id, session.targets[0].id, 'manual review needed');

        const found = await mgr.getClosure(session.id);
        expect(found!.targets[0].status).toBe('escalated');
        expect(found!.targets[0].escalationReason).toBe('manual review needed');
        expect(found!.status).toBe('completed');
      } finally {
        cleanup();
      }
    });

    it('in_progress → failTarget → failed 并记录原因', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test',
          modules: ['top/cpu_core'],
        });
        await mgr.startIteration(session.id, session.targets[0].id);
        await mgr.failTarget(session.id, session.targets[0].id, 'session creation failed');

        const found = await mgr.getClosure(session.id);
        expect(found!.targets[0].status).toBe('failed');
        expect(found!.targets[0].escalationReason).toBe('session creation failed');
        expect(found!.status).toBe('completed');
      } finally {
        cleanup();
      }
    });

    it('abortClosure 将未终态 target 置为 failed，中止后无法再启动迭代', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test',
          modules: ['top/cpu_core', 'top/memory_ctrl'],
        });
        await mgr.startIteration(session.id, session.targets[0].id);
        // 第二个 target 仍 pending

        await mgr.abortClosure(session.id);
        const found = await mgr.getClosure(session.id);
        expect(found!.status).toBe('aborted');
        expect(found!.targets[0].status).toBe('failed'); // in_progress → failed
        expect(found!.targets[1].status).toBe('failed'); // pending → failed

        await expect(
          mgr.startIteration(session.id, session.targets[0].id),
        ).rejects.toThrow(/aborted/);
      } finally {
        cleanup();
      }
    });

    it('failIteration 标记当前迭代为 failed 并记录错误', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test',
          modules: ['top/cpu_core'],
        });
        const targetId = session.targets[0].id;
        await mgr.startIteration(session.id, targetId);
        await mgr.failIteration(session.id, targetId, 'compile error');

        const found = await mgr.getClosure(session.id);
        const it = found!.targets[0].iterations[0];
        expect(it.status).toBe('failed');
        expect(it.error).toBe('compile error');
      } finally {
        cleanup();
      }
    });
  });

  describe('isTargetMet 达标判定矩阵', () => {
    /** 构造单模块 target（gaps 由 metrics 快照推导，仅用于纯函数测试）。 */
    const makeTarget = (gaps: Array<{ metric: CoverageMetric; target: number }>): ClosureTarget => ({
      id: 't1',
      module: { path: 'top/cpu_core', name: 'cpu_core' },
      gaps: gaps.map((g) => ({
        nodePath: 'top/cpu_core',
        nodeName: 'cpu_core',
        metric: g.metric,
        target: g.target,
        actual: 0,
        deficit: g.target,
      })),
      iterations: [],
      status: 'in_progress',
    });

    it('全部 metric 达标 → met', () => {
      const target = makeTarget([
        { metric: 'line', target: 95 },
        { metric: 'branch', target: 90 },
      ]);
      const metrics = makeMetrics({ line: 95, branch: 90.5 });
      expect(isTargetMet(target, metrics, TARGETS_CFG)).toBe(true);
    });

    it('任一 metric 未达标 → 未 met', () => {
      const target = makeTarget([
        { metric: 'line', target: 95 },
        { metric: 'branch', target: 90 },
      ]);
      const metrics = makeMetrics({ line: 96, branch: 89.9 });
      expect(isTargetMet(target, metrics, TARGETS_CFG)).toBe(false);
    });

    it('N/A metric（percentage=null）不阻断达标', () => {
      const target = makeTarget([
        { metric: 'line', target: 95 },
        { metric: 'branch', target: 90 },
      ]);
      // branch 未提供 → N/A；line 达标 → 整体 met
      const metrics = makeMetrics({ line: 95 });
      expect(isTargetMet(target, metrics, TARGETS_CFG)).toBe(true);
    });

    it('targets 配置中无目标的 metric 不阻断达标', () => {
      const target = makeTarget([
        { metric: 'line', target: 95 },
        { metric: 'assertion', target: 100 },
      ]);
      // TARGETS_CFG 无 assertion 目标；line 达标 → 整体 met
      const metrics = makeMetrics({ line: 95, assertion: 50 });
      expect(isTargetMet(target, metrics, TARGETS_CFG)).toBe(true);
    });

    it('空 gaps 的 target 视为 met（无未达标项）', () => {
      const target = makeTarget([]);
      expect(isTargetMet(target, makeMetrics({}), TARGETS_CFG)).toBe(true);
    });
  });

  describe('completeIteration 达标评估', () => {
    it('传入达标 coverage → target 置为 closed', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test',
          modules: ['top/cpu_core'],
        });
        const targetId = session.targets[0].id;

        await mgr.startIteration(session.id, targetId);
        const completed = await mgr.completeIteration(session.id, targetId, {
          generatedTests: ['test_r1.sv'],
          deltaBefore: makeSummary(80),
          deltaAfter: makeSummary(82),
          deltas: makeDeltas(2),
          coverage: {
            metrics: makeMetrics({ line: 95.5, branch: 91 }),
            targets: TARGETS_CFG,
          },
        });
        expect(completed.status).toBe('completed');

        const found = await mgr.getClosure(session.id);
        expect(found!.targets[0].status).toBe('closed');
        expect(found!.status).toBe('completed');
      } finally {
        cleanup();
      }
    });

    it('传入未达标 coverage → target 继续 in_progress', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test',
          modules: ['top/cpu_core'],
        });
        const targetId = session.targets[0].id;

        await mgr.startIteration(session.id, targetId);
        await mgr.completeIteration(session.id, targetId, {
          generatedTests: [],
          deltaBefore: makeSummary(80),
          deltaAfter: makeSummary(85),
          deltas: makeDeltas(5),
          coverage: {
            // branch 仍差 0.5
            metrics: makeMetrics({ line: 95, branch: 89.5 }),
            targets: TARGETS_CFG,
          },
        });

        const found = await mgr.getClosure(session.id);
        expect(found!.targets[0].status).toBe('in_progress');
      } finally {
        cleanup();
      }
    });

    it('达标优先于升级：连续低 delta 但本轮 coverage 达标 → closed 而非 escalated', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test',
          modules: ['top/cpu_core'],
        });
        const targetId = session.targets[0].id;

        // 第 1 轮 delta=0.5（不传 coverage，仅记录）
        await mgr.startIteration(session.id, targetId);
        await mgr.completeIteration(session.id, targetId, {
          generatedTests: [],
          deltaBefore: makeSummary(80),
          deltaAfter: makeSummary(80.5),
          deltas: makeDeltas(0.5),
        });

        // 第 2 轮 delta=0.3（低 delta，本应触发升级）但 coverage 已达标
        await mgr.startIteration(session.id, targetId);
        await mgr.completeIteration(session.id, targetId, {
          generatedTests: [],
          deltaBefore: makeSummary(80.5),
          deltaAfter: makeSummary(80.8),
          deltas: makeDeltas(0.3),
          coverage: {
            metrics: makeMetrics({ line: 96, branch: 92 }),
            targets: TARGETS_CFG,
          },
        });

        const found = await mgr.getClosure(session.id);
        expect(found!.targets[0].status).toBe('closed');
        expect(found!.targets[0].escalationReason).toBeUndefined();
      } finally {
        cleanup();
      }
    });

    it('多轮迭代 round 递增并记录迭代历史', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test',
          modules: ['top/cpu_core'],
        });
        const targetId = session.targets[0].id;

        await mgr.startIteration(session.id, targetId);
        const it1 = await mgr.completeIteration(session.id, targetId, {
          generatedTests: ['test_r1.sv'],
          deltaBefore: makeSummary(80),
          deltaAfter: makeSummary(85),
          deltas: makeDeltas(5),
        });
        expect(it1.round).toBe(1);
        expect(it1.generatedTests).toEqual(['test_r1.sv']);
        expect(it1.deltaAfter!.overall).toBe(85);

        await mgr.startIteration(session.id, targetId);
        const it2 = await mgr.completeIteration(session.id, targetId, {
          generatedTests: [],
          deltaBefore: makeSummary(85),
          deltaAfter: makeSummary(90),
          deltas: makeDeltas(5),
        });
        expect(it2.round).toBe(2);

        const found = await mgr.getClosure(session.id);
        expect(found!.targets[0].iterations).toHaveLength(2);
        expect(found!.targets[0].iterations.map((i) => i.round)).toEqual([1, 2]);
        expect(found!.targets[0].status).toBe('in_progress');
      } finally {
        cleanup();
      }
    });
  });

  describe('升级判定', () => {
    it('连续 2 轮 delta < 1% 触发升级并记录原因', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test',
          modules: ['top/cpu_core'],
        });
        const targetId = session.targets[0].id;

        await mgr.startIteration(session.id, targetId);
        await mgr.completeIteration(session.id, targetId, {
          generatedTests: [],
          deltaBefore: makeSummary(80),
          deltaAfter: makeSummary(80.5),
          deltas: makeDeltas(0.5),
        });
        // 仅 1 轮，不应升级
        let found = await mgr.getClosure(session.id);
        expect(found!.targets[0].status).toBe('in_progress');

        await mgr.startIteration(session.id, targetId);
        await mgr.completeIteration(session.id, targetId, {
          generatedTests: [],
          deltaBefore: makeSummary(80.5),
          deltaAfter: makeSummary(80.8),
          deltas: makeDeltas(0.3),
        });

        found = await mgr.getClosure(session.id);
        expect(found!.targets[0].status).toBe('escalated');
        expect(found!.targets[0].escalationReason).toContain('连续 2 轮');
        expect(found!.targets[0].escalationReason).toContain('< 1%');
      } finally {
        cleanup();
      }
    });

    it('中间一轮 delta >= 1% 则不满足连续条件，不升级', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test',
          modules: ['top/cpu_core'],
        });
        const targetId = session.targets[0].id;

        await mgr.startIteration(session.id, targetId);
        await mgr.completeIteration(session.id, targetId, {
          generatedTests: [],
          deltaBefore: makeSummary(80),
          deltaAfter: makeSummary(81.5),
          deltas: makeDeltas(1.5),
        });
        await mgr.startIteration(session.id, targetId);
        await mgr.completeIteration(session.id, targetId, {
          generatedTests: [],
          deltaBefore: makeSummary(81.5),
          deltaAfter: makeSummary(82),
          deltas: makeDeltas(0.5),
        });

        const found = await mgr.getClosure(session.id);
        expect(found!.targets[0].status).toBe('in_progress');
      } finally {
        cleanup();
      }
    });

    it('自定义 escalationThreshold=3：第 3 轮低 delta 才升级', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test',
          modules: ['top/cpu_core'],
          escalationThreshold: 3,
        });
        const targetId = session.targets[0].id;

        for (let round = 1; round <= 3; round++) {
          await mgr.startIteration(session.id, targetId);
          await mgr.completeIteration(session.id, targetId, {
            generatedTests: [],
            deltaBefore: makeSummary(80 + (round - 1) * 0.2),
            deltaAfter: makeSummary(80 + round * 0.2),
            deltas: makeDeltas(0.2),
          });
          const found = await mgr.getClosure(session.id);
          if (round < 3) {
            expect(found!.targets[0].status).toBe('in_progress');
          } else {
            expect(found!.targets[0].status).toBe('escalated');
            expect(found!.targets[0].escalationReason).toContain('连续 3 轮');
          }
        }
      } finally {
        cleanup();
      }
    });

    it('shouldEscalate 纯函数：不足阈值轮数 / 空迭代 → false', () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const base: ClosureTarget = {
          id: 't1',
          module: { path: 'top/cpu_core', name: 'cpu_core' },
          gaps: [],
          iterations: [
            {
              round: 1,
              generatedTests: [],
              status: 'completed',
              deltaBefore: makeSummary(80),
              deltaAfter: makeSummary(80.1),
              deltas: [],
            },
          ],
          status: 'in_progress',
        };
        // 仅 1 轮 → 不升级
        expect(mgr.shouldEscalate(base, 2)).toBe(false);

        // 空迭代 → 不升级
        const empty: ClosureTarget = { ...base, iterations: [] };
        expect(mgr.shouldEscalate(empty, 2)).toBe(false);

        // 2 轮均 < 1% → 升级
        const lowDelta: ClosureTarget = {
          ...base,
          iterations: [
            { round: 1, generatedTests: [], status: 'completed', deltaBefore: makeSummary(80), deltaAfter: makeSummary(80.5), deltas: [] },
            { round: 2, generatedTests: [], status: 'completed', deltaBefore: makeSummary(80.5), deltaAfter: makeSummary(80.8), deltas: [] },
          ],
        };
        expect(mgr.shouldEscalate(lowDelta, 2)).toBe(true);
      } finally {
        cleanup();
      }
    });
  });

  describe('旧数据迁移（per-gap → per-target）', () => {
    /** 写入旧格式（gaps 数组）的 closures.json。 */
    function writeLegacyClosures(tmpDir: string): void {
      const legacy = {
        id: 'closure_legacy_1',
        sessionId: 'merge_legacy',
        createdAt: 12345,
        status: 'completed',
        gaps: [
          {
            id: 'gap_old_1',
            gap: {
              nodePath: 'top/cpu_core',
              nodeName: 'cpu_core',
              metric: 'line',
              target: 95,
              actual: 80,
              deficit: 15,
            },
            iterations: [
              {
                round: 1,
                generatedTests: ['t.sv'],
                status: 'completed',
                deltaBefore: makeSummary(80),
                deltaAfter: makeSummary(82),
                deltas: [],
              },
            ],
            status: 'closed',
          },
          {
            id: 'gap_old_2',
            gap: {
              nodePath: 'top/cpu_core',
              nodeName: 'cpu_core',
              metric: 'branch',
              target: 90,
              actual: 70,
              deficit: 20,
            },
            iterations: [],
            status: 'pending',
          },
        ],
        maxRounds: 5,
        escalationThreshold: 2,
        workspaceDir: '/legacy/ws',
      };
      const closuresFile = join(tmpDir, '.socverify', 'coverage', 'closure', 'closures.json');
      mkdirSync(dirname(closuresFile), { recursive: true });
      writeFileSync(closuresFile, JSON.stringify([legacy]), 'utf-8');
    }

    it('每个旧 gap 迁移为单 metric target，id 保留（workspace 目录路径不变）', async () => {
      const { mgr, tmpDir, cleanup } = setupClosureManager();
      try {
        writeLegacyClosures(tmpDir);
        const list = await mgr.listClosures();
        expect(list).toHaveLength(1);

        const session = list[0];
        // session 级不再有 gaps 字段
        expect(session).not.toHaveProperty('gaps');
        expect(session.targets).toHaveLength(2);

        const [t1, t2] = session.targets;
        expect(t1.id).toBe('gap_old_1'); // id 保留 → <targetId>/round_N 目录继续有效
        expect(t1.module).toEqual({ path: 'top/cpu_core', name: 'cpu_core' });
        expect(t1.gaps).toHaveLength(1);
        expect(t1.gaps[0].metric).toBe('line');
        expect(t1.iterations).toHaveLength(1);
        expect(t1.iterations[0].generatedTests).toEqual(['t.sv']);
        expect(t1.status).toBe('closed');

        expect(t2.id).toBe('gap_old_2');
        expect(t2.gaps[0].metric).toBe('branch');
        expect(t2.status).toBe('pending');

        // getClosure 同样返回迁移后的结构
        const found = await mgr.getClosure('closure_legacy_1');
        expect(found!.targets).toHaveLength(2);
      } finally {
        cleanup();
      }
    });

    it('迁移仅在内存进行，不回写磁盘原始数据', async () => {
      const { mgr, tmpDir, cleanup } = setupClosureManager();
      try {
        writeLegacyClosures(tmpDir);
        await mgr.listClosures();

        const closuresFile = join(tmpDir, '.socverify', 'coverage', 'closure', 'closures.json');
        const raw = JSON.parse(readFileSync(closuresFile, 'utf-8'));
        // 磁盘上仍是旧格式（gaps 数组）
        expect(Array.isArray(raw[0].gaps)).toBe(true);
        expect(raw[0].targets).toBeUndefined();
      } finally {
        cleanup();
      }
    });
  });

  describe('持久化', () => {
    it('closure.json 写入 targets 结构并可重新加载', async () => {
      const { mgr, tmpDir, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test',
          modules: ['top/cpu_core', 'top/memory_ctrl'],
        });
        const targetId = session.targets[0].id;
        await mgr.startIteration(session.id, targetId);
        await mgr.completeIteration(session.id, targetId, {
          generatedTests: ['test_persist.sv'],
          deltaBefore: makeSummary(80),
          deltaAfter: makeSummary(83),
          deltas: makeDeltas(3),
        });

        // closures.json 存在且为 targets 结构
        const closuresFile = join(tmpDir, '.socverify', 'coverage', 'closure', 'closures.json');
        expect(existsSync(closuresFile)).toBe(true);
        const closuresList = JSON.parse(readFileSync(closuresFile, 'utf-8'));
        expect(closuresList).toHaveLength(1);
        expect(closuresList[0].id).toBe(session.id);
        expect(Array.isArray(closuresList[0].targets)).toBe(true);

        // closure.json 存在且包含完整数据
        const closureFile = join(session.workspaceDir, 'closure.json');
        expect(existsSync(closureFile)).toBe(true);
        const closureData = JSON.parse(readFileSync(closureFile, 'utf-8'));
        expect(closureData.targets).toHaveLength(2);
        expect(closureData.targets[0].iterations).toHaveLength(1);
        expect(closureData.targets[0].iterations[0].generatedTests).toEqual(['test_persist.sv']);

        // 新 ClosureManager 实例（模拟重启）能加载已持久化的数据
        const newMgr = new ClosureManager({
          projectRoot: tmpDir,
          coverageManager: createMockCoverageManager(buildSampleTree(), TARGETS_CFG),
        });
        const reloaded = await newMgr.getClosure(session.id);
        expect(reloaded).not.toBeNull();
        expect(reloaded!.targets).toHaveLength(2);
        expect(reloaded!.targets[0].iterations).toHaveLength(1);
        expect(reloaded!.targets[0].iterations[0].status).toBe('completed');
      } finally {
        cleanup();
      }
    });

    it('startIteration 创建 <targetId>/round_N 目录', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test',
          modules: ['top/cpu_core'],
        });
        const targetId = session.targets[0].id;

        await mgr.startIteration(session.id, targetId);
        expect(existsSync(join(session.workspaceDir, targetId, 'round_1'))).toBe(true);

        await mgr.completeIteration(session.id, targetId, {
          generatedTests: [],
          deltaBefore: makeSummary(80),
          deltaAfter: makeSummary(85),
          deltas: makeDeltas(5),
        });
        await mgr.startIteration(session.id, targetId);
        expect(existsSync(join(session.workspaceDir, targetId, 'round_2'))).toBe(true);
      } finally {
        cleanup();
      }
    });

    it('getWorkspaceDir 返回正确路径', async () => {
      const { mgr, tmpDir, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test',
          modules: ['top/cpu_core'],
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
          mgr.startIteration('closure_unknown', 'target_unknown'),
        ).rejects.toThrow(/not found/);
      } finally {
        cleanup();
      }
    });

    it('startIteration 对不存在的 target 抛错', async () => {
      const { mgr, cleanup } = setupClosureManager();
      try {
        const session = await mgr.startClosure({
          sessionId: 'merge_test',
          modules: ['top/cpu_core'],
        });
        await expect(
          mgr.startIteration(session.id, 'target_unknown'),
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
          modules: ['top/cpu_core'],
        });
        const targetId = session.targets[0].id;
        await expect(
          mgr.completeIteration(session.id, targetId, {
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
