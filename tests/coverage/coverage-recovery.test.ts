/**
 * Coverage Recovery 测试（PRD Issue #03 / ADR 0025 决策 1）。
 *
 * 覆盖：
 * - 多 VDB 合并命令构造正确（-dir 基线 + -dir 新仿真 VDB，输出到 round 报告目录）
 * - Recovery 后的 Coverage Tree 解析并计算出真实 delta（mock EDA runner + fixture）
 * - 基线 cov_merge 目录全程只读（无写入断言）
 * - Recovery 失败返回结构化错误，无静默重试
 * - Recovery 结果对 CoverageManager 可见（缓存更新）
 * - round 级报告目录按迭代保留
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildMergeCommand,
  executeRecovery,
  persistRecoveryResult,
  CoverageRecoveryError,
} from '../../src/main/coverage/coverage-recovery';
import type { EdaToolConfig, CoverageData, CoverageSummary } from '@shared/types';
import { DEFAULT_COVERAGE_TARGETS, COVERAGE_METRICS } from '@shared/types';
import type { PluginBackedCoverage } from '../../src/main/plugin-adapters';
import type { CoverageManager } from '../../src/main/coverage/coverage-manager';
import type { CommandResult, CommandRunner } from '../../src/main/coverage/coverage-report-generator';

// ─── Mock 数据 ──────────────────────────────────────────────────

const VCS_URG_CONFIG: EdaToolConfig = {
  tool: 'vcs-urg',
  covMergeDir: 'cov_merge',
  summaryCommand: 'urg -full64 -dir {covMergeDir} -xml_verbose -format text -show summary -report {reportDir}',
  detailCommand: 'urg -full64 -dir {covMergeDir} -format text -report {reportDir}/detail',
  gradeCommand: 'urg -full64 -dir {covMergeDir} -grade testfile -format text -report {reportDir}/grade',
  execBackend: 'direct',
};

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

function makeCoverageData(sessionId: string, overallPct: number): CoverageData {
  const triplet = { percentage: overallPct, covered: Math.round(overallPct * 10), total: 1000 };
  const metrics = {} as CoverageData['root']['metrics'];
  for (const m of COVERAGE_METRICS) {
    metrics[m] = triplet; // 所有 metric 统一为同一值，便于 delta 计算
  }
  return {
    sessionId,
    source: { covMergeDir: '/mock/cov_merge', edaTool: 'vcs-urg', reportGeneratedAt: Date.now() },
    root: {
      name: 'top',
      path: 'top',
      depth: 0,
      metrics,
      children: [],
    },
    targets: { ...DEFAULT_COVERAGE_TARGETS },
    summaryOnly: true,
  };
}

/** 创建 mock coverage adapter（返回指定 CoverageData） */
function createMockAdapter(data: CoverageData): PluginBackedCoverage {
  return {
    hasParser: () => true,
    parse: vi.fn(async () => ({
      data,
      jsonStr: JSON.stringify(data),
    })),
  } as unknown as PluginBackedCoverage;
}

/** 创建 mock CommandRunner（成功） */
function createSuccessRunner(captured?: { command: string; cwd: string }): ReturnType<typeof vi.fn> {
  return vi.fn(async (command: string, options: { cwd: string }): Promise<CommandResult> => {
    if (captured) {
      captured.command = command;
      captured.cwd = options.cwd;
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
}

/** 创建 mock CoverageManager（带有 cache 方法 spy） */
function createMockCoverageManager(): { getOverview: ReturnType<typeof vi.fn>; getTree: ReturnType<typeof vi.fn>; getTargets: ReturnType<typeof vi.fn>; cache: ReturnType<typeof vi.fn> } {
  return {
    getOverview: vi.fn(),
    getTree: vi.fn(),
    getTargets: vi.fn().mockResolvedValue({ ...DEFAULT_COVERAGE_TARGETS }),
    cache: vi.fn().mockResolvedValue(undefined),
  };
}

// ─── 测试 ────────────────────────────────────────────────────────

describe('Coverage Recovery', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'recovery-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  describe('buildMergeCommand', () => {
    it('vcs-urg 默认模板生成多 -dir 合并命令', () => {
      const cmd = buildMergeCommand(
        '/data/cov_merge',
        ['/tmp/simv.vdb', '/tmp/test2.vdb'],
        VCS_URG_CONFIG,
        '/tmp/round_1/report',
      );
      // 命令包含基线 VDB 和两个新 VDB
      expect(cmd).toContain('-dir "/data/cov_merge"');
      expect(cmd).toContain('-dir "/tmp/simv.vdb"');
      expect(cmd).toContain('-dir "/tmp/test2.vdb"');
      expect(cmd).toContain('-xml_verbose');
      expect(cmd).toContain('-show summary');
      expect(cmd).toContain('-report /tmp/round_1/report');
    });

    it('自定义模板替换 {covMergeDir} 为多 -dir 参数', () => {
      const customConfig: EdaToolConfig = {
        ...VCS_URG_CONFIG,
        summaryCommand: 'urg -custom -dir {covMergeDir} -report {reportDir}',
      };
      const cmd = buildMergeCommand(
        '/data/cov_merge',
        ['/tmp/new.vdb'],
        customConfig,
        '/tmp/report',
      );
      expect(cmd).toContain('-dir "/data/cov_merge" -dir "/tmp/new.vdb"');
      expect(cmd).toContain('-report /tmp/report');
    });

    it('无新 VDB 时仅使用基线 VDB', () => {
      const cmd = buildMergeCommand('/data/cov_merge', [], VCS_URG_CONFIG, '/tmp/report');
      expect(cmd).toContain('-dir "/data/cov_merge"');
      // 只有一个 -dir 参数（基线）
      const dirCount = (cmd.match(/-dir/g) || []).length;
      expect(dirCount).toBe(1);
    });

    it('缺少 summaryCommand 时抛出 CoverageRecoveryError', () => {
      const badConfig: EdaToolConfig = {
        tool: 'unknown',
        covMergeDir: 'x',
        summaryCommand: undefined,
      };
      expect(() => buildMergeCommand('/data', [], badConfig, '/tmp/report')).toThrow(
        CoverageRecoveryError,
      );
    });
  });

  describe('executeRecovery', () => {
    it('多 VDB 合并命令构造正确，runner 接收到正确的命令', async () => {
      const reportDir = join(tmpDir, 'round_1', 'report');
      const captured: { command: string; cwd: string } = { command: '', cwd: '' };
      const runner = createSuccessRunner(captured);
      const adapter = createMockAdapter(makeCoverageData('merge-1', 82));

      await executeRecovery({
        projectRoot: tmpDir,
        baselineVdbDir: '/data/cov_merge',
        newVdbPaths: ['/tmp/simv.vdb'],
        edaConfig: VCS_URG_CONFIG,
        reportDir,
        sessionId: 'merge-1',
        targets: { ...DEFAULT_COVERAGE_TARGETS },
        before: makeSummary(80),
        coverageAdapter: adapter,
        runner: runner as CommandRunner,
      });

      // 验证 runner 接收到包含多 -dir 的命令
      expect(captured.command).toContain('-dir "/data/cov_merge"');
      expect(captured.command).toContain('-dir "/tmp/simv.vdb"');
      // 基线 VDB 目录作为 cwd
      expect(captured.cwd).toBe('/data/cov_merge');
    });

    it('Recovery 后计算出真实 delta', async () => {
      const reportDir = join(tmpDir, 'round_1', 'report');
      const runner = createSuccessRunner();
      // Recovery 后覆盖率从 80% → 82%
      const adapter = createMockAdapter(makeCoverageData('merge-1', 82));

      const result = await executeRecovery({
        projectRoot: tmpDir,
        baselineVdbDir: '/data/cov_merge',
        newVdbPaths: ['/tmp/simv.vdb'],
        edaConfig: VCS_URG_CONFIG,
        reportDir,
        sessionId: 'merge-1',
        targets: { ...DEFAULT_COVERAGE_TARGETS },
        before: makeSummary(80),
        coverageAdapter: adapter,
        runner: runner as CommandRunner,
      });

      expect(result.deltaOverall).toBe(2); // 82 - 80 = 2
      expect(result.after.overall).toBe(82);
      expect(result.before.overall).toBe(80);
    });

    it('round 级报告目录按迭代保留', async () => {
      const reportDir = join(tmpDir, 'round_1', 'report');
      const runner = createSuccessRunner();
      const adapter = createMockAdapter(makeCoverageData('merge-1', 82));

      await executeRecovery({
        projectRoot: tmpDir,
        baselineVdbDir: '/data/cov_merge',
        newVdbPaths: ['/tmp/simv.vdb'],
        edaConfig: VCS_URG_CONFIG,
        reportDir,
        sessionId: 'merge-1',
        targets: { ...DEFAULT_COVERAGE_TARGETS },
        before: makeSummary(80),
        coverageAdapter: adapter,
        runner: runner as CommandRunner,
      });

      // 验证报告目录存在
      expect(existsSync(reportDir)).toBe(true);
      // 验证 meta.json 存在（解析器需要）
      expect(existsSync(join(reportDir, 'meta.json'))).toBe(true);
    });

    it('基线 cov_merge 目录全程只读（无写入）', async () => {
      // 创建一个真实的基线目录来监控写入
      const baselineDir = join(tmpDir, 'cov_merge');
      mkdirSync(baselineDir, { recursive: true });
      writeFileSync(join(baselineDir, 'merged.vdb'), 'mock vdb', 'utf-8');
      const baselineContentsBefore = readdirSync(baselineDir).sort();

      const reportDir = join(tmpDir, 'round_1', 'report');
      const runner = createSuccessRunner();
      const adapter = createMockAdapter(makeCoverageData('merge-1', 82));

      await executeRecovery({
        projectRoot: tmpDir,
        baselineVdbDir: baselineDir,
        newVdbPaths: ['/tmp/simv.vdb'],
        edaConfig: VCS_URG_CONFIG,
        reportDir,
        sessionId: 'merge-1',
        targets: { ...DEFAULT_COVERAGE_TARGETS },
        before: makeSummary(80),
        coverageAdapter: adapter,
        runner: runner as CommandRunner,
      });

      // 验证基线目录内容未改变
      const baselineContentsAfter = readdirSync(baselineDir).sort();
      expect(baselineContentsAfter).toEqual(baselineContentsBefore);
    });

    it('urg 命令失败时返回结构化 CoverageRecoveryError，无静默重试', async () => {
      const reportDir = join(tmpDir, 'round_1', 'report');
      // runner 返回 exitCode=1
      const failRunner = vi.fn(async (): Promise<CommandResult> => ({
        exitCode: 1,
        stdout: '',
        stderr: 'urg: error: cannot open vdb',
      }));
      const adapter = createMockAdapter(makeCoverageData('merge-1', 82));

      await expect(
        executeRecovery({
          projectRoot: tmpDir,
          baselineVdbDir: '/data/cov_merge',
          newVdbPaths: ['/tmp/simv.vdb'],
          edaConfig: VCS_URG_CONFIG,
          reportDir,
          sessionId: 'merge-1',
          targets: { ...DEFAULT_COVERAGE_TARGETS },
          before: makeSummary(80),
          coverageAdapter: adapter,
          runner: failRunner as CommandRunner,
        }),
      ).rejects.toThrow(CoverageRecoveryError);

      // 验证 runner 只被调用一次（无静默重试）
      expect(failRunner).toHaveBeenCalledTimes(1);
    });

    it('Recovery 结果对 CoverageManager 可见（cache 更新）', async () => {
      const reportDir = join(tmpDir, 'round_1', 'report');
      const runner = createSuccessRunner();
      const recoveredData = makeCoverageData('merge-1', 85);
      const adapter = createMockAdapter(recoveredData);
      const mockManager = createMockCoverageManager();

      const result = await executeRecovery({
        projectRoot: tmpDir,
        baselineVdbDir: '/data/cov_merge',
        newVdbPaths: ['/tmp/simv.vdb'],
        edaConfig: VCS_URG_CONFIG,
        reportDir,
        sessionId: 'merge-1',
        targets: { ...DEFAULT_COVERAGE_TARGETS },
        before: makeSummary(80),
        coverageAdapter: adapter,
        runner: runner as CommandRunner,
      });

      // 持久化 Recovery 结果到 CoverageManager
      await persistRecoveryResult(mockManager as unknown as CoverageManager, result);

      // 验证 cache 被调用，且传入的是 Recovery 后的 CoverageData
      expect(mockManager.cache).toHaveBeenCalledTimes(1);
      const cachedData = (mockManager.cache as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(cachedData.sessionId).toBe('merge-1');
      // 验证覆盖率数据为 Recovery 后的 85%
      expect(cachedData.root.metrics.line.percentage).toBe(85);
    });

    it('进度事件按序推送（recovery_init → recovery_done）', async () => {
      const reportDir = join(tmpDir, 'round_1', 'report');
      const runner = createSuccessRunner();
      const adapter = createMockAdapter(makeCoverageData('merge-1', 82));
      const steps: string[] = [];

      await executeRecovery({
        projectRoot: tmpDir,
        baselineVdbDir: '/data/cov_merge',
        newVdbPaths: ['/tmp/simv.vdb'],
        edaConfig: VCS_URG_CONFIG,
        reportDir,
        sessionId: 'merge-1',
        targets: { ...DEFAULT_COVERAGE_TARGETS },
        before: makeSummary(80),
        coverageAdapter: adapter,
        runner: runner as CommandRunner,
        onProgress: (event) => {
          steps.push(event.step);
        },
      });

      // 验证进度事件序列
      expect(steps[0]).toBe('recovery_init');
      expect(steps).toContain('recovery_command');
      expect(steps).toContain('recovery_eda');
      expect(steps).toContain('recovery_parsing');
      expect(steps).toContain('recovery_delta');
      expect(steps[steps.length - 1]).toBe('recovery_done');
    });
  });
});
