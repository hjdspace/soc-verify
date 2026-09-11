import { describe, it, expect, vi } from 'vitest';
import { CoverageManager } from '../../src/main/coverage/coverage-manager';
import { CoverageReportGenerator } from '../../src/main/coverage/coverage-report-generator';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CoverageData, CoverageNode, EdaToolConfig } from '@shared/types';
import { triplet, NA_TRIPLET, DEFAULT_COVERAGE_TARGETS } from '@shared/types';

// ─── 层级 mock 数据（ADR 0007） ──────────────────────────────────

function makeMetrics(opts: {
  line?: [number, number];
  branch?: [number, number];
  toggle?: [number, number];
  condition?: [number, number];
  fsmState?: [number, number];
  fsmTransition?: [number, number];
  functional?: [number, number];
  assertion?: [number, number];
}): CoverageNode['metrics'] {
  const t = (v?: [number, number]) => (v ? triplet(v[0], v[1]) : { ...NA_TRIPLET });
  return {
    line: t(opts.line),
    branch: t(opts.branch),
    toggle: t(opts.toggle),
    condition: t(opts.condition),
    fsm_state: t(opts.fsmState),
    fsm_transition: t(opts.fsmTransition),
    functional: t(opts.functional),
    assertion: t(opts.assertion),
  };
}

function makeMockData(sessionId: string): CoverageData {
  const root: CoverageNode = {
    name: 'top',
    path: 'top',
    depth: 0,
    metrics: makeMetrics({
      line: [902, 1000],
      branch: [850, 1000],
      toggle: [821, 1000],
      condition: [800, 1000],
      fsmState: [50, 50],
      fsmTransition: [90, 100],
      functional: [880, 1000],
      assertion: [817, 1000],
    }),
    children: [
      {
        name: 'cpu_core',
        path: 'cpu_core',
        depth: 1,
        metrics: makeMetrics({
          line: [920, 1000],
          branch: [870, 1000],
          toggle: [850, 1000],
          condition: [820, 1000],
          fsmState: [50, 50],
          fsmTransition: [90, 100],
          functional: [900, 1000],
          assertion: [800, 1000],
        }),
        children: [],
      },
      {
        name: 'memory_ctrl',
        path: 'memory_ctrl',
        depth: 1,
        metrics: makeMetrics({
          line: [880, 1000],
          branch: [830, 1000],
          toggle: [790, 1000],
          condition: [780, 1000],
          functional: [860, 1000],
          assertion: [830, 1000],
        }),
        children: [],
      },
    ],
  };
  return {
    sessionId,
    source: { covMergeDir: '/mock/cov_merge', edaTool: 'imc', reportGeneratedAt: Date.now() },
    root,
    targets: { ...DEFAULT_COVERAGE_TARGETS },
  };
}

// ─── Mock 适配器 ─────────────────────────────────────────────────

/**
 * 创建 mock adapter。
 * - summaryData: summaryOnly=true 时返回的数据（不含 uncovered/testContributions/csvData）
 * - fullData: summaryOnly=false 时返回的完整数据（含 uncovered 等详细字段）
 * 如果只传 data，则两种模式都返回同一份数据。
 */
function createMockAdapter(data: CoverageData | null, fullData?: CoverageData | null) {
  return {
    hasParser: () => data !== null,
    parse: vi.fn(async (
      _sessionId: string,
      _reportDir: string,
      enrichment: {
        sessionId: string;
        covMergeDir: string;
        edaTool: string;
        targets?: Partial<Record<string, number>>;
        summaryOnly?: boolean;
      },
    ) => {
      // summaryOnly=true 返回 summaryData（参数 data），summaryOnly=false 返回 fullData（如果有）
      const sourceData = (enrichment.summaryOnly || !fullData)
        ? (data ?? makeMockData('fallback'))
        : (fullData ?? data ?? makeMockData('fallback'));
      const enriched: CoverageData = {
        ...sourceData,
        sessionId: enrichment.sessionId,
        source: {
          covMergeDir: enrichment.covMergeDir,
          edaTool: enrichment.edaTool as CoverageData['source']['edaTool'],
          reportGeneratedAt: Date.now(),
        },
        targets: enrichment.targets ?? sourceData.targets,
        summaryOnly: enrichment.summaryOnly ?? false,
      };
      return { data: enriched, jsonStr: JSON.stringify(enriched) };
    }),
  };
}

/** 创建带 mock CommandRunner 的 CoverageReportGenerator（命令总是成功）。 */
function createMockReportGenerator(projectRoot: string): CoverageReportGenerator {
  return new CoverageReportGenerator({
    projectRoot,
    runner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  });
}

/** 创建记录执行命令的 mock CommandRunner（用于断言快速导入层命令白名单）。 */
function createRecordingReportGenerator(
  projectRoot: string,
  executed: string[],
): CoverageReportGenerator {
  return new CoverageReportGenerator({
    projectRoot,
    runner: async (command) => {
      executed.push(command);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
}

const MOCK_EDA_CONFIG: EdaToolConfig = {
  tool: 'imc',
  covMergeDir: '/mock/cov_merge',
  summaryCommand: 'echo summary',
  detailCommand: 'echo detail',
  metricsCommand: 'echo metrics',
};

describe('CoverageManager', () => {
  describe('importCoverage', () => {
    it('creates a session, caches data, and returns sessionId', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-import-'));
      const mockData = makeMockData('pre-import');
      const adapter = createMockAdapter(mockData);
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter as never,
        reportGenerator: createMockReportGenerator(tmpDir),
      });

      const result = await mgr.importCoverage('/mock/cov_merge', MOCK_EDA_CONFIG);
      expect(result.sessionId).toMatch(/^merge_\d{8}_\d{6}_/);
      expect(result.data.root.name).toBe('top');
      expect(result.data.root.children).toHaveLength(2);

      // Session 应已写入 sessions.json
      const sessions = await mgr.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe(result.sessionId);

      rmSync(tmpDir, { recursive: true });
    });

    it('throws when no parser available', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-noop-'));
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: null,
        reportGenerator: createMockReportGenerator(tmpDir),
      });

      await expect(mgr.importCoverage('/mock', MOCK_EDA_CONFIG)).rejects.toThrow(
        'No coverage-parser plugin loaded',
      );
      rmSync(tmpDir, { recursive: true });
    });

    it('quick import layer runs only the metrics command for imc (no summary/detail)', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-quick-'));
      const adapter = createMockAdapter(makeMockData('quick'));
      const executed: string[] = [];
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter as never,
        reportGenerator: createRecordingReportGenerator(tmpDir, executed),
      });

      await mgr.importCoverage('/mock/cov_merge', MOCK_EDA_CONFIG);

      // SoC 代码覆盖率重构：导入只执行 metrics 命令；summary（已废弃）/detail 不执行
      expect(executed).toEqual(['echo metrics']);
      rmSync(tmpDir, { recursive: true });
    });

    it('quick import layer keeps summary command for vcs-urg (session.xml source)', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-quick-urg-'));
      const adapter = createMockAdapter(makeMockData('urg'));
      const executed: string[] = [];
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter as never,
        reportGenerator: createRecordingReportGenerator(tmpDir, executed),
      });

      await mgr.importCoverage('/mock/cov_merge', {
        ...MOCK_EDA_CONFIG,
        tool: 'vcs-urg',
        summaryCommand: 'echo urg-summary',
        metricsCommand: undefined,
      });

      // vcs-urg 的快速层数据源是 summary 命令产出的 session.xml
      expect(executed).toEqual(['echo urg-summary']);
      rmSync(tmpDir, { recursive: true });
    });

    it('succeeds without report generator (graceful degradation)', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-nogen-'));
      const adapter = createMockAdapter(makeMockData('x'));
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter as never,
      });

      // Without a report generator, import should still succeed —
      // the EDA command step is skipped and the parser is called directly.
      const result = await mgr.importCoverage('/mock', MOCK_EDA_CONFIG);
      expect(result.sessionId).toBeDefined();
      expect(result.data).toBeDefined();
      rmSync(tmpDir, { recursive: true });
    });
  });

  describe('getOverview', () => {
    it('returns summary with 8 metrics after import', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-overview-'));
      const adapter = createMockAdapter(makeMockData('pre'));
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter as never,
        reportGenerator: createMockReportGenerator(tmpDir),
      });

      const { sessionId } = await mgr.importCoverage('/mock/cov_merge', MOCK_EDA_CONFIG);
      const result = await mgr.getOverview(sessionId);
      expect(result.sessionId).toBe(sessionId);
      expect(result.summary.line).toBeCloseTo(90.2, 1);
      expect(result.summary.branch).toBeCloseTo(85.0, 1);
      expect(result.summary.toggle).toBeCloseTo(82.1, 1);
      expect(result.summary.condition).toBeCloseTo(80.0, 1);
      expect(result.summary.fsm_state).toBeCloseTo(100, 1);
      expect(result.summary.fsm_transition).toBeCloseTo(90, 1);
      expect(result.summary.functional).toBeCloseTo(88.0, 1);
      expect(result.summary.assertion).toBeCloseTo(81.7, 1);
      expect(result.summary.overall).toBeGreaterThan(0);

      rmSync(tmpDir, { recursive: true });
    });

    it('falls back to latest session when sessionId omitted', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-fallback-'));
      const adapter = createMockAdapter(makeMockData('pre'));
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter as never,
        reportGenerator: createMockReportGenerator(tmpDir),
      });

      const { sessionId } = await mgr.importCoverage('/mock/cov_merge', MOCK_EDA_CONFIG);
      const result = await mgr.getOverview();
      expect(result.sessionId).toBe(sessionId);

      rmSync(tmpDir, { recursive: true });
    });

    it('throws when no session available', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-empty-'));
      const mgr = new CoverageManager({ projectRoot: tmpDir, coverageAdapter: null });

      await expect(mgr.getOverview()).rejects.toThrow('No coverage session available');
      rmSync(tmpDir, { recursive: true });
    });
  });

  describe('getTree', () => {
    it('returns full hierarchical CoverageData', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-tree-'));
      const adapter = createMockAdapter(makeMockData('pre'));
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter as never,
        reportGenerator: createMockReportGenerator(tmpDir),
      });

      const { sessionId } = await mgr.importCoverage('/mock/cov_merge', MOCK_EDA_CONFIG);
      const tree = await mgr.getTree(sessionId);
      expect(tree.root.name).toBe('top');
      expect(tree.root.depth).toBe(0);
      expect(tree.root.children).toHaveLength(2);
      expect(tree.root.children[0].name).toBe('cpu_core');
      expect(tree.root.children[0].depth).toBe(1);
      expect(tree.root.children[1].name).toBe('memory_ctrl');

      rmSync(tmpDir, { recursive: true });
    });
  });

  describe('listSessions', () => {
    it('returns empty array when no sessions', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-list-empty-'));
      const mgr = new CoverageManager({ projectRoot: tmpDir, coverageAdapter: null });
      const sessions = await mgr.listSessions();
      expect(sessions).toEqual([]);
      rmSync(tmpDir, { recursive: true });
    });

    it('lists sessions sorted by createdAt descending', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-list-sort-'));
      const adapter = createMockAdapter(makeMockData('pre'));
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter as never,
        reportGenerator: createMockReportGenerator(tmpDir),
      });

      const r1 = await mgr.importCoverage('/mock1', MOCK_EDA_CONFIG);
      // 确保 createdAt 不同
      await new Promise((r) => setTimeout(r, 10));
      const r2 = await mgr.importCoverage('/mock2', MOCK_EDA_CONFIG);

      const sessions = await mgr.listSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions[0].sessionId).toBe(r2.sessionId);
      expect(sessions[1].sessionId).toBe(r1.sessionId);

      rmSync(tmpDir, { recursive: true });
    });
  });

  describe('deleteSession', () => {
    it('removes session from sessions.json', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-delete-'));
      const adapter = createMockAdapter(makeMockData('pre'));
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter as never,
        reportGenerator: createMockReportGenerator(tmpDir),
      });

      const { sessionId } = await mgr.importCoverage('/mock', MOCK_EDA_CONFIG);
      expect(await mgr.listSessions()).toHaveLength(1);

      await mgr.deleteSession(sessionId);
      expect(await mgr.listSessions()).toHaveLength(0);

      rmSync(tmpDir, { recursive: true });
    });
  });

  describe('getTrend', () => {
    it('returns trend data from cached sessions', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-trend-'));
      const adapter = createMockAdapter(makeMockData('pre'));
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter as never,
        reportGenerator: createMockReportGenerator(tmpDir),
      });

      await mgr.importCoverage('/mock1', MOCK_EDA_CONFIG);
      await new Promise((r) => setTimeout(r, 10));
      await mgr.importCoverage('/mock2', MOCK_EDA_CONFIG);

      const trend = await mgr.getTrend();
      expect(trend).toHaveLength(2);
      expect(trend[0].summary).toBeDefined();
      expect(trend[0].summary.line).toBeCloseTo(90.2, 1);
      expect(trend[0].createdAt).toBeGreaterThanOrEqual(trend[1].createdAt);

      rmSync(tmpDir, { recursive: true });
    });

    it('respects limit parameter', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-trend-limit-'));
      const adapter = createMockAdapter(makeMockData('pre'));
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter as never,
        reportGenerator: createMockReportGenerator(tmpDir),
      });

      for (let i = 0; i < 3; i++) {
        await mgr.importCoverage(`/mock${i}`, MOCK_EDA_CONFIG);
        await new Promise((r) => setTimeout(r, 10));
      }

      const trend = await mgr.getTrend(2);
      expect(trend).toHaveLength(2);

      rmSync(tmpDir, { recursive: true });
    });
  });

  describe('exportReport', () => {
    it('exports JSON report', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-export-json-'));
      const adapter = createMockAdapter(makeMockData('pre'));
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter as never,
        reportGenerator: createMockReportGenerator(tmpDir),
      });

      const { sessionId } = await mgr.importCoverage('/mock', MOCK_EDA_CONFIG);
      const outputPath = join(tmpDir, 'report.json');
      await mgr.exportReport(sessionId, 'json', outputPath);

      const content = readFileSync(outputPath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.sessionId).toBe(sessionId);
      expect(parsed.root.name).toBe('top');

      rmSync(tmpDir, { recursive: true });
    });

    it('exports HTML report with 8 metrics', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-export-html-'));
      const adapter = createMockAdapter(makeMockData('pre'));
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter as never,
        reportGenerator: createMockReportGenerator(tmpDir),
      });

      const { sessionId } = await mgr.importCoverage('/mock', MOCK_EDA_CONFIG);
      const outputPath = join(tmpDir, 'report.html');
      await mgr.exportReport(sessionId, 'html', outputPath);

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('<html');
      expect(content).toContain('Coverage Report');
      expect(content).toContain('cpu_core');
      expect(content).toContain('memory_ctrl');
      expect(content).toContain('FSM State');
      expect(content).toContain('FSM Transition');

      rmSync(tmpDir, { recursive: true });
    });
  });

  // ─── Slice 2: Target / Gap / Delta / Triage / Exclusion ──────

  describe('getTargets', () => {
    it('returns DEFAULT_COVERAGE_TARGETS when no sessionId', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-tgt-default-'));
      const mgr = new CoverageManager({ projectRoot: tmpDir, coverageAdapter: null });
      const targets = await mgr.getTargets();
      expect(targets.line).toBe(95);
      expect(targets.branch).toBe(90);
      expect(targets.toggle).toBe(85);
      expect(targets.condition).toBe(85);
      expect(targets.fsm_state).toBe(100);
      expect(targets.fsm_transition).toBe(90);
      expect(targets.functional).toBe(100);
      // assertion 无默认目标
      expect(targets.assertion).toBeUndefined();
      rmSync(tmpDir, { recursive: true });
    });

    it('returns merged targets (default + session override) for a session', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-tgt-merge-'));
      const adapter = createMockAdapter(makeMockData('pre'));
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter as never,
        reportGenerator: createMockReportGenerator(tmpDir),
      });
      // 导入时使用默认 targets
      const { sessionId } = await mgr.importCoverage('/mock', MOCK_EDA_CONFIG);
      const targets = await mgr.getTargets(sessionId);
      expect(targets.line).toBe(95);
      expect(targets.assertion).toBeUndefined();
      rmSync(tmpDir, { recursive: true });
    });
  });

  describe('setTargets', () => {
    it('persists custom targets and overrides defaults', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-settgt-'));
      const adapter = createMockAdapter(makeMockData('pre'));
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter as never,
        reportGenerator: createMockReportGenerator(tmpDir),
      });
      const { sessionId } = await mgr.importCoverage('/mock', MOCK_EDA_CONFIG);

      const merged = await mgr.setTargets(sessionId, { line: 99, assertion: 80 });
      expect(merged.line).toBe(99);
      expect(merged.assertion).toBe(80);
      expect(merged.branch).toBe(90); // 保留其他默认值

      // 重新加载确认持久化
      const reloaded = await mgr.getTargets(sessionId);
      expect(reloaded.line).toBe(99);
      expect(reloaded.assertion).toBe(80);
      rmSync(tmpDir, { recursive: true });
    });
  });

  describe('listGaps', () => {
    it('detects gaps where metric percentage is below target', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-gaps-'));
      const adapter = createMockAdapter(makeMockData('pre'));
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter as never,
        reportGenerator: createMockReportGenerator(tmpDir),
      });
      const { sessionId } = await mgr.importCoverage('/mock', MOCK_EDA_CONFIG);
      // mock 数据：root line=90.2% < 95 target → gap
      const { gaps } = await mgr.listGaps(sessionId);
      expect(gaps.length).toBeGreaterThan(0);
      const lineGaps = gaps.filter((g) => g.metric === 'line');
      expect(lineGaps.length).toBeGreaterThan(0);
      expect(lineGaps[0].target).toBe(95);
      expect(lineGaps[0].actual).toBeLessThan(95);
      expect(lineGaps[0].deficit).toBeCloseTo(95 - lineGaps[0].actual, 1);
      rmSync(tmpDir, { recursive: true });
    });

    it('respects custom targets — lowering target removes gaps', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-gaps-custom-'));
      const adapter = createMockAdapter(makeMockData('pre'));
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter as never,
        reportGenerator: createMockReportGenerator(tmpDir),
      });
      const { sessionId } = await mgr.importCoverage('/mock', MOCK_EDA_CONFIG);
      const before = (await mgr.listGaps(sessionId)).gaps.length;
      // 降低 line target 到 80% → 之前 line=90.2%/92%/88% 的 gap 消失
      await mgr.setTargets(sessionId, { line: 80 });
      const after = (await mgr.listGaps(sessionId)).gaps.length;
      expect(after).toBeLessThan(before);
      // 验证 line 类型的 gap 已全部消失
      const lineGaps = (await mgr.listGaps(sessionId)).gaps.filter((g) => g.metric === 'line');
      expect(lineGaps).toHaveLength(0);
      rmSync(tmpDir, { recursive: true });
    });

    it('falls back to latest session when sessionId omitted', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-gaps-fallback-'));
      const adapter = createMockAdapter(makeMockData('pre'));
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter as never,
        reportGenerator: createMockReportGenerator(tmpDir),
      });
      const { sessionId } = await mgr.importCoverage('/mock', MOCK_EDA_CONFIG);
      const { sessionId: resolved } = await mgr.listGaps();
      expect(resolved).toBe(sessionId);
      rmSync(tmpDir, { recursive: true });
    });
  });

  describe('getDelta', () => {
    it('computes per-metric delta between two sessions', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-delta-'));
      // 第一次导入：line=90.2%
      const adapter1 = createMockAdapter(makeMockData('pre-1'));
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter1 as never,
        reportGenerator: createMockReportGenerator(tmpDir),
      });
      const r1 = await mgr.importCoverage('/mock1', MOCK_EDA_CONFIG);
      await new Promise((res) => setTimeout(res, 10));

      // 第二次导入：构造一个 line 更高的 mock
      const data2 = makeMockData('pre-2');
      data2.root.metrics = makeMetrics({ line: [950, 1000] });
      const adapter2 = createMockAdapter(data2);
      mgr.setAdapter(adapter2 as never);
      const r2 = await mgr.importCoverage('/mock2', MOCK_EDA_CONFIG);

      const delta = await mgr.getDelta(r1.sessionId, r2.sessionId);
      const lineDelta = delta.deltas.find((d) => d.metric === 'line');
      expect(lineDelta).toBeDefined();
      expect(lineDelta!.before).toBeCloseTo(90.2, 1);
      expect(lineDelta!.after).toBeCloseTo(95.0, 1);
      expect(lineDelta!.delta).toBeCloseTo(4.8, 1);
      expect(lineDelta!.delta).toBeGreaterThan(0);
      rmSync(tmpDir, { recursive: true });
    });
  });

  describe('Triage CRUD', () => {
    it('addTriage persists entry and listTriage returns it', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-triage-add-'));
      const adapter = createMockAdapter(makeMockData('pre'));
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter as never,
        reportGenerator: createMockReportGenerator(tmpDir),
      });
      const { sessionId } = await mgr.importCoverage('/mock', MOCK_EDA_CONFIG);

      const entry = await mgr.addTriage({
        sessionId,
        nodePath: 'cpu_core',
        metric: 'line',
        gap: {
          nodePath: 'cpu_core',
          nodeName: 'cpu_core',
          metric: 'line',
          target: 95,
          actual: 92,
          deficit: 3,
        },
        cause: 'missing_scenario',
        confidence: 'high',
        note: 'need directed test for ALU',
        triagedBy: 'tester',
      });
      expect(entry.id).toMatch(/^triage_/);
      expect(entry.triagedAt).toBeGreaterThan(0);

      const list = await mgr.listTriage(sessionId);
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(entry.id);
      expect(list[0].cause).toBe('missing_scenario');
      expect(list[0].confidence).toBe('high');
      rmSync(tmpDir, { recursive: true });
    });

    it('listTriage without sessionId aggregates all sessions', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-triage-aggr-'));
      const adapter = createMockAdapter(makeMockData('pre'));
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter as never,
        reportGenerator: createMockReportGenerator(tmpDir),
      });
      const r1 = await mgr.importCoverage('/mock1', MOCK_EDA_CONFIG);
      await new Promise((res) => setTimeout(res, 10));
      const r2 = await mgr.importCoverage('/mock2', MOCK_EDA_CONFIG);

      await mgr.addTriage({
        sessionId: r1.sessionId, nodePath: 'top', metric: 'line',
        gap: { nodePath: 'top', nodeName: 'top', metric: 'line', target: 95, actual: 90, deficit: 5 },
      });
      await mgr.addTriage({
        sessionId: r2.sessionId, nodePath: 'top', metric: 'branch',
        gap: { nodePath: 'top', nodeName: 'top', metric: 'branch', target: 90, actual: 85, deficit: 5 },
      });

      const all = await mgr.listTriage();
      expect(all).toHaveLength(2);
      rmSync(tmpDir, { recursive: true });
    });

    it('deleteTriage removes the entry', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-triage-del-'));
      const adapter = createMockAdapter(makeMockData('pre'));
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter as never,
        reportGenerator: createMockReportGenerator(tmpDir),
      });
      const { sessionId } = await mgr.importCoverage('/mock', MOCK_EDA_CONFIG);
      const entry = await mgr.addTriage({
        sessionId, nodePath: 'top', metric: 'line',
        gap: { nodePath: 'top', nodeName: 'top', metric: 'line', target: 95, actual: 90, deficit: 5 },
      });
      expect(await mgr.listTriage(sessionId)).toHaveLength(1);
      await mgr.deleteTriage(entry.id);
      expect(await mgr.listTriage(sessionId)).toHaveLength(0);
      rmSync(tmpDir, { recursive: true });
    });

    it('deleteTriage on non-existent id is a no-op', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-triage-noop-'));
      const mgr = new CoverageManager({ projectRoot: tmpDir, coverageAdapter: null });
      await expect(mgr.deleteTriage('nonexistent')).resolves.toBeUndefined();
      rmSync(tmpDir, { recursive: true });
    });
  });

  describe('Exclusion workflow', () => {
    it('requestExclusion creates a pending entry', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-excl-req-'));
      const adapter = createMockAdapter(makeMockData('pre'));
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter as never,
        reportGenerator: createMockReportGenerator(tmpDir),
      });
      const { sessionId } = await mgr.importCoverage('/mock', MOCK_EDA_CONFIG);

      const entry = await mgr.requestExclusion({
        sessionId,
        nodePath: 'memory_ctrl',
        metric: 'toggle',
        reason: 'dead code — module deprecated',
        requestedBy: 'engineer1',
      });
      expect(entry.id).toMatch(/^excl_/);
      expect(entry.status).toBe('pending');
      expect(entry.requestedBy).toBe('engineer1');
      expect(entry.requestedAt).toBeGreaterThan(0);

      const list = await mgr.listExclusions(sessionId);
      expect(list).toHaveLength(1);
      expect(list[0].status).toBe('pending');
      rmSync(tmpDir, { recursive: true });
    });

    it('approveExclusion transitions pending → approved', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-excl-approve-'));
      const adapter = createMockAdapter(makeMockData('pre'));
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter as never,
        reportGenerator: createMockReportGenerator(tmpDir),
      });
      const { sessionId } = await mgr.importCoverage('/mock', MOCK_EDA_CONFIG);
      const entry = await mgr.requestExclusion({
        sessionId, nodePath: 'top', metric: 'line',
        reason: 'dead code', requestedBy: 'engineer1',
      });

      const approved = await mgr.approveExclusion(entry.id, 'lead1');
      expect(approved.status).toBe('approved');
      expect(approved.approvedBy).toBe('lead1');
      expect(approved.approvedAt).toBeGreaterThan(0);

      const list = await mgr.listExclusions(sessionId);
      expect(list[0].status).toBe('approved');
      rmSync(tmpDir, { recursive: true });
    });

    it('rejectExclusion transitions pending → rejected with reason', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-excl-reject-'));
      const adapter = createMockAdapter(makeMockData('pre'));
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter as never,
        reportGenerator: createMockReportGenerator(tmpDir),
      });
      const { sessionId } = await mgr.importCoverage('/mock', MOCK_EDA_CONFIG);
      const entry = await mgr.requestExclusion({
        sessionId, nodePath: 'top', metric: 'line',
        reason: 'maybe dead code', requestedBy: 'engineer1',
      });

      const rejected = await mgr.rejectExclusion(entry.id, 'lead1', 'need more evidence');
      expect(rejected.status).toBe('rejected');
      expect(rejected.approvedBy).toBe('lead1');
      expect(rejected.rejectionReason).toBe('need more evidence');
      rmSync(tmpDir, { recursive: true });
    });

    it('approveExclusion on already-approved entry throws', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-excl-twice-'));
      const adapter = createMockAdapter(makeMockData('pre'));
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter as never,
        reportGenerator: createMockReportGenerator(tmpDir),
      });
      const { sessionId } = await mgr.importCoverage('/mock', MOCK_EDA_CONFIG);
      const entry = await mgr.requestExclusion({
        sessionId, nodePath: 'top', metric: 'line',
        reason: 'dead code', requestedBy: 'engineer1',
      });
      await mgr.approveExclusion(entry.id, 'lead1');
      await expect(mgr.approveExclusion(entry.id, 'lead1')).rejects.toThrow(
        /already approved/,
      );
      rmSync(tmpDir, { recursive: true });
    });

    it('listExclusions filters by status', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-excl-filter-'));
      const adapter = createMockAdapter(makeMockData('pre'));
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter as never,
        reportGenerator: createMockReportGenerator(tmpDir),
      });
      const { sessionId } = await mgr.importCoverage('/mock', MOCK_EDA_CONFIG);
      const e1 = await mgr.requestExclusion({
        sessionId, nodePath: 'top', metric: 'line',
        reason: 'r1', requestedBy: 'u1',
      });
      const e2 = await mgr.requestExclusion({
        sessionId, nodePath: 'top', metric: 'branch',
        reason: 'r2', requestedBy: 'u1',
      });
      await mgr.approveExclusion(e1.id, 'lead');

      const pending = await mgr.listExclusions(sessionId, 'pending');
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe(e2.id);

      const approved = await mgr.listExclusions(sessionId, 'approved');
      expect(approved).toHaveLength(1);
      expect(approved[0].id).toBe(e1.id);

      const all = await mgr.listExclusions(sessionId);
      expect(all).toHaveLength(2);
      rmSync(tmpDir, { recursive: true });
    });
  });

  describe('Session lifecycle — full flow', () => {
    it('deleteSession removes cache, triage, and exclusion files', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-lifecycle-'));
      const adapter = createMockAdapter(makeMockData('pre'));
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter as never,
        reportGenerator: createMockReportGenerator(tmpDir),
      });
      const { sessionId } = await mgr.importCoverage('/mock', MOCK_EDA_CONFIG);

      // 添加 triage 和 exclusion
      await mgr.addTriage({
        sessionId, nodePath: 'top', metric: 'line',
        gap: { nodePath: 'top', nodeName: 'top', metric: 'line', target: 95, actual: 90, deficit: 5 },
      });
      await mgr.requestExclusion({
        sessionId, nodePath: 'top', metric: 'line',
        reason: 'r', requestedBy: 'u',
      });

      expect(await mgr.listTriage(sessionId)).toHaveLength(1);
      expect(await mgr.listExclusions(sessionId)).toHaveLength(1);

      await mgr.deleteSession(sessionId);

      // 删除后 listTriage / listExclusions 不应再返回该 session 的条目
      expect(await mgr.listTriage(sessionId)).toHaveLength(0);
      expect(await mgr.listExclusions(sessionId)).toHaveLength(0);
      // session 列表也应为空
      expect(await mgr.listSessions()).toHaveLength(0);
      // 缓存文件应被清理
      expect(await mgr.getSession(sessionId)).toBeNull();
      rmSync(tmpDir, { recursive: true });
    });

    it('create → list → switch → delete lifecycle', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-lifecycle-switch-'));
      const adapter = createMockAdapter(makeMockData('pre'));
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter as never,
        reportGenerator: createMockReportGenerator(tmpDir),
      });

      // create
      const r1 = await mgr.importCoverage('/mock1', MOCK_EDA_CONFIG);
      await new Promise((res) => setTimeout(res, 10));
      const r2 = await mgr.importCoverage('/mock2', MOCK_EDA_CONFIG);

      // list（倒序，最新在前）
      const sessions = await mgr.listSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions[0].sessionId).toBe(r2.sessionId);
      expect(sessions[1].sessionId).toBe(r1.sessionId);

      // switch（通过 getOverview/getTree 使用不同 sessionId）
      const ov1 = await mgr.getOverview(r1.sessionId);
      const ov2 = await mgr.getOverview(r2.sessionId);
      expect(ov1.sessionId).toBe(r1.sessionId);
      expect(ov2.sessionId).toBe(r2.sessionId);

      // delete 第一个
      await mgr.deleteSession(r1.sessionId);
      const after = await mgr.listSessions();
      expect(after).toHaveLength(1);
      expect(after[0].sessionId).toBe(r2.sessionId);

      rmSync(tmpDir, { recursive: true });
    });
  });

  // ─── 分层解析：parseDetails 测试 ────────────────────────────────

  describe('parseDetails', () => {
    it('throws when session not found', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-detail-notfound-'));
      const adapter = createMockAdapter(makeMockData('pre'));
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter as never,
        reportGenerator: createMockReportGenerator(tmpDir),
      });

      await expect(mgr.parseDetails('nonexistent', MOCK_EDA_CONFIG)).rejects.toThrow(
        /not found/,
      );
      rmSync(tmpDir, { recursive: true });
    });

    it('parses details and merges into existing session', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-detail-merge-'));
      // summary data：只有 root，没有 uncovered
      const summaryData = makeMockData('pre-summary');
      summaryData.summaryOnly = true;

      // full data：有 uncovered 数据
      const fullData = makeMockData('pre-full');
      fullData.summaryOnly = false;
      fullData.uncovered = {
        functional: [
          { module: 'cpu_core', description: 'uncovered bin[0]' },
        ],
      };

      const adapter = createMockAdapter(summaryData, fullData);
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter as never,
        reportGenerator: createMockReportGenerator(tmpDir),
      });

      // Step 1: 导入（只解析 summary）
      const { sessionId } = await mgr.importCoverage('/mock', MOCK_EDA_CONFIG);
      const cached = await mgr.getSession(sessionId);
      expect(cached?.summaryOnly).toBe(true);
      expect(cached?.uncovered).toBeUndefined();

      // Step 2: 按需详细解析
      const result = await mgr.parseDetails(sessionId, MOCK_EDA_CONFIG);
      expect(result.summaryOnly).toBe(false);
      expect(result.uncovered).toBeDefined();
      expect(result.uncovered?.functional).toHaveLength(1);

      // 缓存应已更新
      const updated = await mgr.getSession(sessionId);
      expect(updated?.summaryOnly).toBe(false);
      expect(updated?.uncovered).toBeDefined();

      rmSync(tmpDir, { recursive: true });
    });

    it('throws when no parser available', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-detail-noparser-'));
      const adapter = createMockAdapter(makeMockData('pre'));
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter as never,
        reportGenerator: createMockReportGenerator(tmpDir),
      });

      // 先正常导入
      const { sessionId } = await mgr.importCoverage('/mock', MOCK_EDA_CONFIG);

      // 移除 adapter
      mgr.setAdapter(null);

      await expect(mgr.parseDetails(sessionId, MOCK_EDA_CONFIG)).rejects.toThrow(
        'No coverage-parser plugin loaded',
      );
      rmSync(tmpDir, { recursive: true });
    });

    it('calls adapter.parse with summaryOnly=false', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-detail-opt-'));
      const summaryData = makeMockData('pre-summary');
      summaryData.summaryOnly = true;
      const fullData = makeMockData('pre-full');
      fullData.summaryOnly = false;

      const adapter = createMockAdapter(summaryData, fullData);
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter as never,
        reportGenerator: createMockReportGenerator(tmpDir),
      });

      const { sessionId } = await mgr.importCoverage('/mock', MOCK_EDA_CONFIG);

      // 验证导入时以 summaryOnly=true 调用
      expect(adapter.parse).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ summaryOnly: true }),
      );

      // 清除 mock 调用记录
      adapter.parse.mockClear();

      // 执行详细解析
      await mgr.parseDetails(sessionId, MOCK_EDA_CONFIG);

      // 验证详细解析时以 summaryOnly=false 调用
      expect(adapter.parse).toHaveBeenCalledWith(
        sessionId,
        expect.any(String),
        expect.objectContaining({ summaryOnly: false }),
      );

      rmSync(tmpDir, { recursive: true });
    });
  });
});
