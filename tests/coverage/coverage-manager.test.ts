import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CoverageManager } from '../../src/main/coverage/coverage-manager';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CoverageData } from '@shared/plugin-types';

// Mock PluginBackedCoverage
function createMockAdapter(data: CoverageData | null) {
  return {
    hasParser: () => data !== null,
    parse: vi.fn(async () => data ?? { runId: 'test', overall: 0 }),
  };
}

describe('CoverageManager', () => {
  const mockData: CoverageData = {
    runId: 'run_001',
    overall: 85.5,
    line: 90.2,
    toggle: 82.1,
    functional: 88.0,
    assertion: 81.7,
    bySubsys: [
      { subsys: 'cpu_core', line: 92, toggle: 85, functional: 90, assertion: 80, overall: 86.75 },
      { subsys: 'memory_ctrl', line: 88, toggle: 79, functional: 86, assertion: 83, overall: 84.0 },
    ],
  };

  describe('getOverview', () => {
    it('returns summary with 4 coverage types', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-test-'));
      const adapter = createMockAdapter(mockData);
      const mgr = new CoverageManager({ projectRoot: tmpDir, coverageAdapter: adapter as never });

      const result = await mgr.getOverview('run_001');
      expect(result.summary.overall).toBe(85.5);
      expect(result.summary.line).toBe(90.2);
      expect(result.summary.toggle).toBe(82.1);
      expect(result.summary.functional).toBe(88.0);
      expect(result.summary.assertion).toBe(81.7);
      expect(result.runId).toBe('run_001');

      rmSync(tmpDir, { recursive: true });
    });

    it('throws when no parser available', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-test-'));
      const mgr = new CoverageManager({ projectRoot: tmpDir, coverageAdapter: null });

      await expect(mgr.getOverview()).rejects.toThrow('No coverage-parser plugin loaded');
      rmSync(tmpDir, { recursive: true });
    });

    it('caches coverage data to .socverify/coverage/', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-cache-test-'));
      const adapter = createMockAdapter(mockData);
      const mgr = new CoverageManager({ projectRoot: tmpDir, coverageAdapter: adapter as never });

      await mgr.getOverview('run_001');

      // Second call should not invoke parse again (cached)
      const parseSpy = adapter.parse;
      await mgr.getOverview('run_001');
      expect(parseSpy).toHaveBeenCalledTimes(1);

      rmSync(tmpDir, { recursive: true });
    });
  });

  describe('getBySubsys', () => {
    it('returns coverage broken down by subsystem', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-subsys-test-'));
      const adapter = createMockAdapter(mockData);
      const mgr = new CoverageManager({ projectRoot: tmpDir, coverageAdapter: adapter as never });

      const result = await mgr.getBySubsys('run_001');
      expect(result.items).toHaveLength(2);
      expect(result.items[0].subsys).toBe('cpu_core');
      expect(result.items[0].summary.overall).toBe(86.75);
      expect(result.items[1].subsys).toBe('memory_ctrl');

      rmSync(tmpDir, { recursive: true });
    });
  });

  describe('listCachedRuns', () => {
    it('returns empty array when no cache directory exists', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-list-test-'));
      const mgr = new CoverageManager({ projectRoot: tmpDir, coverageAdapter: null });
      const runs = await mgr.listCachedRuns();
      expect(runs).toEqual([]);
      rmSync(tmpDir, { recursive: true });
    });

    it('lists cached run IDs from .socverify/coverage/', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-list-test-'));
      const covDir = join(tmpDir, '.socverify', 'coverage');
      mkdirSync(covDir, { recursive: true });
      writeFileSync(join(covDir, 'run_001.json'), '{}');
      writeFileSync(join(covDir, 'run_002.json'), '{}');

      const mgr = new CoverageManager({ projectRoot: tmpDir, coverageAdapter: null });
      const runs = await mgr.listCachedRuns();
      expect(runs).toContain('run_001');
      expect(runs).toContain('run_002');
      expect(runs).toHaveLength(2);

      rmSync(tmpDir, { recursive: true });
    });
  });

  describe('getDetail', () => {
    it('returns raw coverage data', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-detail-test-'));
      const adapter = createMockAdapter(mockData);
      const mgr = new CoverageManager({ projectRoot: tmpDir, coverageAdapter: adapter as never });

      const detail = await mgr.getDetail('run_001');
      expect(detail).toEqual(mockData);

      rmSync(tmpDir, { recursive: true });
    });

    it('returns cached data when available', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-detail-cache-test-'));
      const covDir = join(tmpDir, '.socverify', 'coverage');
      mkdirSync(covDir, { recursive: true });
      const cachedData = { ...mockData, runId: 'cached_run' };
      writeFileSync(join(covDir, 'cached_run.json'), JSON.stringify(cachedData));

      const adapter = createMockAdapter(mockData);
      const mgr = new CoverageManager({ projectRoot: tmpDir, coverageAdapter: adapter as never });

      const detail = await mgr.getDetail('cached_run');
      expect(detail?.runId).toBe('cached_run');
      expect(adapter.parse).not.toHaveBeenCalled();

      rmSync(tmpDir, { recursive: true });
    });
  });

  describe('getTrend', () => {
    it('returns trend data from cached runs', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-trend-test-'));
      const covDir = join(tmpDir, '.socverify', 'coverage');
      mkdirSync(covDir, { recursive: true });
      writeFileSync(join(covDir, 'run_001.json'), JSON.stringify(mockData));
      const mockData2 = { ...mockData, runId: 'run_002', overall: 90 };
      writeFileSync(join(covDir, 'run_002.json'), JSON.stringify(mockData2));

      const mgr = new CoverageManager({ projectRoot: tmpDir, coverageAdapter: null });
      const trend = await mgr.getTrend();
      expect(trend).toHaveLength(2);

      rmSync(tmpDir, { recursive: true });
    });
  });

  describe('exportReport', () => {
    it('exports JSON report', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-export-test-'));
      const adapter = createMockAdapter(mockData);
      const mgr = new CoverageManager({ projectRoot: tmpDir, coverageAdapter: adapter as never });
      const outputPath = join(tmpDir, 'report.json');

      await mgr.exportReport('run_001', 'json', outputPath);
      const content = readFileSync(outputPath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.runId).toBe('run_001');

      rmSync(tmpDir, { recursive: true });
    });

    it('exports HTML report', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'cov-export-html-test-'));
      const adapter = createMockAdapter(mockData);
      const mgr = new CoverageManager({ projectRoot: tmpDir, coverageAdapter: adapter as never });
      const outputPath = join(tmpDir, 'report.html');

      await mgr.exportReport('run_001', 'html', outputPath);
      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('<html');
      expect(content).toContain('Coverage Report');
      expect(content).toContain('cpu_core');

      rmSync(tmpDir, { recursive: true });
    });
  });
});
