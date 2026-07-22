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
        path: 'top/cpu_core',
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
        path: 'top/memory_ctrl',
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

function createMockAdapter(data: CoverageData | null) {
  return {
    hasParser: () => data !== null,
    parse: vi.fn(async (_sessionId: string, _reportDir: string) =>
      data ?? makeMockData('fallback'),
    ),
  };
}

/** 创建带 mock CommandRunner 的 CoverageReportGenerator（命令总是成功）。 */
function createMockReportGenerator(projectRoot: string): CoverageReportGenerator {
  return new CoverageReportGenerator({
    projectRoot,
    runner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
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

    it('throws when no report generator configured', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-nogen-'));
      const adapter = createMockAdapter(makeMockData('x'));
      const mgr = new CoverageManager({
        projectRoot: tmpDir,
        coverageAdapter: adapter as never,
      });

      await expect(mgr.importCoverage('/mock', MOCK_EDA_CONFIG)).rejects.toThrow(
        'No report generator configured',
      );
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
});
